'use strict';
/*
 * Express router for the Cactus Tracker. Mounted at /cactus-tracker (standalone
 * index.js or from the office bundle: app.use('/cactus-tracker', createRouter(...))).
 *
 * One board call returns everything the UI needs; writes are tiny and idempotent so
 * the phone can retry them safely from the yard.
 */
const express = require('express');
const path = require('path');
const { all, get, run, metaGet, metaSet, nowISO } = require('./db');
const { todayCT, weekDatesCT, daysBetween, normNum, canonArea, canonicalTruckNumber } = require('./util');
const { syncRoster, syncActivity, scanRipRap } = require('./sync-newmile');
const { syncSamsara, syncHOS, syncHOSDaily, syncWorkTimes, backfillParking, locateTruck, debugHOS, refreshHOSTruck, cameraSnapshot } = require('./sync-samsara');
const { logChange, snapshotTruckDay, historyOf, daySnapshots } = require('./history');

const VALID_STATUS = ['ok', 'shop', 'down', 'no_driver', 'vacation', 'deleased'];
const EDITABLE = ['note', 'status', 'status_note', 'return_date', 'rest_days', 'area', 'division', 'rip_rap', 'star', 'phone', 'tags', 'driver', 'trailer_type'];

function createRouter({ config, newmile, log }) {
  const router = express.Router();
  router.use(express.json());
  const say = log || (() => {});

  // ---------- candado opcional con PIN ----------
  // El board trae nombres y teléfonos de drivers: con el link en la nube conviene un
  // PIN de equipo. Se activa poniendo ACCESS_PIN (App Setting en Azure) o
  // config.accessPin — sin eso, todo queda abierto como antes. El PIN se pide UNA vez
  // por dispositivo (cookie de 180 días); el OAuth callback de NewMile pasa con la
  // cookie del mismo navegador.
  const PIN = process.env.ACCESS_PIN || config.accessPin || '';
  const crypto = require('crypto');
  const pinCookie = PIN ? crypto.createHash('sha256').update('cactus|' + PIN).digest('hex').slice(0, 40) : '';
  const OPEN_PATHS = ['/api/login', '/api/health', '/login.html', '/manifest.webmanifest', '/icon-180.png', '/icon-192.png', '/icon-512.png'];
  if (PIN) {
    router.use((req, res, next) => {
      if (OPEN_PATHS.includes(req.path)) return next();
      const cookie = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('ct_auth='));
      if (cookie && cookie.slice(8) === pinCookie) return next();
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'PIN required' });
      return res.redirect(req.baseUrl + '/login.html');
    });
  }
  router.post('/api/login', (req, res) => {
    if (!PIN) return res.json({ ok: true });
    if (String((req.body || {}).pin || '') !== PIN) return res.status(401).json({ error: 'wrong PIN' });
    res.setHeader('Set-Cookie', `ct_auth=${pinCookie}; Path=${req.baseUrl || '/'}; Max-Age=15552000; HttpOnly; SameSite=Lax`);
    res.json({ ok: true });
  });

  // Abrir la app ES el sync: si al pedir el board la actividad tiene más de 20 min,
  // se dispara un sync en segundo plano (el board responde al instante con lo que hay
  // y la UI se refresca sola cuando termina). Así no hace falta pinger ni cron: la
  // visita de la mañana despierta el host Y trae los datos frescos.
  let syncInflight = false;
  function maybeBackgroundSync() {
    if (!newmile) return false;
    if (syncInflight) return true;
    const last = metaGet('last_sync_newmile_activity');
    if (last && (Date.now() - Date.parse(last)) < 30 * 60 * 1000) return false; // 30 min (antes 20)
    syncInflight = true;
    (async () => {
      try {
        if (newmile.connected || await newmile.resume()) {
          await syncActivity(newmile, 3); // ventana corta: barato para el tier gratis
          say('auto-sync al abrir: actividad actualizada');
        }
      } catch (e) {
        say('auto-sync al abrir falló: ' + (e.message || e));
      } finally {
        syncInflight = false;
      }
    })();
    return true;
  }

  // ---------- board ----------
  // Vistas: un org real (CACTUS, KT), o virtual: ALL = todo junto, SUBS = todos los
  // subhaulers/ICs sin importar en qué org viven (los de Cactus North se quedan ahí
  // Y salen aquí — misma data, otra vista).
  router.get('/api/board', (req, res) => {
    const orgId = normNum(req.query.org || 'CACTUS');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayCT();
    const virtual = orgId === 'ALL' || orgId === 'SUBS';
    const org = virtual
      ? { id: orgId, label: orgId === 'ALL' ? 'All fleets' : 'Subhaulers' }
      : get('SELECT * FROM orgs WHERE id = ?', orgId);
    if (!org) return res.status(404).json({ error: 'unknown org: ' + orgId });

    const divisions = virtual
      ? all(`SELECT d.* FROM divisions d JOIN orgs o ON o.id = d.org_id WHERE o.enabled = 1 ORDER BY o.sort, d.sort`)
      : all('SELECT * FROM divisions WHERE org_id = ? ORDER BY sort', orgId);
    // SUBS = subhaulers de verdad (sin Samsara, viven de NewMile). Los CKJ ICs también
    // llevan is_sub=1 pero NO son subs — tienen su propio tab CKJ ICS y sí traen GPS.
    const trucks = virtual
      ? all(`SELECT t.* FROM trucks t JOIN orgs o ON o.id = t.org_id
             WHERE o.enabled = 1 AND t.archived = 0 ${orgId === 'SUBS' ? "AND t.is_sub = 1 AND NOT (t.org_id = 'KT' AND t.number LIKE 'CKJ%')" : ''}`)
      : all('SELECT * FROM trucks WHERE org_id = ? AND archived = 0', orgId);
    const states = virtual
      ? all('SELECT * FROM dispatch_state WHERE date = ?', date)
      : all('SELECT * FROM dispatch_state WHERE date = ? AND org_id = ?', date, orgId);
    const stMap = new Map(states.map(s => [s.org_id + '|' + s.number, s]));
    // CARRY-OVER de DOWN: un truck marcado ✕ un día sigue down los días siguientes
    // (hasta que alguien confirme con el chofer y lo toque — esa marca explícita corta
    // el arrastre). Solo se hereda 'd'; asignaciones son por día.
    const prevRows = virtual
      ? all('SELECT org_id, number, state, date FROM dispatch_state WHERE date < ? ORDER BY date DESC', date)
      : all('SELECT org_id, number, state, date FROM dispatch_state WHERE date < ? AND org_id = ? ORDER BY date DESC', date, orgId);
    const carryMap = new Map(); // org|num -> {state, date} (la marca MÁS RECIENTE anterior)
    for (const r of prevRows) {
      const k = r.org_id + '|' + r.number;
      if (!carryMap.has(k)) carryMap.set(k, r);
    }
    // rangos programados de no-disponible (vacaciones/shop): vigentes o futuros vs la fecha vista
    const offs = virtual
      ? all('SELECT * FROM time_off WHERE to_date >= ?', date)
      : all('SELECT * FROM time_off WHERE org_id = ? AND to_date >= ?', orgId, date);
    const offMap = new Map();
    for (const o of offs) {
      const k = o.org_id + '|' + o.number;
      (offMap.get(k) || offMap.set(k, []).get(k)).push(o);
    }
    const today = todayCT();
    // past date → overlay how each truck WAS that day (status/notas de ese día)
    const historical = date < today;
    const snaps = historical ? daySnapshots(virtual ? null : orgId, date) : null;

    // EQUIDAD: cargas de los últimos 7 días por truck (para repartir parejo y ver quién
    // anda bajo). El front suma por dueño en el encabezado del grupo.
    const wk = weekDatesCT(date);
    const wkFrom = wk.Mon, wkTo = wk.Sat;
    const wkMap = new Map();
    for (const r of all(`SELECT org_id, number, SUM(loads) AS n FROM activity_log
                         WHERE load_date >= ? AND load_date <= ? GROUP BY org_id, number`, wkFrom, wkTo)) {
      wkMap.set(r.org_id + '|' + r.number, r.n);
    }
    // HOS trabajado: lo de ESTE día y el acumulado de la semana hasta este día (por driver)
    const hosDayMap = new Map(), hosWkMap = new Map();
    for (const r of all('SELECT driver_id, drive_ms, duty_ms FROM hos_days WHERE date = ?', date)) hosDayMap.set(r.driver_id, r);
    // JORNADA del día visto: a qué hora prendió y a qué hora apagó cada truck
    const workMap = new Map();
    for (const r of all('SELECT org_id, number, started_at, ended_at FROM work_days WHERE date = ?', date)) {
      workMap.set(r.org_id + '|' + r.number, r);
    }
    for (const r of all(`SELECT driver_id, SUM(COALESCE(duty_ms, drive_ms)) AS n FROM hos_days
                         WHERE date >= ? AND date <= ? GROUP BY driver_id`, wkFrom, date < wkTo ? date : wkTo)) {
      hosWkMap.set(r.driver_id, r.n);
    }

    const outTrucks = trucks.map(t => {
      const s = stMap.get(t.org_id + '|' + t.number);
      const driverChangedRecent = t.driver_changed_at && (Date.now() - Date.parse(t.driver_changed_at)) < 48 * 3600 * 1000;
      const snap = snaps ? snaps.get(t.org_id + '|' + t.number) : null;
      return {
        ...t,
        ...(snap ? {
          status: snap.status, status_note: snap.status_note, return_date: snap.return_date,
          note: snap.note, driver: snap.driver, division: snap.division || t.division,
          area: snap.area || t.area, rip_rap: snap.rip_rap != null ? snap.rip_rap : t.rip_rap,
          from_snapshot: 1
        } : {}),
        state: s ? s.state : ((carryMap.get(t.org_id + '|' + t.number) || {}).state === 'd' ? 'd' : 'p'),
        state_source: s ? s.source : ((carryMap.get(t.org_id + '|' + t.number) || {}).state === 'd' ? 'carry' : null),
        nm_confirmed: s ? (s.nm_confirmed || 0) : 0,
        nm_dest: s && s.nm_info ? (() => { try { return JSON.parse(s.nm_info); } catch (e) { return []; } })() : [],
        hos_worked: t.samsara_driver_id ? (hosDayMap.get(String(t.samsara_driver_id)) || null) : null,
        hos_worked_wk_ms: t.samsara_driver_id ? (hosWkMap.get(String(t.samsara_driver_id)) || null) : null,
        work_day: workMap.get(t.org_id + '|' + t.number) || null,
        loads_week: wkMap.get(t.org_id + '|' + t.number) || 0,
        down_since: !s && (carryMap.get(t.org_id + '|' + t.number) || {}).state === 'd' ? carryMap.get(t.org_id + '|' + t.number).date : null,
        state_by: s ? s.marked_by : null,
        time_off: offMap.get(t.org_id + '|' + t.number) || [],
        days_since_last_load: t.last_load_date ? daysBetween(t.last_load_date, today) : null,
        driver_changed_recent: driverChangedRecent ? { prev: t.driver_prev, at: t.driver_changed_at } : null
      };
    });

    res.json({
      org: { id: org.id, label: org.label },
      orgs: all('SELECT id, label, enabled FROM orgs ORDER BY sort'),
      divisions,
      // ALL primero, luego una por división de cada org, y SUBS al final (vistas virtuales)
      tabs: [{ org_id: 'ALL', id: 'ALL', label: 'ALL' }]
        .concat(all(`SELECT d.org_id, d.id, d.label FROM divisions d JOIN orgs o ON o.id = d.org_id
                     WHERE o.enabled = 1 ORDER BY o.sort, d.sort`))
        .concat([{ org_id: 'SUBS', id: 'SUBS', label: 'SUBS' }]),
      date, today, historical,
      // ¿este día ya se cotejó contra las asignaciones de NewMile? (para avisar "planeado
      // aquí pero NO está en NewMile" solo cuando hay datos reales que comparar)
      nm_checked: !!metaGet('nm_assign_checked_' + date),
      // huecos en las órdenes de NewMile de este día (calculado en cada sync de actividad)
      nm_gaps: (() => { try { return JSON.parse(metaGet('nm_gaps_' + date) || '[]'); } catch (e) { return []; } })(),
      week: weekDatesCT(date),
      trucks: outTrucks,
      meta: {
        version: config.version || 'dev',
        last_sync_roster: metaGet('last_sync_newmile_roster'),
        last_sync_activity: metaGet('last_sync_newmile_activity'),
        last_sync_samsara: metaGet('last_sync_samsara'),
        auto_mark: metaGet('auto_mark', '1') !== '0',
        syncing: maybeBackgroundSync(),
        sync_now: (() => { try { return JSON.parse(metaGet('sync_now_status') || 'null'); } catch (e) { return null; } })(),
        newmile: newmile ? newmile.status() : { connected: false }
      }
    });
  });

  // ---------- dispatch state ----------
  router.post('/api/state', (req, res) => {
    const { date, org, number, state, by } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !org || !number || !['p', 'a', 'd'].includes(state)) {
      return res.status(400).json({ error: 'body: {date ISO, org, number, state p|a|d}' });
    }
    // nm_confirmed vuelve a 0: la confirmación vs NewMile se re-verifica en el próximo sync
    // (y el destino se limpia — si sigue asignado en NewMile, el sync lo repone solo)
    run(`INSERT INTO dispatch_state (date, org_id, number, state, source, marked_by, marked_at, nm_confirmed, nm_info) VALUES (?,?,?,?,'manual',?,?,0,'')
         ON CONFLICT(date, org_id, number) DO UPDATE SET state = excluded.state, source = 'manual', marked_by = excluded.marked_by, marked_at = excluded.marked_at, nm_confirmed = 0, nm_info = ''`,
      date, normNum(org), normNum(number), state, String(by || '').slice(0, 40), nowISO());
    res.json({ ok: true });
  });

  router.post('/api/reset', (req, res) => {
    const { date, org, division } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !org) return res.status(400).json({ error: 'body: {date, org, division?}' });
    if (division) {
      run(`DELETE FROM dispatch_state WHERE date = ? AND org_id = ? AND number IN
             (SELECT number FROM trucks WHERE org_id = ? AND division = ?)`,
        date, normNum(org), normNum(org), normNum(division));
    } else {
      run('DELETE FROM dispatch_state WHERE date = ? AND org_id = ?', date, normNum(org));
    }
    res.json({ ok: true });
  });

  // ---------- truck edits (my fields — NewMile never overwrites these) ----------
  router.post('/api/truck/:org/:number', (req, res) => {
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, number);
    if (!row) return res.status(404).json({ error: 'truck not found' });
    const sets = [], vals = [];
    for (const f of EDITABLE) {
      if (!(f in (req.body || {}))) continue;
      let v = req.body[f];
      if (f === 'status' && !VALID_STATUS.includes(v)) return res.status(400).json({ error: 'invalid status' });
      if (f === 'rip_rap' || f === 'star') v = v ? 1 : 0;
      if (f === 'area' && v) v = canonArea(v); // zonas SIN estado: "PARIS, TX" → "PARIS"
      if (f === 'division' && v != null && v !== '') {
        const d = get('SELECT 1 AS x FROM divisions WHERE org_id = ? AND id = ?', orgId, normNum(v));
        if (!d) return res.status(400).json({ error: 'invalid division' });
        v = normNum(v);
      }
      sets.push(`${f} = ?`); vals.push(v == null ? '' : v);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    // corregir el tipo a mano lo blinda contra el sync de NewMile
    if ('trailer_type' in (req.body || {})) sets.push('trailer_override = 1');
    sets.push('updated_at = ?'); vals.push(nowISO());
    run(`UPDATE trucks SET ${sets.join(', ')} WHERE org_id = ? AND number = ?`, ...vals, orgId, number);
    const updated = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, number);
    // multi-user audit + today's snapshot (quién cambió qué, y cómo quedó el día)
    const by = String((req.body || {}).by || '').slice(0, 40);
    for (const f of EDITABLE) if (f in (req.body || {})) logChange(orgId, number, f, row[f], updated[f], by);
    snapshotTruckDay(updated);
    res.json({ ok: true, truck: updated });
  });

  // ¿Por qué este truck no trae HOS? Abrir /api/hos/debug?number=169 lo dice completo:
  // driver del board vs driver asignado en Samsara vs nombres parecidos en los relojes.
  router.get('/api/hos/debug', async (req, res) => {
    const hit = truckForAssignment(req.query.number || '');
    if (!hit) return res.status(404).json({ error: 'truck not found on the board' });
    const row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', hit.org_id, hit.number);
    try { res.json(await debugHOS(config, row)); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // QUITAR DEL BOARD a mano (ruido: trucks viejos, sin chofer, de orgs que ya no corren).
  // Es archivado, NO borrado: el historial queda, y si el truck vuelve a correr carga o
  // llega asignado en NewMile, REGRESA SOLO al board. Cero riesgo de perderlo.
  router.post('/api/truck/:org/:number/remove', (req, res) => {
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, number);
    if (!row) return res.status(404).json({ error: 'truck not found' });
    const by = String((req.body || {}).by || '').slice(0, 40);
    run(`UPDATE trucks SET archived = 1, is_new = 0, maybe_removed = 0 WHERE org_id = ? AND number = ?`, orgId, number);
    logChange(orgId, number, 'removed', '', 'removed from board (returns by itself if it hauls again)', by);
    res.json({ ok: true });
  });

  // Time off programado: "vacaciones toda la semana que viene" con un tap. Entra y
  // regresa solo por fecha; MISSING lo excluye únicamente esos días.
  router.post('/api/truck/:org/:number/timeoff', (req, res) => {
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const { from, to, reason, note, by } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || to < from) {
      return res.status(400).json({ error: 'body: {from ISO, to ISO (>= from), reason?, note?}' });
    }
    if (!get('SELECT 1 AS x FROM trucks WHERE org_id = ? AND number = ?', orgId, number)) {
      return res.status(404).json({ error: 'truck not found' });
    }
    const rz = ['vacation', 'shop', 'down', 'personal'].includes(reason) ? reason : 'vacation';
    run(`INSERT INTO time_off (org_id, number, from_date, to_date, reason, note, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      orgId, number, from, to, rz, String(note || '').slice(0, 200), String(by || '').slice(0, 40), nowISO());
    logChange(orgId, number, 'time_off', '', `${rz} ${from} → ${to}`, by);
    res.json({ ok: true, time_off: all('SELECT * FROM time_off WHERE org_id = ? AND number = ? ORDER BY from_date', orgId, number) });
  });

  router.post('/api/truck/:org/:number/timeoff/delete', (req, res) => {
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const { id, by } = req.body || {};
    const row = get('SELECT * FROM time_off WHERE id = ? AND org_id = ? AND number = ?', Number(id) || 0, orgId, number);
    if (!row) return res.status(404).json({ error: 'time off entry not found' });
    run('DELETE FROM time_off WHERE id = ?', row.id);
    logChange(orgId, number, 'time_off', `${row.reason} ${row.from_date} → ${row.to_date}`, 'removed', by);
    res.json({ ok: true });
  });

  // Historial por truck: cambios (quién/cuándo), cargas y dónde durmió.
  router.get('/api/truck/:org/:number/history', (req, res) => {
    res.json(historyOf(normNum(req.params.org), normNum(req.params.number)));
  });

  // RIP RAP: aceptar/descartar la sugerencia detectada en las órdenes de NewMile.
  router.post('/api/truck/:org/:number/rip', (req, res) => {
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const { action, by } = req.body || {};
    const row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, number);
    if (!row) return res.status(404).json({ error: 'truck not found' });
    if (action === 'accept') {
      run(`UPDATE trucks SET rip_rap = 1, rip_suggested = 0, updated_at = ? WHERE org_id = ? AND number = ?`, nowISO(), orgId, number);
      logChange(orgId, number, 'rip_rap', row.rip_rap, 1, by);
      snapshotTruckDay(get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, number));
    } else {
      run(`UPDATE trucks SET rip_suggested = 0 WHERE org_id = ? AND number = ?`, orgId, number);
    }
    res.json({ ok: true });
  });

  // Área sugerida por GPS nocturno: aceptar mueve el truck a esa área; descartar la limpia.
  router.post('/api/truck/:org/:number/area-suggest', (req, res) => {
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const { action, by } = req.body || {};
    const row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, number);
    if (!row) return res.status(404).json({ error: 'truck not found' });
    if (action === 'accept' && row.suggested_area) {
      const dest = canonArea(row.suggested_area);
      run(`UPDATE trucks SET area = ?, suggested_area = '', updated_at = ? WHERE org_id = ? AND number = ?`,
        dest, nowISO(), orgId, number);
      logChange(orgId, number, 'area', row.area, dest, by);
      snapshotTruckDay(get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, number));
    } else {
      run(`UPDATE trucks SET suggested_area = '' WHERE org_id = ? AND number = ?`, orgId, number);
    }
    res.json({ ok: true });
  });

  // GPS en vivo de UN truck (botón ↻ del cuadrito).
  router.post('/api/truck/:org/:number/locate', async (req, res) => {
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const t = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, number);
    if (!t) return res.status(404).json({ error: 'truck not found' });
    if (t.org_id === 'CACTUS' && t.is_sub) return res.status(400).json({ error: 'Cactus subs have no Samsara' });
    const orgRow = get('SELECT * FROM orgs WHERE id = ?', t.org_id);
    try {
      const loc = await locateTruck(config, orgRow, t);
      // el mismo ↻ también deja las HORAS DE SERVICIO de ese driver al segundo
      let hos = null;
      try { hos = await refreshHOSTruck(config, t); } catch (e) { /* best effort */ }
      res.json({ ok: true, ...loc, hos, truck: get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, number) });
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  // 📷 Snapshot de las cámaras (frontal + cabina) AL MOMENTO — sin abrir Samsara.
  // Tarda ~10-20 s (la cámara sube la foto); si no regresa nada, la cámara está mal.
  router.post('/api/truck/:org/:number/camera', async (req, res) => {
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const t = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, number);
    if (!t) return res.status(404).json({ error: 'truck not found' });
    try { res.json({ ok: true, ...(await cameraSnapshot(config, t)) }); }
    catch (e) { res.status(502).json({ error: String(e.message || e) }); }
  });

  // Re-corre el acomodo por GPS a demanda (noches de los últimos {days}, default 2).
  router.post('/api/scan/parking', async (req, res) => {
    try {
      res.json({ ok: true, ...(await backfillParking(config, Number((req.body || {}).days) || 2)) });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Escaneo manual de RIP RAP sobre una ventana de días (default 30).
  router.post('/api/scan/riprap', async (req, res) => {
    if (!newmile) return res.status(503).json({ error: 'NewMile not configured' });
    try {
      if (!newmile.connected && !(await newmile.resume())) {
        return res.status(401).json({ error: 'NOT_CONNECTED', hint: 'open /api/newmile/connect' });
      }
      res.json({ ok: true, ...(await scanRipRap(newmile, Number((req.body || {}).days) || 30)) });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Confirm a ⚑ NUEVO: place it (division + area) and clear the flag.
  router.post('/api/truck/:org/:number/confirm-new', (req, res) => {
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const { division, area } = req.body || {};
    if (!division) return res.status(400).json({ error: 'division is required to confirm a NEW truck' });
    const d = get('SELECT 1 AS x FROM divisions WHERE org_id = ? AND id = ?', orgId, normNum(division));
    if (!d) return res.status(400).json({ error: 'invalid division' });
    const r = run(`UPDATE trucks SET is_new = 0, division = ?, area = COALESCE(NULLIF(?, ''), area), suggested_division = NULL, updated_at = ?
                   WHERE org_id = ? AND number = ?`,
      normNum(division), canonArea(area || ''), nowISO(), orgId, number);
    if (!r.changes) return res.status(404).json({ error: 'truck not found' });
    res.json({ ok: true });
  });

  // Resolve a ¿de baja?: archive it (kept for history) or keep it active.
  router.post('/api/truck/:org/:number/resolve-removed', (req, res) => {
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const action = (req.body || {}).action;
    if (!['archive', 'keep'].includes(action)) return res.status(400).json({ error: "action: 'archive' | 'keep'" });
    const r = run(`UPDATE trucks SET maybe_removed = 0, archived = ?, updated_at = ? WHERE org_id = ? AND number = ?`,
      action === 'archive' ? 1 : 0, nowISO(), orgId, number);
    if (!r.changes) return res.status(404).json({ error: 'truck not found' });
    res.json({ ok: true });
  });

  // Accept/dismiss a proposed flag (from the Samsara vehicle name or NewMile name suffix).
  // Accept maps common texts to a status; the raw text lands in status_note either way.
  router.post('/api/truck/:org/:number/flag', (req, res) => {
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const { source, action } = req.body || {}; // source: 'samsara'|'newmile'; action: 'accept'|'dismiss'
    const col = source === 'newmile' ? 'detected_flag' : 'samsara_flag';
    const row = get(`SELECT * FROM trucks WHERE org_id = ? AND number = ?`, orgId, number);
    if (!row) return res.status(404).json({ error: 'truck not found' });
    const flag = row[col] || '';
    if (action === 'accept' && flag) {
      let status = row.status;
      if (/DELEAS/i.test(flag)) status = 'deleased';
      else if (/SHOP/i.test(flag)) status = 'shop';
      else if (/DOWN/i.test(flag)) status = 'down';
      run(`UPDATE trucks SET status = ?, status_note = ?, ${col} = '', updated_at = ? WHERE org_id = ? AND number = ?`,
        status, flag, nowISO(), orgId, number);
    } else {
      run(`UPDATE trucks SET ${col} = '', updated_at = ? WHERE org_id = ? AND number = ?`, nowISO(), orgId, number);
    }
    res.json({ ok: true });
  });

  // ---------- settings ----------
  router.post('/api/settings', (req, res) => {
    if ('auto_mark' in (req.body || {})) metaSet('auto_mark', req.body.auto_mark ? '1' : '0');
    res.json({ ok: true, auto_mark: metaGet('auto_mark', '1') !== '0' });
  });

  // ---------- ÓRDENES: planear y DESPACHAR desde el tracker ----------
  // GET /api/orders?date=  → órdenes de NewMile del día con sus asignaciones y huecos.
  // POST /api/orders/assign {order_id, date, trucks:[{org,number}], load_limit?, by}
  //   → bulk_create_assignments (nacen draft) + confirm_assignments (visibles al driver)
  //   → marca los trucks asignados ⚡ aquí mismo. Planear = despachar, un solo paso.
  // POST /api/orders/unassign {assignment_id, date} → borra la asignación (solo sin loads).
  const ordersCache = {}; // dateISO -> {at, data} (TTL corto: el panel se siente vivo)
  function truckForAssignment(rawNumber) {
    const n = normNum(rawNumber || '').replace(/\s+/g, '');
    const cands = [n, canonicalTruckNumber('KT', n)];
    if (/^\d{1,4}$/.test(n)) cands.push('CKJ' + n);
    if (n.startsWith('C') && /^\d+$/.test(n.slice(1))) cands.push(n.slice(1));
    for (const c of [...new Set(cands)]) {
      const hit = get('SELECT org_id, number, display_number FROM trucks WHERE number = ?', c);
      if (hit) return hit;
    }
    return get('SELECT org_id, number, display_number FROM trucks WHERE display_number = ?', n) || null;
  }
  router.get('/api/orders', async (req, res) => {
    if (!newmile) return res.status(503).json({ error: 'NewMile not configured' });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayCT();
    const c = ordersCache[date];
    if (c && (Date.now() - c.at) < 180000 && !req.query.fresh) return res.json(c.data);
    try {
      if (!newmile.connected && !(await newmile.resume())) {
        return res.status(401).json({ error: 'NOT_CONNECTED', hint: 'open /api/newmile/connect' });
      }
      const rows = await newmile.ordersForDate(date);
      const orders = rows.map(({ order: o, assignments }) => ({
        id: o.id,
        name: o.reference || o.project_name || o.customer_name || ('Order ' + o.id),
        customer: o.customer_name || '',
        material: o.material_name || o.material || '',
        pickup: o.pickup_location_name || o.pickup_org_location_name || o.pickup_site_name || '',
        dropoff: o.dropoff_location_name || o.dropoff_org_location_name || o.dropoff_site_name || '',
        qty: o.quantity_requested != null ? o.quantity_requested : null,
        unit: o.quantity_measurement_unit || '',
        planned: o.planned_truck_count != null ? o.planned_truck_count : null,
        status: o.status || '',
        earliest: o.earliest_load_time || o.start_date || null,
        assigned: (assignments || []).map(a => {
          const local = truckForAssignment(a.truck_number || (a.truck && a.truck.truck_number) || '');
          return {
            id: a.id, truck_number: a.truck_number || '', driver: a.driver_name || '',
            status: a.assignment_status || '', loads: a.load_count || 0, load_limit: a.load_limit != null ? a.load_limit : null,
            org: local ? local.org_id : null, number: local ? local.number : null
          };
        })
      }));
      const data = { date, orders, fetched_at: nowISO() };
      ordersCache[date] = { at: Date.now(), data };
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // saca los IDs de asignaciones creadas de la respuesta del utility (shape defensivo)
  function extractAssignments(resp) {
    const found = [];
    const walk = (x) => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (x && typeof x === 'object') {
        if (x.id != null && (x.truck_id != null || x.order_id != null) && !x.resource_type) found.push(x);
        for (const v of Object.values(x)) walk(v);
      }
    };
    walk(resp);
    return found;
  }
  router.post('/api/orders/assign', async (req, res) => {
    if (!newmile) return res.status(503).json({ error: 'NewMile not configured' });
    const { order_id, date, trucks, load_limit, by } = req.body || {};
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : todayCT();
    if (!order_id || !Array.isArray(trucks) || !trucks.length) {
      return res.status(400).json({ error: 'body: {order_id, trucks:[{org,number}], date?, load_limit?, by?}' });
    }
    try {
      if (!newmile.connected && !(await newmile.resume())) {
        return res.status(401).json({ error: 'NOT_CONNECTED' });
      }
      const failed = [], entries = [];
      for (const tr of trucks) {
        const row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', normNum(tr.org), normNum(tr.number));
        if (!row) { failed.push({ ...tr, reason: 'not on the board' }); continue; }
        if (row.nm_truck_id == null) { failed.push({ ...tr, reason: 'no NewMile id yet — run Sync now first' }); continue; }
        entries.push({ order_id: Number(order_id), truck_id: row.nm_truck_id, _row: row });
      }
      let created = [], warnings = null, confirmed = false;
      if (entries.length) {
        const resp = await newmile.bulkCreateAssignments(
          entries.map(e => ({ order_id: e.order_id, truck_id: e.truck_id })),
          load_limit ? { default_load_limit: Number(load_limit) } : {});
        if (resp && resp.warnings) warnings = resp.warnings;
        created = extractAssignments(resp);
        const ids = created.map(a => a.id);
        if (ids.length) {
          try { await newmile.confirmAssignments(ids); confirmed = true; }
          catch (e) { warnings = (warnings || []).concat(['confirm failed (left as draft): ' + (e.message || e)]); }
        }
        // marca local: asignado ⚡ (verificado — lo acabamos de meter a NewMile), con su
        // DESTINO para que el cuadrito diga a dónde va desde el primer segundo
        const who = String(by || '').slice(0, 40);
        const cachedOrder = ((ordersCache[day] && ordersCache[day].data.orders) || []).find(o => String(o.id) === String(order_id));
        const dest = cachedOrder ? JSON.stringify([{
          n: String(cachedOrder.name || '').slice(0, 60), c: String(cachedOrder.customer || '').slice(0, 40),
          m: String(cachedOrder.material || '').slice(0, 40), d: String(cachedOrder.dropoff || '').slice(0, 50)
        }]) : '';
        const byTruckId = new Map(created.map(a => [a.truck_id, a]));
        for (const e of entries) {
          if (ids.length && !byTruckId.has(e.truck_id)) continue; // no regresó creado
          run(`INSERT INTO dispatch_state (date, org_id, number, state, source, marked_by, marked_at, nm_confirmed, nm_info)
               VALUES (?,?,?,?,'manual',?,?,1,?)
               ON CONFLICT(date, org_id, number) DO UPDATE SET state='a', source='manual', marked_by=excluded.marked_by, marked_at=excluded.marked_at, nm_confirmed=1, nm_info=excluded.nm_info`,
            day, e._row.org_id, e._row.number, 'a', who, nowISO(), dest);
          logChange(e._row.org_id, e._row.number, 'nm_assign', '', 'order ' + order_id + (load_limit ? ' x' + load_limit : ''), who);
        }
      }
      delete ordersCache[day];
      res.json({ ok: true, pushed: created.length || entries.length, confirmed, warnings, failed });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  router.post('/api/orders/unassign', async (req, res) => {
    if (!newmile) return res.status(503).json({ error: 'NewMile not configured' });
    const { assignment_id, date } = req.body || {};
    if (!assignment_id) return res.status(400).json({ error: 'body: {assignment_id, date?}' });
    try {
      if (!newmile.connected && !(await newmile.resume())) return res.status(401).json({ error: 'NOT_CONNECTED' });
      await newmile.deleteAssignment(Number(assignment_id));
      if (date) delete ordersCache[date];
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // SYNC NOW INSTANTÁNEO: dispara todo en el FONDO (NewMile ∥ Samsara en paralelo) y
  // regresa de inmediato. El board se refresca solo conforme aterriza cada parte; el
  // estado vive en meta para que el botón enseñe el avance en vivo.
  let syncNowBusy = false;
  async function runSyncNow() {
    // Progreso REAL por fase, con conteos — el board lo pinta en vivo mientras corre.
    const st = { running: true, started: nowISO(), parts: {
      nm: { s: 'run' }, gps: { s: 'run' }, hos: { s: 'wait' }, daily: { s: 'wait' }, work: { s: 'wait' }
    } };
    const save = () => metaSet('sync_now_status', JSON.stringify(st));
    const done = (k, n) => { st.parts[k] = { s: 'ok', n: n == null ? undefined : n }; save(); };
    const fail = (k, e) => { st.parts[k] = { s: 'err', msg: String(e.message || e).slice(0, 80) }; save(); };
    save();
    await Promise.all([
      (async () => { // NewMile: cargas frescas + auto-cover + destinos + huecos
        try {
          if (newmile && (newmile.connected || await newmile.resume())) {
            const a = await syncActivity(newmile, 3);
            done('nm', a.matched);
          } else st.parts.nm = { s: 'off' }, save();
        } catch (e) { fail('nm', e); }
      })(),
      (async () => { // Samsara en cadena: GPS primero, luego relojes/diario/jornada EN PARALELO
        let veh = null;
        try {
          const s = await syncSamsara(config, { light: true, skipExtras: true });
          veh = s.vehiclesByOrg;
          done('gps', s.gps);
        } catch (e) { fail('gps', e); }
        st.parts.hos = { s: 'run' }; st.parts.daily = { s: 'run' }; st.parts.work = { s: 'run' }; save();
        await Promise.all([
          syncHOS(config, veh).then(r => done('hos', r.matched)).catch(e => fail('hos', e)),
          syncHOSDaily(config, 2).then(r => done('daily', r.saved)).catch(e => fail('daily', e)),
          syncWorkTimes(config, 1).then(r => done('work', r.saved)).catch(e => fail('work', e))
        ]);
      })()
    ]);
    st.running = false; st.done_at = nowISO(); save();
  }
  router.post('/api/sync/now', (req, res) => {
    const already = syncNowBusy;
    if (!syncNowBusy) {
      syncNowBusy = true;
      runSyncNow().catch((e) => say('sync now error: ' + (e.message || e))).finally(() => { syncNowBusy = false; });
    }
    res.json({ ok: true, started: true, already });
  });

  // ---------- syncs (manual "Sync ahora" + used by the scheduler) ----------
  router.post('/api/sync/newmile', async (req, res) => {
    if (!newmile) return res.status(503).json({ error: 'NewMile not configured' });
    try {
      if (!newmile.connected && !(await newmile.resume())) {
        return res.status(401).json({ error: 'NOT_CONNECTED', hint: 'open /api/newmile/connect' });
      }
      const roster = await syncRoster(newmile);
      const activity = await syncActivity(newmile);
      res.json({ ok: true, roster, activity });
    } catch (e) {
      say('sync newmile error: ' + e.message);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  router.post('/api/sync/samsara', async (req, res) => {
    try {
      // syncSamsara ya jala la posición ACTUAL de cada troke y los re-acomoda por GPS
      // (applyPlacements adentro). El backfill de 2 noches de historial es pesado y lo
      // corre el scheduler/boot — meterlo aquí alargaba la petición y la cortaba (499).
      const s = await syncSamsara(config, { light: true }); // botón = fresco; lo pesado es del nocturno
      res.json({ ok: true, ...s });
    } catch (e) {
      say('sync samsara error: ' + e.message);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---------- audit (JSON version of the 7/9 xlsx) ----------
  router.get('/api/audit', (req, res) => {
    const orgId = normNum(req.query.org || 'CACTUS');
    const today = todayCT();
    const trucks = all('SELECT * FROM trucks WHERE org_id = ?', orgId);
    const active = t => !t.archived;
    const days = t => t.last_load_date ? daysBetween(t.last_load_date, today) : null;
    res.json({
      org: orgId, date: today,
      totals: { roster: trucks.filter(active).length, subs: trucks.filter(t => active(t) && t.is_sub).length },
      nuevos: trucks.filter(t => active(t) && t.is_new).map(t => t.number),
      posibles_bajas: trucks.filter(t => active(t) && t.maybe_removed).map(t => t.number),
      archivados: trucks.filter(t => t.archived).map(t => t.number),
      sin_carga_5d: trucks.filter(t => active(t) && days(t) != null && days(t) >= 5 && days(t) < 14).map(t => ({ number: t.number, days: days(t) })),
      sin_carga_14d: trucks.filter(t => active(t) && (days(t) == null || days(t) >= 14)).map(t => ({ number: t.number, days: days(t) })),
      flags_pendientes: trucks.filter(t => active(t) && (t.samsara_flag || t.detected_flag))
        .map(t => ({ number: t.number, samsara: t.samsara_flag || null, newmile: t.detected_flag || null }))
    });
  });

  // ---------- NewMile web sign-in ----------
  function callbackUri(req) {
    // publicBase (tunnel URL) wins; otherwise honor the proxy headers the tunnel sets.
    const base = (config.publicBase || '').replace(/\/$/, '');
    if (base) return base + req.baseUrl + '/api/newmile/callback';
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}${req.baseUrl}/api/newmile/callback`;
  }

  router.get('/api/newmile/status', (req, res) => res.json(newmile ? newmile.status() : { connected: false }));

  router.get('/api/newmile/connect', async (req, res) => {
    if (!newmile) return res.status(503).send('NewMile not configured');
    try {
      if (await newmile.resume()) return res.redirect(req.baseUrl + '/?connected=1');
      const { authUrl } = await newmile.beginAuth(callbackUri(req));
      res.redirect(authUrl);
    } catch (e) { res.status(500).send('Error starting sign-in: ' + e.message); }
  });

  router.get('/api/newmile/callback', async (req, res) => {
    if (!newmile) return res.status(503).send('NewMile not configured');
    try {
      await newmile.finishAuth(req.query);
      res.redirect(req.baseUrl + '/?connected=1');
    } catch (e) { res.status(500).send('Sign-in failed: ' + e.message + '. Go back and try again.'); }
  });

  router.post('/api/newmile/disconnect', (req, res) => res.json(newmile ? newmile.disconnect() : { connected: false }));

  // Health + KEEPALIVE: un ping externo (GitHub Actions cada 15 min) despierta el host
  // en Azure y, de paso, dispara el auto-sync en segundo plano (dedup de 20 min). Así el
  // board se mantiene solo aunque NADIE lo tenga abierto — solo revisas qué queda libre.
  router.get('/api/health', (req, res) => {
    const syncing = maybeBackgroundSync();
    res.json({
      ok: true,
      version: config.version || 'dev',
      today: todayCT(),
      syncing,
      newmile_connected: newmile ? !!newmile.connected : false,
      last_sync_activity: metaGet('last_sync_newmile_activity'),
      last_sync_samsara: metaGet('last_sync_samsara'),
      // diagnóstico HOS a la vista: cuántos drivers reportó Samsara, cuántos se
      // emparejaron a un truck, y el error exacto si el token no tiene permiso
      last_sync_hos: metaGet('last_sync_hos'),
      samsara_summary: (() => { try { return JSON.parse(metaGet('last_sync_samsara_summary') || 'null'); } catch (e) { return null; } })(),
      hos_trucks: get(`SELECT COUNT(*) AS n FROM trucks WHERE hos_at != '' AND hos_at IS NOT NULL`).n
    });
  });

  // ---------- static frontend ----------
  // el HTML nunca se cachea (cada deploy llega al instante al cel); los iconos sí
  router.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else if (/\.(png|webmanifest)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }));

  return router;
}

module.exports = { createRouter };
