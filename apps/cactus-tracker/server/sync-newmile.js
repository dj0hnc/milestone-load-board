'use strict';
/*
 * NewMile sync jobs — the heart of "que JAMÁS se me pase un truck".
 *
 * syncRoster (4:30 AM CT + "Sync ahora"):
 *   - Pull every truck, keep the ones whose fleet matches an enabled org (Cactus = fleet 5).
 *   - Update driver / trailer_type when NewMile changed them; a driver change leaves a
 *     48 h "driver cambió: antes X → ahora Y" badge.
 *   - Fleet-5 truck missing from my roster → created with ⚑ NUEVO (division NULL, red
 *     banner until I place it). Roster truck gone from fleet 5 → flagged ¿de baja?
 *     (maybe_removed) — NOTHING is ever deleted automatically.
 *   - Subs (is_sub=1) are exempt from the ¿de baja? check: they live in their own
 *     NewMile fleets, not in fleet 5.
 *
 * syncActivity (hourly 4 AM–7 PM CT):
 *   - load_tickets for a rolling window ending today. Cactus rows come as "C1127"
 *     (prefix stripped); sub rows match by raw number. Today's driver beats the
 *     static roster driver (trucks rotate).
 *   - Auto-cover: a truck with loads TODAY is marked 'a' (source 'auto') unless I
 *     already touched it manually — FALTAN becomes the real gap, not a tap list.
 *   - A load from an unknown Cactus/sub truck creates it with ⚑ NUEVO on the spot
 *     (this is how 1065/1091/1105/1139 were caught on 7/9/26).
 *   - PLUS today's order assignments: a truck already planned in NewMile (plan pushed
 *     from the desktop board or in NewMile itself) is auto-covered even before its
 *     first load lands — no double-marking a truck that is already dispatched.
 */
const { all, get, run, metaSet, nowISO } = require('./db');
const { normNum, splitNameFlag, normLoadTruck, todayCT, shiftISO, reportDateToISO } = require('./util');

const ACTIVITY_WINDOW_DAYS = 21;   // enough history to compute "X días sin carga" up to red (>=14)

function enabledOrgs() {
  return all('SELECT * FROM orgs WHERE enabled = 1 ORDER BY sort').map(o => ({
    ...o, fleetNames: JSON.parse(o.nm_fleet_names || '[]')
  }));
}
// Sub fleet names are matched for activity even while the SUBS org/tab is still disabled,
// because sub trucks currently live inside the Cactus board (SPEC §2).
function subFleetNames() {
  const o = get('SELECT nm_fleet_names FROM orgs WHERE id = ?', 'SUBS');
  return o ? JSON.parse(o.nm_fleet_names || '[]') : [];
}

// ---------- roster ----------
async function syncRoster(client) {
  const orgs = enabledOrgs();
  const nmTrucks = await client.listTrucksAll();
  const summary = { updated: 0, driverChanges: 0, created: 0, flaggedRemoved: 0, detectedFlags: 0 };

  for (const org of orgs) {
    if (!org.nm_fleet_id) continue;
    const mine = nmTrucks.filter(t => {
      const fid = t.fleet_id != null ? t.fleet_id : (t.fleet && t.fleet.id);
      const fname = typeof t.fleet === 'string' ? t.fleet : (t.fleet && t.fleet.name);
      return fid === org.nm_fleet_id || org.fleetNames.some(n => normNum(n) === normNum(fname));
    });
    const seen = new Set();

    for (const t of mine) {
      const { number, flag } = splitNameFlag(t.truck_number || t.number || '');
      if (!number) continue;
      seen.add(number);
      const driver = (t.driver_name || t.driver || '').trim();
      const trailer = (t.truck_type || t.trailer_type || '').trim();
      const nmId = t.id != null ? t.id : t.truck_id;

      const row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', org.id, number);
      if (!row) {
        // NEVER silently missing: create with ⚑ NUEVO, no division until I assign it.
        run(`INSERT INTO trucks (org_id, number, division, area, driver, trailer_type, detected_flag,
               nm_truck_id, is_new, updated_at)
             VALUES (?,?,NULL,'(SIN YARD)',?,?,?,?,1,?)`,
          org.id, number, driver, trailer, flag, nmId, nowISO());
        summary.created++;
        continue;
      }
      const sets = [], vals = [];
      if (driver && driver !== row.driver) {
        sets.push('driver_prev = ?', 'driver = ?', 'driver_changed_at = ?');
        vals.push(row.driver || '', driver, nowISO());
        summary.driverChanges++;
      }
      if (trailer && trailer !== row.trailer_type) { sets.push('trailer_type = ?'); vals.push(trailer); }
      if (nmId != null && nmId !== row.nm_truck_id) { sets.push('nm_truck_id = ?'); vals.push(nmId); }
      if (flag && flag !== row.detected_flag) { sets.push('detected_flag = ?'); vals.push(flag); summary.detectedFlags++; }
      if (row.maybe_removed) { sets.push('maybe_removed = 0'); } // it's back in the fleet
      if (sets.length) {
        sets.push('updated_at = ?'); vals.push(nowISO());
        run(`UPDATE trucks SET ${sets.join(', ')} WHERE org_id = ? AND number = ?`, ...vals, org.id, number);
        summary.updated++;
      }
    }

    // ¿de baja? — only fleet trucks (subs live in other fleets); flag, never delete.
    const missing = all(
      `SELECT number FROM trucks WHERE org_id = ? AND is_sub = 0 AND archived = 0 AND maybe_removed = 0`,
      org.id).filter(r => !seen.has(r.number));
    for (const r of missing) {
      run(`UPDATE trucks SET maybe_removed = 1, updated_at = ? WHERE org_id = ? AND number = ?`, nowISO(), org.id, r.number);
      summary.flaggedRemoved++;
    }
  }

  metaSet('last_sync_newmile_roster', nowISO());
  metaSet('last_sync_newmile_roster_summary', JSON.stringify(summary));
  return summary;
}

// ---------- activity ----------
async function syncActivity(client) {
  const today = todayCT();
  const from = shiftISO(today, -ACTIVITY_WINDOW_DAYS);
  const rows = await client.loadTicketsRangeAll(from, today);
  const orgs = enabledOrgs();
  const cactus = orgs.find(o => o.id === 'CACTUS');
  const subNames = subFleetNames();
  const summary = { tickets: rows.length, matched: 0, autoCovered: 0, createdNew: 0, unmatched: 0 };

  // rebuild the window: aggregate loads per (org, number, date) with the LAST driver seen
  const agg = new Map(); // key org|num|date -> {loads, driver}
  const autoMark = get(`SELECT value FROM meta WHERE key = 'auto_mark'`);
  const autoOn = !autoMark || autoMark.value !== '0';

  for (const r of rows) {
    const fleetName = (typeof r.fleet === 'string' ? r.fleet : (r.fleet && r.fleet.name)) || '';
    const iso = reportDateToISO(r.order_date) || today;
    let orgId = null, num = null;

    if (cactus && cactus.fleetNames.some(n => normNum(n) === normNum(fleetName))) {
      orgId = 'CACTUS';
      num = normLoadTruck(r.truck_number, fleetName, cactus.fleetNames, cactus.truck_prefix);
    } else if (subNames.some(n => normNum(n) === normNum(fleetName))) {
      // sub fleets: raw number, no prefix; they render inside the Cactus board today
      orgId = 'CACTUS';
      num = normNum(r.truck_number);
    } else {
      // any other fleet: only match if the number already exists in my roster
      const cand = normNum(r.truck_number);
      const hit = get(`SELECT org_id FROM trucks WHERE number = ? AND archived = 0`, cand);
      if (!hit) { summary.unmatched++; continue; }
      orgId = hit.org_id; num = cand;
    }

    const key = orgId + '|' + num + '|' + iso;
    const cur = agg.get(key) || { loads: 0, driver: '' };
    cur.loads++;
    if (r.driver_name) cur.driver = String(r.driver_name).trim();
    agg.set(key, cur);
  }

  for (const [key, v] of agg) {
    const [orgId, num, iso] = key.split('|');
    let row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, num);
    if (!row) {
      // Ran a load but is not on my roster → ⚑ NUEVO immediately (never wait for 4:30 AM).
      const sub = subNames.length && /^(BT|BW|HS|AE)\d/i.test(num) ? 1 : 0;
      run(`INSERT INTO trucks (org_id, number, division, area, driver, tags, is_sub, is_new, updated_at)
           VALUES (?,?,NULL,'(SIN YARD)',?,?,?,1,?)`,
        orgId, num, v.driver || '', sub ? 'SUBHAULER' : '', sub, nowISO());
      row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, num);
      summary.createdNew++;
    }
    run(`INSERT INTO activity_log (org_id, number, load_date, driver, loads) VALUES (?,?,?,?,?)
         ON CONFLICT(org_id, number, load_date) DO UPDATE SET loads = excluded.loads, driver = excluded.driver`,
      orgId, num, iso, v.driver || '', v.loads);
    summary.matched++;

    const isToday = iso === today;
    run(`UPDATE trucks SET
           last_load_date = CASE WHEN last_load_date IS NULL OR last_load_date < ? THEN ? ELSE last_load_date END,
           last_load_driver = CASE WHEN last_load_date IS NULL OR last_load_date <= ? THEN ? ELSE last_load_driver END,
           loads_today = CASE WHEN ? THEN ? ELSE loads_today END,
           updated_at = ?
         WHERE org_id = ? AND number = ?`,
      iso, iso, iso, v.driver || '', isToday ? 1 : 0, v.loads, nowISO(), orgId, num);

    // Auto-cover: hauling today = covered. Manual marks always win.
    if (autoOn && isToday) {
      const st = get('SELECT * FROM dispatch_state WHERE date = ? AND org_id = ? AND number = ?', today, orgId, num);
      if (!st) {
        run(`INSERT INTO dispatch_state (date, org_id, number, state, source, marked_at) VALUES (?,?,?,'a','auto',?)`,
          today, orgId, num, nowISO());
        summary.autoCovered++;
      } else if (st.source === 'auto' && st.state !== 'a') {
        run(`UPDATE dispatch_state SET state = 'a', marked_at = ? WHERE date = ? AND org_id = ? AND number = ? AND source = 'auto'`,
          nowISO(), today, orgId, num);
      }
    }
  }

  // Assignments of today: cover trucks that are PLANNED even if they haven't hauled yet.
  if (autoOn) {
    try {
      const assigns = await client.assignmentsToday(today);
      const nums = new Set();
      for (const a of assigns) {
        const raw = a.truck_number || (a.truck && (a.truck.truck_number || a.truck.number)) || '';
        if (!raw) continue;
        let n = normNum(raw);
        // assignment numbers usually match the truck resource (plain for Cactus), but be
        // tolerant of the load-report style "C1127"
        if (!get('SELECT 1 AS x FROM trucks WHERE number = ? AND archived = 0', n) &&
            cactus && cactus.truck_prefix && n.startsWith(cactus.truck_prefix) && /\d/.test(n.slice(1))) {
          n = n.slice(cactus.truck_prefix.length);
        }
        nums.add(n);
      }
      summary.assignments = assigns.length;
      for (const n of nums) {
        const hit = get('SELECT org_id, number FROM trucks WHERE number = ? AND archived = 0', n);
        if (!hit) continue;
        const st = get('SELECT * FROM dispatch_state WHERE date = ? AND org_id = ? AND number = ?', today, hit.org_id, hit.number);
        if (!st) {
          run(`INSERT INTO dispatch_state (date, org_id, number, state, source, marked_at) VALUES (?,?,?,'a','auto',?)`,
            today, hit.org_id, hit.number, nowISO());
          summary.autoCovered++;
        }
      }
    } catch (e) {
      summary.assignmentsError = String(e.message || e); // assignments are best-effort; loads already covered actives
    }
  }

  // zero out loads_today for trucks that had none today
  run(`UPDATE trucks SET loads_today = 0
       WHERE loads_today > 0 AND NOT EXISTS (
         SELECT 1 FROM activity_log a WHERE a.org_id = trucks.org_id AND a.number = trucks.number AND a.load_date = ?)`,
    today);

  metaSet('last_sync_newmile_activity', nowISO());
  metaSet('last_sync_newmile_activity_summary', JSON.stringify(summary));
  return summary;
}

module.exports = { syncRoster, syncActivity };
