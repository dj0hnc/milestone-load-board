'use strict';
/*
 * Standalone entry — `node server/index.js` (or `npm start`).
 *
 * Inside mab-office-bundle mount it instead:
 *   const { createTracker } = require('./apps/cactus-tracker/server');
 *   const { router, startScheduler } = createTracker({ config });
 *   app.use('/cactus-tracker', router);
 *   startScheduler();
 *
 * Scheduler (America/Chicago, checked every 30 s — no cron dependency):
 *   04:30  roster sync (NewMile fleet 5: drivers, trailer types, NUEVOS, ¿de baja?)
 *   hh:00 4 AM–7 PM  activity sync (load_tickets → última carga, driver de hoy, auto-cover)
 *   05:00  Samsara sync (flags en nombres + tags de terminal; NUNCA toca subs)
 * No 3 AM reset job: dispatch marks are keyed by real date, old days never bleed in.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { open, metaGet, metaSet, backupTo, DATA_DIR } = require('./db');
const seed = require('./seed');
const { createRouter } = require('./routes');
const { NewMileClient } = require('./newmile-client');
const { syncRoster, syncActivity, scanRipRap } = require('./sync-newmile');
const { syncSamsara, backfillParking } = require('./sync-samsara');
const { snapshotAllToday } = require('./history');
const { ctParts } = require('./util');

function loadConfig() {
  const p = process.env.CACTUS_CONFIG || path.join(DATA_DIR, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { /* sin archivo: puro env */ }
  // Variables de entorno (App Settings en Azure) — pisan al archivo. Así todo se
  // configura copy-paste en el portal, sin editar archivos en el servidor:
  //   PUBLIC_BASE            https://cactus-tracker.azurewebsites.net
  //   SAMSARA_TOKEN_CACTUS   token read-only del org Cactus Express
  //   SAMSARA_TOKEN_CKJ      token read-only del org CKJ Transport
  if (process.env.PUBLIC_BASE) cfg.publicBase = process.env.PUBLIC_BASE;
  const envToks = [
    ['SAMSARA_TOKEN_CACTUS', 'Cactus Express'],
    ['SAMSARA_TOKEN_CKJ', 'CKJ Transport']
  ].filter(([k]) => process.env[k]);
  if (envToks.length) {
    cfg.samsara = cfg.samsara || {};
    const toks = (cfg.samsara.tokens || []).filter(t => t && !envToks.some(([, name]) => t.name === name));
    cfg.samsara.tokens = [...envToks.map(([k, name]) => ({ name, token: process.env[k] })), ...toks];
  }
  return cfg;
}

// ---------- AUTO-UPDATE (self-hosted) ----------
// El tracker se actualiza SOLO: cada 10 min revisa GitHub; si hay versión nueva hace
// git pull y se reinicia (el loop de run-tracker.cmd lo reprende con el código nuevo).
// Nadie vuelve a abrir PowerShell para actualizar. En Azure se salta (ahí despliega CI).
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
function gitQ(cmd) { return execSync(cmd, { cwd: REPO_ROOT, timeout: 90000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
function currentVersion() {
  try { return gitQ('git rev-parse --short HEAD'); } catch (e) { return 'dev'; }
}
function selfUpdate(log) {
  if (process.env.WEBSITE_INSTANCE_ID || process.env.CACTUS_NO_SELF_UPDATE) return false;
  try {
    gitQ('git fetch --quiet origin');
    const branch = gitQ('git rev-parse --abbrev-ref HEAD');
    const local = gitQ('git rev-parse HEAD');
    const remote = gitQ(`git rev-parse origin/${branch}`);
    if (!remote || local === remote) return false;
    gitQ('git pull --ff-only --quiet');
    log(`AUTO-UPDATE: nueva versión ${remote.slice(0, 7)} instalada — reiniciando en 2 s…`);
    setTimeout(() => process.exit(0), 2000); // el loop lo levanta con lo nuevo
    return true;
  } catch (e) {
    log('auto-update check falló: ' + String(e.message || e).split('\n')[0]);
    return false;
  }
}

function createTracker(opts) {
  const config = (opts && opts.config) || loadConfig();
  const log = (opts && opts.log) || ((s) => console.log('[cactus-tracker]', s));
  config.version = currentVersion();

  open();
  seed.main(false); // idempotent first-boot seed
  try { snapshotAllToday(); } catch (e) { log('snapshot inicial falló: ' + e.message); }

  const newmile = new NewMileClient({
    config: { mcpUrl: (config.newmile && config.newmile.mcpUrl) || 'https://app.newmile.com/mcp', oauth: (config.newmile && config.newmile.oauth) || {} },
    tokenPath: path.join(DATA_DIR, 'newmile-tokens.json'),
    onLog: (s) => log('newmile: ' + s)
  });
  newmile.resume().then(st => log(st ? ('NewMile conectado: ' + (st.user || 'ok')) : 'NewMile sin sesión — conectar desde la UI')).catch(() => {});

  // GPS placement al boot: reconstruye dónde durmió la flota. Es CPU-pesado (jala historial
  // de Samsara), así que en el tier GRATIS de Azure NO lo corremos en cada reinicio — solo
  // si no ha corrido en las últimas 6 h. Evita agotar la cuota de CPU de F1 con cada deploy.
  setTimeout(async () => {
    const last = metaGet('last_gps_backfill');
    const freshEnough = last && (Date.now() - Date.parse(last)) < 6 * 3600 * 1000;
    if (freshEnough) { log('GPS placement al boot omitido (corrió hace < 6 h)'); return; }
    try {
      const s = await backfillParking(config, 2);
      log(s.orgs.length ? ('GPS placement → ' + JSON.stringify(s)) : 'GPS placement pospuesto: sin tokens de Samsara aún');
    } catch (e) { log('GPS placement error: ' + (e.message || e)); }
  }, 5000);

  const router = createRouter({ config, newmile, log });

  // ---------- scheduler ----------
  // Catch-up friendly: cada job corre "al llegar o DESPUÉS de su hora" con dedup por día
  // PERSISTIDO en la DB. Así funciona igual en la PC de la oficina que en una nube que
  // duerme: si el host estaba dormido a las 4:30, el sync corre al primer despertar del
  // día (la visita que lo despertó lo dispara) en vez de perderse hasta mañana.
  let lastActivityHourKey = '', timer = null, lastUpdCheck = 0;

  async function tick() {
    // auto-update cada 10 min (también domingos): si hay código nuevo, pull + restart
    if (Date.now() - lastUpdCheck > 10 * 60 * 1000) {
      lastUpdCheck = Date.now();
      if (selfUpdate(log)) return; // se va a reiniciar: no arranques jobs a medias
    }
    const { dateISO, hour, minute, weekday } = ctParts();
    if (weekday === 'Sun') return; // no dispatch Sundays
    const afterOr = (h, m) => hour > h || (hour === h && minute >= m);
    try {
      if (afterOr(4, 30) && metaGet('job_roster_day') !== dateISO) {
        metaSet('job_roster_day', dateISO);
        if (newmile.connected || await newmile.resume()) {
          const rs = await syncRoster(newmile);
          log('roster sync → ' + JSON.stringify(rs));
          // UNA vez al día: actividad con ventana COMPLETA (21 d) para recalcular "X días
          // sin carga". El resto del día la actividad corre con ventana corta (barato).
          try { log('activity full 21d → ' + JSON.stringify(await syncActivity(newmile, 21))); } catch (e) { log('activity full error: ' + e.message); }
          // trucks nuevos → acomodarlos por GPS de inmediato, no hasta mañana
          if (rs.created > 0) { try { log('GPS placement (nuevos) → ' + JSON.stringify(await backfillParking(config, 1))); } catch (e) {} }
          // rip-rap scan diario (ventana corta; el backfill largo se corre manual)
          try { log('riprap scan → ' + JSON.stringify(await scanRipRap(newmile, 14))); } catch (e) { log('riprap scan error: ' + e.message); }
        } else log('roster sync saltado: NewMile sin sesión');
      }
      // Samsara diario desde las 4:10; el parking log solo se escribe si de verdad
      // estamos en la ventana 3-6 AM (sync-samsara lo decide) — despertar tarde
      // actualiza posición/flags/sugerencias sin inventar "dónde durmió".
      if (afterOr(4, 10) && metaGet('job_samsara_day') !== dateISO) {
        metaSet('job_samsara_day', dateISO);
        log('samsara sync → ' + JSON.stringify(await syncSamsara(config)));
        try { log('GPS placement → ' + JSON.stringify(await backfillParking(config, 1))); } catch (e) { log('GPS placement error: ' + (e.message || e)); }
      }
      // Respaldo diario de la DB (20:00 o al primer despertar después): VACUUM INTO
      // un snapshot consistente en DATA_DIR/backups, conserva los últimos 14.
      if (hour >= 20 && metaGet('job_backup_day') !== dateISO) {
        metaSet('job_backup_day', dateISO);
        try {
          const dir = path.join(DATA_DIR, 'backups');
          backupTo(path.join(dir, 'cactus-' + dateISO + '.db'));
          const old = fs.readdirSync(dir).filter(f => /^cactus-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -14);
          for (const f of old) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
          log('backup diario listo: cactus-' + dateISO + '.db');
        } catch (e) { log('backup falló: ' + (e.message || e)); }
      }
      // Actividad periódica: CADA 2 HORAS (horas pares 4–18 CT) con ventana CORTA (3 días).
      // Suficiente para auto-cover y para mover last_load; el recálculo completo lo hace el
      // job diario de arriba. Menos pulls = el tier gratis aguanta.
      const hourKey = dateISO + ':' + hour;
      if (hour >= 4 && hour <= 19 && hour % 2 === 0 && lastActivityHourKey !== hourKey) {
        lastActivityHourKey = hourKey;
        if (newmile.connected || await newmile.resume()) {
          log('activity sync ' + hour + ':00 (3d) → ' + JSON.stringify(await syncActivity(newmile, 3)));
        }
        snapshotAllToday(); // el estado del día queda guardado conforme avanza (historial)
      }
    } catch (e) {
      log('scheduler error: ' + (e.message || e));
    }
  }

  function startScheduler() {
    if (timer) return;
    timer = setInterval(tick, 60000); // 60 s (antes 30 s): menos wakeups en el tier gratis
    timer.unref && timer.unref();
    tick(); // catch-up inmediato: si el host durmió a la hora del job, corre al despertar
    log('scheduler activo (roster+full 4:30 · samsara 4:10 · actividad cada 2 h 4–19 CT · tick 60 s, con catch-up)');
  }
  function stopScheduler() { if (timer) clearInterval(timer); timer = null; }

  return { router, newmile, config, startScheduler, stopScheduler, log };
}

if (require.main === module) {
  const t = createTracker();
  const app = express();
  app.use('/cactus-tracker', t.router);
  app.get('/', (req, res) => res.redirect('/cactus-tracker/'));
  const port = process.env.PORT || (t.config.port || 8791);
  app.listen(port, () => t.log('escuchando en http://localhost:' + port + '/cactus-tracker/'));
  t.startScheduler();
}

module.exports = { createTracker };
