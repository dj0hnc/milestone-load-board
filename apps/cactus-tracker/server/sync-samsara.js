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
 *    current position (reverse-geo city) as "última posición"; runs inside the 3–6 AM
 *    CT window also log it as that day's parking spot. The majority city of the last
 *    7 nights becomes suggested_area when it differs from my assignment — shown as a
 *    "📍 duerme en X" badge that I accept or dismiss. Nothing moves by itself.
 */
const fs = require('fs');
const { all, get, run, metaGet, metaSet, nowISO } = require('./db');
const { splitNameFlag, canonicalTruckNumber, ktDivisionHint, ctParts, todayCT, shiftISO, normNum } = require('./util');

// Fallback de ciudad cuando el reverse-geo no viene: pueblo más cercano de la operación.
const TOWNS = [
  ['PARIS', 33.662, -95.548], ['POWDERLY', 33.811, -95.506], ['HUGO', 34.011, -95.510],
  ['BLOSSOM', 33.662, -95.385], ['CLARKSVILLE', 33.611, -95.053], ['DETROIT', 33.662, -95.267],
  ['BOGATA', 33.470, -95.213], ['COOPER', 33.373, -95.692], ['CAMPBELL', 33.148, -95.951],
  ['PECAN GAP', 33.438, -95.851], ['SAVOY', 33.600, -96.366], ['SCROGGINS', 33.023, -95.211],
  ['MT VERNON', 33.188, -95.221], ['SULPHUR SPRINGS', 33.138, -95.601], ['ALBA', 32.792, -95.634],
  ['GILMER', 32.729, -94.942], ['SAWYER', 34.023, -95.364], ['VALLIANT', 34.004, -95.093],
  ['EAGLETOWN', 34.036, -94.565], ['TYLER', 32.351, -95.301], ['DALLAS', 32.777, -96.797],
  ['KAUFMAN', 32.589, -96.309], ['ATHENS', 32.205, -95.856], ['LONGVIEW', 32.501, -94.740],
  ['CORSICANA', 32.095, -96.469], ['KERENS', 32.132, -96.228], ['ENNIS', 32.329, -96.625],
  ['RHOME', 33.054, -97.472], ['WHITEWRIGHT', 33.513, -96.407], ['GREENVILLE', 33.138, -96.111]
];
function nearestTown(lat, lon) {
  if (lat == null || lon == null) return '';
  let best = '', bestD = Infinity;
  for (const [name, tl, tn] of TOWNS) {
    const d = Math.pow((lat - tl) * 111, 2) + Math.pow((lon - tn) * 92, 2); // km² aprox
    if (d < bestD) { bestD = d; best = name; }
  }
  return bestD <= 40 * 40 ? best : ''; // más de ~40 km de todo lo conocido: no adivinar
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
function samsaraTruck(orgId, number) {
  let row = get(`SELECT * FROM trucks WHERE org_id = ? AND number = ? AND (is_sub = 0 OR org_id = 'KT')`, orgId, number);
  if (!row && orgId === 'KT' && /^\d{1,3}$/.test(number)) {
    row = get(`SELECT * FROM trucks WHERE org_id = 'KT' AND number = ?`, 'CKJ' + number);
  }
  return row;
}

// DESCUBRIMIENTO de CKJ ICs desde Samsara: un vehículo del org CKJ con nombre de puros
// 1-3 dígitos ("450", "479") ES un IC. Si no está en el roster, se crea CONFIRMADO bajo
// CKJ ICS con su ciudad de estacionamiento — sin esperar a que corra una carga en NewMile.
function discoverIC(orgId, number, city, lat, lon, summary) {
  if (orgId !== 'KT' || !/^\d{1,3}$/.test(number)) return null;
  const icNum = 'CKJ' + number;
  run(`INSERT INTO trucks (org_id, number, display_number, division, area, tags, is_sub, is_new, updated_at)
       VALUES ('KT', ?, ?, 'ICS', ?, 'CKJ IC', 1, 0, ?)
       ON CONFLICT(org_id, number) DO NOTHING`,
    icNum, icNum, city || '(SIN YARD)', nowISO());
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

// "123 CR 4520, Paris, TX 75462" → PARIS · "Tyler, TX" → TYLER
function cityFrom(formatted) {
  const parts = String(formatted || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  const raw = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
  return normNum(raw.replace(/\d+/g, '').trim());
}

// Map a parked city onto MY area names (fuzzy: exact, prefix either way, MT↔MOUNT).
function mapCityToArea(city, areas) {
  if (!city) return '';
  const norm = s => normNum(s).replace(/^MOUNT\b/, 'MT').replace(/[^A-Z0-9 ]/g, '');
  const c = norm(city);
  for (const a of areas) {
    const n = norm(a);
    if (!n || n === '(SIN YARD)') continue;
    if (n === c || (c.length >= 4 && n.startsWith(c)) || (n.length >= 4 && c.startsWith(n))) return a;
  }
  return city; // unknown city: propose the city itself (maybe a new yard)
}

// Majority parked city of the last 7 nights → suggested_area when it disagrees with me.
function computeAreaSuggestions(orgId, summary) {
  const areas = all(`SELECT DISTINCT area FROM trucks WHERE org_id = ? AND area IS NOT NULL AND area != ''`, orgId).map(r => r.area);
  const trucks = all(`SELECT * FROM trucks WHERE org_id = ? AND is_sub = 0 AND archived = 0`, orgId);
  for (const t of trucks) {
    const nights = all(`SELECT city FROM parking_log WHERE org_id = ? AND number = ? AND city != '' ORDER BY date DESC LIMIT 7`, orgId, t.number);
    if (!nights.length) continue;
    const count = {};
    for (const n of nights) count[n.city] = (count[n.city] || 0) + 1;
    const [topCity, votes] = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
    // one lone night is not "vive ahí" unless the truck has no area yet
    if (votes < 2 && t.area && t.area !== '(SIN YARD)') continue;
    const suggestion = mapCityToArea(topCity, areas);
    const cur = normNum(t.area || '');
    if (suggestion && normNum(suggestion) !== cur && suggestion !== t.suggested_area) {
      run(`UPDATE trucks SET suggested_area = ?, updated_at = ? WHERE org_id = ? AND number = ?`,
        suggestion, nowISO(), orgId, t.number);
      summary.areaSuggestions++;
    } else if (suggestion && normNum(suggestion) === cur && t.suggested_area) {
      run(`UPDATE trucks SET suggested_area = '' WHERE org_id = ? AND number = ?`, orgId, t.number); // moved back home
    }
  }
}

// Historia GPS de una ventana (para reconstruir dónde DURMIÓ cada truck).
async function fetchGpsHistory(token, startISO, endISO) {
  let out = [], after = '', pages = 0;
  do {
    const url = 'https://api.samsara.com/fleet/vehicles/stats/history?types=gps'
      + '&startTime=' + encodeURIComponent(startISO) + '&endTime=' + encodeURIComponent(endISO)
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
          const { number: rawNum } = splitNameFlag(v.name || '');
          const number = canonicalTruckNumber(org.id, rawNum);
          if (!number) continue;
          const pts = (v.gps || []).filter(g => g.speedMilesPerHour == null || g.speedMilesPerHour < 3);
          if (!pts.length) continue;
          const p = pts[Math.floor(pts.length / 2)]; // punto de media madrugada
          const city = cityFrom(p.reverseGeo && p.reverseGeo.formattedLocation) || nearestTown(p.latitude, p.longitude);
          if (!city) continue;
          let row = samsaraTruck(org.id, number);
          if (!row) row = discoverIC(org.id, number, city, p.latitude, p.longitude, summary);
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

const KT_TERMINALS = ['POWDERLY', 'RHOME', 'WHITEWRIGHT'];
function applyPlacements(org, summary) {
  const areas = all(`SELECT DISTINCT area FROM trucks WHERE org_id = ? AND area IS NOT NULL AND area != ''`, org.id).map(r => r.area);
  // los KT ICs sí entran (tienen Samsara); los subs de Cactus no
  for (const t of all(`SELECT * FROM trucks WHERE org_id = ? AND archived = 0 AND (is_sub = 0 OR org_id = 'KT')`, org.id)) {
    const nights = all(`SELECT city FROM parking_log WHERE org_id = ? AND number = ? AND city != '' ORDER BY date DESC LIMIT 7`, org.id, t.number);
    const count = {};
    for (const n of nights) count[n.city] = (count[n.city] || 0) + 1;
    const topCity = Object.entries(count).sort((a, b) => b[1] - a[1]).map(e => e[0])[0] || '';
    const target = topCity ? mapCityToArea(topCity, areas) : '';
    const sets = [], vals = [];

    if (org.id === 'KT') {
      const divGuess = (KT_TERMINALS.includes(normNum(topCity)) ? normNum(topCity) : null)
        || ktDivisionHint(t.display_number || '')
        || (t.is_sub && nights.length ? 'ICS' : null) // IC con GPS confirmado → su terminal ICS
        || null;
      if (!t.division && divGuess) {
        sets.push('division = ?'); vals.push(divGuess); summary.placedDivision++;
        if (t.is_new) { sets.push('is_new = 0', "suggested_division = NULL"); summary.autoConfirmedNew++; }
      }
      if (target && (!t.area || t.area === '(SIN YARD)')) { sets.push('area = ?'); vals.push(target); summary.placedArea++; }
      else if (target && normNum(target) !== normNum(t.area || '') && t.suggested_area !== target) { sets.push('suggested_area = ?'); vals.push(target); summary.suggested++; }
    } else {
      if (target && (!t.area || t.area === '(SIN YARD)')) { sets.push('area = ?'); vals.push(target); summary.placedArea++; }
      else if (target && normNum(target) !== normNum(t.area || '') && t.suggested_area !== target) { sets.push('suggested_area = ?'); vals.push(target); summary.suggested++; }
    }
    if (sets.length) {
      sets.push('updated_at = ?'); vals.push(nowISO());
      run(`UPDATE trucks SET ${sets.join(', ')} WHERE org_id = ? AND number = ?`, ...vals, org.id, t.number);
    }
  }
}

async function syncSamsara(cfg) {
  const orgs = all('SELECT * FROM orgs WHERE enabled = 1 AND samsara = 1 ORDER BY sort');
  const summary = { vehicles: 0, matched: 0, flags: 0, suggestions: 0, gps: 0, parkingLogged: 0, areaSuggestions: 0, skippedOrgs: [] };

  for (const org of orgs) {
    const token = tokenFor(cfg, org.samsara_org);
    if (!token) { summary.skippedOrgs.push(org.id + ' (sin token)'); continue; }

    const divs = all('SELECT * FROM divisions WHERE org_id = ?', org.id);
    const tagToDiv = new Map(divs.filter(d => d.samsara_tag_id).map(d => [String(d.samsara_tag_id), d.id]));

    const vehicles = await fetchVehicles(token);
    summary.vehicles += vehicles.length;

    for (const v of vehicles) {
      const parsed = splitNameFlag(v.name || '');
      const number = canonicalTruckNumber(org.id, parsed.number); // CKJ: "KT-7045" → 7045
      const flag = parsed.flag;
      if (!number) continue;
      const row = samsaraTruck(org.id, number);
      if (!row) continue;
      summary.matched++;

      const sets = [], vals = [];
      const sid = v.id != null ? String(v.id) : null;
      if (sid && sid !== row.samsara_id) { sets.push('samsara_id = ?'); vals.push(sid); }
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
      const isSleepWindow = hour >= 3 && hour < 6;
      const today = todayCT();
      for (const [rawNumber, g] of Object.entries(gps)) {
        const number = canonicalTruckNumber(org.id, rawNumber);
        let row = samsaraTruck(org.id, number);
        if (!row) row = discoverIC(org.id, number, g.city, g.lat, g.lon, summary);
        if (!row) continue;
        summary.gps++;
        run(`UPDATE trucks SET parked_city = ?, parked_at = ? WHERE org_id = ? AND number = ?`,
          g.city || '', g.time || '', org.id, row.number);
        // parked = sleep window and not rolling
        if (isSleepWindow && (g.speed == null || g.speed < 3) && g.city) {
          run(`INSERT INTO parking_log (org_id, number, date, city, lat, lon) VALUES (?,?,?,?,?,?)
               ON CONFLICT(org_id, number, date) DO UPDATE SET city = excluded.city, lat = excluded.lat, lon = excluded.lon`,
            org.id, row.number, today, g.city, g.lat, g.lon);
          summary.parkingLogged++;
        }
      }
      computeAreaSuggestions(org.id, summary);
    } catch (e) {
      summary.gpsError = String(e.message || e);
    }
  }

  metaSet('last_sync_samsara', nowISO());
  metaSet('last_sync_samsara_summary', JSON.stringify(summary));
  return summary;
}

module.exports = { syncSamsara, backfillParking, applyPlacements, nearestTown, discoverIC };
