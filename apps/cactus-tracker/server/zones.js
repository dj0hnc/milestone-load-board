'use strict';
/*
 * 🗺 DISPATCHER ZONES — who owns which truck (Tony's split, TX Operations meeting 2026-09-01).
 *
 *   Juan  → Cactus North + Cactus South EAST (RKH / Tyler side)
 *   Mary  → KT Rhome + KT Whitewright + CKJ ICS (independent contractors)
 *   Jimmy → KT Powderly + Cactus South WEST (DFW side)
 *
 * The zones themselves are EDITABLE: polygons (drawn on the map in zones.html) + each
 * dispatcher's name / short tag / color live in meta.zones_config (JSON). Defaults below.
 *
 * Owner of a truck, in order:
 *   1. MANUAL  — trucks.dispatcher set by a person (zones.html / ✎ modal). Always wins.
 *   2. KT TERMINAL — Rhome / Whitewright → Mary, Powderly → Jimmy, ICS → Mary (company structure).
 *   3. DRAWN ZONE — the zone polygon that contains where the truck SLEEPS (latest parking_log
 *      night, 3-5 AM GPS; falls back to the last live position). Stable: a South truck hauling
 *      to Dallas today does not flip to Jimmy.
 *   4. DIVISION / YARD — Cactus North → Juan; Cactus South by yard / parked-city words.
 *   5. otherwise unassigned ("?") so somebody moves it by hand.
 */
const { all, metaGet, metaSet } = require('./db');

const DEFAULT_DISPATCHERS = [
  { id: 'juan',  name: 'Juan',  short: 'J',  color: '#3F7080', zones: 'Cactus North · Cactus South East (RKH, Tyler)' },
  { id: 'mary',  name: 'Mary',  short: 'M',  color: '#7A2FA8', zones: 'KT Rhome · KT Whitewright · CKJ ICS' },
  { id: 'jimmy', name: 'Jimmy', short: 'JM', color: '#4E8C63', zones: 'KT Powderly · Cactus South West (DFW)' },
];
const IDS = new Set(DEFAULT_DISPATCHERS.map(d => d.id));

// [lng, lat] polygons (NE Texas) — the shapes the zone map draws by default.
const Z_NORTH = [[-96.95, 33.50], [-96.80, 33.92], [-96.45, 34.02], [-95.95, 34.22], [-95.20, 34.30], [-94.72, 33.95], [-94.80, 33.48], [-95.45, 33.36], [-96.15, 33.40], [-96.70, 33.40]];
const Z_SE = [[-96.28, 32.86], [-95.90, 33.02], [-95.42, 32.98], [-94.62, 32.72], [-94.55, 32.28], [-95.12, 32.02], [-95.80, 32.08], [-96.30, 32.40], [-96.38, 32.66]];
const Z_SW = [[-97.90, 33.32], [-97.30, 33.34], [-96.82, 33.10], [-96.62, 32.62], [-96.70, 32.22], [-97.10, 32.05], [-97.65, 32.12], [-97.95, 32.60]];
function circlePoly(lng, lat, km) {
  const pts = [];
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * 2 * Math.PI;
    pts.push([Math.round((lng + km / (111.32 * Math.cos(lat * Math.PI / 180)) * Math.cos(a)) * 1e4) / 1e4, Math.round((lat + km / 110.57 * Math.sin(a)) * 1e4) / 1e4]);
  }
  return pts;
}
const DEFAULT_ZONES = [
  { id: 'north', name: 'North', owner: 'juan', poly: Z_NORTH },
  { id: 'se', name: 'South East', owner: 'juan', poly: Z_SE },
  { id: 'sw', name: 'South West', owner: 'jimmy', poly: Z_SW },
  { id: 'rhome', name: 'Rhome terminal', owner: 'mary', poly: circlePoly(-97.472, 33.054, 16) },
  { id: 'whitewright', name: 'Whitewright terminal', owner: 'mary', poly: circlePoly(-96.393, 33.512, 16) },
];

// ---------- config (meta.zones_config) ----------
const cleanStr = (v, dflt, max) => { const s = String(v == null ? '' : v).replace(/[<>]/g, '').trim(); return (s || dflt || '').slice(0, max); };
const hex = v => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : '');
function normalize(c) {
  const out = { dispatchers: [], zones: [] };
  const src = (c && Array.isArray(c.dispatchers)) ? c.dispatchers : [];
  for (const d of DEFAULT_DISPATCHERS) {
    const s = src.find(x => x && x.id === d.id) || {};
    out.dispatchers.push({ id: d.id, name: cleanStr(s.name, d.name, 24), short: cleanStr(s.short, d.short, 3).toUpperCase(), color: hex(s.color) || d.color, zones: d.zones });
  }
  const zs = (c && Array.isArray(c.zones)) ? c.zones : DEFAULT_ZONES;
  const seen = new Set();
  for (const z of zs.slice(0, 40)) {
    if (!z || !Array.isArray(z.poly)) continue;
    const poly = z.poly
      .filter(p => Array.isArray(p) && isFinite(+p[0]) && isFinite(+p[1]) && +p[0] > -110 && +p[0] < -85 && +p[1] > 25 && +p[1] < 40)
      .map(p => [Math.round(+p[0] * 1e4) / 1e4, Math.round(+p[1] * 1e4) / 1e4]).slice(0, 80);
    if (poly.length < 3) continue;
    let id = cleanStr(z.id, '', 24).toLowerCase().replace(/[^a-z0-9_-]/g, '') || ('z' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
    while (seen.has(id)) id += 'x';
    seen.add(id);
    out.zones.push({ id, name: cleanStr(z.name, 'Zone', 32), owner: IDS.has(z.owner) ? z.owner : '', poly });
  }
  return out;
}
let _cfg = null;
function getConfig() {
  if (_cfg) return _cfg;
  let saved = null;
  try { saved = JSON.parse(metaGet('zones_config', '') || 'null'); } catch (e) { saved = null; }
  _cfg = normalize(saved);
  return _cfg;
}
function saveConfig(c) { const n = normalize(c); metaSet('zones_config', JSON.stringify(n)); _cfg = n; return n; }
function resetConfig() { metaSet('zones_config', ''); _cfg = null; return getConfig(); }
const dispatchers = () => getConfig().dispatchers;
const zonesList = () => getConfig().zones;
const DEFAULTS = () => normalize(null);

// ---------- geometry ----------
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// first configured zone (in list order) that contains the point — smaller "terminal" zones are
// listed after the big ones by default, so put a small zone FIRST in the list to carve out an area.
function zoneAt(lat, lon) {
  lat = Number(lat); lon = Number(lon);
  if (!isFinite(lat) || !isFinite(lon) || !lat || !lon) return null;
  for (const z of zonesList()) if (inPoly(lon, lat, z.poly)) return z;
  return null;
}

// Yard / parked-city words that place a Cactus SOUTH truck on one side or the other (no GPS).
const SE_AREAS = /TYLER|MINEOLA|LINDALE|LONGVIEW|KILGORE|ATHENS|CANTON|JACKSONVILLE|HENDERSON|PALESTINE|TERRELL|SCURRY|KAUFMAN|WILLS POINT|GRAND SALINE|EMORY|EDGEWOOD|\bVAN\b|QUITMAN|WINNSBORO|GILMER|MARSHALL|CARTHAGE|RUSK|WHITEHOUSE|BULLARD|CHANDLER|BROWNSBORO|MALAKOFF|CORSICANA|TEAGUE|FAIRFIELD|MEXIA|KERENS|SEVEN POINTS|MABANK|GUN BARREL|CROCKETT|NACOGDOCHES|LUFKIN|TROUP|ARP|OVERTON|BIG SANDY|HAWKINS|PITTSBURG|MT VERNON|MOUNT VERNON|SULPHUR SPRINGS|GREENVILLE|WOLFE CITY|COMMERCE|POINT\b|LONE OAK/i;
const SW_AREAS = /DALLAS|FORT WORTH|FT\.? WORTH|WAXAHACHIE|CLEBURNE|ENNIS|MIDLOTHIAN|MANSFIELD|ARLINGTON|GRAND PRAIRIE|IRVING|GARLAND|MESQUITE|DECATUR|DENTON|BRIDGEPORT|RHOME|BURLESON|ALVARADO|RED OAK|LANCASTER|DESOTO|CEDAR HILL|WEATHERFORD|GRANBURY|HILLSBORO|ITALY|FERRIS|SEAGOVILLE|ROCKWALL|ROYSE CITY|FORNEY|WYLIE|PLANO|FRISCO|MCKINNEY|LEWISVILLE|SAGINAW|AZLE|SPRINGTOWN|MINERAL WELLS|HUTCHINS|WILMER|PALMER|VENUS|JOSHUA|GODLEY|KEENE|GRANDVIEW|RIO VISTA|WHITNEY|WEST\b|WACO|HALTOM|KELLER|HURST|EULESS|BEDFORD|GRAPEVINE|CARROLLTON|ADDISON|RICHARDSON|ALLEN|PROSPER|CELINA|ANNA|MELISSA|PRINCETON|FARMERSVILLE|SANGER|KRUM|AUBREY|PILOT POINT|GAINESVILLE|BOWIE|JACKSBORO|ALEDO|WILLOW PARK|HUDSON OAKS|CRESSON|STEPHENVILLE|GLEN ROSE/i;

function r(id, why, zone) { return { id: id || '', why: why || '', zone: zone || '' }; }

// Where the truck sleeps: latest parking_log night with coordinates, else the last live position.
function sleepMap() {
  const m = new Map();
  try {
    for (const p of all(`SELECT org_id, number, lat, lon FROM parking_log
                          WHERE lat IS NOT NULL AND lon IS NOT NULL AND date >= date('now', '-30 days') ORDER BY date ASC`)) {
      m.set(p.org_id + '|' + p.number, { lat: p.lat, lon: p.lon, src: 'sleep' });
    }
  } catch (e) { /* no parking log yet → live positions */ }
  return m;
}
function posOf(t, sleeps) {
  const s = sleeps && sleeps.get(t.org_id + '|' + t.number);
  if (s) return s;
  if (t.last_lat != null && t.last_lon != null && Number(t.last_lat) && Number(t.last_lon)) return { lat: Number(t.last_lat), lon: Number(t.last_lon), src: 'live' };
  return null;
}

// The automatic owner of a truck row. `pos` = {lat, lon, src} or null.
function autoOf(t, pos) {
  const org = String(t.org_id || '').toUpperCase();
  const div = String(t.division || '').toUpperCase();
  const area = String(t.area || '').toUpperCase();
  const parked = String(t.parked_city || '').toUpperCase();
  const z = pos ? zoneAt(pos.lat, pos.lon) : null;
  const zoneWhy = z ? ((pos.src === 'sleep' ? 'sleeps in ' : 'last seen in ') + z.name) : '';
  if (org === 'KT') {
    if (div === 'RHOME') return r('mary', 'KT Rhome terminal', 'rhome');
    if (div === 'WHITEWRIGHT') return r('mary', 'KT Whitewright terminal', 'whitewright');
    if (div === 'POWDERLY') return r('jimmy', 'KT Powderly terminal', 'north');
    if (div === 'ICS') return r('mary', 'CKJ independent contractor', '');
    if (z && z.owner) return r(z.owner, (t.is_sub ? 'subhauler · ' : 'no terminal · ') + zoneWhy, z.id);
    if (t.is_sub) return r('', 'subhauler — assign by hand', '');
    return r('', 'KT truck without terminal — confirm', '');
  }
  if (org === 'CACTUS') {
    if (z && z.owner) return r(z.owner, (div ? 'Cactus ' + div[0] + div.slice(1).toLowerCase() + ' · ' : '') + zoneWhy + (t.is_sub ? ' (subhauler)' : ''), z.id);
    if (div === 'NORTH') return r('juan', t.is_sub ? 'Cactus North subhauler' : 'Cactus North', 'north');
    if (div === 'SOUTH') {
      if (SW_AREAS.test(area)) return r('jimmy', 'Cactus South · yard ' + area + ' (South West)', 'sw');
      if (SE_AREAS.test(area)) return r('juan', 'Cactus South · yard ' + area + ' (South East)', 'se');
      if (SW_AREAS.test(parked)) return r('jimmy', 'Cactus South · parks in ' + parked + ' (South West)', 'sw');
      if (SE_AREAS.test(parked)) return r('juan', 'Cactus South · parks in ' + parked + ' (South East)', 'se');
      return r('', 'Cactus South — which side? confirm', '');
    }
    if (t.is_sub) return r('', 'floating subhauler — assign by hand', '');
    return r('', 'no division yet', '');
  }
  return r('', 'assign by hand', '');
}

function validId(v) { const m = String(v || '').toLowerCase().trim(); return IDS.has(m) ? m : ''; }

// Mutates the row: dispatcher_auto / dispatcher_why / zone / dispatcher_manual / dispatcher_eff
// + zone_lat / zone_lon / zone_src (the position the rule used, so the map can show it).
function decorate(t, sleeps) {
  const pos = posOf(t, sleeps);
  const a = autoOf(t, pos);
  const manual = validId(t.dispatcher);
  t.dispatcher_auto = a.id;
  t.dispatcher_why = a.why;
  t.zone = a.zone;
  t.dispatcher_manual = manual;
  t.dispatcher_eff = manual || a.id;
  t.zone_lat = pos ? pos.lat : null;
  t.zone_lon = pos ? pos.lon : null;
  t.zone_src = pos ? pos.src : '';
  return t;
}
function decorateAll(rows) { const sleeps = sleepMap(); for (const t of rows) decorate(t, sleeps); return rows; }

module.exports = { DEFAULT_DISPATCHERS, IDS, getConfig, saveConfig, resetConfig, DEFAULTS, dispatchers, zonesList, zoneAt, autoOf, decorate, decorateAll, validId, inPoly };
