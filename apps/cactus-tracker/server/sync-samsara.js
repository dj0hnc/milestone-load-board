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
const { all, get, run, metaSet, nowISO } = require('./db');
const { splitNameFlag, ctParts, todayCT, normNum } = require('./util');

function tokenFor(cfg, orgName) {
  const toks = (cfg.samsara && cfg.samsara.tokens) || [];
  const t = toks.find(x => x && x.name === orgName && x.token);
  return t ? t.token : null;
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
      const { number, flag } = splitNameFlag(v.name || '');
      if (!number) continue;
      // subs are never in Samsara — the is_sub filter is belt & suspenders
      const row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ? AND is_sub = 0', org.id, number);
      if (!row) continue;
      summary.matched++;

      const sets = [], vals = [];
      const sid = v.id != null ? String(v.id) : null;
      if (sid && sid !== row.samsara_id) { sets.push('samsara_id = ?'); vals.push(sid); }
      if (flag !== (row.samsara_flag || '')) { sets.push('samsara_flag = ?'); vals.push(flag); if (flag) summary.flags++; }

      // terminal tag → suggestion ONLY while the truck has no division (⚑ NUEVO)
      if (!row.division) {
        const tagIds = (v.tags || []).map(t => String(t.id));
        const div = tagIds.map(t => tagToDiv.get(t)).find(Boolean);
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
      for (const [number, g] of Object.entries(gps)) {
        const row = get('SELECT number, is_sub FROM trucks WHERE org_id = ? AND number = ? AND is_sub = 0', org.id, number);
        if (!row) continue;
        summary.gps++;
        run(`UPDATE trucks SET parked_city = ?, parked_at = ? WHERE org_id = ? AND number = ?`,
          g.city || '', g.time || '', org.id, number);
        // parked = sleep window and not rolling
        if (isSleepWindow && (g.speed == null || g.speed < 3) && g.city) {
          run(`INSERT INTO parking_log (org_id, number, date, city, lat, lon) VALUES (?,?,?,?,?,?)
               ON CONFLICT(org_id, number, date) DO UPDATE SET city = excluded.city, lat = excluded.lat, lon = excluded.lon`,
            org.id, number, today, g.city, g.lat, g.lon);
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

module.exports = { syncSamsara };
