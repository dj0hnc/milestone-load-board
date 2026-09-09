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
const { todayCT, shiftISO } = require('./util');

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
  { id: 'RKH', re: /\bR\.?K\.? ?HALL\b|\bRKH\b/, name: 'R.K. Hall', domain: 'rkhall.com', color: '#7a5c1e' },
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
    } else if (row.status !== 'manual') {
      run(`UPDATE places SET lat = ?, lon = ?, status = 'exact', geo_addr = ?, nm_location_id = ?, updated_at = ? WHERE key = ?`, lat, lon, String(l.address || ''), l.id, nowISO(), key);
    }
    n++;
  }
  return n;
}

// ---------- 3. resolve coordinates: org_location by core match, then geocode ----------
function resolveFromCatalog() {
  let n = 0;
  const known = all(`SELECT key, brand, core, lat, lon FROM places WHERE lat IS NOT NULL AND status IN ('exact','manual') AND core <> ''`);
  for (const p of all(`SELECT key, brand, core FROM places WHERE lat IS NULL AND status IN ('new','unresolved') AND core <> ''`)) {
    const hit = known.find(k => k.core === p.core && (k.brand === p.brand || !p.brand || !k.brand));
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
      if (g.lat == null && p.lat != null) { g.lat = p.lat; g.lon = p.lon; g.status = p.status; g.geo_addr = p.geo_addr; }
      if (g.status !== 'manual' && p.status === 'manual') { g.lat = p.lat; g.lon = p.lon; g.status = 'manual'; }
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

module.exports = { rebuild, listMerged, coordsIndex, lookup, setManual, hide, addManual, norm, BRANDS };
