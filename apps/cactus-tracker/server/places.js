'use strict';
/*
 * 📍 PLACES — the plants, pits, rail yards and drop-off sites we actually work with, on the map.
 *
 * NewMile has NO coordinates for the pickups/drop-offs we use every day (Tyler Rail, Bells Savoy,
 * Bridgeport, Corsicana Yard, Arcosa Cottonwood, every Quikrete / Texas Materials plant…): an order
 * only carries `vendor_location` / `delivery_location` NAME strings. org_location (our own saved
 * locations) does have lat/lng but covers customers / jobsites, not the plants.
 *
 * So this module BUILDS the catalog:
 *   1. names from the orders of the last N days (pickup = vendor_location, drop = delivery_location)
 *      with how many orders / loads touched them;
 *   2. our org_location entries (exact coordinates) — also used to resolve order names;
 *   3. a geocode (Google via NewMile's geocode_address) for names still without coordinates, with a
 *      quality gate: street/route → exact, city-only → approx (the pin sits on the town, Juan drags
 *      it), state-only → unresolved;
 *   4. MERGE of aliases: same brand + same core tokens ("Martin Marietta - Tyler Rail" = "MM Tyler
 *      Rail" = "Tyler Yard"), or same brand within 1.2 km. The busiest name is the primary.
 *   5. manual pins (status 'manual') always win and are never overwritten by a rebuild.
 */
const { all, get, run, metaGet, metaSet, nowISO } = require('./db');
const { todayCT, shiftISO, normNum, canonicalTruckNumber } = require('./util');

run(`CREATE TABLE IF NOT EXISTS places (
  key TEXT PRIMARY KEY,            -- normalized name
  name TEXT DEFAULT '',            -- as NewMile shows it (most common spelling)
  kind TEXT DEFAULT '',            -- pickup | dropoff | both | site (org_location only)
  brand TEXT DEFAULT '',           -- QUIKRETE, MM, RKH, TXMAT, HEIDELBERG, ARCOSA, VULCAN…
  core TEXT DEFAULT '',            -- tokens left after brand + stop words (TYLER, BELLS SAVOY…)
  lat REAL, lon REAL,
  status TEXT DEFAULT 'new',       -- new | exact | approx | unresolved | manual | hidden
  geo_query TEXT DEFAULT '', geo_addr TEXT DEFAULT '',
  orders30 INTEGER DEFAULT 0, loads30 INTEGER DEFAULT 0, pickups30 INTEGER DEFAULT 0, drops30 INTEGER DEFAULT 0,
  last_seen TEXT DEFAULT '', src TEXT DEFAULT '', nm_location_id INTEGER,
  updated_at TEXT DEFAULT ''
)`);

// ---------- brands (logo + color) ----------
const BRANDS = [
  { id: 'QUIKRETE', re: /\bQUIKRETE\b|\bQK\b|\bQUICKRETE\b/, name: 'Quikrete', domain: 'quikrete.com', color: '#c8102e' },
  { id: 'TXMAT', re: /TEXAS MATERIALS|\bTX MAT\b|\bTXMAT\b|\bTX MATERIALS\b/, name: 'Texas Materials', domain: 'texasmaterials.com', color: '#0b5394' },
  { id: 'MM', re: /MARTIN MARIETTA|\bMM\b|\bMLM\b/, name: 'Martin Marietta', domain: 'martinmarietta.com', color: '#1f4e79' },
  { id: 'RKH', re: /\bR\.? ?K\.? ?HALL\b|\bRKH\b|\bRK HALL\b/, name: 'R.K. Hall', domain: 'rkhall.com', color: '#7a5c1e' },
  { id: 'HEIDELBERG', re: /HEIDELBERG|HEILDEBERG|\bHBP\b|\bHM\b/, name: 'Heidelberg Materials', domain: 'heidelbergmaterials.us', color: '#00693e' },
  { id: 'ARCOSA', re: /\bARCOSA\b|\bAC\b(?=\s|$|-)/, name: 'Arcosa', domain: 'arcosa.com', color: '#e07b00' },
  { id: 'VULCAN', re: /\bVULCAN\b/, name: 'Vulcan Materials', domain: 'vulcanmaterials.com', color: '#5b6770' },
  { id: 'AMRIZE', re: /\bAMRIZE\b|\bHOLCIM\b/, name: 'Amrize', domain: 'amrize.com', color: '#0a4b78' },
  { id: 'CEMEX', re: /\bCEMEX\b/, name: 'Cemex', domain: 'cemex.com', color: '#005ba8' },
  { id: 'LHOIST', re: /\bLHOIST\b/, name: 'Lhoist', domain: 'lhoist.com', color: '#5c2d91' },
  { id: 'SNYDER', re: /\bSNYDER QUARRY\b/, name: 'Snyder Quarry', domain: '', color: '#6b4f2a' },
  { id: 'CSI', re: /\bCSI\b|\bRMC\b/, name: 'CSI', domain: '', color: '#444' },
  { id: 'INDUS', re: /\bINDUS\b/, name: 'Indus', domain: '', color: '#444' },
];
const STOP = new Set(['RAIL', 'YARD', 'PLANT', 'QUARRY', 'READY', 'MIX', 'SAND', 'GRAVEL', 'PIT', 'TRAIN', 'UNLOAD', 'SIDE', 'WEST', 'EAST', 'NORTH', 'SOUTH', 'INSIDE', 'OUTSIDE', 'THE', 'AT', 'LLC', 'INC', 'CO', 'AND', 'OF', 'TX', 'TEXAS', 'OK', 'OKLAHOMA', 'MATERIALS', 'MATERIAL', 'ASPHALT', 'CONCRETE', 'AGGREGATES', 'AGGREGATE', 'CRUSHED', 'STONE', 'ROCK', 'DROP', 'OFF', 'PICK', 'UP', 'SITE', 'JOB', 'PO', 'RM', 'S', 'G']);
function norm(s) { return String(s || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function brandOf(n) { for (const b of BRANDS) if (b.re.test(n)) return b.id; return ''; }
function coreOf(n, brand) {
  let s = n;
  const b = BRANDS.find(x => x.id === brand);
  if (b) s = s.replace(b.re, ' ');
  return s.split(' ').filter(t => t && !STOP.has(t) && !/^\d+$/.test(t)).join(' ').trim();
}
function distKm(a, b, c, d) { return Math.sqrt(Math.pow((a - c) * 111, 2) + Math.pow((b - d) * 92, 2)); }
const brandInfo = id => BRANDS.find(b => b.id === id) || null;

// ---------- upsert helpers ----------
function upsertName(raw, kind, orders, loads, seen) {
  const key = norm(raw); if (!key) return;
  const brand = brandOf(key), core = coreOf(key, brand);
  const row = get('SELECT key FROM places WHERE key = ?', key);
  if (!row) {
    run(`INSERT INTO places (key, name, kind, brand, core, status, orders30, loads30, pickups30, drops30, last_seen, src, updated_at)
         VALUES (?,?,?,?,?,'new',?,?,?,?,?,'orders',?)`, key, String(raw).trim(), kind, brand, core, orders, loads,
      kind === 'pickup' ? orders : 0, kind === 'dropoff' ? orders : 0, seen, nowISO());
  } else {
    run(`UPDATE places SET orders30 = orders30 + ?, loads30 = loads30 + ?, pickups30 = pickups30 + ?, drops30 = drops30 + ?,
         last_seen = CASE WHEN ? > last_seen THEN ? ELSE last_seen END, brand = ?, core = ?, updated_at = ? WHERE key = ?`,
      orders, loads, kind === 'pickup' ? orders : 0, kind === 'dropoff' ? orders : 0, seen, seen, brand, core, nowISO(), key);
  }
}

// ---------- 1. names + counts from the last N days of orders ----------
async function tallyOrders(client, days) {
  const today = todayCT(), from = shiftISO(today, -(days || 30)), to = shiftISO(today, 1);
  run(`UPDATE places SET orders30 = 0, loads30 = 0, pickups30 = 0, drops30 = 0 WHERE src = 'orders'`);
  let rows = [], page = 1, totalPages = 1;
  do {
    const r = await client.callTool('list_resources', { resource_type: 'order', filters: { order_date_from: from, order_date_to: to, page, page_size: 100 } });
    rows = rows.concat((r && (r.orders || r.results || r.rows)) || []);
    totalPages = (r && (r.total_pages || r.pages)) || 1;
    page++;
  } while (page <= totalPages && page <= 60);
  const acc = new Map(); // key|kind -> {raw, orders, loads, seen}
  for (const o of rows) {
    const seen = String(o.start_date || '').slice(0, 10);
    const loads = Number(o.load_count) || 0;
    for (const [field, kind] of [['vendor_location', 'pickup'], ['delivery_location', 'dropoff']]) {
      const raw = String(o[field] || '').trim(); if (!raw) continue;
      const k = norm(raw) + '|' + kind;
      const a = acc.get(k) || { raw, orders: 0, loads: 0, seen: '' };
      a.orders++; a.loads += loads; if (seen > a.seen) a.seen = seen;
      // keep the most common spelling: the shortest clean one wins ties
      if (raw.length < a.raw.length) a.raw = raw;
      acc.set(k, a);
    }
  }
  for (const [k, a] of acc) { const kind = k.split('|')[1]; upsertName(a.raw, kind, a.orders, a.loads, a.seen); }
  // kind = both when a name is used on both sides
  run(`UPDATE places SET kind = CASE WHEN pickups30 > 0 AND drops30 > 0 THEN 'both' WHEN pickups30 > 0 THEN 'pickup' WHEN drops30 > 0 THEN 'dropoff' ELSE kind END WHERE src = 'orders'`);
  return { orders: rows.length, names: acc.size };
}

// ---------- 2. our org_location entries (exact coordinates) ----------
async function importOrgLocations(client, orgId) {
  let rows = [], page = 1, totalPages = 1;
  do {
    const r = await client.callTool('list_resources', { resource_type: 'org_location', filters: { org_id: orgId, page, page_size: 100 } });
    rows = rows.concat((r && (r.locations || r.results || r.rows)) || []);
    totalPages = (r && (r.total_pages || r.pages)) || 1;
    page++;
  } while (page <= totalPages && page <= 20);
  let n = 0;
  for (const l of rows) {
    const lat = Number(l.lat), lon = Number(l.lng);
    if (!isFinite(lat) || !isFinite(lon) || !lat || !lon) continue;
    const key = norm(l.name); if (!key) continue;
    const brand = brandOf(key), core = coreOf(key, brand);
    const row = get('SELECT key, status FROM places WHERE key = ?', key);
    if (!row) {
      run(`INSERT INTO places (key, name, kind, brand, core, lat, lon, status, geo_addr, src, nm_location_id, updated_at)
           VALUES (?,?,?,?,?,?,?,'exact',?,'org_location',?,?)`, key, String(l.name).trim(), 'site', brand, core, lat, lon, String(l.address || ''), l.id, nowISO());
    } else if (row.status !== 'manual' && row.status !== 'samsara') {
      run(`UPDATE places SET lat = ?, lon = ?, status = 'exact', geo_addr = ?, nm_location_id = ?, brand = ?, core = ?, updated_at = ? WHERE key = ?`, lat, lon, String(l.address || ''), l.id, brand, core, nowISO(), key);
    }
    n++;
  }
  return n;
}

// ---------- 3. resolve coordinates: org_location by core match, then geocode ----------
function resolveFromCatalog() {
  let n = 0;
  // exact sources (org_location / Samsara / manual) resolve names that are still new, unresolved
  // or only town-level (approx) — an exact catalog hit always beats a Google town centroid.
  const known = all(`SELECT key, brand, core, lat, lon FROM places WHERE lat IS NOT NULL AND status IN ('exact','manual','samsara') AND core <> '' AND src <> 'orders' OR (lat IS NOT NULL AND status IN ('manual','samsara') AND core <> '')`);
  for (const p of all(`SELECT key, brand, core FROM places WHERE status IN ('new','unresolved','approx') AND core <> '' AND src = 'orders'`)) {
    // same brand, or an unbranded order name adopting a branded catalog entry ("Tyler Yard" → MM Tyler).
    // A BRANDED name never adopts another brand's spot (Texas Materials Tyler ≠ MM Tyler Rail).
    const hit = known.find(k => k.key !== p.key && k.core === p.core && (k.brand === p.brand || (!p.brand && k.brand)));
    if (hit) { run(`UPDATE places SET lat = ?, lon = ?, status = 'exact', geo_addr = 'matched: ' || ?, updated_at = ? WHERE key = ?`, hit.lat, hit.lon, hit.key, nowISO(), p.key); n++; }
  }
  return n;
}
function geoQuality(g) {
  const c = (g && g.address_components) || {};
  if (c.street_number || c.route) return 'exact';
  if (c.city || c.county || c.zip) return 'approx';
  return 'unresolved';
}
async function geocodeMissing(client, limit) {
  const todo = all(`SELECT key, name, brand, core FROM places WHERE lat IS NULL AND status = 'new' AND orders30 > 0 ORDER BY loads30 DESC, orders30 DESC LIMIT ?`, limit || 40);
  const out = { tried: 0, exact: 0, approx: 0, unresolved: 0, errors: 0 };
  for (const p of todo) {
    // clean query: drop the "A -> B" arrows and "@", keep brand + place words; add TX unless OK/AR is named
    let q = String(p.name).replace(/->|→|@/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/\b(OK|OKLAHOMA|AR|ARKANSAS|LA|LOUISIANA)\b/i.test(q) && !/\bTX\b|TEXAS/i.test(q)) q += ', TX';
    out.tried++;
    try {
      const g = await client.callTool('call_utility', { utility_name: 'geocode_address', args: { address: q } });
      const lat = Number(g && g.lat), lon = Number(g && g.lng);
      const st = (isFinite(lat) && isFinite(lon) && lat && lon) ? geoQuality(g) : 'unresolved';
      out[st]++;
      run(`UPDATE places SET lat = ?, lon = ?, status = ?, geo_query = ?, geo_addr = ?, updated_at = ? WHERE key = ?`,
        st === 'unresolved' ? null : lat, st === 'unresolved' ? null : lon, st, q, String((g && g.formatted_address) || ''), nowISO(), p.key);
    } catch (e) { out.errors++; run(`UPDATE places SET status = 'unresolved', geo_query = ?, geo_addr = ?, updated_at = ? WHERE key = ?`, q, 'error: ' + String(e.message || e).slice(0, 120), nowISO(), p.key); }
  }
  return out;
}

// ---------- 4. merged view (aliases collapse into the busiest name) ----------
const RANK = { manual: 5, samsara: 4, exact: 3, approx: 2, unresolved: 1, new: 0, hidden: 0 };
function groupKeyOf(p) { return (p.brand || '') + '|' + (p.core || p.key); }
function listMerged(opts) {
  const o = opts || {};
  const rows = all(`SELECT * FROM places WHERE status <> 'hidden' ORDER BY loads30 DESC, orders30 DESC, name`);
  const groups = new Map();
  for (const p of rows) {
    let gk = groupKeyOf(p);
    // a no-brand name joins a branded group with the same core if their kinds are compatible
    if (!p.brand && p.core) {
      for (const [k, g] of groups) if (g.core === p.core && g.brand && (g.kind === p.kind || g.kind === 'both' || p.kind === 'both')) { gk = k; break; }
    }
    // geo merge: same brand within 1.2 km
    if (p.lat != null && p.brand) {
      for (const [k, g] of groups) if (g.brand === p.brand && g.lat != null && distKm(g.lat, g.lon, p.lat, p.lon) < 1.2) { gk = k; break; }
    }
    const g = groups.get(gk);
    if (!g) groups.set(gk, { key: p.key, name: p.name, kind: p.kind, brand: p.brand, core: p.core, lat: p.lat, lon: p.lon, status: p.status, geo_addr: p.geo_addr, orders30: p.orders30, loads30: p.loads30, pickups30: p.pickups30, drops30: p.drops30, last_seen: p.last_seen, src: p.src, aliases: [], keys: [p.key] });
    else {
      g.aliases.push(p.name); g.keys.push(p.key);
      g.orders30 += p.orders30; g.loads30 += p.loads30; g.pickups30 += p.pickups30; g.drops30 += p.drops30;
      if (p.last_seen > g.last_seen) g.last_seen = p.last_seen;
      // the group sits where its BEST-known member is: manual > Samsara stops > exact > town-level
      if (p.lat != null && (g.lat == null || RANK[p.status] > RANK[g.status])) { g.lat = p.lat; g.lon = p.lon; g.status = p.status; g.geo_addr = p.geo_addr; }
      if (g.kind !== p.kind && p.kind) g.kind = (g.kind === 'site' ? p.kind : (p.kind === 'site' ? g.kind : 'both'));
    }
  }
  let list = [...groups.values()];
  if (!o.includeSites) list = list.filter(g => g.kind !== 'site' || g.orders30 > 0);
  for (const g of list) { const b = brandInfo(g.brand); g.brand_name = b ? b.name : ''; g.logo = b && b.domain ? 'https://logo.clearbit.com/' + b.domain : ''; g.color = b ? b.color : ''; }
  return list;
}
// name → coordinates (for placing subhaulers at the plant they are working today)
function coordsIndex() {
  const idx = new Map();
  for (const g of listMerged({ includeSites: true })) if (g.lat != null) for (const k of g.keys) idx.set(k, { lat: g.lat, lon: g.lon, name: g.name });
  return idx;
}
function lookup(idx, rawName) { return idx.get(norm(rawName)) || null; }

// ---------- manual edits ----------
function setManual(key, lat, lon, by, name) {
  const p = get('SELECT * FROM places WHERE key = ?', key);
  if (!p) return null;
  run(`UPDATE places SET lat = ?, lon = ?, status = 'manual', name = COALESCE(NULLIF(?, ''), name), geo_addr = ?, updated_at = ? WHERE key = ?`,
    Number(lat), Number(lon), String(name || '').trim().slice(0, 80), 'pinned by ' + String(by || 'web').slice(0, 40) + ' ' + nowISO().slice(0, 10), nowISO(), key);
  return get('SELECT * FROM places WHERE key = ?', key);
}
function hide(key, on) { run(`UPDATE places SET status = ?, updated_at = ? WHERE key = ?`, on ? 'hidden' : 'new', nowISO(), key); }
function addManual(name, lat, lon, kind, by) {
  const key = norm(name); if (!key) return null;
  const brand = brandOf(key), core = coreOf(key, brand);
  run(`INSERT INTO places (key, name, kind, brand, core, lat, lon, status, geo_addr, src, updated_at) VALUES (?,?,?,?,?,?,?,'manual',?,'manual',?)
       ON CONFLICT(key) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, status = 'manual', kind = excluded.kind, updated_at = excluded.updated_at`,
    key, String(name).trim(), kind || 'both', brand, core, Number(lat), Number(lon), 'pinned by ' + String(by || 'web').slice(0, 40), nowISO());
  return get('SELECT * FROM places WHERE key = ?', key);
}

// ---------- full rebuild (button / nightly) ----------
async function rebuild(client, opts) {
  const o = Object.assign({ days: 30, geocodeLimit: 40, orgId: null }, opts || {});
  const summary = { at: nowISO() };
  summary.orders = await tallyOrders(client, o.days);
  try { const orgId = o.orgId || (client.profile && (client.profile.org_id || (client.profile.org && client.profile.org.id))) || null; if (orgId) summary.org_locations = await importOrgLocations(client, orgId); } catch (e) { summary.org_locations_error = String(e.message || e); }
  summary.matched = resolveFromCatalog();
  summary.geocoded = await geocodeMissing(client, o.geocodeLimit);
  summary.total = (get('SELECT COUNT(*) AS n FROM places') || {}).n;
  summary.withCoords = (get('SELECT COUNT(*) AS n FROM places WHERE lat IS NOT NULL') || {}).n;
  metaSet('places_last_build', JSON.stringify(summary));
  return summary;
}

// ---------- 5. LEARN plants from Samsara stops (Juan's idea, 2026-09-08) ----------
// The trucks assigned to an order from "Tyler Rail" all STOPPED at the same spot to load: that
// spot IS the plant. For each day: the trucks' GPS history (Samsara) → stops (≥ minStopMin at
// one spot, not the truck's own yard) → every stop is a candidate for each place name on that
// truck's orders that day. Pickups: the cell visited by the most distinct trucks wins (drop-offs
// vary per order, the plant does not); drop-offs: same, excluding cells next to a learned pickup.
// Result status 'samsara' — beats Google, loses only to a manual pin.
// Samsara's history stream is ~1 point every 5 minutes, so a stop is simply a run of consecutive
// points that stay within 250 m of each other (speed is ignored — a single "speed 0" point tells
// nothing). Duration = last − first + half a cadence on each side; ≥ minMin counts as a stop.
function extractStops(gps, minMin) {
  const pts = (gps || []).filter(g => g && g.latitude != null && g.longitude != null && g.time).sort((a, b) => a.time < b.time ? -1 : 1);
  const stops = []; let cur = null;
  const flush = () => {
    if (cur) { const dur = (cur.t1 - cur.t0) / 60000 + Math.min(5, cur.gapMin); if (cur.n >= 2 && dur >= minMin) stops.push({ lat: cur.lat / cur.n, lon: cur.lon / cur.n, min: dur, first: cur.t0 }); }
    cur = null;
  };
  let prevT = null;
  for (const g of pts) {
    const t = Date.parse(g.time);
    const gapMin = prevT == null ? 5 : Math.min(30, (t - prevT) / 60000); prevT = t;
    if (cur && distKm(cur.lat / cur.n, cur.lon / cur.n, g.latitude, g.longitude) < 0.25) { cur.n++; cur.lat += g.latitude; cur.lon += g.longitude; cur.t1 = t; cur.gapMin = Math.max(cur.gapMin, gapMin); continue; }
    flush();
    cur = { n: 1, lat: g.latitude, lon: g.longitude, t0: t, t1: t, gapMin };
  }
  flush();
  return stops;
}
// truck → {pickup names, drop-off names} for one day. With a NewMile client: straight from that
// day's orders + assignments (works for any past day). Without: today's cached nm_info.
async function namesForDay(day, client) {
  const names = new Map();
  const add = (key, v, d) => { if (!key) return; const e = names.get(key) || { v: new Set(), d: new Set() }; if (v) e.v.add(norm(v)); if (d) e.d.add(norm(d)); names.set(key, e); };
  if (client) {
    const byDisp = new Map(), byNum = new Map();
    for (const t of all(`SELECT org_id, number, display_number FROM trucks WHERE archived = 0`)) {
      if (t.display_number) byDisp.set(String(t.display_number).trim().toUpperCase(), t.org_id + '|' + t.number);
      byNum.set(t.org_id + '|' + String(t.number).toUpperCase(), t.org_id + '|' + t.number);
    }
    const resolve = raw => {
      const up = String(raw || '').trim().toUpperCase(); if (!up) return null;
      if (byDisp.has(up)) return byDisp.get(up);
      const n = normNum(raw);
      for (const org of ['CACTUS', 'KT']) { const c = canonicalTruckNumber(org, n); if (byNum.has(org + '|' + c.toUpperCase())) return byNum.get(org + '|' + c.toUpperCase()); }
      const dig = (n.match(/\d{2,}/) || [''])[0];
      if (dig && byNum.has('KT|CKJ' + dig)) return byNum.get('KT|CKJ' + dig);
      return null;
    };
    let rows = [];
    try { rows = await client.ordersForDate(day); } catch (e) { return names; }
    for (const { order: o, assignments } of rows) {
      const v = o.vendor_location || '', d = o.delivery_location || '';
      for (const a of (assignments || [])) { if (/cancel/i.test(a.assignment_status || '')) continue; add(resolve(a.truck_number || (a.truck && a.truck.truck_number) || ''), v, d); }
    }
    return names;
  }
  for (const s of all(`SELECT org_id, number, nm_info FROM dispatch_state WHERE date = ? AND state = 'a' AND nm_info IS NOT NULL AND nm_info <> ''`, day)) {
    let dest = []; try { dest = JSON.parse(s.nm_info) || []; } catch (e) { continue; }
    for (const x of dest) add(s.org_id + '|' + s.number, x.v, x.d);
  }
  return names;
}
async function learnFromSamsara(cfg, opts) {
  const sam = require('./sync-samsara');
  const o = Object.assign({ days: 7, minStopMin: 6, cell: 0.006 }, opts || {});
  const today = todayCT();
  const orgs = all('SELECT * FROM orgs WHERE enabled = 1 AND samsara = 1');
  const sleeps = new Map();
  for (const p of all(`SELECT org_id, number, lat, lon FROM parking_log WHERE lat IS NOT NULL AND date >= date('now', '-30 days') ORDER BY date ASC`)) sleeps.set(p.org_id + '|' + p.number, { lat: p.lat, lon: p.lon });
  const cand = new Map(); // 'v|KEY' / 'd|KEY' -> Map(cell -> agg)
  const summary = { at: nowISO(), days: 0, vehicles: 0, stops: 0, learned_pickups: 0, learned_dropoffs: 0, errors: [] };
  for (let d = 1; d <= o.days; d++) {
    const day = shiftISO(today, -d);
    const dow = new Date(day + 'T12:00:00Z').getUTCDay(); if (dow === 0 || dow === 6) continue; // weekdays only (Juan)
    const names = await namesForDay(day, o.client);
    if (!names.size) continue;
    for (const org of orgs) {
      const token = sam.tokenFor(cfg, org.samsara_org); if (!token) continue;
      let vehicles;
      try { vehicles = await sam.fetchGpsHistory(token, day + 'T10:00:00Z', shiftISO(day, 1) + 'T02:00:00Z'); }
      catch (e) { summary.errors.push(org.id + ' ' + day + ': ' + String(e.message || e)); continue; }
      summary.days++;
      for (const v of vehicles) {
        const row = sam.resolveSamsaraTruck(org.id, v.name || '').row; if (!row) continue;
        const key = row.org_id + '|' + row.number; const nm = names.get(key); if (!nm) continue;
        summary.vehicles++;
        // diagnostics: what does the GPS stream look like? (points, cadence, how many are "slow")
        const gps = v.gps || []; summary.points = (summary.points || 0) + gps.length;
        if (gps.length > 1) { const gaps = []; for (let i = 1; i < Math.min(gps.length, 200); i++) gaps.push((Date.parse(gps[i].time) - Date.parse(gps[i - 1].time)) / 1000); gaps.sort((a, b) => a - b); summary.gapSecMedian = gaps[Math.floor(gaps.length / 2)]; }
        summary.slowPoints = (summary.slowPoints || 0) + gps.filter(g => g.speedMilesPerHour == null || g.speedMilesPerHour < 2).length;
        summary.noSpeedField = (summary.noSpeedField || 0) + gps.filter(g => g.speedMilesPerHour == null).length;
        if (!summary.sample && gps.length) summary.sample = JSON.stringify(gps[Math.floor(gps.length / 2)]).slice(0, 300);
        const allStops = extractStops(gps, o.minStopMin); summary.rawStops = (summary.rawStops || 0) + allStops.length;
        const home = sleeps.get(key);
        for (const st of allStops) {
          if (home && distKm(home.lat, home.lon, st.lat, st.lon) < 1.5) continue; // its own yard / home
          summary.stops++;
          const cell = Math.round(st.lat / o.cell) + ':' + Math.round(st.lon / (o.cell * 1.2));
          for (const [kind, set] of [['v', nm.v], ['d', nm.d]]) for (const pk of set) {
            const ck = kind + '|' + pk; const m = cand.get(ck) || new Map();
            const c = m.get(cell) || { n: 0, w: 0, lat: 0, lon: 0, trucks: new Set(), days: new Set(), first: Infinity };
            c.n++; c.w += st.min; c.lat += st.lat * st.min; c.lon += st.lon * st.min; c.trucks.add(key); c.days.add(day); c.first = Math.min(c.first, st.first % 86400000);
            m.set(cell, c); cand.set(ck, m);
          }
        }
      }
    }
  }
  const learned = new Map();
  const better = (a, b, wantEarly) => !b || a.trucks.size > b.trucks.size || (a.trucks.size === b.trucks.size && (wantEarly ? a.first < b.first : a.w > b.w));
  const apply = (pk, best, kind) => {
    if (!best || best.trucks.size < 2 || best.n < 3) return false;
    const lat = Math.round(best.lat / best.w * 1e5) / 1e5, lon = Math.round(best.lon / best.w * 1e5) / 1e5;
    const p = get('SELECT key, status FROM places WHERE key = ?', pk);
    if (!p || p.status === 'manual') return false;
    run(`UPDATE places SET lat = ?, lon = ?, status = 'samsara', geo_addr = ?, updated_at = ? WHERE key = ?`, lat, lon,
      'Samsara stops: ' + best.trucks.size + ' trucks · ' + best.days.size + ' days · ' + best.n + ' stops', nowISO(), pk);
    learned.set(pk, { lat, lon }); summary[kind === 'v' ? 'learned_pickups' : 'learned_dropoffs']++;
    return true;
  };
  for (const [ck, m] of cand) if (ck.startsWith('v|')) { let best = null; for (const c of m.values()) if (better(c, best, true)) best = c; apply(ck.slice(2), best, 'v'); }
  for (const [ck, m] of cand) if (ck.startsWith('d|')) {
    let best = null;
    for (const c of m.values()) {
      const lat = c.lat / c.w, lon = c.lon / c.w; let nearPick = false;
      for (const L of learned.values()) if (distKm(L.lat, L.lon, lat, lon) < 1.5) { nearPick = true; break; }
      if (!nearPick && better(c, best, false)) best = c;
    }
    apply(ck.slice(2), best, 'd');
  }
  metaSet('places_last_learn', JSON.stringify(summary));
  return summary;
}

module.exports = { rebuild, learnFromSamsara, listMerged, coordsIndex, lookup, setManual, hide, addManual, norm, BRANDS };
