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
const { todayCT, weekDatesCT, daysBetween, normNum } = require('./util');
const { syncRoster, syncActivity, scanRipRap } = require('./sync-newmile');
const { syncSamsara } = require('./sync-samsara');
const { logChange, snapshotTruckDay, historyOf, daySnapshots } = require('./history');

const VALID_STATUS = ['ok', 'shop', 'down', 'no_driver', 'vacation', 'deleased'];
const EDITABLE = ['note', 'status', 'status_note', 'return_date', 'rest_days', 'area', 'division', 'rip_rap', 'phone', 'tags', 'driver', 'trailer_type'];

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
    if (last && (Date.now() - Date.parse(last)) < 20 * 60 * 1000) return false;
    syncInflight = true;
    (async () => {
      try {
        if (newmile.connected || await newmile.resume()) {
          await syncActivity(newmile);
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
    const trucks = virtual
      ? all(`SELECT t.* FROM trucks t JOIN orgs o ON o.id = t.org_id
             WHERE o.enabled = 1 AND t.archived = 0 ${orgId === 'SUBS' ? 'AND t.is_sub = 1' : ''}`)
      : all('SELECT * FROM trucks WHERE org_id = ? AND archived = 0', orgId);
    const states = virtual
      ? all('SELECT * FROM dispatch_state WHERE date = ?', date)
      : all('SELECT * FROM dispatch_state WHERE date = ? AND org_id = ?', date, orgId);
    const stMap = new Map(states.map(s => [s.org_id + '|' + s.number, s]));
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
        state: s ? s.state : 'p',
        state_source: s ? s.source : null,
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
      week: weekDatesCT(date),
      trucks: outTrucks,
      meta: {
        last_sync_roster: metaGet('last_sync_newmile_roster'),
        last_sync_activity: metaGet('last_sync_newmile_activity'),
        last_sync_samsara: metaGet('last_sync_samsara'),
        auto_mark: metaGet('auto_mark', '1') !== '0',
        syncing: maybeBackgroundSync(),
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
    run(`INSERT INTO dispatch_state (date, org_id, number, state, source, marked_by, marked_at) VALUES (?,?,?,?,'manual',?,?)
         ON CONFLICT(date, org_id, number) DO UPDATE SET state = excluded.state, source = 'manual', marked_by = excluded.marked_by, marked_at = excluded.marked_at`,
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
      if (f === 'rip_rap') v = v ? 1 : 0;
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
      run(`UPDATE trucks SET area = ?, suggested_area = '', updated_at = ? WHERE org_id = ? AND number = ?`,
        row.suggested_area, nowISO(), orgId, number);
      logChange(orgId, number, 'area', row.area, row.suggested_area, by);
      snapshotTruckDay(get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, number));
    } else {
      run(`UPDATE trucks SET suggested_area = '' WHERE org_id = ? AND number = ?`, orgId, number);
    }
    res.json({ ok: true });
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
      normNum(division), normNum(area || ''), nowISO(), orgId, number);
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
      const s = await syncSamsara(config);
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

  router.get('/api/health', (req, res) => res.json({ ok: true, today: todayCT() }));

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
