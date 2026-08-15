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
const { execSync, exec } = require('child_process');
const { open, metaGet, metaSet, backupTo, DATA_DIR } = require('./db');
const seed = require('./seed');
const { createRouter } = require('./routes');
const { NewMileClient } = require('./newmile-client');
const { syncRoster, syncActivity, scanRipRap } = require('./sync-newmile');
const { syncSamsara, syncHOS, syncHOSDaily, syncWorkTimes, backfillParking } = require('./sync-samsara');
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
// El tracker se actualiza SOLO: cada minuto revisa GitHub (asíncrono — no congela el
// board mientras pregunta); si hay commits nuevos hace git pull y se reinicia (el loop
// de run-tracker.cmd lo reprende con el código nuevo). En Azure se salta (ahí despliega CI).
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
function gitQ(cmd) { return execSync(cmd, { cwd: REPO_ROOT, timeout: 90000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
function currentVersion() {
  try { return gitQ('git rev-parse --short HEAD'); } catch (e) { return 'dev'; }
}
function gitA(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: REPO_ROOT, timeout: 90000 }, (err, stdout) => err ? reject(err) : resolve(String(stdout).trim()));
  });
}
let updInFlight = false, updLastErrLog = 0;
async function selfUpdate(log) {
  if (process.env.WEBSITE_INSTANCE_ID || process.env.CACTUS_NO_SELF_UPDATE || updInFlight) return false;
  updInFlight = true;
  try {
    await gitA('git fetch --quiet origin');
    const branch = await gitA('git rev-parse --abbrev-ref HEAD');
    // solo si el remoto va ADELANTE (commits que no tengo); un local adelantado no reinicia
    const behind = await gitA(`git rev-list --count HEAD..origin/${branch}`);
    if (!Number(behind)) { updInFlight = false; return false; }
    await gitA('git pull --ff-only --quiet');
    const now = await gitA('git rev-parse --short HEAD');
    log(`AUTO-UPDATE: nueva versión ${now} instalada — reiniciando en 2 s…`);
    setTimeout(() => process.exit(0), 2000); // el loop lo levanta con lo nuevo
    return true; // updInFlight se queda en true: ya nos vamos a reiniciar
  } catch (e) {
    // sin internet un rato = normal; avisar máx. 1 vez cada 10 min para no ensuciar el log
    if (Date.now() - updLastErrLog > 10 * 60 * 1000) {
      updLastErrLog = Date.now();
      log('auto-update check falló: ' + String(e.message || e).split('\n')[0]);
    }
    updInFlight = false;
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
  let lastActivityHourKey = '', timer = null, lastUpdCheck = 0, lastGps = 0, gpsBusy = false, lastFast = 0, fastBusy = false;

  async function tick() {
    // auto-update en cada tick = cada minuto (también domingos): código nuevo → pull + restart
    if (Date.now() - lastUpdCheck > 55 * 1000) {
      lastUpdCheck = Date.now();
      if (await selfUpdate(log)) return; // se va a reiniciar: no arranques jobs a medias
    }
    const { dateISO, hour, minute, weekday } = ctParts();
    // POSICIÓN AL MOMENTO: barrido ligero de puro GPS cada 3 min en horario de trabajo
    // (cada 15 min de noche). Es lo que hace que "rodando/parado" y la ubicación sean de
    // ahorita. Corre también en domingo: los trokes se mueven aunque no haya despacho.
    const gpsEvery = (hour >= 4 && hour <= 20) ? 3 * 60000 : 15 * 60000;
    if (!gpsBusy && Date.now() - lastGps > gpsEvery) {
      gpsBusy = true; lastGps = Date.now();
      syncSamsara(config, { gpsOnly: true, skipExtras: true })
        .then(s => { if (s.gpsError) log('gps live error: ' + s.gpsError); })
        .catch(e => log('gps live error: ' + (e.message || e)))
        .finally(() => { gpsBusy = false; });
    }
    // CARRIL RÁPIDO cada 15 min (60 de noche): censo Samsara (flags, drivers asignados,
    // trucks nuevos) + relojes HOS. Son 3-4 llamadas por org — barato, y todo se siente
    // del momento en vez de "una vez al día".
    const fastEvery = (hour >= 4 && hour <= 20) ? 15 * 60000 : 60 * 60000;
    if (!fastBusy && Date.now() - lastFast > fastEvery) {
      fastBusy = true; lastFast = Date.now();
      (async () => {
        try {
          const s = await syncSamsara(config, { light: true, skipExtras: true }); // censo + GPS + acomodo
          await syncHOS(config, s.vehiclesByOrg); // relojes con la lista ya en mano
        } catch (e) { log('fast sync error: ' + (e.message || e)); }
        finally { fastBusy = false; }
      })();
    }
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
        // HOS al día: las horas cambian conforme manejan — refresco barato cada 2 h
        try { log('hos sync → ' + JSON.stringify(await syncHOS(config))); } catch (e) { log('hos error: ' + (e.message || e)); }
        // y lo TRABAJADO hoy (daily log de hoy) para el historial día a día
        try { log('hos daily → ' + JSON.stringify(await syncHOSDaily(config, 1))); } catch (e) { log('hos daily error: ' + (e.message || e)); }
        // y la JORNADA de hoy (prendió/apagó) — "terminó" aparece en cuanto apague
        try { log('work times → ' + JSON.stringify(await syncWorkTimes(config, 1))); } catch (e) { log('work times error: ' + (e.message || e)); }

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

// ¿Hay un tracker VIVO respondiendo en el puerto? (distingue "gemelo sano" de "zombie")
function portHealthy(port) {
  return new Promise((resolve) => {
    const req = require('http').get({ host: '127.0.0.1', port, path: '/cactus-tracker/api/health', timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
// Windows deja procesos zombie agarrando el puerto tras un reinicio (nos pasó con el
// auto-update): el puerto figura ocupado pero nadie responde → 502 eterno. Aquí el
// tracker se cura solo: encuentra al que tiene el puerto y lo mata antes de arrancar.
function killPortHolder(port, log) {
  if (process.platform !== 'win32') return 0;
  try {
    const out = execSync('netstat -aon -p tcp', { timeout: 15000 }).toString();
    const pids = new Set();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+\S+\s+(\d+)\s*$/i);
      if (m && Number(m[1]) === Number(port) && Number(m[2]) !== process.pid && /LISTENING/i.test(line)) pids.add(m[2]);
    }
    for (const pid of pids) {
      log(`puerto ${port} secuestrado por proceso zombie ${pid} — matándolo`);
      try { execSync('taskkill /F /PID ' + pid, { timeout: 10000 }); } catch (e) {}
    }
    return pids.size;
  } catch (e) {
    log('no pude revisar el puerto: ' + String(e.message || e).split('\n')[0]);
    return 0;
  }
}

if (require.main === module) {
  (async () => {
    const t = createTracker();
    const app = express();
    app.use('/cactus-tracker', t.router);
    app.get('/', (req, res) => res.redirect('/cactus-tracker/'));
    const port = process.env.PORT || (t.config.port || 8791);

    if (await portHealthy(port)) {
      // ya hay OTRO tracker sano sirviendo (dos ventanas abiertas): no pelear el puerto.
      t.log(`ya hay un tracker sano en el puerto ${port} — esta ventana sobra, reviso en 60 s`);
      setTimeout(() => process.exit(0), 60000); // el loop del .cmd re-checa cada minuto
      return;
    }

    const start = (retried) => {
      const srv = app.listen(port, () => { t.log('escuchando en http://localhost:' + port + '/cactus-tracker/'); t.startScheduler(); });
      srv.on('error', (e) => {
        if (e && e.code === 'EADDRINUSE' && !retried) {
          t.log(`puerto ${port} ocupado pero sin responder — liberándolo…`);
          killPortHolder(port, t.log);
          setTimeout(() => start(true), 2500);
        } else {
          t.log('no pude arrancar: ' + (e.message || e));
          setTimeout(() => process.exit(1), 1000); // el loop del .cmd reintenta
        }
      });
    };
    start(false);
  })();
}

module.exports = { createTracker };
