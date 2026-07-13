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
  const lastCity = nights.length ? nights[0].city : '';
  let target = lastCity ? mapCityToArea(lastCity, areas) : '';
  const isKnown = x => x && areas.some(a => areaMergeKey(a) === areaMergeKey(x));
  // ciudad que no es zona conocida → alinear a la zona de operación más cercana
  if (target && !isKnown(target)) {
    const pt = nights.find(n => n.city === lastCity && n.lat != null);
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
  } else if (org.id === 'KT' && t.is_sub && !t.division && nights.length) {
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
      const flag = parsed.flag;
      const res = resolveSamsaraTruck(org.id, v.name || '');
      const row = res.row;
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
      // parking real: madrugada (3-6) o FIN DEL DÍA (7-11 PM) — donde queda parado
      const isSleepWindow = (hour >= 3 && hour < 6) || (hour >= 19 && hour <= 23);
      const today = todayCT();
      for (const [rawNumber, g] of Object.entries(gps)) {
        const res = resolveSamsaraTruck(org.id, rawNumber);
        let row = res.row;
        if (!row && res.icBare) row = discoverIC(org.id, res.icBare, g.city, g.lat, g.lon, summary);
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
      // el sync TAMBIÉN re-acomoda por GPS: terminal/zona se corrigen solas aquí mismo
      applyPlacements(org, summary);
    } catch (e) {
      summary.gpsError = String(e.message || e);
    }
  }

  metaSet('last_sync_samsara', nowISO());
  metaSet('last_sync_samsara_summary', JSON.stringify(summary));
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
  const city = g._city || cityFrom(g.reverseGeo && g.reverseGeo.formattedLocation) || nearestTown(g.latitude, g.longitude);
  run(`UPDATE trucks SET parked_city = ?, parked_at = ?, updated_at = ? WHERE org_id = ? AND number = ?`,
    city || '', g.time || nowISO(), nowISO(), truck.org_id, truck.number);
  // EL REFRESH ES LA VERDAD: si está estacionado (no rodando), esa es su ubicación de
  // hoy → se registra y el truck se va SOLO a su terminal/zona correspondiente.
  const speed = g.speedMilesPerHour != null ? g.speedMilesPerHour : null;
  let moved = null;
  if (city && (speed == null || speed < 3)) {
    run(`INSERT INTO parking_log (org_id, number, date, city, lat, lon) VALUES (?,?,?,?,?,?)
         ON CONFLICT(org_id, number, date) DO UPDATE SET city = excluded.city, lat = excluded.lat, lon = excluded.lon`,
      truck.org_id, truck.number, todayCT(), city, g.latitude == null ? null : g.latitude, g.longitude == null ? null : g.longitude);
    const fresh = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', truck.org_id, truck.number);
    const after = placeTruck(orgRow, fresh, knownAreas(), {});
    if (after && (after.area !== truck.area || after.division !== truck.division)) {
      moved = { area: after.area, division: after.division };
    }
  }
  return { city: city || '', time: g.time || null, speed, moved };
}

module.exports = { syncSamsara, backfillParking, applyPlacements, placeTruck, mapCityToArea, nearestTown, discoverIC, resolveSamsaraTruck, locateTruck };
