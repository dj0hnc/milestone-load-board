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
const { normNum, splitNameFlag, canonicalTruckNumber, displayTruckNumber, ktDivisionHint, shortTrailer, normLoadTruck, todayCT, shiftISO, reportDateToISO } = require('./util');

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

// Resolve a load/ticket row to a roster truck. Rules mirror the desktop's rotation.js:
//  - Cactus Express rows come prefixed "C1127" → 1127, auto-create NUEVO if unknown.
//  - CKJ Transport rows: "CKJ7040" (4+ digits) = KT truck → 7040, auto-create NUEVO;
//    "CKJ340" (3 digits) = CKJ-affiliated sub and other carriers riding the CKJ fleet
//    (e.g. "ARANGO - 1116") only match if already on my roster — never auto-created.
//  - Cactus sub fleets (Butler, Billy Walker, Hope, Arrowhead): raw number, auto-create.
//  - Any other fleet: match only if the number already exists somewhere in my roster.
function matchLoadRow(r, orgs, subNames) {
  const fleetName = (typeof r.fleet === 'string' ? r.fleet : (r.fleet && r.fleet.name)) || '';
  const orgHit = orgs.find(o => o.fleetNames.some(n => normNum(n) === normNum(fleetName)));
  if (orgHit) {
    let num = normLoadTruck(r.truck_number, fleetName, orgHit.fleetNames, orgHit.truck_prefix);
    if (orgHit.id === 'KT') {
      const digits = canonicalTruckNumber('KT', num);
      if (!/^\d{4,}$/.test(digits)) {
        const cand = normNum(r.truck_number).replace(/\s+/g, '');
        // CKJ IC (independent contractor): CKJ + 1-3 dígitos → truck propio bajo KT ICS,
        // con el número COMPLETO como llave y display (así lo ves en NewMile)
        if (/^CKJ\d{1,3}$/.test(cand)) {
          return { orgId: 'KT', num: cand, autoCreate: true, sub: true, tags: 'CKJ IC', suggestedDivision: 'ICS', display: cand.slice(3) };
        }
        // otros números ajenos rodando bajo el fleet CKJ (Arango…): solo si ya existen
        const hit = get('SELECT org_id, number FROM trucks WHERE number IN (?, ?) AND archived = 0', cand, digits);
        return hit ? { orgId: hit.org_id, num: hit.number, autoCreate: false } : null;
      }
      // CKJ#### de 4 dígitos: normalmente flota KT, pero si NO hay truck de flota con
      // esos dígitos y SÍ existe el IC (CKJ7078 descubierto por Samsara), es el IC
      if (!get(`SELECT 1 AS x FROM trucks WHERE org_id = 'KT' AND number = ?`, digits) &&
          get(`SELECT 1 AS x FROM trucks WHERE org_id = 'KT' AND number = ?`, 'CKJ' + digits)) {
        return { orgId: 'KT', num: 'CKJ' + digits, autoCreate: false };
      }
      num = digits;
    }
    return { orgId: orgHit.id, num, autoCreate: true };
  }
  if (subNames.some(n => normNum(n) === normNum(fleetName))) {
    return { orgId: 'CACTUS', num: normNum(r.truck_number), autoCreate: true, sub: true, tags: 'SUBHAULER' };
  }
  const cand = normNum(r.truck_number).replace(/\s+/g, '');
  const hit = get('SELECT org_id, number FROM trucks WHERE number = ? AND archived = 0', cand);
  if (hit) return { orgId: hit.org_id, num: hit.number, autoCreate: false };
  // el display también cuenta ("LT245" guardado como display del sub "245")
  const hd = get('SELECT org_id, number FROM trucks WHERE display_number = ? AND archived = 0', cand);
  if (hd) return { orgId: hd.org_id, num: hd.number, autoCreate: false };
  const pm = /^([A-Z]{1,4})-?(\d{1,4})$/.exec(cand);
  if (pm) {
    // sub ya en el roster con el número INCOMPLETO (Livingston "245" vs NewMile "LT245"):
    // se matchea por los dígitos y de paso se le pone el número completo de NewMile
    const bare = get(`SELECT org_id, number, display_number FROM trucks WHERE number = ? AND is_sub = 1 AND archived = 0`, pm[2]);
    if (bare) {
      if (bare.display_number === bare.number) {
        run(`UPDATE trucks SET display_number = ?, updated_at = ? WHERE org_id = ? AND number = ?`, cand, nowISO(), bare.org_id, bare.number);
      }
      return { orgId: bare.org_id, num: bare.number, autoCreate: false };
    }
    // SUB EXTERNO (AMP6060, PDR1062, SL47…): SIN fleet en NewMile porque no es ni de
    // Cactus ni de CKJ, pero corre en NUESTRAS órdenes → es de los que usamos. Se crea
    // solo, directo al board: CACTUS NORTH, zona SUBS (al final), tag SUBHAULER.
    // Con fleet ajeno (otra carrier) se queda como antes: match-only, nunca se crea.
    if (!normNum(fleetName)) {
      return { orgId: 'CACTUS', num: cand, autoCreate: true, sub: true, tags: 'SUBHAULER', division: 'NORTH', area: 'SUBS' };
    }
  }
  return null;
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
      const rawName = t.truck_number || t.number || '';
      const parsed = splitNameFlag(rawName);
      const number = canonicalTruckNumber(org.id, parsed.number); // "KT-7040 P" → 7040 (llave)
      const display = displayTruckNumber(rawName);                // "KT-7040 P" (como NewMile)
      const flag = parsed.flag;
      if (!number) continue;
      seen.add(number);
      const driver = (t.driver_name || t.driver || '').trim();
      const trailer = shortTrailer(t.truck_type || t.trailer_type || ''); // "Aluminum End Dump" → AL-ED
      const nmId = t.id != null ? t.id : (t.truck_id != null ? t.truck_id : null);

      const row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', org.id, number);
      if (!row) {
        // NEVER silently missing: create with ⚑ NUEVO, no division until I assign it.
        // KT names carry the terminal letter ("KT-7040 P") → pre-fill the suggestion.
        const hint = org.id === 'KT' ? ktDivisionHint(rawName) : null;
        run(`INSERT INTO trucks (org_id, number, display_number, division, area, driver, trailer_type, detected_flag,
               nm_truck_id, suggested_division, is_new, updated_at)
             VALUES (?,?,?,NULL,'(SIN YARD)',?,?,?,?,?,1,?)`,
          org.id, number, display, driver, trailer, flag, nmId, hint, nowISO());
        summary.created++;
        continue;
      }
      const sets = [], vals = [];
      if (driver && driver !== row.driver) {
        sets.push('driver_prev = ?', 'driver = ?', 'driver_changed_at = ?');
        vals.push(row.driver || '', driver, nowISO());
        summary.driverChanges++;
      }
      if (trailer && trailer !== row.trailer_type && !row.trailer_override) { sets.push('trailer_type = ?'); vals.push(trailer); }
      if (display && display !== row.display_number) { sets.push('display_number = ?'); vals.push(display); }
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
    // Guard: a truncated/failed pull must never flag half the fleet — if NewMile
    // returned less than half of my active roster for this org, skip the check.
    const active = all(
      `SELECT number FROM trucks WHERE org_id = ? AND is_sub = 0 AND archived = 0 AND maybe_removed = 0`,
      org.id);
    if (active.length >= 4 && seen.size < active.length / 2) {
      summary.removalCheckSkipped = (summary.removalCheckSkipped || []).concat(
        `${org.id}: pull trajo ${seen.size} de ${active.length} activos`);
    } else {
      for (const r of active.filter(r => !seen.has(r.number))) {
        run(`UPDATE trucks SET maybe_removed = 1, updated_at = ? WHERE org_id = ? AND number = ?`, nowISO(), org.id, r.number);
        summary.flaggedRemoved++;
      }
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
    const iso = reportDateToISO(r.order_date) || today;
    const m = matchLoadRow(r, orgs, subNames);
    if (!m) { summary.unmatched++; continue; }

    const key = m.orgId + '|' + m.num + '|' + iso;
    const cur = agg.get(key) || { loads: 0, driver: '', m };
    cur.loads++;
    if (r.driver_name) cur.driver = String(r.driver_name).trim();
    agg.set(key, cur);
  }

  for (const [key, v] of agg) {
    const [orgId, num, iso] = key.split('|');
    let row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, num);
    if (!row) {
      if (!v.m.autoCreate) { summary.unmatched += v.loads; continue; }
      // Ran a load but is not on my roster → ⚑ NUEVO immediately (never wait for 4:30 AM).
      // Los subs externos traen su lugar (NORTH / zona SUBS) → entran directo al board.
      const sub = v.m.sub || (orgId === 'CACTUS' && /^(BT|BW|HS|AE)\d/i.test(num)) ? 1 : 0;
      run(`INSERT INTO trucks (org_id, number, display_number, division, area, driver, tags, is_sub, suggested_division, is_new, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        orgId, num, v.m.display || num, v.m.division || null, v.m.area || '(SIN YARD)', v.driver || '',
        v.m.tags || (sub ? 'SUBHAULER' : ''), sub, v.m.suggestedDivision || null, v.m.area ? 0 : 1, nowISO());
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

  // Assignments: cover trucks that are PLANNED even if they haven't hauled yet — for
  // TODAY and for the NEXT WORKING DAY (dispatch plans a day ahead: a refresh must show
  // tomorrow's board already covered with what was pushed to NewMile).
  async function coverFromAssignments(dateISO, label) {
    try {
      const assigns = await client.assignmentsToday(dateISO);
      const nums = new Set();
      for (const a of assigns) {
        const raw = a.truck_number || (a.truck && (a.truck.truck_number || a.truck.number)) || '';
        if (raw) nums.add(normNum(raw).replace(/\s+/g, ''));
      }
      summary[label + 'Assignments'] = assigns.length;
      for (const n of nums) {
        // assignment numbers usually match the truck resource, but tolerate the
        // load-report styles too: "C1127" (Cactus) and "KT-7040 P"/"CKJ7040" (KT)
        const candidates = [n, canonicalTruckNumber('KT', n)];
        if (cactus && cactus.truck_prefix && n.startsWith(cactus.truck_prefix) && /\d/.test(n.slice(cactus.truck_prefix.length))) {
          candidates.push(n.slice(cactus.truck_prefix.length));
        }
        let hit = null;
        for (const c of [...new Set(candidates)]) {
          hit = get('SELECT org_id, number FROM trucks WHERE number = ? AND archived = 0', c);
          if (hit) break;
        }
        if (!hit) continue;
        const st = get('SELECT * FROM dispatch_state WHERE date = ? AND org_id = ? AND number = ?', dateISO, hit.org_id, hit.number);
        if (!st) {
          run(`INSERT INTO dispatch_state (date, org_id, number, state, source, marked_at) VALUES (?,?,?,'a','auto',?)`,
            dateISO, hit.org_id, hit.number, nowISO());
          summary[label + 'Covered'] = (summary[label + 'Covered'] || 0) + 1;
        }
      }
    } catch (e) {
      summary[label + 'AssignmentsError'] = String(e.message || e); // best-effort
    }
  }
  if (autoOn) {
    await coverFromAssignments(today, 'today');
    const wd = new Date(today + 'T12:00:00Z').getUTCDay();
    const nextWork = shiftISO(today, wd === 6 ? 2 : 1); // sábado planea el lunes
    await coverFromAssignments(nextWork, 'tomorrow');
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

// ---------- RIP RAP capability scan ----------
// "¿Qué trucks SÍ pueden cargar rip rap?" — la evidencia más dura es que ya lo cargaron.
// Scans load_tickets materials over a window; a roster truck that hauled rip rap but is
// not marked rip_rap gets rip_suggested + evidence (loads, dates, material names). I
// confirm from the UI (my rip-rap flag is the truth; this only proposes, never marks).
const RIP_RE = /rip\s*-?\s*rap|riprap/i;

async function scanRipRap(client, days) {
  const today = todayCT();
  const from = shiftISO(today, -(days || 30));
  const rows = await client.loadTicketsMaterialsAll(from, today);
  const orgs = enabledOrgs();
  const subNames = subFleetNames();

  const evidence = new Map(); // org|num -> {loads, first, last, materials:Set}
  for (const r of rows) {
    const mat = String(r.material || '') + ' | ' + String(r.alternative_material_name || '');
    if (!RIP_RE.test(mat)) continue;
    const m = matchLoadRow(r, orgs, subNames);
    if (!m) continue;
    const num = m.num;
    const iso = reportDateToISO(r.order_date) || today;
    const key = m.orgId + '|' + num;
    const e = evidence.get(key) || { loads: 0, first: iso, last: iso, materials: new Set() };
    e.loads++;
    if (iso < e.first) e.first = iso;
    if (iso > e.last) e.last = iso;
    e.materials.add((r.material || r.alternative_material_name || '').trim());
    evidence.set(key, e);
  }

  const summary = { window_days: days || 30, rip_loads: 0, trucks: [], suggested: 0, already_marked: 0, unknown: [] };
  for (const [key, e] of evidence) {
    const [orgId, num] = key.split('|');
    summary.rip_loads += e.loads;
    const t = { number: num, loads: e.loads, first: e.first, last: e.last, materials: [...e.materials] };
    summary.trucks.push(t);
    const row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ? AND archived = 0', orgId, num);
    if (!row) { summary.unknown.push(num); continue; }
    const ev = JSON.stringify({ loads: e.loads, first: e.first, last: e.last, materials: [...e.materials] });
    if (row.rip_rap) {
      summary.already_marked++;
      run(`UPDATE trucks SET rip_evidence = ? WHERE org_id = ? AND number = ?`, ev, orgId, num);
    } else {
      run(`UPDATE trucks SET rip_suggested = 1, rip_evidence = ?, updated_at = ? WHERE org_id = ? AND number = ?`,
        ev, nowISO(), orgId, num);
      summary.suggested++;
    }
  }
  summary.trucks.sort((a, b) => b.loads - a.loads);
  metaSet('last_scan_riprap', nowISO());
  metaSet('last_scan_riprap_summary', JSON.stringify(summary));
  return summary;
}

module.exports = { syncRoster, syncActivity, scanRipRap, matchLoadRow };
