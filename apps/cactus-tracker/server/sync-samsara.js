'use strict';
/*
 * Samsara sync — flags + terminal tags. CACTUS ONLY (and later KT).
 *
 * HARD RULE: subhaulers are NOT in Samsara. Every query here filters is_sub = 0 and
 * only runs for orgs with samsara = 1; sub trucks are never matched, never flagged,
 * never suggested a division. Their info comes exclusively from NewMile.
 *
 * What it does (token scope: vehicles + tags only — no trips / driver-assignments):
 *  - GET /fleet/vehicles (paginated). Vehicle names carry the flags
 *    ("1023-IN SHOP 08/20/2025", "553-Deleased Need Camera"): parse → propose in
 *    samsara_flag. I confirm or dismiss from the UI; nothing changes status by itself.
 *  - Terminal tags → suggested_division for trucks I have not placed yet
 *    (Paris Terminal 4218297 = NORTH, Lufkin Terminal 4218296 = SOUTH). My manual
 *    assignment always wins — suggestions only fill the ⚑ NUEVO confirm form.
 *  - GPS PARKING (the real value): where does the truck SLEEP. Every sync stores the
 *    current position (reverse-geo city) as "última posición"; runs inside the sleep
 *    windows also log it as that day's parking spot. EL GPS ES LA VERDAD: si la última
 *    noche fue en otra zona conocida (o en otra terminal de KT), el truck SE MUEVE
 *    solo. Solo las ciudades desconocidas quedan como suggested_area (badge de un tap).
 */
const fs = require('fs');
const { all, get, run, metaGet, metaSet, nowISO } = require('./db');
const { splitNameFlag, canonicalTruckNumber, ktDivisionHint, ctParts, todayCT, shiftISO, normNum, canonArea, areaMergeKey } = require('./util');

// Fallback cuando el reverse-geo no da ciudad: pueblo más cercano de la operación.
const TOWNS = [
  ['PARIS', 'TX', 33.662, -95.548], ['POWDERLY', 'TX', 33.811, -95.506], ['HUGO', 'OK', 34.011, -95.510],
  ['BLOSSOM', 'TX', 33.662, -95.385], ['CLARKSVILLE', 'TX', 33.611, -95.053], ['DETROIT', 'TX', 33.662, -95.267],
  ['BOGATA', 'TX', 33.470, -95.213], ['COOPER', 'TX', 33.373, -95.692], ['CAMPBELL', 'TX', 33.148, -95.951],
  ['PECAN GAP', 'TX', 33.438, -95.851], ['SAVOY', 'TX', 33.600, -96.366], ['SCROGGINS', 'TX', 33.023, -95.211],
  ['MT VERNON', 'TX', 33.188, -95.221], ['SULPHUR SPRINGS', 'TX', 33.138, -95.601], ['ALBA', 'TX', 32.792, -95.634],
  ['GILMER', 'TX', 32.729, -94.942], ['SAWYER', 'OK', 34.023, -95.364], ['VALLIANT', 'OK', 34.004, -95.093],
  ['EAGLETOWN', 'OK', 34.036, -94.565], ['TYLER', 'TX', 32.351, -95.301], ['DALLAS', 'TX', 32.777, -96.797],
  ['KAUFMAN', 'TX', 32.589, -96.309], ['ATHENS', 'TX', 32.205, -95.856], ['LONGVIEW', 'TX', 32.501, -94.740],
  ['CORSICANA', 'TX', 32.095, -96.469], ['KERENS', 'TX', 32.132, -96.228], ['ENNIS', 'TX', 32.329, -96.625],
  ['RHOME', 'TX', 33.054, -97.472], ['WHITEWRIGHT', 'TX', 33.513, -96.407], ['GREENVILLE', 'TX', 33.138, -96.111],
  ['FORT WORTH', 'TX', 32.756, -97.331], ['MCKINNEY', 'TX', 33.198, -96.615], ['SHERMAN', 'TX', 33.635, -96.609],
  ['TERRELL', 'TX', 32.736, -96.275], ['WAXAHACHIE', 'TX', 32.387, -96.848], ['MOUNT PLEASANT', 'TX', 33.157, -94.968]
];
// distancia aproximada en km (suficiente para "¿se movió?" a estas latitudes)
function distKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lat2 == null) return Infinity;
  return Math.sqrt(Math.pow((lat1 - lat2) * 111, 2) + Math.pow((lon1 - lon2) * 92, 2));
}

function nearestTown(lat, lon) {
  if (lat == null || lon == null) return '';
  let best = '', bestD = Infinity;
  for (const [name, st, tl, tn] of TOWNS) {
    const d = Math.pow((lat - tl) * 111, 2) + Math.pow((lon - tn) * 92, 2); // km² aprox
    if (d < bestD) { bestD = d; best = name + ', ' + st; }
  }
  return bestD <= 45 * 45 ? best : ''; // más de ~45 km de todo lo conocido: no adivinar
}

// Tokens: los propios (config.samsara.tokens) Y/O los del otro tool via
// config.samsara.tokensFile — apunta al newmile.config.json del Load Board de
// escritorio o del office bundle y los reutiliza sin copiarlos (shape
// {samsara:{tokens:[{name,token}]}} o {tokens:[...]}). Los propios ganan.
function allTokens(cfg) {
  const own = (cfg.samsara && cfg.samsara.tokens) || [];
  let ext = [];
  const file = cfg.samsara && cfg.samsara.tokensFile;
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      ext = (j.samsara && j.samsara.tokens) || j.tokens || [];
    } catch (e) { /* archivo ausente o ilegible: seguimos con los propios */ }
  }
  return [...own.filter(t => t && t.token), ...ext.filter(t => t && t.token)];
}

function tokenFor(cfg, orgName) {
  const t = allTokens(cfg).find(x => x.name === orgName);
  return t ? t.token : null;
}

// Busca el truck que corresponde a un vehículo de Samsara. Los subs de CACTUS no
// están en Samsara (excluidos), pero los KT ICs SÍ: en Samsara aparecen como dígitos
// pelones ("211") y en el roster viven como "CKJ211".
// REGLA DE ORO DE LOS ICs (del despacho): en el Samsara de CKJ, TODO vehículo cuyo
// nombre NO empieza con "KT-" es un IC — número pelón de 1-4 dígitos ("450", "7078").
// Se guardan como CKJ#### (llave, sin chocar con la flota KT-) pero SE MUESTRAN pelones.
function resolveSamsaraTruck(orgId, rawName) {
  const parsed = splitNameFlag(rawName).number.replace(/\s+/g, '');
  if (orgId === 'KT' && /^\d{1,4}$/.test(parsed)) {
    return { icBare: parsed, row: get(`SELECT * FROM trucks WHERE org_id = 'KT' AND number = ?`, 'CKJ' + parsed) };
  }
  const canon = canonicalTruckNumber(orgId, parsed);
  return { icBare: null, row: get(`SELECT * FROM trucks WHERE org_id = ? AND number = ? AND (is_sub = 0 OR org_id = 'KT')`, orgId, canon) };
}
function samsaraTruck(orgId, number) { // compat: lookup por número ya canónico
  let row = get(`SELECT * FROM trucks WHERE org_id = ? AND number = ? AND (is_sub = 0 OR org_id = 'KT')`, orgId, number);
  if (!row && orgId === 'KT' && /^\d{1,4}$/.test(number)) {
    row = get(`SELECT * FROM trucks WHERE org_id = 'KT' AND number = ?`, 'CKJ' + number);
  }
  return row;
}

// Crea un IC CONFIRMADO bajo CKJ ICS con su ciudad de estacionamiento — sin esperar
// a que corra una carga en NewMile. Display = número pelón, como en Samsara.
function discoverIC(orgId, number, city, lat, lon, summary) {
  if (orgId !== 'KT' || !/^\d{1,4}$/.test(number)) return null;
  const icNum = 'CKJ' + number;
  const area = city ? mapCityToArea(city, knownAreas()) : '(SIN YARD)';
  run(`INSERT INTO trucks (org_id, number, display_number, division, area, tags, is_sub, is_new, updated_at)
       VALUES ('KT', ?, ?, 'ICS', ?, 'CKJ IC', 1, 0, ?)
       ON CONFLICT(org_id, number) DO NOTHING`,
    icNum, number, area || '(SIN YARD)', nowISO());
  if (city) {
    run(`INSERT INTO parking_log (org_id, number, date, city, lat, lon) VALUES ('KT', ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, number, date) DO UPDATE SET city = excluded.city`,
      icNum, todayCT(), city, lat == null ? null : lat, lon == null ? null : lon);
  }
  if (summary) summary.icsDiscovered = (summary.icsDiscovered || 0) + 1;
  return get(`SELECT * FROM trucks WHERE org_id = 'KT' AND number = ?`, icNum);
}

async function fetchVehicles(token) {
  let out = [], after = '', pages = 0;
  do {
    const url = 'https://api.samsara.com/fleet/vehicles?limit=512' + (after ? '&after=' + encodeURIComponent(after) : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!r.ok) throw new Error('Samsara vehicles HTTP ' + r.status);
    const j = await r.json();
    out = out.concat(j.data || []);
    after = (j.pagination && j.pagination.hasNextPage) ? j.pagination.endCursor : '';
    pages++;
  } while (after && pages < 20);
  return out;
}

// ---- HOS: relojes de horas de servicio por DRIVER (/fleet/hos/clocks) ----
// driveRemaining = manejo que le queda HOY · shiftRemaining = turno de hoy ·
// cycleRemaining = lo que le queda de la SEMANA (ciclo 60/70 h). Con eso el board
// responde "¿puede jalar el fin de semana?" sin abrir Samsara.
async function fetchHosClocks(token) {
  let out = [], after = '', pages = 0;
  do {
    const url = 'https://api.samsara.com/fleet/hos/clocks?limit=512' + (after ? '&after=' + encodeURIComponent(after) : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!r.ok) throw new Error('Samsara hos HTTP ' + r.status);
    const j = await r.json();
    out = out.concat(j.data || []);
    after = (j.pagination && j.pagination.hasNextPage) ? j.pagination.endCursor : '';
    pages++;
  } while (after && pages < 10);
  return out;
}
// nombres: mayúsculas, sin signos, tokens ORDENADOS ("Perez Juan" == "JUAN PEREZ")
const normDrvName = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');

async function syncHOS(cfg, vehiclesByOrg) {
  const orgs = all('SELECT * FROM orgs WHERE enabled = 1 AND samsara = 1 ORDER BY sort');
  const summary = { drivers: 0, matched: 0, assignedIds: 0, skippedOrgs: [] };
  for (const org of orgs) {
    const token = tokenFor(cfg, org.samsara_org);
    if (!token) { summary.skippedOrgs.push(org.id + ' (sin token)'); continue; }
    let clocks;
    try { clocks = await fetchHosClocks(token); } catch (e) { summary['error_' + org.id] = String(e.message || e); continue; }
    summary.drivers += clocks.length;
    // Vehículo→driver desde el propio Samsara: la asignación oficial gana siempre.
    // (reusa la lista si el caller ya la trajo — cero llamadas dobles)
    try {
      const vlist = (vehiclesByOrg && vehiclesByOrg.get(org.id)) || await fetchVehicles(token);
      for (const v of vlist) {
        const sd = v.staticAssignedDriver && v.staticAssignedDriver.id != null ? String(v.staticAssignedDriver.id) : null;
        if (!sd) continue;
        const res = resolveSamsaraTruck(org.id, v.name || '');
        if (res.row && res.row.samsara_driver_id !== sd) {
          run(`UPDATE trucks SET samsara_driver_id = ? WHERE org_id = ? AND number = ?`, sd, org.id, res.row.number);
          summary.assignedIds++;
        }
      }
    } catch (e) { summary['vehError_' + org.id] = String(e.message || e); }
    const trucks = all('SELECT org_id, number, driver, samsara_id, samsara_driver_id FROM trucks WHERE org_id = ? AND archived = 0', org.id);
    const byDrvId = new Map(trucks.filter(t => t.samsara_driver_id).map(t => [String(t.samsara_driver_id), t]));
    // EN QUÉ TRUCK ANDA AHORITA: los relojes traen currentVehicle — perfecto para ICs
    // y trucks sin driver asignado en Samsara (el que lo trae rodando ES su driver)
    const byVehId = new Map(trucks.filter(t => t.samsara_id).map(t => [String(t.samsara_id), t]));
    // por nombre solo si es ÚNICO en la flota (dos "JUAN PEREZ" = ambiguo, no adivinar);
    // "Elaine Raper / Lonnie Seat" cuenta por cada segmento
    const byName = new Map();
    for (const t of trucks) {
      for (const part of String(t.driver || '').split('/')) {
        const k = normDrvName(part);
        if (!k || k === 'NO DRIVER' || k === 'DRIVER SIN') continue;
        byName.set(k, byName.has(k) ? null : t);
      }
    }
    // SUBCONJUNTO: "ANDREW WHIPKEY" empata con "ANDREW DAVID WHIPKEY" (≥2 tokens y uno
    // contiene al otro) — pero solo si el candidato es ÚNICO, si no, no se adivina
    const nameKeys = [...byName.keys()];
    const subsetMatch = (k) => {
      if (!k) return null;
      if (byName.has(k)) return byName.get(k); // EXACTO gana (null si era ambiguo)
      const ks = k.split(' ');
      const hits = nameKeys.filter(nk => {
        if (nk === k) return true;
        const ns = nk.split(' ');
        const [small, big] = ks.length <= ns.length ? [ks, ns] : [ns, ks];
        return small.length >= 2 && small.every(w => big.includes(w));
      });
      return hits.length === 1 ? byName.get(hits[0]) : null;
    };
    const now = nowISO();
    for (const c of clocks) {
      const drv = c.driver || {}, ck = c.clocks || {};
      const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null) return Number(o[k]); return null; };
      const drive = pick(ck.drive, 'driveRemainingDurationMs', 'remainingDurationMs', 'driveRemainingMs');
      const shift = pick(ck.shift, 'shiftRemainingDurationMs', 'remainingDurationMs', 'shiftRemainingMs');
      const cycle = pick(ck.cycle, 'cycleRemainingDurationMs', 'remainingDurationMs', 'cycleRemainingMs');
      const tmrw = pick(ck.cycle, 'cycleTomorrowDurationMs'); // lo que RECUPERA mañana
      // cuánto se PASARON (violations) — el board lo enseña como horas en NEGATIVO
      const vio = c.violations || {};
      const vShift = pick(vio, 'shiftDrivingViolationDurationMs', 'shiftViolationDurationMs');
      const vCycle = pick(vio, 'cycleViolationDurationMs');
      if (drive == null && shift == null && cycle == null) continue;
      const curVeh = c.currentVehicle && c.currentVehicle.id != null ? String(c.currentVehicle.id) : null;
      const t = byDrvId.get(String(drv.id)) || (curVeh && byVehId.get(curVeh)) || subsetMatch(normDrvName(drv.name));
      if (!t) continue;
      run(`UPDATE trucks SET hos_drive_ms = ?, hos_shift_ms = ?, hos_cycle_ms = ?, hos_cycle_tmrw_ms = ?,
             hos_viol_shift_ms = ?, hos_viol_cycle_ms = ?, hos_at = ?, hos_driver = ?,
             samsara_driver_id = COALESCE(samsara_driver_id, ?)
           WHERE org_id = ? AND number = ?`,
        drive, shift, cycle, tmrw, vShift, vCycle, now, String(drv.name || '').slice(0, 60),
        drv.id != null ? String(drv.id) : null, t.org_id, t.number);
      summary.matched++;
    }
  }
  metaSet('last_sync_hos', nowISO());
  return summary;
}

// ---- BARRIDO AUDITOR: revisa TODOS los trucks, repara lo reparable, lista lo demás ----
// Categorías: ok · fixed (id amarrado aquí mismo) · no_samsara_link (ni vehículo) ·
// no_driver_assigned (vehículo sin driver en Samsara y nombre no empata) ·
// driver_no_clocks (driver amarrado pero sin ELD) · ambiguous_name (2+ candidatos).
async function auditHOS(cfg) {
  const orgs = all('SELECT * FROM orgs WHERE enabled = 1 AND samsara = 1 ORDER BY sort');
  const out = { checked: 0, ok: 0, fixed: [], no_samsara_link: [], no_driver_assigned: [], driver_no_clocks: [], ambiguous_name: [], no_token: [] };
  for (const org of orgs) {
    const token = tokenFor(cfg, org.samsara_org);
    if (!token) { out.no_token.push(org.id); continue; }
    const clocks = await fetchHosClocks(token);
    const vehicles = await fetchVehicles(token);
    const vehById = new Map(vehicles.filter(v => v.id != null).map(v => [String(v.id), v]));
    const clockById = new Map(clocks.filter(c => c.driver && c.driver.id != null).map(c => [String(c.driver.id), c]));
    // quién trae CADA vehículo ahorita (clave para ICs sin asignación en Samsara)
    const clockByVeh = new Map();
    for (const c of clocks) {
      const cv = c.currentVehicle && c.currentVehicle.id != null ? String(c.currentVehicle.id) : null;
      if (cv && !clockByVeh.has(cv)) clockByVeh.set(cv, c);
    }
    const nameIdx = clocks.map(c => [normDrvName((c.driver || {}).name), c]).filter(([k]) => k);
    const nameMatch = (parts) => {
      const hits = new Map();
      for (const p of parts) for (const [k, c] of nameIdx) {
        let hit = k === p;
        if (!hit) {
          const a = k.split(' '), b = p.split(' ');
          const [s, bg] = a.length <= b.length ? [a, b] : [b, a];
          hit = s.length >= 2 && s.every(w => bg.includes(w));
        }
        if (hit) hits.set(String((c.driver || {}).id), c);
      }
      return [...hits.values()];
    };
    const trucks = all(`SELECT * FROM trucks WHERE org_id = ? AND archived = 0 AND (is_sub = 0 OR number LIKE 'CKJ%')`, org.id);
    for (const t of trucks) {
      out.checked++;
      const label = (t.display_number || t.number) + (t.driver ? ' · ' + t.driver : '');
      if (!t.samsara_id) { out.no_samsara_link.push(label); continue; }
      let drvId = t.samsara_driver_id;
      const veh = vehById.get(String(t.samsara_id));
      const vSd = veh && veh.staticAssignedDriver && veh.staticAssignedDriver.id != null ? String(veh.staticAssignedDriver.id) : null;
      if (vSd) drvId = vSd; // la asignación oficial del vehículo SIEMPRE manda
      if (drvId && clockById.has(String(drvId))) {
        if (String(drvId) !== String(t.samsara_driver_id || '')) {
          run(`UPDATE trucks SET samsara_driver_id = ? WHERE org_id = ? AND number = ?`, String(drvId), t.org_id, t.number);
          out.fixed.push(label + ' → vehicle assignment');
        }
        out.ok++; continue;
      }
      // ¿alguien trae ESTE vehículo rodando ahorita? — ese es su driver (ICs sobre todo)
      const cv = clockByVeh.get(String(t.samsara_id));
      if (cv && cv.driver && cv.driver.id != null) {
        run(`UPDATE trucks SET samsara_driver_id = ? WHERE org_id = ? AND number = ?`, String(cv.driver.id), t.org_id, t.number);
        out.fixed.push(label + ' → driving it now: ' + (cv.driver.name || cv.driver.id));
        out.ok++; continue;
      }
      // sin id con relojes → intenta por NOMBRE (exacto o subconjunto, único)
      const parts = String(t.driver || '').split('/').map(normDrvName).filter(k => k && k !== 'NO DRIVER' && k !== 'DRIVER SIN');
      const hits = parts.length ? nameMatch(parts).filter(c => clockById.has(String(c.driver.id))) : [];
      if (hits.length === 1) {
        const nid = String(hits[0].driver.id);
        run(`UPDATE trucks SET samsara_driver_id = ? WHERE org_id = ? AND number = ?`, nid, t.org_id, t.number);
        out.fixed.push(label + ' → by name: ' + hits[0].driver.name);
        out.ok++; continue;
      }
      if (hits.length > 1) { out.ambiguous_name.push(label + ' ≈ ' + hits.map(c => c.driver.name).join(' / ')); continue; }
      if (drvId) { out.driver_no_clocks.push(label); continue; }
      out.no_driver_assigned.push(label);
    }
  }
  // con los ids reparados, aplica los relojes de una vez
  try { out.applied = await syncHOS(cfg); } catch (e) { out.applyError = String(e.message || e); }
  return out;
}

// HOS EN VIVO de UN truck (botón ↻ del cuadrito): consulta los relojes de SU driver
// al momento — mismo tap que refresca el GPS deja las horas al segundo.
async function refreshHOSTruck(cfg, row) {
  const org = get('SELECT * FROM orgs WHERE id = ?', row.org_id);
  if (!org || !org.samsara) return null;
  const token = tokenFor(cfg, org.samsara_org);
  if (!token) return null;
  let drvId = row.samsara_driver_id;
  // sin driver-id guardado: pregúntale al vehículo quién trae asignado ahorita
  if (!drvId && row.samsara_id) {
    try {
      const r = await fetch('https://api.samsara.com/fleet/vehicles/' + encodeURIComponent(row.samsara_id),
        { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
      const j = r.ok ? await r.json() : null;
      const sd = j && j.data && j.data.staticAssignedDriver;
      if (sd && sd.id != null) {
        drvId = String(sd.id);
        run(`UPDATE trucks SET samsara_driver_id = ? WHERE org_id = ? AND number = ?`, drvId, row.org_id, row.number);
      }
    } catch (e) { /* best effort */ }
  }
  if (!drvId) return null;
  const r = await fetch('https://api.samsara.com/fleet/hos/clocks?driverIds=' + encodeURIComponent(drvId),
    { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  if (!r.ok) throw new Error('Samsara hos HTTP ' + r.status);
  const j = await r.json();
  const c = (j.data || [])[0];
  if (!c) return null;
  const ck = c.clocks || {};
  const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null) return Number(o[k]); return null; };
  const drive = pick(ck.drive, 'driveRemainingDurationMs', 'remainingDurationMs', 'driveRemainingMs');
  const shift = pick(ck.shift, 'shiftRemainingDurationMs', 'remainingDurationMs', 'shiftRemainingMs');
  const cycle = pick(ck.cycle, 'cycleRemainingDurationMs', 'remainingDurationMs', 'cycleRemainingMs');
  const tmrw = pick(ck.cycle, 'cycleTomorrowDurationMs');
  const vio = c.violations || {};
  const vShift = pick(vio, 'shiftDrivingViolationDurationMs', 'shiftViolationDurationMs');
  const vCycle = pick(vio, 'cycleViolationDurationMs');
  if (drive == null && shift == null && cycle == null) return null;
  run(`UPDATE trucks SET hos_drive_ms = ?, hos_shift_ms = ?, hos_cycle_ms = ?, hos_cycle_tmrw_ms = ?,
         hos_viol_shift_ms = ?, hos_viol_cycle_ms = ?, hos_at = ?, hos_driver = ?
       WHERE org_id = ? AND number = ?`,
    drive, shift, cycle, tmrw, vShift, vCycle, nowISO(), String((c.driver || {}).name || '').slice(0, 60), row.org_id, row.number);
  return { drive, shift, cycle, tmrw };
}

// ---- HOS DIARIO: cuánto trabajó cada driver CADA día (/fleet/hos/daily-logs) ----
// El historial que el board enseña por fecha. Claves defensivas: Samsara anida las
// duraciones distinto según versión, así que se buscan por patrón en el objeto.
async function fetchHosDailyLogs(token, startISO, endISO) {
  let out = [], after = '', pages = 0;
  do {
    const url = 'https://api.samsara.com/fleet/hos/daily-logs?startDate=' + startISO + '&endDate=' + endISO +
      (after ? '&after=' + encodeURIComponent(after) : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!r.ok) throw new Error('Samsara daily-logs HTTP ' + r.status);
    const j = await r.json();
    out = out.concat(j.data || []);
    after = (j.pagination && j.pagination.hasNextPage) ? j.pagination.endCursor : '';
    pages++;
  } while (after && pages < 30);
  return out;
}
function deepFindMs(obj, re, depth) {
  if (!obj || typeof obj !== 'object' || (depth || 0) > 4) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number' && re.test(k)) return v;
    if (v && typeof v === 'object') { const r = deepFindMs(v, re, (depth || 0) + 1); if (r != null) return r; }
  }
  return null;
}
async function syncHOSDaily(cfg, days) {
  const orgs = all('SELECT * FROM orgs WHERE enabled = 1 AND samsara = 1 ORDER BY sort');
  const today = todayCT();
  const start = new Date(today + 'T12:00:00Z'); start.setUTCDate(start.getUTCDate() - (days || 8));
  const startISO = start.toISOString().slice(0, 10);
  const summary = { entries: 0, saved: 0, skippedOrgs: [] };
  for (const org of orgs) {
    const token = tokenFor(cfg, org.samsara_org);
    if (!token) { summary.skippedOrgs.push(org.id + ' (sin token)'); continue; }
    let logs;
    try { logs = await fetchHosDailyLogs(token, startISO, today); } catch (e) { summary['error_' + org.id] = String(e.message || e); continue; }
    summary.entries += logs.length;
    if (logs[0] && !metaGet('hos_daily_sample')) metaSet('hos_daily_sample', JSON.stringify(logs[0]).slice(0, 900));
    for (const e of logs) {
      const drv = e.driver || {};
      if (drv.id == null) continue;
      const day = String(e.logDate || e.date || e.startTime || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const drive = deepFindMs(e, /^drive.*(durationMs|Ms)$/i);
      const duty = deepFindMs(e, /onDuty.*(durationMs|Ms)$/i);
      if (drive == null && duty == null) continue;
      run(`INSERT INTO hos_days (driver_id, date, name, drive_ms, duty_ms) VALUES (?,?,?,?,?)
           ON CONFLICT(driver_id, date) DO UPDATE SET name = excluded.name, drive_ms = excluded.drive_ms, duty_ms = excluded.duty_ms`,
        String(drv.id), day, String(drv.name || '').slice(0, 60), drive, duty);
      summary.saved++;
    }
  }
  metaSet('last_sync_hos_daily', nowISO());
  return summary;
}

// ---- CÁMARAS: snapshot AL MOMENTO (frontal + cabina) sin abrir Samsara ----
// Pide una captura fresca y espera a que la cámara la suba (~10-20 s). Si no regresa
// nada, la cámara está desconectada / el truck no trae dashcam — el mismo botón sirve
// de prueba de vida para mandar al chofer a revisar el cable.
async function cameraSnapshot(cfg, row) {
  const org = get('SELECT * FROM orgs WHERE id = ?', row.org_id);
  if (!org || !org.samsara) throw new Error('this truck has no Samsara');
  const token = tokenFor(cfg, org.samsara_org);
  if (!token) throw new Error('no Samsara token for ' + org.id);
  if (!row.samsara_id) throw new Error('truck has no Samsara id yet — run Sync now first');

  // La cámara solo graba con el truck ENCENDIDO. Si "ahorita" no está grabando (parado
  // de noche), caemos al último momento en que SÍ grabó: último movimiento / última señal.
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' };
  const tryCreate = async (atISO) => {
    const r = await fetch('https://api.samsara.com/cameras/media/retrieval', {
      method: 'POST', headers,
      body: JSON.stringify({
        startTime: atISO, endTime: atISO, vehicleId: String(row.samsara_id),
        inputs: ['dashcamRoadFacing', 'dashcamDriverFacing'], mediaType: 'image'
      })
    });
    if (r.ok) { const j = await r.json(); return { rid: j && j.data && (j.data.retrievalId || j.data.id) }; }
    const txt = await r.text().catch(() => '');
    if (r.status === 400 && /not recording/i.test(txt)) return { notRecording: true };
    throw new Error('camera request HTTP ' + r.status + (txt ? ' · ' + txt.slice(0, 140) : ''));
  };
  const minusMin = (iso, m) => new Date(Date.parse(iso) - m * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
  const nowISO2 = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const wd = get('SELECT ended_at FROM work_days WHERE org_id = ? AND number = ? AND ended_at IS NOT NULL ORDER BY date DESC LIMIT 1', row.org_id, row.number);
  const candidates = [{ at: nowISO2, live: true }];
  for (const ts of [row.last_moved_at, wd && wd.ended_at, row.samsara_seen_at].filter(Boolean)) {
    candidates.push({ at: minusMin(ts, 2), live: false }); // 2 min antes de apagar: aún grababa
  }
  let rid = null, used = null;
  for (const c of candidates.slice(0, 4)) {
    const res = await tryCreate(c.at);
    if (res.rid) { rid = res.rid; used = c; break; }
    // notRecording → prueba el siguiente candidato
  }
  if (!rid) throw new Error('CAMERA_OFFLINE'); // ni un momento grabado reciente: cámara mal

  const images = new Map();
  for (let i = 0; i < 9; i++) {
    await new Promise(r => setTimeout(r, i === 0 ? 3500 : 2500));
    const r = await fetch('https://api.samsara.com/cameras/media/retrieval?retrievalId=' + encodeURIComponent(rid),
      { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!r.ok) continue;
    const j = await r.json();
    let media = (j.data && (j.data.media || j.data)) || [];
    if (!Array.isArray(media)) media = [];
    for (const m of media) {
      const url = (m.urlInfo && m.urlInfo.url) || m.url || m.downloadUrl;
      if (m.input && url && (!m.status || /available/i.test(String(m.status)))) images.set(m.input, url);
    }
    if (images.size >= 2) break;
  }
  return { images: [...images.entries()].map(([input, url]) => ({ input, url })), at: used.at, live: used.live };
}

// ---- JORNADA: a qué hora PRENDIÓ y APAGÓ cada truck (engine states, eventos ligeros) ----
async function fetchEngineHistory(token, startISO, endISO) {
  let out = [], after = '', pages = 0;
  do {
    const url = 'https://api.samsara.com/fleet/vehicles/stats/history?types=engineStates'
      + '&startTime=' + encodeURIComponent(startISO) + '&endTime=' + encodeURIComponent(endISO)
      + (after ? '&after=' + encodeURIComponent(after) : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!r.ok) throw new Error('Samsara engine history HTTP ' + r.status);
    const j = await r.json();
    out = out.concat(j.data || []);
    after = (j.pagination && j.pagination.hasNextPage) ? j.pagination.endCursor : '';
    pages++;
  } while (after && pages < 40);
  return out;
}
const ctDateOf = t => { try { return new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); } catch (e) { return ''; } };

// started_at = primer "On" del día CT · ended_at = último "Off" (solo si quedó apagado;
// si el último evento es On/Idle sigue afuera → ended_at NULL). Hoy se recalcula en cada
// sync, así que "terminó" aparece solo cuando de verdad apagó.
async function syncWorkTimes(cfg, days) {
  const orgs = all('SELECT * FROM orgs WHERE enabled = 1 AND samsara = 1 ORDER BY sort');
  const today = todayCT();
  const summary = { days: 0, saved: 0, skippedOrgs: [] };
  for (const org of orgs) {
    const token = tokenFor(cfg, org.samsara_org);
    if (!token) { summary.skippedOrgs.push(org.id + ' (sin token)'); continue; }
    for (let d = 0; d < (days || 1); d++) {
      const day = shiftISO(today, -d);
      try {
        // ventana UTC que cubre el día CT completo (CDT/CST); los eventos se
        // clasifican por SU fecha CT real, así que el margen extra no contamina
        const endISO = d === 0 ? nowISO() : shiftISO(day, 1) + 'T07:00:00Z';
        const vehicles = await fetchEngineHistory(token, day + 'T05:00:00Z', endISO);
        for (const v of vehicles) {
          const res = resolveSamsaraTruck(org.id, v.name || '');
          if (!res.row) continue;
          const evs = (v.engineStates || []).filter(e => e && e.time && ctDateOf(e.time) === day)
            .sort((a, b) => a.time < b.time ? -1 : 1);
          if (!evs.length) continue;
          const firstOn = evs.find(e => /on|idle/i.test(String(e.value)));
          if (!firstOn) continue;
          const lastEv = evs[evs.length - 1];
          const ended = /off/i.test(String(lastEv.value)) ? lastEv.time : null; // sigue afuera si no apagó
          run(`INSERT INTO work_days (org_id, number, date, started_at, ended_at) VALUES (?,?,?,?,?)
               ON CONFLICT(org_id, number, date) DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at`,
            org.id, res.row.number, day, firstOn.time, ended);
          summary.saved++;
        }
        summary.days++;
      } catch (e) { summary['error_' + org.id + '_' + day] = String(e.message || e); }
    }
  }
  metaSet('last_sync_worktimes', nowISO());
  return summary;
}

// Diagnóstico HOS de UN truck: por qué sí/no le llegan relojes. Compara el driver de
// NewMile contra los nombres reales de Samsara y enseña candidatos parecidos.
async function debugHOS(cfg, row) {
  const org = get('SELECT * FROM orgs WHERE id = ?', row.org_id);
  if (!org || !org.samsara) return { error: 'org has no Samsara' };
  const token = tokenFor(cfg, org.samsara_org);
  if (!token) return { error: 'no Samsara token for ' + org.id };
  const out = {
    truck: row.display_number || row.number,
    board_driver: row.driver || '(empty)',
    samsara_driver_id_stored: row.samsara_driver_id || null,
    hos_at: row.hos_at || null
  };
  // ¿el vehículo tiene driver asignado en Samsara?
  if (row.samsara_id) {
    try {
      const r = await fetch('https://api.samsara.com/fleet/vehicles/' + encodeURIComponent(row.samsara_id),
        { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
      const j = r.ok ? await r.json() : null;
      const sd = j && j.data && j.data.staticAssignedDriver;
      out.vehicle_assigned_driver = sd ? (sd.name + ' (id ' + sd.id + ')') : 'NONE — assign the driver to the vehicle in Samsara';
    } catch (e) { out.vehicle_assigned_driver = 'error: ' + (e.message || e); }
  } else out.vehicle_assigned_driver = 'truck has no samsara_id yet';
  // relojes en vivo: ¿está el driver? ¿hay nombres parecidos? ¿y qué VALORES manda?
  try {
    const clocks = await fetchHosClocks(token);
    out.clock_drivers_total = clocks.length;
    const parts = String(row.driver || '').split('/').map(normDrvName).filter(Boolean);
    const byId = row.samsara_driver_id && clocks.find(c => String((c.driver || {}).id) === String(row.samsara_driver_id));
    out.clock_by_stored_id = byId ? (byId.driver.name || '?') : null;
    const exact = clocks.filter(c => parts.includes(normDrvName((c.driver || {}).name)));
    out.exact_name_matches = exact.map(c => c.driver.name);
    const tokens = new Set(parts.join(' ').split(' ').filter(w => w.length > 2));
    out.similar_names_in_samsara = clocks
      .map(c => (c.driver || {}).name || '')
      .filter(n => normDrvName(n).split(' ').some(w => tokens.has(w)))
      .slice(0, 8);
    // CRUDO: el JSON tal cual de Samsara (para cachar claves/unidades mal leídas)
    const hit = byId || exact[0];
    out.raw_matched_clocks = hit ? JSON.stringify(hit.clocks || hit).slice(0, 700) : null;
    out.raw_first_entry = clocks[0] ? JSON.stringify(clocks[0]).slice(0, 700) : null;
    // ¿cuántos drivers traen ALGO > 0? (si todos vienen en 0, es cosa de Samsara/ELD)
    const ms = c => { const k = c.clocks || {}; return ['drive', 'shift', 'cycle'].map(x => k[x] || {}).flatMap(o => Object.values(o)).filter(v => typeof v === 'number'); };
    out.drivers_with_nonzero = clocks.filter(c => ms(c).some(v => v > 0)).length;
  } catch (e) { out.clocks_error = String(e.message || e); }
  // historial diario guardado para ESTE driver + muestra cruda del endpoint daily-logs
  out.daily_rows = row.samsara_driver_id
    ? all('SELECT date, drive_ms, duty_ms FROM hos_days WHERE driver_id = ? ORDER BY date DESC LIMIT 8', String(row.samsara_driver_id))
    : [];
  out.daily_sample_raw = (metaGet('hos_daily_sample') || '').slice(0, 500) || null;
  return out;
}

// GPS snapshot with reverse-geo (same endpoint the desktop uses, plus reverseGeo).
async function fetchGps(token) {
  let out = {}, after = '', pages = 0;
  do {
    const url = 'https://api.samsara.com/fleet/vehicles/stats?types=gps' + (after ? '&after=' + encodeURIComponent(after) : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!r.ok) throw new Error('Samsara gps HTTP ' + r.status);
    const j = await r.json();
    for (const v of (j.data || [])) {
      const g = v.gps; if (!g) continue;
      const { number } = splitNameFlag(v.name || '');
      if (!number) continue;
      out[number] = {
        lat: g.latitude != null ? g.latitude : null,
        lon: g.longitude != null ? g.longitude : null,
        time: g.time || null,
        speed: g.speedMilesPerHour != null ? g.speedMilesPerHour : null,
        city: cityFrom(g.reverseGeo && g.reverseGeo.formattedLocation)
      };
    }
    after = (j.pagination && j.pagination.hasNextPage) ? j.pagination.endCursor : '';
    pages++;
  } while (after && pages < 20);
  return out;
}

// PARKING LOCATION = "CIUDAD, ST" siempre. Parsea del FINAL de la dirección:
// "1301 W Washington St, Paris, TX 75460, USA" → "PARIS, TX"
// "Tyler, TX" → "TYLER, TX" · "US-69, TX 75453" → "" (solo carretera: usar nearestTown)
const ROAD_RE = /^(US|I|FM|CR|SH|TX|OK)[-\s]?\d|\b(HWY|HIGHWAY|ROAD|COUNTY|LOOP|INTERSTATE)\b|\bRD$/i;
function cityFrom(formatted) {
  let parts = String(formatted || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  if (/^(USA|UNITED STATES|MEXICO|MX)$/i.test(parts[parts.length - 1])) parts.pop();
  let state = '';
  const m = /^([A-Za-z]{2})(\s+\d{5}(-\d{4})?)?$/.exec(parts[parts.length - 1] || '');
  if (m) { state = m[1].toUpperCase(); parts.pop(); }
  if (!parts.length) return '';
  const rawLast = parts[parts.length - 1];
  // si lo único que quedó parece carretera/calle (no hubo componente de ciudad), no adivinar
  if (parts.length === 1 && ROAD_RE.test(normNum(rawLast))) return '';
  let city = normNum(rawLast.replace(/\d+/g, '').replace(/\s+/g, ' ').trim());
  if (!city || /^[-\s]*$/.test(city)) return '';
  return state ? city + ', ' + state : city;
}

// Map a parked city onto MY area names (fuzzy: exact, prefix either way, MT↔MOUNT).
// Devuelve SIEMPRE un nombre canónico de zona (sin ", TX") — así jamás nacen duplicados.
function mapCityToArea(city, areas) {
  if (!city) return '';
  const c = areaMergeKey(city);
  if (!c) return '';
  for (const a of areas) {
    const n = areaMergeKey(a);
    if (!n || n === 'SIN YARD') continue;
    if (n === c || (c.length >= 4 && n.startsWith(c)) || (n.length >= 4 && c.startsWith(n))) return canonArea(a);
  }
  return canonArea(city); // unknown city: propose the city itself (maybe a new yard)
}

// Historia GPS de una ventana (para reconstruir dónde DURMIÓ cada truck).
// vehicleIds opcional: limita a un truck (p. ej. para buscar su último movimiento).
async function fetchGpsHistory(token, startISO, endISO, vehicleIds) {
  let out = [], after = '', pages = 0;
  do {
    const url = 'https://api.samsara.com/fleet/vehicles/stats/history?types=gps'
      + '&startTime=' + encodeURIComponent(startISO) + '&endTime=' + encodeURIComponent(endISO)
      + (vehicleIds ? '&vehicleIds=' + encodeURIComponent(vehicleIds) : '')
      + (after ? '&after=' + encodeURIComponent(after) : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!r.ok) throw new Error('Samsara gps history HTTP ' + r.status);
    const j = await r.json();
    out = out.concat(j.data || []);
    after = (j.pagination && j.pagination.hasNextPage) ? j.pagination.endCursor : '';
    pages++;
  } while (after && pages < 40);
  return out;
}

// BACKFILL + ACOMODO AUTOMÁTICO: reconstruye el parking de las últimas `days` noches
// (ventana 3-6 AM CT ≈ 08-11Z en verano) y coloca los trucks por área él solo:
//  - sin área o "(SIN YARD)" → área directa (no hay nada que pisar)
//  - KT: área + terminal directas (GPS y/o la letra del nombre); un ⚑ NEW de KT con
//    señal clara se confirma solo — menos revisión manual
//  - área ya curada que no coincide → solo suggested_area (badge de un tap)
async function backfillParking(cfg, days) {
  const orgs = all('SELECT * FROM orgs WHERE enabled = 1 AND samsara = 1 ORDER BY sort');
  const summary = { nights: 0, placedArea: 0, placedDivision: 0, autoConfirmedNew: 0, suggested: 0, orgs: [], errors: [] };
  const today = todayCT();

  for (const org of orgs) {
    const token = tokenFor(cfg, org.samsara_org);
    if (!token) { summary.errors.push(org.id + ': sin token'); continue; }
    summary.orgs.push(org.id);
    for (let d = 1; d <= (days || 2); d++) {
      const day = shiftISO(today, -d + 1); // hoy y hacia atrás
      try {
        const vehicles = await fetchGpsHistory(token, day + 'T08:00:00Z', day + 'T11:00:00Z');
        for (const v of vehicles) {
          const pts = (v.gps || []).filter(g => g.speedMilesPerHour == null || g.speedMilesPerHour < 3);
          if (!pts.length) continue;
          const p = pts[Math.floor(pts.length / 2)]; // punto de media madrugada
          const city = cityFrom(p.reverseGeo && p.reverseGeo.formattedLocation) || nearestTown(p.latitude, p.longitude);
          if (!city) continue;
          const res = resolveSamsaraTruck(org.id, v.name || '');
          let row = res.row;
          if (!row && res.icBare) row = discoverIC(org.id, res.icBare, city, p.latitude, p.longitude, summary);
          if (!row) continue;
          run(`INSERT INTO parking_log (org_id, number, date, city, lat, lon) VALUES (?,?,?,?,?,?)
               ON CONFLICT(org_id, number, date) DO UPDATE SET city = excluded.city, lat = excluded.lat, lon = excluded.lon`,
            org.id, row.number, day, city, p.latitude, p.longitude);
          summary.nights++;
        }
      } catch (e) { summary.errors.push(`${org.id} ${day}: ${e.message}`); }
    }
    applyPlacements(org, summary);
  }
  metaSet('last_gps_backfill', nowISO());
  metaSet('last_gps_backfill_summary', JSON.stringify(summary));
  return summary;
}

// ÚLTIMO MOVIMIENTO EXACTO de un truck: barre su historia GPS hacia atrás (día por
// día, del más reciente al más viejo) y regresa el último instante con velocidad —
// para que el "down since" sea REAL y no una fecha inventada.
async function lastMovementFromHistory(token, vehicleId, days) {
  const today = todayCT();
  for (let d = 0; d < (days || 14); d++) {
    const day = shiftISO(today, -d);
    const rows = await fetchGpsHistory(token, day + 'T00:00:00Z', shiftISO(day, 1) + 'T00:00:00Z', vehicleId);
    let best = null;
    for (const v of rows) {
      for (const p of (v.gps || [])) {
        if (p.speedMilesPerHour != null && p.speedMilesPerHour >= 3 && p.time && (!best || p.time > best)) best = p.time;
      }
    }
    if (best) return best; // el día más reciente con movimiento gana
  }
  return null;
}

const KT_TERMINALS = ['POWDERLY', 'RHOME', 'WHITEWRIGHT'];

// zonas operativas EN USO (cruzan compañías) — contra esto se mapea todo GPS
function knownAreas() {
  return all(`SELECT DISTINCT t.area FROM trucks t JOIN orgs o ON o.id = t.org_id
              WHERE o.enabled = 1 AND t.area IS NOT NULL AND t.area != '' AND t.area != '(SIN YARD)'`).map(r => r.area);
}

// EL GPS ES LA VERDAD (regla del despacho): el truck vive donde DURMIÓ la última noche.
//  - última noche en una zona conocida distinta → SE MUEVE solo (área, y terminal si es KT)
//  - ciudad desconocida → se alinea a la zona de operación más cercana; si ni así,
//    solo suggested_area (zonas nuevas las apruebo yo con un tap)
// Acomoda UN truck; lo usan el sync completo y el ⟳ de cada cuadrito.
function placeTruck(org, t, areas, summary) {
  const nights = all(`SELECT city, lat, lon FROM parking_log WHERE org_id = ? AND number = ? AND city != '' ORDER BY date DESC LIMIT 7`, org.id, t.number);
  // sin noches registradas todavía, la última posición conocida cuenta — un truck CON
  // ubicación jamás se queda tirado en (NO YARD)
  const lastCity = nights.length ? nights[0].city : (t.parked_city || '');
  let target = lastCity ? mapCityToArea(lastCity, areas) : '';
  const isKnown = x => x && areas.some(a => areaMergeKey(a) === areaMergeKey(x));
  // ciudad que no es zona conocida → alinear a la zona de operación más cercana
  if (target && !isKnown(target)) {
    const pt = nights.find(n => n.city === lastCity && n.lat != null)
      || (!nights.length && t.last_lat != null ? { lat: t.last_lat, lon: t.last_lon } : null);
    const town = pt ? nearestTown(pt.lat, pt.lon) : '';
    const t2 = town ? mapCityToArea(town, areas) : '';
    if (isKnown(t2)) target = t2;
  }
  const sets = [], vals = [];
  let terminalMoved = false;

  if (org.id === 'KT' && !t.is_sub) {
    // terminal según dónde durmió ("WHITEWRIGHT, TX" → WHITEWRIGHT); una noche basta
    const cityBase = canonArea(lastCity);
    const gpsTerminal = KT_TERMINALS.includes(cityBase) ? cityBase : null;
    if (gpsTerminal && t.division !== gpsTerminal) {
      sets.push('division = ?', 'area = ?', "suggested_area = ''"); vals.push(gpsTerminal, gpsTerminal);
      summary.terminalMoves = (summary.terminalMoves || 0) + 1;
      terminalMoved = true;
      if (t.is_new) { sets.push('is_new = 0', 'suggested_division = NULL'); summary.autoConfirmedNew = (summary.autoConfirmedNew || 0) + 1; }
    } else if (!t.division) {
      const divGuess = gpsTerminal || ktDivisionHint(t.display_number || '') || null;
      if (divGuess) {
        sets.push('division = ?'); vals.push(divGuess); summary.placedDivision = (summary.placedDivision || 0) + 1;
        if (t.is_new) { sets.push('is_new = 0', 'suggested_division = NULL'); summary.autoConfirmedNew = (summary.autoConfirmedNew || 0) + 1; }
      }
    }
  } else if (org.id === 'KT' && t.is_sub && !t.division && (nights.length || t.parked_city)) {
    sets.push('division = ?'); vals.push('ICS'); summary.placedDivision = (summary.placedDivision || 0) + 1; // IC con GPS confirmado
  }

  if (!terminalMoved && target) {
    if (!t.area || t.area === '(SIN YARD)') {
      sets.push('area = ?'); vals.push(target); summary.placedArea = (summary.placedArea || 0) + 1;
    } else if (areaMergeKey(target) === areaMergeKey(t.area)) {
      if (t.suggested_area) sets.push("suggested_area = ''"); // regresó a casa: limpiar el badge
    } else if (isKnown(target)) {
      // durmió en OTRA zona conocida → se mueve solo, sin preguntar
      sets.push('area = ?', "suggested_area = ''"); vals.push(target);
      summary.movedArea = (summary.movedArea || 0) + 1;
    } else if (t.suggested_area !== target) {
      sets.push('suggested_area = ?'); vals.push(target); summary.suggested = (summary.suggested || 0) + 1;
    }
  }
  if (sets.length) {
    sets.push('updated_at = ?'); vals.push(nowISO());
    run(`UPDATE trucks SET ${sets.join(', ')} WHERE org_id = ? AND number = ?`, ...vals, org.id, t.number);
    return get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', org.id, t.number);
  }
  return null;
}

function applyPlacements(org, summary) {
  const areas = knownAreas();
  // los KT ICs sí entran (tienen Samsara); los subs de Cactus no
  for (const t of all(`SELECT * FROM trucks WHERE org_id = ? AND archived = 0 AND (is_sub = 0 OR org_id = 'KT')`, org.id)) {
    placeTruck(org, t, areas, summary);
  }
}

async function syncSamsara(cfg, opts) {
  const light = !!(opts && opts.light); // SYNC NOW del botón: fresco sí, histórico pesado no
  const orgs = all('SELECT * FROM orgs WHERE enabled = 1 AND samsara = 1 ORDER BY sort');
  const summary = { vehicles: 0, matched: 0, flags: 0, suggestions: 0, gps: 0, parkingLogged: 0, areaSuggestions: 0, skippedOrgs: [] };
  const vehiclesByOrg = new Map(); // se los pasamos a syncHOS para no pedirlos DOS veces

  // Las orgs corren EN PARALELO (Cactus y KT a la vez): mitad del tiempo de pared
  await Promise.all(orgs.map((org) => (async () => {
    const token = tokenFor(cfg, org.samsara_org);
    if (!token) { summary.skippedOrgs.push(org.id + ' (sin token)'); return; }

    const divs = all('SELECT * FROM divisions WHERE org_id = ?', org.id);
    const tagToDiv = new Map(divs.filter(d => d.samsara_tag_id).map(d => [String(d.samsara_tag_id), d.id]));

    const vehicles = await fetchVehicles(token);
    vehiclesByOrg.set(org.id, vehicles);
    summary.vehicles += vehicles.length;

    for (const v of vehicles) {
      const parsed = splitNameFlag(v.name || '');
      const flag = parsed.flag;
      const res = resolveSamsaraTruck(org.id, v.name || '');
      let row = res.row;
      // IC en la lista de vehículos pero sin señal de GPS todavía: se crea AQUÍ para
      // que TODOS los ICs de Samsara existan en el board desde el primer sync
      if (!row && res.icBare) row = discoverIC(org.id, res.icBare, '', null, null, summary);
      if (!row) continue;
      summary.matched++;

      const sets = [], vals = [];
      const sid = v.id != null ? String(v.id) : null;
      if (sid && sid !== row.samsara_id) { sets.push('samsara_id = ?'); vals.push(sid); }
      // driver asignado al vehículo en Samsara → mapea los relojes de HOS a ESTE truck
      const sdrv = v.staticAssignedDriver && v.staticAssignedDriver.id != null ? String(v.staticAssignedDriver.id) : null;
      if (sdrv && sdrv !== row.samsara_driver_id) { sets.push('samsara_driver_id = ?'); vals.push(sdrv); }
      if (flag !== (row.samsara_flag || '')) { sets.push('samsara_flag = ?'); vals.push(flag); if (flag) summary.flags++; }

      // terminal → suggestion ONLY while the truck has no division (⚑ NUEVO).
      // KT: la letra del nombre ("KT-7040 P") manda; si no hay letra, el tag de terminal.
      if (!row.division) {
        const tagIds = (v.tags || []).map(t => String(t.id));
        const div = (org.id === 'KT' && ktDivisionHint(v.name || '')) || tagIds.map(t => tagToDiv.get(t)).find(Boolean);
        if (div && div !== row.suggested_division) { sets.push('suggested_division = ?'); vals.push(div); summary.suggestions++; }
      }
      if (sets.length) {
        sets.push('updated_at = ?'); vals.push(nowISO());
        run(`UPDATE trucks SET ${sets.join(', ')} WHERE org_id = ? AND number = ?`, ...vals, org.id, row.number);
      }
    }

    // ---- GPS: última posición siempre; parking log solo en la ventana 3-6 AM CT ----
    try {
      const gps = await fetchGps(token);
      const { hour } = ctParts();
      // parking real: madrugada (3-6) o FIN DEL DÍA (7-11 PM) — donde queda parado
      const isSleepWindow = (hour >= 3 && hour < 6) || (hour >= 19 && hour <= 23);
      const today = todayCT();
      for (const [rawNumber, g] of Object.entries(gps)) {
        const res = resolveSamsaraTruck(org.id, rawNumber);
        let row = res.row;
        if (!row && res.icBare) row = discoverIC(org.id, res.icBare, g.city, g.lat, g.lon, summary);
        if (!row) continue;
        summary.gps++;
        // señal VIVA: llegó lectura GPS de este truck (aunque sea vieja, trae timestamp
        // real del equipo — si el equipo murió, este campo se queda congelado y el board avisa)
        if (g.time) run(`UPDATE trucks SET samsara_seen_at = ? WHERE org_id = ? AND number = ? AND (samsara_seen_at = '' OR samsara_seen_at < ?)`, g.time, org.id, row.number, g.time);
        // reverse-geo sin ciudad (pura carretera) → pueblo de operación más cercano;
        // y JAMÁS pisar una ubicación conocida con un blanco — se queda la última buena
        const city = g.city || nearestTown(g.lat, g.lon) || '';
        if (city) {
          run(`UPDATE trucks SET parked_city = ?, parked_at = ? WHERE org_id = ? AND number = ?`,
            city, g.time || '', org.id, row.number);
        }
        // movimiento REAL: rodando ahorita, o se desplazó >500 m desde la última lectura
        const moved = (g.speed != null && g.speed >= 3) ||
          (row.last_lat != null && g.lat != null && distKm(row.last_lat, row.last_lon, g.lat, g.lon) > 0.5);
        if (g.lat != null) {
          run(`UPDATE trucks SET last_lat = ?, last_lon = ?${moved ? ', last_moved_at = ?' : ''} WHERE org_id = ? AND number = ?`,
            g.lat, g.lon, ...(moved ? [g.time || nowISO()] : []), org.id, row.number);
        } else if (moved) {
          run(`UPDATE trucks SET last_moved_at = ? WHERE org_id = ? AND number = ?`, g.time || nowISO(), org.id, row.number);
        }
        // parked = sleep window and not rolling
        if (isSleepWindow && (g.speed == null || g.speed < 3) && city) {
          run(`INSERT INTO parking_log (org_id, number, date, city, lat, lon) VALUES (?,?,?,?,?,?)
               ON CONFLICT(org_id, number, date) DO UPDATE SET city = excluded.city, lat = excluded.lat, lon = excluded.lon`,
            org.id, row.number, today, city, g.lat, g.lon);
          summary.parkingLogged++;
        }
      }
      // el sync TAMBIÉN re-acomoda por GPS: terminal/zona se corrigen solas aquí mismo
      applyPlacements(org, summary);
    } catch (e) {
      summary.gpsError = String(e.message || e);
    }
  })().catch((e) => { summary['orgError_' + org.id] = String(e.message || e); })));

  if (!(opts && opts.skipExtras)) {
    // HOS de pasada: el mismo SYNC NOW / sync diario deja las horas al día
    try { summary.hos = await syncHOS(cfg, vehiclesByOrg); } catch (e) { summary.hosError = String(e.message || e); }
    // HISTORIAL diario: el botón solo trae lo fresco (2 días); el sync nocturno los 8
    try { summary.hosDaily = await syncHOSDaily(cfg, light ? 2 : 8); } catch (e) { summary.hosDailyError = String(e.message || e); }
    // y la JORNADA (prendió/apagó): hoy en el botón, hoy+ayer en el nocturno
    try { summary.workTimes = await syncWorkTimes(cfg, light ? 1 : 2); } catch (e) { summary.workTimesError = String(e.message || e); }
  }

  metaSet('last_sync_samsara', nowISO());
  metaSet('last_sync_samsara_summary', JSON.stringify(summary));
  // la lista de vehículos viaja al caller (SYNC NOW por fases la reusa) pero NO al meta
  Object.defineProperty(summary, 'vehiclesByOrg', { value: vehiclesByOrg, enumerable: false });
  return summary;
}

// GPS en vivo de UN truck (botón ↻ del cuadrito): consulta Samsara al momento y
// actualiza su parking location real.
async function locateTruck(cfg, orgRow, truck) {
  const token = tokenFor(cfg, orgRow.samsara_org);
  if (!token) throw new Error('no Samsara token for ' + orgRow.id);
  let g = null;
  if (truck.samsara_id) {
    const r = await fetch('https://api.samsara.com/fleet/vehicles/stats?types=gps&vehicleIds=' + encodeURIComponent(truck.samsara_id),
      { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (r.ok) { const j = await r.json(); const v = (j.data || [])[0]; if (v && v.gps) g = v.gps; }
  }
  if (!g) { // sin id guardado: snapshot completo y matchear por nombre
    const snap = await fetchGps(token);
    for (const [rawName, gg] of Object.entries(snap)) {
      const res = resolveSamsaraTruck(orgRow.id, rawName);
      if (res.row && res.row.number === truck.number) { g = { latitude: gg.lat, longitude: gg.lon, time: gg.time, speedMilesPerHour: gg.speed, reverseGeo: { formattedLocation: gg.rawGeo || '' } }; if (gg.city) g._city = gg.city; break; }
    }
  }
  if (!g) throw new Error('truck not found in Samsara');
  // señal viva confirmada por el ↻ (el timestamp real del equipo manda)
  if (g.time) run(`UPDATE trucks SET samsara_seen_at = ? WHERE org_id = ? AND number = ? AND (samsara_seen_at = '' OR samsara_seen_at < ?)`, g.time, truck.org_id, truck.number, g.time);
  const city = g._city || cityFrom(g.reverseGeo && g.reverseGeo.formattedLocation) || nearestTown(g.latitude, g.longitude);
  // ubicación conocida jamás se pisa con un blanco — se queda la última buena
  if (city) {
    run(`UPDATE trucks SET parked_city = ?, parked_at = ?, updated_at = ? WHERE org_id = ? AND number = ?`,
      city, g.time || nowISO(), nowISO(), truck.org_id, truck.number);
  }
  const speed = g.speedMilesPerHour != null ? g.speedMilesPerHour : null;
  // movimiento real: rodando ahorita, o se desplazó >500 m desde la última lectura
  const movedNow = (speed != null && speed >= 3) ||
    (truck.last_lat != null && g.latitude != null && distKm(truck.last_lat, truck.last_lon, g.latitude, g.longitude) > 0.5);
  if (g.latitude != null) {
    run(`UPDATE trucks SET last_lat = ?, last_lon = ?${movedNow ? ', last_moved_at = ?' : ''} WHERE org_id = ? AND number = ?`,
      g.latitude, g.longitude, ...(movedNow ? [g.time || nowISO()] : []), truck.org_id, truck.number);
  }
  // EL REFRESH ES LA VERDAD: si está estacionado (no rodando), esa es su ubicación de
  // hoy → se registra y el truck se va SOLO a su terminal/zona correspondiente.
  let moved = null, lastMoved = null;
  if (city && (speed == null || speed < 3)) {
    run(`INSERT INTO parking_log (org_id, number, date, city, lat, lon) VALUES (?,?,?,?,?,?)
         ON CONFLICT(org_id, number, date) DO UPDATE SET city = excluded.city, lat = excluded.lat, lon = excluded.lon`,
      truck.org_id, truck.number, todayCT(), city, g.latitude == null ? null : g.latitude, g.longitude == null ? null : g.longitude);
    const fresh = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', truck.org_id, truck.number);
    const after = placeTruck(orgRow, fresh, knownAreas(), {});
    if (after && (after.area !== truck.area || after.division !== truck.division)) {
      moved = { area: after.area, division: after.division };
    }
    // parado + con id: buscar en la historia el último movimiento REAL (down exacto)
    if (!movedNow && truck.samsara_id) {
      try {
        lastMoved = await lastMovementFromHistory(token, truck.samsara_id, 14);
        if (lastMoved) {
          run(`UPDATE trucks SET last_moved_at = ? WHERE org_id = ? AND number = ? AND (last_moved_at = '' OR last_moved_at IS NULL OR last_moved_at < ?)`,
            lastMoved, truck.org_id, truck.number, lastMoved);
        }
      } catch (e) { /* best-effort: el locate no falla por la historia */ }
    }
  }
  const finalRow = get('SELECT last_moved_at FROM trucks WHERE org_id = ? AND number = ?', truck.org_id, truck.number);
  return { city: city || '', time: g.time || null, speed, moved, last_moved_at: (finalRow && finalRow.last_moved_at) || null };
}

module.exports = { syncSamsara, syncHOS, syncHOSDaily, syncWorkTimes, refreshHOSTruck, cameraSnapshot, debugHOS, auditHOS, backfillParking, applyPlacements, placeTruck, mapCityToArea, nearestTown, discoverIC, resolveSamsaraTruck, locateTruck };
