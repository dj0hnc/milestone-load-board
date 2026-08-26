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
const { todayCT, weekDatesCT, daysBetween, normNum, canonArea, canonicalTruckNumber, shortTrailer } = require('./util');
const { syncRoster, syncActivity, syncAssignments, scanRipRap, reconcileICs } = require('./sync-newmile');
const { syncSamsara, syncHOS, syncHOSDaily, syncWorkTimes, backfillParking, locateTruck, debugHOS, auditHOS, refreshHOSTruck, cameraSnapshot, cameraCheck } = require('./sync-samsara');
const { logChange, snapshotTruckDay, historyOf, daySnapshots } = require('./history');

const VALID_STATUS = ['ok', 'shop', 'down', 'no_driver', 'vacation', 'deleased'];
const EDITABLE = ['note', 'status', 'status_note', 'return_date', 'rest_days', 'area', 'division', 'rip_rap', 'star', 'phone', 'tags', 'driver', 'trailer_type', 'trailer_type2'];

function createRouter({ config, newmile, log }) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' })); // Miley: conversaciones con tool_results crecen >100kb
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
  const OPEN_PATHS = ['/api/login', '/api/health', '/api/states', '/api/board-status', '/api/board-note', '/api/board-calls', '/api/sync-assignments', '/api/recruit/import', '/api/recruit/pending', '/api/recruit/pending/ack', '/login.html', '/manifest.webmanifest', '/icon-180.png', '/icon-192.png', '/icon-512.png'];
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

  // ---------- 🪪 IDENTIDAD vía el login NewMile del BOARD (2026-08-24) ----------
  // El usuario ya inició sesión de NewMile en el board (per-session). Como board y tracker
  // comparten dominio, su cookie llega aquí también — se la reenviamos al board (localhost)
  // y él nos dice QUIÉN es. Cache 5 min por cookie. Sin secretos compartidos: el board manda.
  const _idCache = new Map();
  async function identityOf(req) {
    try {
      const ck = String(req.headers.cookie || ''); if (!ck) return null;
      const h = crypto.createHash('sha1').update(ck).digest('hex');
      const c = _idCache.get(h); if (c && Date.now() - c.at < 5 * 60000) return c.name;
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch('http://127.0.0.1:8090/api/whoami', { headers: { cookie: ck }, signal: ctl.signal });
      clearTimeout(to);
      const j = r.ok ? await r.json() : null;
      const name = (j && j.connected && j.name) ? String(j.name).slice(0, 40) : null;
      _idCache.set(h, { at: Date.now(), name });
      if (_idCache.size > 200) _idCache.clear();
      return name;
    } catch (e) { return null; }
  }

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
  router.get('/api/board', async (req, res) => {
    const identity = await identityOf(req);   // 🪪 quién es este navegador (login NewMile del board)
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
    for (const r of all(`SELECT org_id, number, SUM(loads) AS n, SUM(revenue) AS rev FROM activity_log
                         WHERE load_date >= ? AND load_date <= ? GROUP BY org_id, number`, wkFrom, wkTo)) {
      wkMap.set(r.org_id + '|' + r.number, r);
    }
    // 💰 dinero del DÍA VISTO por truck (freight_rate_extended sumado por el sync) — Tony
    const dayRevMap = new Map();
    for (const r of all('SELECT org_id, number, revenue FROM activity_log WHERE load_date = ?', date)) {
      dayRevMap.set(r.org_id + '|' + r.number, r.revenue || 0);
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

    // 📞 última entrada de la bitácora por troca — se enseña al pie del chip
    const lastCallMap = new Map();
    for (const r of all(`SELECT c.org_id, c.number, c.ts, c.author, c.kind, c.text FROM calls c
                         JOIN (SELECT org_id, number, MAX(id) AS mid FROM calls GROUP BY org_id, number) m
                           ON m.org_id = c.org_id AND m.number = c.number AND m.mid = c.id`)) {
      lastCallMap.set(r.org_id + '|' + r.number, { ts: r.ts, author: r.author, kind: r.kind, text: r.text });
    }
    // 📝 cuántas entradas acumula cada troca (bitácora) — el chip enseña el contador
    const callCountMap = new Map();
    for (const r of all('SELECT org_id, number, COUNT(*) AS n FROM calls GROUP BY org_id, number')) {
      callCountMap.set(r.org_id + '|' + r.number, r.n);
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
        nm_load_status: s ? (s.nm_load_status || '') : '',
        nm_dest: s && s.nm_info ? (() => { try { return JSON.parse(s.nm_info); } catch (e) { return []; } })() : [],
        hos_worked: t.samsara_driver_id ? (hosDayMap.get(String(t.samsara_driver_id)) || null) : null,
        hos_worked_wk_ms: t.samsara_driver_id ? (hosWkMap.get(String(t.samsara_driver_id)) || null) : null,
        work_day: workMap.get(t.org_id + '|' + t.number) || null,
        loads_week: (wkMap.get(t.org_id + '|' + t.number) || {}).n || 0,
        rev_week: Math.round(((wkMap.get(t.org_id + '|' + t.number) || {}).rev || 0) * 100) / 100,
        rev_day: Math.round((dayRevMap.get(t.org_id + '|' + t.number) || 0) * 100) / 100,
        down_since: !s && (carryMap.get(t.org_id + '|' + t.number) || {}).state === 'd' ? carryMap.get(t.org_id + '|' + t.number).date : null,
        state_by: s ? s.marked_by : null,
        time_off: offMap.get(t.org_id + '|' + t.number) || [],
        days_since_last_load: t.last_load_date ? daysBetween(t.last_load_date, today) : null,
        driver_changed_recent: driverChangedRecent ? { prev: t.driver_prev, at: t.driver_changed_at } : null,
        last_call: lastCallMap.get(t.org_id + '|' + t.number) || null,
        calls_count: callCountMap.get(t.org_id + '|' + t.number) || 0
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
      // 🚛 barra de números del día — TODAS las orgs sin importar el tab, misma división en
      // flotillas que los reportes AM/PM del board: CACTUS / KT (número trae "KT") / CKJ
      // (resto de la flota KT) / SUBHAULERS (is_sub). working = marcados cubiertos ese día.
      working: (() => {
        const w = { total: 0, CACTUS: 0, KT: 0, CKJ: 0, SUBHAULERS: 0, x: 0, nw: 0 };
        const rows = all(`SELECT t.org_id, t.number, t.is_sub, s.state FROM trucks t
                          JOIN orgs o ON o.id = t.org_id
                          JOIN dispatch_state s ON s.org_id = t.org_id AND s.number = t.number AND s.date = ?
                          WHERE o.enabled = 1 AND t.archived = 0`, date);
        for (const r of rows) {
          if (r.state === 'n') { w.nw++; continue; }
          if (r.state === 'd') { w.x++; continue; }
          if (r.state !== 'a') continue;
          w.total++;
          const num = String(r.number || '').toUpperCase();
          let b;
          if (r.org_id === 'KT') b = num.indexOf('KT') >= 0 ? 'KT' : (num.indexOf('CKJ') === 0 ? 'CKJ' : (r.is_sub ? 'SUBHAULERS' : 'CKJ'));
          else b = r.is_sub ? 'SUBHAULERS' : 'CACTUS';
          w[b]++;
        }
        return w;
      })(),
      identity: identity,   // 🪪 nombre real (NewMile) — el front firma notas/marcas con él
      recruitAllowed: recruitAllowed(identity),   // 🔒 el botón RECRUIT solo se enseña a Juan/Tony
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !org || !number || !['p', 'a', 'd', 'n'].includes(state)) {
      return res.status(400).json({ error: 'body: {date ISO, org, number, state p|a|d|n}' });
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
  // 🔁 ESPEJO tracker → board (2026-08-26): la disponibilidad es UN solo switch compartido.
  // Un cambio de status AQUÍ prende/apaga la MISMA bandera 🚩 del board al instante
  // (localhost, canal abierto /api/truck-notes/set). fromTracker:1 corta el eco — el board
  // NO re-espeja de regreso. Fire-and-forget: nunca bloquea ni rompe el guardado local.
  function mirrorStatusToBoard(t, status, reason, by) {
    try {
      const num = String((t && (t.display_number || t.number)) || '').trim();
      if (!num) return;
      const st = status === 'ok' ? 'ok' : (status === 'shop' ? 'shop' : 'off');
      fetch('http://127.0.0.1:8090/api/truck-notes/set', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          num, status: st,
          reason: st === 'ok' ? '' : String(reason || status || '').slice(0, 300),
          by: String(by || 'tracker').slice(0, 60), fromTracker: 1
        })
      }).catch(() => {});
    } catch (e) { /* board caído → el feed de states lo empareja después */ }
  }

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
    // el switch de disponibilidad cambió aquí → misma bandera al board, al instante
    if ('status' in (req.body || {}) && updated.status !== row.status) {
      mirrorStatusToBoard(updated, updated.status, updated.status_note, by || 'tracker');
    }
    res.json({ ok: true, truck: updated });
  });

  // RECONCILIAR ICs: /api/ics/reconcile?dry=1 enseña qué falta; sin dry los crea/revive.
  router.get('/api/ics/reconcile', async (req, res) => {
    if (!newmile) return res.status(503).json({ error: 'NewMile not configured' });
    try {
      if (!newmile.connected && !(await newmile.resume())) return res.status(401).json({ error: 'NOT_CONNECTED' });
      res.json(await reconcileICs(newmile, { dry: req.query.dry === '1' }));
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // BUSCADOR TOTAL: /api/find?q=ramirez busca en TODA la flota (archivados incluidos)
  // por número, display, driver o dueño — dice dónde vive cada uno y por qué no se ve.
  router.get('/api/find', (req, res) => {
    const q = '%' + String(req.query.q || '').trim() + '%';
    if (q === '%%') return res.status(400).json({ error: 'use ?q=texto' });
    const rows = all(
      `SELECT org_id, number, display_number, division, area, driver, owner_name, is_sub, is_new, archived, status, last_load_date
       FROM trucks
       WHERE number LIKE ? OR display_number LIKE ? OR driver LIKE ? OR owner_name LIKE ?
       ORDER BY archived, org_id, number LIMIT 80`, q, q, q, q);
    res.json({
      found: rows.length,
      trucks: rows.map(t => ({
        truck: t.display_number || t.number, org: t.org_id, division: t.division, area: t.area,
        driver: t.driver || '', owner: t.owner_name || '', sub: !!t.is_sub,
        status: t.status, last_load: t.last_load_date || null,
        visible: t.archived ? 'NO — ARCHIVED (restore below)' : 'yes',
        restore: t.archived ? `/cactus-tracker/api/truck/${t.org_id}/${encodeURIComponent(t.number)}/restore?yes=1` : undefined
      }))
    });
  });

  // ➕ ALTA MANUAL: agregar un truck nuevo al board AL MOMENTO (o revivir uno archivado).
  // Busca en NewMile por número para traer chofer/traila/dueño de una; sin sesión de
  // NewMile lo crea pelón y el roster de las 4:30 le completa los datos después.
  router.post('/api/truck/create', async (req, res) => {
    const { org, number, division, by } = req.body || {};
    const orgId = normNum(org), num = normNum(number);
    if (!orgId || !num) return res.status(400).json({ error: 'org and number required' });
    if (!get('SELECT id FROM orgs WHERE id = ?', orgId)) return res.status(404).json({ error: 'unknown org: ' + orgId });
    const div = division ? normNum(division) : null;
    if (div && !get('SELECT 1 AS x FROM divisions WHERE org_id = ? AND id = ?', orgId, div)) {
      return res.status(400).json({ error: 'unknown division ' + div + ' for ' + orgId });
    }
    const existing = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, num);
    if (existing) {
      run(`UPDATE trucks SET archived = 0, maybe_removed = 0, is_new = 0${div ? ', division = ?' : ''}, updated_at = ? WHERE org_id = ? AND number = ?`,
        ...(div ? [div] : []), nowISO(), orgId, num);
      logChange(orgId, num, 'restored', '', 'added back via ➕' + (existing.archived ? ' (was archived)' : ''), by || 'web');
      return res.json({ ok: true, restored: true, truck: existing.display_number || num, was_archived: !!existing.archived });
    }
    let nm = null;
    try {
      if (newmile && (newmile.connected || await newmile.resume())) {
        const hits = await newmile.findTrucks(num);
        nm = (hits || []).find(t => normNum(String(t.truck_number || '')) === num) || null;
      }
    } catch (e) { /* NewMile sin sesión: alta pelona */ }
    const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
    run(`INSERT INTO trucks (org_id, number, display_number, division, driver, trailer_type, owner_name, nm_truck_id, is_new, status, updated_at)
         VALUES (?,?,?,?,?,?,?,?,0,'ok',?)`,
      orgId, num, nm ? clean(nm.truck_number) : '', div, nm ? clean(nm.driver_name) : '',
      nm ? shortTrailer(nm.truck_type || '') : '', nm ? clean(nm.owner_name) : '',
      nm && nm.id != null ? nm.id : null, nowISO());
    logChange(orgId, num, 'created', '', 'added via ➕' + (nm ? ` (NewMile: ${clean(nm.driver_name) || 'no driver'} · ${clean(nm.fleet_name)})` : ' (not found in NewMile yet)'), by || 'web');
    res.json({ ok: true, created: true, truck: num, newmile: nm ? { driver: clean(nm.driver_name), type: nm.truck_type || '', owner: clean(nm.owner_name), fleet: clean(nm.fleet_name) } : null });
  });

  // ---------- CANAL DE LECTURA para el load board ----------
  // Estados del tracker (down/shop/vacaciones/X del día/notas) en JSON de SOLO lectura,
  // sin PIN pero con llave dedicada. La llave se genera UNA vez en esta máquina y vive
  // en la DB local — nunca en el repo (que es público). Juan la ve en /api/states-key.
  let statesKey = metaGet('states_key', '');
  if (!statesKey) { statesKey = crypto.randomBytes(24).toString('hex'); metaSet('states_key', statesKey); }

  router.get('/api/states', (req, res) => {
    if (String(req.query.key || '') !== statesKey) return res.status(401).json({ error: 'bad key' });
    const today = todayCT();
    const trucks = all(`SELECT t.org_id, t.number, t.display_number, t.division, t.driver, t.status, t.status_note,
                               t.note, t.return_date, t.rest_days, t.updated_at,
                               t.hos_drive_ms, t.hos_cycle_ms, t.hos_at
                        FROM trucks t JOIN orgs o ON o.id = t.org_id WHERE o.enabled = 1 AND t.archived = 0`);
    const states = new Map(all('SELECT org_id, number, state FROM dispatch_state WHERE date = ?', today)
      .map(r => [r.org_id + '|' + r.number, r.state]));
    // 💰 dinero freight de HOY y de la SEMANA (Lun-Sáb) por troke — para los chips del board
    const wk = weekDatesCT(today);
    const revs = new Map();
    for (const r of all(`SELECT org_id, number,
                                ROUND(SUM(CASE WHEN load_date = ? THEN revenue ELSE 0 END), 0) AS rd,
                                ROUND(SUM(revenue), 0) AS rw
                         FROM activity_log WHERE load_date >= ? AND load_date <= ? GROUP BY org_id, number`, today, wk.Mon, wk.Sat)) {
      revs.set(r.org_id + '|' + r.number, { rd: r.rd || 0, rw: r.rw || 0 });
    }
    const offs = new Map();
    for (const o of all('SELECT org_id, number, from_date, to_date, reason FROM time_off WHERE from_date <= ? AND to_date >= ?', today, today)) {
      offs.set(o.org_id + '|' + o.number, `${o.reason} ${o.from_date}→${o.to_date}`);
    }
    // contrato pedido por el board: mapa plano {"1096":{status,note,...}} + _meta aparte
    const out = { _meta: { date: today, count: trucks.length, generatedAt: nowISO() } };
    for (const t of trucks) {
      const k0 = t.display_number || t.number;
      const key = out[k0] ? t.org_id + ':' + k0 : k0; // número repetido entre orgs → prefijo
      const st = states.get(t.org_id + '|' + t.number) || null;
      out[key] = {
        org: t.org_id, division: t.division, driver: t.driver || '',
        status: t.status, note: [t.status_note, t.note].filter(Boolean).join(' · '),
        returnDate: t.return_date || '', restDays: t.rest_days || '',
        timeOff: offs.get(t.org_id + '|' + t.number) || null,
        todayState: st === 'a' ? 'assigned' : st === 'd' ? 'x' : st === 'n' ? 'nowork' : st === 'p' ? 'pending' : null,
        updatedAt: t.updated_at || null,
        // ⏱ HOS frescas (<20h) + 💰 freight hoy/semana — el board las pinta en sus chips
        hosLeftMs: (t.hos_at && (Date.now() - Date.parse(t.hos_at)) < 20 * 3600e3) ? (t.hos_drive_ms != null ? t.hos_drive_ms : null) : null,
        hosCycleMs: (t.hos_at && (Date.now() - Date.parse(t.hos_at)) < 20 * 3600e3) ? (t.hos_cycle_ms != null ? t.hos_cycle_ms : null) : null,
        revDay: (revs.get(t.org_id + '|' + t.number) || {}).rd || 0,
        revWeek: (revs.get(t.org_id + '|' + t.number) || {}).rw || 0
      };
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(out);
  });

  // La llave del canal — SOLO detrás del PIN. Juan la copia y se la pasa al board.
  // ⚡ CARRIL INSTANTÁNEO (2026-08-26): el board avisa "acabo de push-ear a NewMile" y el
  // tracker corre su sync SOLO-asignaciones YA (en vez de esperar el carril de 3 min).
  // Canal de máquinas (states-key), con candado anti-ráfaga de 5 s.
  let _asgPokeAt = 0, _asgPokeBusy = false;
  router.post('/api/sync-assignments', async (req, res) => {
    if (String((req.query || {}).key || (req.body || {}).key || '') !== statesKey) return res.status(401).json({ error: 'bad key' });
    if (!newmile) return res.status(503).json({ error: 'NewMile not configured' });
    if (_asgPokeBusy || Date.now() - _asgPokeAt < 5000) return res.json({ ok: true, debounced: true });
    _asgPokeAt = Date.now(); _asgPokeBusy = true;
    try {
      if (!newmile.connected && !(await newmile.resume())) return res.status(401).json({ error: 'NOT_CONNECTED' });
      res.json({ ok: true, summary: await syncAssignments(newmile) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
    finally { _asgPokeBusy = false; }
  });

  router.get('/api/states-key', (req, res) => {
    res.json({
      key: statesKey,
      url: (req.baseUrl || '/cactus-tracker') + '/api/states?key=' + statesKey,
      note: 'read-only feed for the office board — share the key only with it'
    });
  });

  // ¿Y ESTOS dónde andan? Para las listas de Tony: de cada número dice si está activo
  // (y en qué tab), BORRADO (archivado), en revisión ⚑ NUEVO, o si no existe.
  router.post('/api/find/bulk', (req, res) => {
    const nums = [...new Set(((req.body || {}).numbers || []).map(normNum).filter(Boolean))].slice(0, 60);
    const out = [];
    for (const n of nums) {
      const rows = all(`SELECT org_id, number, display_number, division, status, driver, archived, is_new, is_sub, last_load_date
                        FROM trucks WHERE number = ? OR display_number = ?`, n, n);
      if (!rows.length) { out.push({ number: n, found: false }); continue; }
      for (const t of rows) out.push({
        number: n, found: true, org: t.org_id, division: t.division, status: t.status,
        driver: t.driver || '', archived: !!t.archived, is_new: !!t.is_new, sub: !!t.is_sub,
        last_load: t.last_load_date || null, real_number: t.number
      });
    }
    res.json({ results: out });
  });

  // Restaurar un archivado desde el navegador del cel (GET a propósito, con ?yes=1)
  router.get('/api/truck/:org/:number/restore', (req, res) => {
    if (req.query.yes !== '1') return res.status(400).json({ error: 'add ?yes=1 to confirm' });
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, number);
    if (!row) return res.status(404).json({ error: 'truck not found' });
    run(`UPDATE trucks SET archived = 0, maybe_removed = 0 WHERE org_id = ? AND number = ?`, orgId, number);
    logChange(orgId, number, 'restored', '', 'restored to board via /restore', 'web');
    res.json({ ok: true, truck: row.display_number || row.number, back_on_board: true });
  });

  // BARRIDO de toda la flota: /api/hos/audit revisa cada truck contra Samsara, amarra
  // los ids que pueda (asignación del vehículo o nombre único) y lista los que no con
  // su razón exacta. Correr después de cambios de drivers o cuando falten relojes.
  router.get('/api/hos/audit', async (req, res) => {
    try { res.json(await auditHOS(config)); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
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
      // recuerda hasta qué carga vi: el scan solo vuelve a proponer si hay cargas rip NUEVAS
      let last = '';
      try { last = JSON.parse(row.rip_evidence || '{}').last || ''; } catch (e) { /* evidencia vieja ilegible */ }
      run(`UPDATE trucks SET rip_suggested = 0, rip_dismissed_last = ? WHERE org_id = ? AND number = ?`,
        last || nowISO().slice(0, 10), orgId, number);
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
      run(`UPDATE trucks SET area = ?, suggested_area = '', suggested_area_dismissed = '', updated_at = ? WHERE org_id = ? AND number = ?`,
        dest, nowISO(), orgId, number);
      logChange(orgId, number, 'area', row.area, dest, by);
      snapshotTruckDay(get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, number));
    } else {
      // recuerda EL VALOR descartado: el GPS no vuelve a proponer esa misma área
      run(`UPDATE trucks SET suggested_area = '', suggested_area_dismissed = ? WHERE org_id = ? AND number = ?`,
        row.suggested_area || '', orgId, number);
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

  // 📞 BITÁCORA — el registro de llamadas/notas por troca (autor + hora). Cualquiera que
  // hable con el chofer lo anota; todos ven el hilo completo en el modal 📞 del chip.
  router.get('/api/truck/:org/:number/calls', (req, res) => {
    const t = get('SELECT org_id, number FROM trucks WHERE org_id = ? AND number = ?', req.params.org, req.params.number);
    if (!t) return res.status(404).json({ error: 'truck not found' });
    res.json({
      ok: true,
      calls: all('SELECT id, ts, author, kind, text FROM calls WHERE org_id = ? AND number = ? ORDER BY id DESC LIMIT 200', t.org_id, t.number)
    });
  });
  router.post('/api/truck/:org/:number/calls', (req, res) => {
    const t = get('SELECT org_id, number FROM trucks WHERE org_id = ? AND number = ?', req.params.org, req.params.number);
    if (!t) return res.status(404).json({ error: 'truck not found' });
    const b = req.body || {};
    const text = String(b.text || '').trim().slice(0, 500);
    const author = String(b.author || '').trim().slice(0, 40);
    if (!text) return res.status(400).json({ error: 'text required' });
    const ts = nowISO();
    const kind = b.kind === 'note' ? 'note' : 'call';
    run('INSERT INTO calls (ts, org_id, number, author, kind, text) VALUES (?,?,?,?,?,?)', ts, t.org_id, t.number, author, kind, text);
    res.json({ ok: true, call: { ts, author, kind, text } });
  });

  // 🔒 gate de identidad para TODAS las APIs de recruit (menos los canales de máquina con
  // states-key). Registrado ANTES de las rutas — Express respeta el orden. Funciones
  // recruitAllowed/identityOf declaradas más abajo (hoisting de function declarations).
  router.use('/api/recruit', async (req, res, next) => {
    const p = req.path;
    if (p === '/import' || p === '/pending' || p === '/pending/ack') return next();
    if (recruitAllowed(await identityOf(req))) return next();
    res.status(403).json({ error: 'restricted', hint: 'Recruiting is Juan & Tony only — sign in to NewMile on the Board' });
  });

  // ---------- 🤝 RECRUITING (HubSpot Subhauler pipeline — Juan's onboarding cockpit) ----------
  // The tracker keeps a local mirror of the recruitment deals so the page is instant and
  // Juan's own layer (checklist, follow-ups, notes) lives HERE, not in HubSpot. The mirror
  // arrives through /api/recruit/import (below), pushed from the laptop.
  router.get('/api/recruit/board', async (req, res) => {
    const identity = await identityOf(req);
    const recruits = all('SELECT * FROM recruits ORDER BY hs_modified DESC');
    const pend = all('SELECT deal_id, to_label, ts FROM recruit_moves WHERE applied = 0');
    const pendMap = {};
    for (const p of pend) pendMap[p.deal_id] = p;
    const steps = all('SELECT deal_id, step, done, by, ts FROM recruit_steps WHERE done = 1');
    const notes = all(`SELECT n.deal_id, n.ts, n.author, n.kind, n.text FROM recruit_notes n
                       JOIN (SELECT deal_id, MAX(id) mid FROM recruit_notes GROUP BY deal_id) l
                       ON n.deal_id = l.deal_id AND n.id = l.mid`);
    const counts = all('SELECT deal_id, COUNT(*) c FROM recruit_notes GROUP BY deal_id');
    const stepMap = {}, noteMap = {}, countMap = {};
    for (const s of steps) (stepMap[s.deal_id] = stepMap[s.deal_id] || {})[s.step] = { by: s.by, ts: s.ts };
    for (const n of notes) noteMap[n.deal_id] = n;
    for (const c of counts) countMap[c.deal_id] = c.c;
    for (const r of recruits) { r.steps = stepMap[r.deal_id] || {}; r.last_note = noteMap[r.deal_id] || null; r.notes_count = countMap[r.deal_id] || 0; r.pending_move = pendMap[r.deal_id] || null; }
    res.json({ ok: true, recruits, identity, synced_at: metaGet('recruit_synced_at', '') });
  });

  // Import/refresh the mirror. OPEN (no PIN) but guarded by the states key — this is how
  // the laptop pushes fresh HubSpot data without a session. Upsert: HubSpot fields update,
  // Juan's local layer (steps/notes/local_status/next_follow) is never touched; stage_since
  // moves only when the stage actually changed.
  router.post('/api/recruit/import', (req, res) => {
    if (String((req.query || {}).key || (req.body || {}).key || '') !== statesKey) return res.status(401).json({ error: 'bad key' });
    const list = (req.body || {}).recruits;
    if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'recruits[] required' });
    const ts = nowISO();
    let created = 0, updated = 0;
    for (const d of list) {
      const id = String(d.deal_id || '').trim();
      if (!id) continue;
      const prev = get('SELECT deal_id, stage FROM recruits WHERE deal_id = ?', id);
      // HubSpot knows the REAL stage-entry date (hs_v2_date_entered_current_stage) — when the
      // import carries it, it wins; otherwise fall back to "first time we saw this stage".
      const since = String(d.stage_since || '') || ((!prev || prev.stage !== String(d.stage || '')) ? ts : null);
      if (prev) {
        run(`UPDATE recruits SET pipeline=?, stage=?, stage_label=?, company=?, contact=?,
             phone=CASE WHEN ?<>'' THEN ? ELSE phone END, email=CASE WHEN ?<>'' THEN ? ELSE email END,
             hs_owner=?, trucks=?, truck_type=?, lead_source=?, hs_contacts=?, hs_modified=?, synced_at=?${since ? ', stage_since=?' : ''} WHERE deal_id=?`,
          ...[String(d.pipeline || ''), String(d.stage || ''), String(d.stage_label || ''), String(d.company || '').slice(0, 80), String(d.contact || '').slice(0, 60),
            String(d.phone || ''), String(d.phone || ''), String(d.email || ''), String(d.email || ''),
            String(d.hs_owner || ''), String(d.trucks || ''), String(d.truck_type || ''), String(d.lead_source || ''), String(d.hs_contacts || ''),
            String(d.hs_modified || ''), ts, ...(since ? [since] : []), id]);
        updated++;
      } else {
        run(`INSERT INTO recruits (deal_id, pipeline, stage, stage_label, company, contact, phone, email, hs_owner, trucks, truck_type, lead_source, hs_contacts, hs_modified, stage_since, synced_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          id, String(d.pipeline || ''), String(d.stage || ''), String(d.stage_label || ''), String(d.company || '').slice(0, 80), String(d.contact || '').slice(0, 60),
          String(d.phone || ''), String(d.email || ''), String(d.hs_owner || ''), String(d.trucks || ''), String(d.truck_type || ''), String(d.lead_source || ''), String(d.hs_contacts || ''),
          String(d.hs_modified || ''), ts, ts);
        created++;
      }
    }
    metaSet('recruit_synced_at', ts);
    say(`recruit import: ${created} new, ${updated} updated`);
    res.json({ ok: true, created, updated });
  });

  // Checklist toggle — idempotent, safe to retry from the yard.
  router.post('/api/recruit/:dealId/step', (req, res) => {
    const r = get('SELECT deal_id FROM recruits WHERE deal_id = ?', req.params.dealId);
    if (!r) return res.status(404).json({ error: 'recruit not found' });
    const b = req.body || {};
    const step = String(b.step || '');
    if (!['org', 'trucks', 'users', 'drivers', 'admins', 'firstload'].includes(step)) return res.status(400).json({ error: 'bad step' });
    if (b.done) run('INSERT OR REPLACE INTO recruit_steps (deal_id, step, done, by, ts) VALUES (?,?,1,?,?)', r.deal_id, step, String(b.by || '').slice(0, 40), nowISO());
    else run('DELETE FROM recruit_steps WHERE deal_id = ? AND step = ?', r.deal_id, step);
    res.json({ ok: true });
  });

  // Move a deal to another pipeline stage. The page reflects it INSTANTLY (local truth);
  // the move is queued for HubSpot and shows as "HS pending" until the laptop applies it
  // through the HubSpot connector and acks. One pending move per deal (a newer one wins).
  router.post('/api/recruit/:dealId/move', (req, res) => {
    const r = get('SELECT deal_id, stage, stage_label FROM recruits WHERE deal_id = ?', req.params.dealId);
    if (!r) return res.status(404).json({ error: 'recruit not found' });
    const b = req.body || {};
    const toStage = String(b.to_stage || '').trim(), toLabel = String(b.to_label || '').trim();
    if (!/^\d{6,}$/.test(toStage)) return res.status(400).json({ error: 'bad stage' });
    if (toStage === r.stage) return res.json({ ok: true, noop: true });
    const ts = nowISO();
    run('DELETE FROM recruit_moves WHERE deal_id = ? AND applied = 0', r.deal_id);
    run('INSERT INTO recruit_moves (ts, deal_id, to_stage, to_label, moved_by) VALUES (?,?,?,?,?)', ts, r.deal_id, toStage, toLabel, String(b.by || '').slice(0, 40));
    run('UPDATE recruits SET stage = ?, stage_label = ?, stage_since = ? WHERE deal_id = ?', toStage, toLabel, ts, r.deal_id);
    say(`recruit move: ${r.deal_id} → ${toLabel || toStage} (queued for HubSpot)`);
    res.json({ ok: true });
  });

  // The HubSpot write-back queue (states-key guarded, no PIN — the laptop drains it).
  router.get('/api/recruit/pending', (req, res) => {
    if (String((req.query || {}).key || '') !== statesKey) return res.status(401).json({ error: 'bad key' });
    res.json({ ok: true, moves: all('SELECT m.id, m.ts, m.deal_id, m.to_stage, m.to_label, m.moved_by, r.company FROM recruit_moves m LEFT JOIN recruits r ON r.deal_id = m.deal_id WHERE m.applied = 0 ORDER BY m.id') });
  });
  router.post('/api/recruit/pending/ack', (req, res) => {
    if (String((req.query || {}).key || (req.body || {}).key || '') !== statesKey) return res.status(401).json({ error: 'bad key' });
    const ids = ((req.body || {}).ids || []).map(Number).filter(n => n > 0);
    if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
    const ts = nowISO();
    for (const id of ids) run('UPDATE recruit_moves SET applied = 1, applied_at = ? WHERE id = ?', ts, id);
    res.json({ ok: true, acked: ids.length });
  });

  // Juan's local fields: follow-up date, graduated/paused flag, phone/email corrections.
  router.post('/api/recruit/:dealId/set', (req, res) => {
    const r = get('SELECT deal_id FROM recruits WHERE deal_id = ?', req.params.dealId);
    if (!r) return res.status(404).json({ error: 'recruit not found' });
    const b = req.body || {};
    for (const f of ['local_status', 'next_follow', 'phone', 'email']) {
      if (b[f] !== undefined) run(`UPDATE recruits SET ${f} = ? WHERE deal_id = ?`, String(b[f]).slice(0, 80), r.deal_id);
    }
    res.json({ ok: true });
  });

  // Follow-up notes — same thread pattern as the truck call log.
  router.get('/api/recruit/:dealId/notes', (req, res) => {
    res.json({ ok: true, notes: all('SELECT id, ts, author, kind, text FROM recruit_notes WHERE deal_id = ? ORDER BY id DESC LIMIT 200', req.params.dealId) });
  });
  router.post('/api/recruit/:dealId/notes', (req, res) => {
    const r = get('SELECT deal_id FROM recruits WHERE deal_id = ?', req.params.dealId);
    if (!r) return res.status(404).json({ error: 'recruit not found' });
    const b = req.body || {};
    const text = String(b.text || '').trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: 'text required' });
    const ts = nowISO();
    const kind = b.kind === 'note' ? 'note' : 'call';
    run('INSERT INTO recruit_notes (ts, deal_id, author, kind, text) VALUES (?,?,?,?,?)', ts, r.deal_id, String(b.author || '').slice(0, 40), kind, text);
    res.json({ ok: true, note: { ts, author: b.author, kind, text } });
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

  // ¿ya subió la foto? El front pregunta cada 5 s con el id del retrieval (sin bloquear).
  router.get('/api/truck/:org/:number/camera/:rid', async (req, res) => {
    const t = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', normNum(req.params.org), normNum(req.params.number));
    if (!t) return res.status(404).json({ error: 'truck not found' });
    try { res.json({ ok: true, ...(await cameraCheck(config, t, req.params.rid)) }); }
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
    // "keep" = yo sé que sigue activo: el sweep del roster no re-avisa por 21 días
    const r = run(`UPDATE trucks SET maybe_removed = 0, archived = ?, baja_dismissed_at = ?, updated_at = ? WHERE org_id = ? AND number = ?`,
      action === 'archive' ? 1 : 0, action === 'keep' ? nowISO() : '', nowISO(), orgId, number);
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
      // el nombre en Samsara/NewMile sigue diciendo lo mismo: recordar el texto para no reproponerlo
      run(`UPDATE trucks SET status = ?, status_note = ?, ${col} = '', ${col}_dismissed = ?, updated_at = ? WHERE org_id = ? AND number = ?`,
        status, flag, flag, nowISO(), orgId, number);
      if (status !== row.status) mirrorStatusToBoard(row, status, flag, 'tracker flag'); // switch → board
    } else {
      run(`UPDATE trucks SET ${col} = '', ${col}_dismissed = ?, updated_at = ? WHERE org_id = ? AND number = ?`, flag, nowISO(), orgId, number);
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
      // SECUENCIA elegida (opcional): coloca SOLO la asignación nueva en la corrida pedida del
      // troke (1 = primera). Mismo patrón seguro del board (placeNew): las filas existentes
      // conservan su orden relativo, nada más se inserta la nueva en su lugar. Solo aplica en
      // asignación de UN troke; filas ya con cargas no se mueven (no cuentan para la posición).
      let placedAt = null;
      const position = Number((req.body || {}).position) || 0;
      if (position > 0 && confirmed && created.length === 1 && entries.length === 1) {
        try {
          const tid = entries[0].truck_id, newAid = Number(created[0].id);
          const REO = ['pending', 'draft', 'active', 'missing_driver', 'pending_removal'];
          let rows = [];
          for (const st of REO) {
            const r2 = await newmile.callTool('list_resources', { resource_type: 'order_assignment', filters: { truck_id: tid, assignment_status: st, page_size: 100 } });
            rows = rows.concat((r2 && (r2.order_assignments || r2.results || r2.rows)) || []);
          }
          const ro = rows.filter(r => (r.load_count || 0) === 0 && REO.indexOf(String(r.assignment_status || '').toLowerCase()) >= 0)
            .sort((a, b) => ((a.ordinal || 0) - (b.ordinal || 0)));
          const newRow = ro.find(r => Number(r.id) === newAid);
          const olds = ro.filter(r => Number(r.id) !== newAid);
          if (newRow && olds.length) {
            const idx = Math.min(Math.max(position - 1, 0), olds.length);
            const res2 = olds.slice(); res2.splice(idx, 0, newRow);
            const newIds = res2.map(r => r.id), curIds = ro.map(r => r.id);
            if (newIds.join(',') !== curIds.join(',')) {
              await newmile.callUtility('reorder_assignments', { truck_id: tid, assignment_ids: newIds });
              placedAt = position;
              say(`assign: ${entries[0]._row.number} colocado como corrida #${position} (order ${order_id})`);
            } else placedAt = position; // ya estaba donde se pidió
          }
        } catch (e) { warnings = (warnings || []).concat(['sequence placement failed (assignment created OK): ' + (e.message || e)]); }
      }
      delete ordersCache[day];
      res.json({ ok: true, pushed: created.length || entries.length, confirmed, warnings, failed, placedAt });
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

  // ---------- BOARD → TRACKER status mirror ----------
  // El Load Board escribe aquí cuando el dispatcher marca un troke shop/off/ok, para que la MISMA
  // info viva en el tracker (el tracker→board ya funciona por el feed /states). Open + states-key
  // (como el import de recruiting). Mapea: board off→down, shop→shop, ok→ok. Sin loop: el board
  // solo LEE los estados del tracker, nunca al revés desde un estado nacido en el tracker.
  router.post('/api/board-status', (req, res) => {
    if (String((req.query || {}).key || (req.body || {}).key || '') !== statesKey) return res.status(401).json({ error: 'bad key' });
    const b = req.body || {};
    const num = normNum(b.number || b.num);
    if (!num) return res.status(400).json({ error: 'number required' });
    const bs = String(b.status || 'ok').toLowerCase();
    const status = bs === 'shop' ? 'shop' : (bs === 'off' || bs === 'down') ? 'down' : 'ok';
    // encontrar el troke por número O display (el board manda el número del chip, sin org)
    const row = get('SELECT org_id, number, status FROM trucks WHERE (UPPER(number) = UPPER(?) OR UPPER(display_number) = UPPER(?)) AND archived = 0 ORDER BY is_sub ASC LIMIT 1', num, num)
             || get('SELECT org_id, number, status FROM trucks WHERE UPPER(number) = UPPER(?) OR UPPER(display_number) = UPPER(?) LIMIT 1', num, num);
    if (!row) return res.json({ ok: true, matched: false });   // troke no está en el tracker — no es error
    if (row.status === status && !b.reason) return res.json({ ok: true, matched: true, unchanged: true });
    run('UPDATE trucks SET status = ?, status_note = CASE WHEN ? <> \'\' THEN ? ELSE status_note END, updated_at = ? WHERE org_id = ? AND number = ?',
      status, String(b.reason || ''), String(b.reason || '').slice(0, 300), nowISO(), row.org_id, row.number);
    logChange(row.org_id, row.number, 'status', row.status || '', status + (b.reason ? (' — ' + b.reason) : '') + ' (from board)', String(b.by || 'board'));
    say(`board→tracker: ${row.number} → ${status}${b.reason ? ' (' + b.reason + ')' : ''}`);
    res.json({ ok: true, matched: true, org: row.org_id, number: row.number, status });
  });

  // ---------- BITÁCORA UNIFICADA (2026-08-24): una sola historia por troke ----------
  // El board ESCRIBE sus notas aquí (board-note) y LEE la historia completa (board-calls) —
  // así una llamada anotada en cualquiera de los dos vive en la misma bitácora (tabla calls).
  // Ambos open + states-key, como el resto del canal board⇄tracker.
  router.post('/api/board-note', (req, res) => {
    if (String((req.query || {}).key || (req.body || {}).key || '') !== statesKey) return res.status(401).json({ error: 'bad key' });
    const b = req.body || {};
    const num = normNum(b.number || b.num);
    const text = String(b.text || '').trim().slice(0, 500);
    if (!num || !text) return res.status(400).json({ error: 'number + text required' });
    const row = get('SELECT org_id, number FROM trucks WHERE UPPER(number) = UPPER(?) AND archived = 0 ORDER BY is_sub ASC LIMIT 1', num)
             || get('SELECT org_id, number FROM trucks WHERE UPPER(number) = UPPER(?) LIMIT 1', num);
    if (!row) return res.json({ ok: true, matched: false });
    run('INSERT INTO calls (ts, org_id, number, author, kind, text) VALUES (?,?,?,?,?,?)',
      nowISO(), row.org_id, row.number, String(b.by || 'board').slice(0, 40), 'note', text);
    res.json({ ok: true, matched: true });
  });
  router.get('/api/board-calls', (req, res) => {
    if (String((req.query || {}).key || '') !== statesKey) return res.status(401).json({ error: 'bad key' });
    const num = normNum(req.query.number || req.query.num || '');
    if (!num) return res.status(400).json({ error: 'number required' });
    const row = get('SELECT org_id, number FROM trucks WHERE UPPER(number) = UPPER(?) AND archived = 0 ORDER BY is_sub ASC LIMIT 1', num)
             || get('SELECT org_id, number FROM trucks WHERE UPPER(number) = UPPER(?) LIMIT 1', num);
    if (!row) return res.json({ ok: true, matched: false, calls: [] });
    res.json({ ok: true, matched: true, calls: all('SELECT ts, author, kind, text FROM calls WHERE org_id = ? AND number = ? ORDER BY id DESC LIMIT 100', row.org_id, row.number) });
  });

  // 🔒 RECRUIT ES PRIVADO (Juan 2026-08-24): solo Juan y Tony, identificados por SU login de
  // NewMile en el board. Lista editable en meta `recruit_allow` (prefijos de nombre, comas).
  // Sin identidad permitida: la página pide conectarse y las APIs regresan 403. Los canales
  // de máquina (import/pending/ack) siguen con states-key, no aplican aquí.
  function recruitAllowed(identity) {
    if (!identity) return false;
    const allow = String(metaGet('recruit_allow', 'juan,tony')).toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    const id = String(identity).toLowerCase();
    return allow.some(a => id.startsWith(a) || id.includes(a));
  }
  async function recruitGatePage(req, res, next) {
    if (recruitAllowed(await identityOf(req))) return next();
    res.status(403).type('html').send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#1C2333;color:#e8ecf3;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px"><div><div style="font-size:44px">🔒</div><h2 style="margin:8px 0">Recruiting is private</h2><p style="color:#8f97ab;max-width:420px;margin:0 auto 10px">This area belongs to Juan &amp; Tony. Open the <a href="/full" style="color:#C8991F">Board</a>, sign in to NewMile with YOUR account, then come back.</p><p><a href="/cactus-tracker/" style="color:#C8991F">&#8592; Back to the tracker</a></p></div></body>');
  }
  router.get('/recruit', recruitGatePage, (req, res) => res.redirect(req.baseUrl + '/recruit.html'));
  router.get('/recruit.html', recruitGatePage, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'recruit.html')));

  // ---------- 🤖 MILEY sabor tracker (2026-08-24, "échale a todo") ----------
  // Proxy fino a Anthropic (server/ai.js). PROTEGIDO por el PIN de sesión (no está en
  // OPEN_PATHS). El agent-loop vive en el front (mismo patrón probado del board): los tools
  // de LECTURA pegan a las APIs del tracker con la cookie del usuario — recruiting incluido,
  // que ya viene gateado por identidad (un no-permitido recibe 403 y Miley lo dice tal cual).
  // Los tools de ESCRITURA siempre confirman en pantalla y firman con la identidad NewMile.
  const miley = require('./ai');
  router.post('/api/ai/chat', async (req, res) => {
    const b = req.body || {};
    if (!miley.ready()) return res.json({ error: 'Miley is asleep on this machine (no API key)' });
    const r = await miley.chat(Array.isArray(b.messages) ? b.messages : [], String(b.context || ''), Array.isArray(b.tools) ? b.tools : null);
    res.json(r);
  });
  // 🗂 HISTORIAL de Miley (Juan: "no quisiera perder mis conversaciones"): vive en el SERVER,
  // no en el teléfono — sobrevive cambios de dispositivo. Cada quien ve las suyas (por author).
  // El front auto-guarda la conversación tras cada respuesta (upsert por id).
  router.get('/api/ai/chats', (req, res) => {
    const a = String(req.query.author || '').slice(0, 40);
    if (!a) return res.json({ ok: true, chats: [] });
    res.json({ ok: true, chats: all('SELECT id, ts, title FROM ai_chats WHERE author = ? ORDER BY ts DESC LIMIT 50', a) });
  });
  router.get('/api/ai/chats/:id', (req, res) => {
    const r = get('SELECT id, ts, author, title, messages FROM ai_chats WHERE id = ?', String(req.params.id).slice(0, 60));
    if (!r) return res.status(404).json({ error: 'not found' });
    try { r.messages = JSON.parse(r.messages); } catch (e) { r.messages = []; }
    res.json({ ok: true, chat: r });
  });
  router.post('/api/ai/chats', (req, res) => {
    const b = req.body || {};
    const id = String(b.id || '').slice(0, 60), author = String(b.author || '').slice(0, 40);
    const msgs = Array.isArray(b.messages) ? b.messages : null;
    if (!id || !author || !msgs || !msgs.length) return res.status(400).json({ error: 'id + author + messages required' });
    const title = String(b.title || '').slice(0, 80);
    const json = JSON.stringify(msgs).slice(0, 400000); // tope sano: una conversación gigante no revienta la DB
    if (get('SELECT id FROM ai_chats WHERE id = ?', id)) {
      run('UPDATE ai_chats SET ts = ?, title = ?, messages = ? WHERE id = ?', nowISO(), title, json, id);
    } else {
      run('INSERT INTO ai_chats (id, ts, author, title, messages) VALUES (?,?,?,?,?)', id, nowISO(), author, title, json);
    }
    res.json({ ok: true });
  });
  router.post('/api/ai/chats/:id/delete', (req, res) => {
    run('DELETE FROM ai_chats WHERE id = ?', String(req.params.id).slice(0, 60));
    res.json({ ok: true });
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
