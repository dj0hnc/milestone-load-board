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
const { syncRoster, syncActivity } = require('./sync-newmile');
const { syncSamsara } = require('./sync-samsara');

const VALID_STATUS = ['ok', 'shop', 'down', 'no_driver', 'vacation', 'deleased'];
const EDITABLE = ['note', 'status', 'status_note', 'return_date', 'rest_days', 'area', 'division', 'rip_rap', 'phone', 'tags', 'driver'];

function createRouter({ config, newmile, log }) {
  const router = express.Router();
  router.use(express.json());
  const say = log || (() => {});

  // ---------- board ----------
  router.get('/api/board', (req, res) => {
    const orgId = normNum(req.query.org || 'CACTUS');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayCT();
    const org = get('SELECT * FROM orgs WHERE id = ?', orgId);
    if (!org) return res.status(404).json({ error: 'org desconocida: ' + orgId });

    const divisions = all('SELECT * FROM divisions WHERE org_id = ? ORDER BY sort', orgId);
    const trucks = all('SELECT * FROM trucks WHERE org_id = ? AND archived = 0', orgId);
    const states = all('SELECT * FROM dispatch_state WHERE date = ? AND org_id = ?', date, orgId);
    const stMap = new Map(states.map(s => [s.number, s]));
    const today = todayCT();

    const outTrucks = trucks.map(t => {
      const s = stMap.get(t.number);
      const driverChangedRecent = t.driver_changed_at && (Date.now() - Date.parse(t.driver_changed_at)) < 48 * 3600 * 1000;
      return {
        ...t,
        state: s ? s.state : 'p',
        state_source: s ? s.source : null,
        days_since_last_load: t.last_load_date ? daysBetween(t.last_load_date, today) : null,
        driver_changed_recent: driverChangedRecent ? { prev: t.driver_prev, at: t.driver_changed_at } : null
      };
    });

    res.json({
      org: { id: org.id, label: org.label },
      orgs: all('SELECT id, label, enabled FROM orgs ORDER BY sort'),
      divisions,
      date, today,
      week: weekDatesCT(date),
      trucks: outTrucks,
      meta: {
        last_sync_roster: metaGet('last_sync_newmile_roster'),
        last_sync_activity: metaGet('last_sync_newmile_activity'),
        last_sync_samsara: metaGet('last_sync_samsara'),
        auto_mark: metaGet('auto_mark', '1') !== '0',
        newmile: newmile ? newmile.status() : { connected: false }
      }
    });
  });

  // ---------- dispatch state ----------
  router.post('/api/state', (req, res) => {
    const { date, org, number, state } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !org || !number || !['p', 'a', 'd'].includes(state)) {
      return res.status(400).json({ error: 'body: {date ISO, org, number, state p|a|d}' });
    }
    run(`INSERT INTO dispatch_state (date, org_id, number, state, source, marked_at) VALUES (?,?,?,?,'manual',?)
         ON CONFLICT(date, org_id, number) DO UPDATE SET state = excluded.state, source = 'manual', marked_at = excluded.marked_at`,
      date, normNum(org), normNum(number), state, nowISO());
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
    if (!row) return res.status(404).json({ error: 'truck no existe' });
    const sets = [], vals = [];
    for (const f of EDITABLE) {
      if (!(f in (req.body || {}))) continue;
      let v = req.body[f];
      if (f === 'status' && !VALID_STATUS.includes(v)) return res.status(400).json({ error: 'status inválido' });
      if (f === 'rip_rap') v = v ? 1 : 0;
      if (f === 'division' && v != null && v !== '') {
        const d = get('SELECT 1 AS x FROM divisions WHERE org_id = ? AND id = ?', orgId, normNum(v));
        if (!d) return res.status(400).json({ error: 'división inválida' });
        v = normNum(v);
      }
      sets.push(`${f} = ?`); vals.push(v == null ? '' : v);
    }
    if (!sets.length) return res.status(400).json({ error: 'nada que actualizar' });
    sets.push('updated_at = ?'); vals.push(nowISO());
    run(`UPDATE trucks SET ${sets.join(', ')} WHERE org_id = ? AND number = ?`, ...vals, orgId, number);
    res.json({ ok: true, truck: get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, number) });
  });

  // Confirm a ⚑ NUEVO: place it (division + area) and clear the flag.
  router.post('/api/truck/:org/:number/confirm-new', (req, res) => {
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const { division, area } = req.body || {};
    if (!division) return res.status(400).json({ error: 'division requerida para confirmar un NUEVO' });
    const d = get('SELECT 1 AS x FROM divisions WHERE org_id = ? AND id = ?', orgId, normNum(division));
    if (!d) return res.status(400).json({ error: 'división inválida' });
    const r = run(`UPDATE trucks SET is_new = 0, division = ?, area = COALESCE(NULLIF(?, ''), area), suggested_division = NULL, updated_at = ?
                   WHERE org_id = ? AND number = ?`,
      normNum(division), normNum(area || ''), nowISO(), orgId, number);
    if (!r.changes) return res.status(404).json({ error: 'truck no existe' });
    res.json({ ok: true });
  });

  // Resolve a ¿de baja?: archive it (kept for history) or keep it active.
  router.post('/api/truck/:org/:number/resolve-removed', (req, res) => {
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const action = (req.body || {}).action;
    if (!['archive', 'keep'].includes(action)) return res.status(400).json({ error: "action: 'archive' | 'keep'" });
    const r = run(`UPDATE trucks SET maybe_removed = 0, archived = ?, updated_at = ? WHERE org_id = ? AND number = ?`,
      action === 'archive' ? 1 : 0, nowISO(), orgId, number);
    if (!r.changes) return res.status(404).json({ error: 'truck no existe' });
    res.json({ ok: true });
  });

  // Accept/dismiss a proposed flag (from the Samsara vehicle name or NewMile name suffix).
  // Accept maps common texts to a status; the raw text lands in status_note either way.
  router.post('/api/truck/:org/:number/flag', (req, res) => {
    const orgId = normNum(req.params.org), number = normNum(req.params.number);
    const { source, action } = req.body || {}; // source: 'samsara'|'newmile'; action: 'accept'|'dismiss'
    const col = source === 'newmile' ? 'detected_flag' : 'samsara_flag';
    const row = get(`SELECT * FROM trucks WHERE org_id = ? AND number = ?`, orgId, number);
    if (!row) return res.status(404).json({ error: 'truck no existe' });
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
    if (!newmile) return res.status(503).json({ error: 'NewMile no configurado' });
    try {
      if (!newmile.connected && !(await newmile.resume())) {
        return res.status(401).json({ error: 'NOT_CONNECTED', hint: 'abre /api/newmile/connect' });
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
    if (!newmile) return res.status(503).send('NewMile no configurado');
    try {
      if (await newmile.resume()) return res.redirect(req.baseUrl + '/?connected=1');
      const { authUrl } = await newmile.beginAuth(callbackUri(req));
      res.redirect(authUrl);
    } catch (e) { res.status(500).send('Error iniciando sign-in: ' + e.message); }
  });

  router.get('/api/newmile/callback', async (req, res) => {
    if (!newmile) return res.status(503).send('NewMile no configurado');
    try {
      await newmile.finishAuth(req.query);
      res.redirect(req.baseUrl + '/?connected=1');
    } catch (e) { res.status(500).send('Sign-in falló: ' + e.message + '. Regresa e intenta de nuevo.'); }
  });

  router.post('/api/newmile/disconnect', (req, res) => res.json(newmile ? newmile.disconnect() : { connected: false }));

  router.get('/api/health', (req, res) => res.json({ ok: true, today: todayCT() }));

  // ---------- static frontend ----------
  router.use(express.static(path.join(__dirname, '..', 'public')));

  return router;
}

module.exports = { createRouter };
