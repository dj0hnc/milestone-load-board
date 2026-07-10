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
const { open, metaGet, metaSet, DATA_DIR } = require('./db');
const seed = require('./seed');
const { createRouter } = require('./routes');
const { NewMileClient } = require('./newmile-client');
const { syncRoster, syncActivity, scanRipRap } = require('./sync-newmile');
const { syncSamsara } = require('./sync-samsara');
const { snapshotAllToday } = require('./history');
const { ctParts } = require('./util');

function loadConfig() {
  const p = process.env.CACTUS_CONFIG || path.join(DATA_DIR, 'config.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
}

function createTracker(opts) {
  const config = (opts && opts.config) || loadConfig();
  const log = (opts && opts.log) || ((s) => console.log('[cactus-tracker]', s));

  open();
  seed.main(false); // idempotent first-boot seed
  try { snapshotAllToday(); } catch (e) { log('snapshot inicial falló: ' + e.message); }

  const newmile = new NewMileClient({
    config: { mcpUrl: (config.newmile && config.newmile.mcpUrl) || 'https://app.newmile.com/mcp', oauth: (config.newmile && config.newmile.oauth) || {} },
    tokenPath: path.join(DATA_DIR, 'newmile-tokens.json'),
    onLog: (s) => log('newmile: ' + s)
  });
  newmile.resume().then(st => log(st ? ('NewMile conectado: ' + (st.user || 'ok')) : 'NewMile sin sesión — conectar desde la UI')).catch(() => {});

  const router = createRouter({ config, newmile, log });

  // ---------- scheduler ----------
  // Catch-up friendly: cada job corre "al llegar o DESPUÉS de su hora" con dedup por día
  // PERSISTIDO en la DB. Así funciona igual en la PC de la oficina que en una nube que
  // duerme: si el host estaba dormido a las 4:30, el sync corre al primer despertar del
  // día (la visita que lo despertó lo dispara) en vez de perderse hasta mañana.
  let lastActivityHourKey = '', timer = null;

  async function tick() {
    const { dateISO, hour, minute, weekday } = ctParts();
    if (weekday === 'Sun') return; // no dispatch Sundays
    const afterOr = (h, m) => hour > h || (hour === h && minute >= m);
    try {
      if (afterOr(4, 30) && metaGet('job_roster_day') !== dateISO) {
        metaSet('job_roster_day', dateISO);
        if (newmile.connected || await newmile.resume()) {
          log('roster sync → ' + JSON.stringify(await syncRoster(newmile)));
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
      }
      const hourKey = dateISO + ':' + hour;
      if (hour >= 4 && hour <= 19 && lastActivityHourKey !== hourKey) {
        lastActivityHourKey = hourKey;
        if (newmile.connected || await newmile.resume()) {
          log('activity sync ' + hour + ':00 → ' + JSON.stringify(await syncActivity(newmile)));
        }
        snapshotAllToday(); // el estado del día queda guardado conforme avanza (historial)
      }
    } catch (e) {
      log('scheduler error: ' + (e.message || e));
    }
  }

  function startScheduler() {
    if (timer) return;
    timer = setInterval(tick, 30000);
    timer.unref && timer.unref();
    tick(); // catch-up inmediato: si el host durmió a la hora del job, corre al despertar
    log('scheduler activo (roster 4:30 · samsara 4:10 · actividad cada hora 4–19 CT, con catch-up)');
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
