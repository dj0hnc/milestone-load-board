'use strict';
/*
 * 🗺 DISPATCHER ZONES — who owns which truck (Tony's split, TX Operations meeting 2026-09-01).
 *
 *   Juan  → Cactus North + Cactus South EAST (RKH / Tyler side)
 *   Mary  → KT Rhome + KT Whitewright + CKJ ICS (independent contractors)
 *   Jimmy → KT Powderly + Cactus South WEST (DFW side)
 *
 * Every truck gets an AUTOMATIC owner from this rule (org + division + yard/area, GPS as a last
 * resort) and an optional MANUAL owner (trucks.dispatcher, '' = automatic) that always wins.
 * Manual moves are shared server-side, so everybody sees the same split on every device.
 *
 * Stability matters more than precision: the automatic rule reads the truck's YARD/AREA and
 * parked city first (they change rarely) and only falls back to the live GPS zone when the truck
 * has no yard at all — otherwise a South truck hauling to Dallas today would flip to Jimmy and
 * back tomorrow.
 */

const DISPATCHERS = [
  { id: 'juan',  name: 'Juan',  short: 'J',  color: '#3F7080', dark: '#5a95f9', zones: 'Cactus North · Cactus South East (RKH, Tyler)' },
  { id: 'mary',  name: 'Mary',  short: 'M',  color: '#7A2FA8', dark: '#b07be0', zones: 'KT Rhome · KT Whitewright · CKJ ICS' },
  { id: 'jimmy', name: 'Jimmy', short: 'JM', color: '#4E8C63', dark: '#22c55e', zones: 'KT Powderly · Cactus South West (DFW)' },
];
const IDS = new Set(DISPATCHERS.map(d => d.id));

// Zone polygons [lng, lat] — same shapes the zone map draws (NE Texas).
const Z_NORTH = [[-96.95, 33.50], [-96.80, 33.92], [-96.45, 34.02], [-95.95, 34.22], [-95.20, 34.30], [-94.72, 33.95], [-94.80, 33.48], [-95.45, 33.36], [-96.15, 33.40], [-96.70, 33.40]];
const Z_SE = [[-96.28, 32.86], [-95.90, 33.02], [-95.42, 32.98], [-94.62, 32.72], [-94.55, 32.28], [-95.12, 32.02], [-95.80, 32.08], [-96.30, 32.40], [-96.38, 32.66]];
const Z_SW = [[-97.90, 33.32], [-97.30, 33.34], [-96.82, 33.10], [-96.62, 32.62], [-96.70, 32.22], [-97.10, 32.05], [-97.65, 32.12], [-97.95, 32.60]];

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function gpsZone(lat, lon) {
  lat = Number(lat); lon = Number(lon);
  if (!isFinite(lat) || !isFinite(lon) || !lat || !lon) return '';
  if (inPoly(lon, lat, Z_NORTH)) return 'NORTH';
  if (inPoly(lon, lat, Z_SE)) return 'SE';
  if (inPoly(lon, lat, Z_SW)) return 'SW';
  return '';
}

// Yard / parked-city words that place a Cactus SOUTH truck on one side or the other.
const SE_AREAS = /TYLER|MINEOLA|LINDALE|LONGVIEW|KILGORE|ATHENS|CANTON|JACKSONVILLE|HENDERSON|PALESTINE|TERRELL|SCURRY|KAUFMAN|WILLS POINT|GRAND SALINE|EMORY|EDGEWOOD|\bVAN\b|QUITMAN|WINNSBORO|GILMER|MARSHALL|CARTHAGE|RUSK|WHITEHOUSE|BULLARD|CHANDLER|BROWNSBORO|MALAKOFF|CORSICANA|TEAGUE|FAIRFIELD|MEXIA|KERENS|SEVEN POINTS|MABANK|GUN BARREL|CROCKETT|NACOGDOCHES|LUFKIN|TROUP|ARP|OVERTON|BIG SANDY|HAWKINS|PITTSBURG|MT VERNON|MOUNT VERNON|SULPHUR SPRINGS|GREENVILLE|WOLFE CITY|COMMERCE|POINT\b|LONE OAK/i;
const SW_AREAS = /DALLAS|FORT WORTH|FT\.? WORTH|WAXAHACHIE|CLEBURNE|ENNIS|MIDLOTHIAN|MANSFIELD|ARLINGTON|GRAND PRAIRIE|IRVING|GARLAND|MESQUITE|DECATUR|DENTON|BRIDGEPORT|RHOME|BURLESON|ALVARADO|RED OAK|LANCASTER|DESOTO|CEDAR HILL|WEATHERFORD|GRANBURY|HILLSBORO|ITALY|FERRIS|SEAGOVILLE|ROCKWALL|ROYSE CITY|FORNEY|WYLIE|PLANO|FRISCO|MCKINNEY|LEWISVILLE|SAGINAW|AZLE|SPRINGTOWN|MINERAL WELLS|HUTCHINS|WILMER|PALMER|VENUS|JOSHUA|GODLEY|KEENE|GRANDVIEW|RIO VISTA|WHITNEY|WEST\b|WACO|HALTOM|KELLER|HURST|EULESS|BEDFORD|GRAPEVINE|CARROLLTON|ADDISON|RICHARDSON|ALLEN|PROSPER|CELINA|ANNA|MELISSA|PRINCETON|FARMERSVILLE|SANGER|KRUM|AUBREY|PILOT POINT|GAINESVILLE|BOWIE|JACKSBORO|ALEDO|WILLOW PARK|HUDSON OAKS|CRESSON|STEPHENVILLE|GLEN ROSE|MIDLOTHIAN/i;

function r(id, why, zone) { return { id: id || '', why: why || '', zone: zone || '' }; }

// The automatic owner of a truck row (any row shape that carries org_id/division/area/is_sub…).
function autoOf(t) {
  const org = String(t.org_id || '').toUpperCase();
  const div = String(t.division || '').toUpperCase();
  const area = String(t.area || '').toUpperCase();
  const parked = String(t.parked_city || '').toUpperCase();
  const gz = gpsZone(t.last_lat, t.last_lon);
  if (org === 'KT') {
    if (div === 'RHOME') return r('mary', 'KT Rhome terminal', 'SW');
    if (div === 'WHITEWRIGHT') return r('mary', 'KT Whitewright terminal', 'NORTH');
    if (div === 'POWDERLY') return r('jimmy', 'KT Powderly terminal', 'NORTH');
    if (div === 'ICS') return r('mary', 'CKJ independent contractor', '');
    if (t.is_sub) return r('', 'subhauler — assign by hand', '');
    if (gz === 'NORTH') return r('jimmy', 'no terminal marked · GPS on the Powderly side', 'NORTH');
    if (gz === 'SW') return r('mary', 'no terminal marked · GPS on the Rhome side', 'SW');
    return r('', 'KT truck without terminal — confirm', '');
  }
  if (org === 'CACTUS') {
    // subs that already live in a division belong to that zone's dispatcher (Tony: "Cactus
    // North" is Juan's whole tab, subs included); only the floating subs (no division) wait.
    if (div === 'NORTH') return r('juan', t.is_sub ? 'Cactus North subhauler' : 'Cactus North', 'NORTH');
    if (div === 'SOUTH') {
      if (SW_AREAS.test(area)) return r('jimmy', 'Cactus South · yard ' + area + ' (South West)', 'SW');
      if (SE_AREAS.test(area)) return r('juan', 'Cactus South · yard ' + area + ' (South East)', 'SE');
      if (SW_AREAS.test(parked)) return r('jimmy', 'Cactus South · parks in ' + parked + ' (South West)', 'SW');
      if (SE_AREAS.test(parked)) return r('juan', 'Cactus South · parks in ' + parked + ' (South East)', 'SE');
      if (gz === 'SW') return r('jimmy', 'Cactus South · GPS South West', 'SW');
      if (gz === 'SE' || gz === 'NORTH') return r('juan', 'Cactus South · GPS South East', 'SE');
      return r('', 'Cactus South — which side? confirm', '');
    }
    if (t.is_sub) return r('', 'floating subhauler — assign by hand', '');
    return r('', 'no division yet', '');
  }
  return r('', 'assign by hand', '');
}

function validId(v) { const m = String(v || '').toLowerCase().trim(); return IDS.has(m) ? m : ''; }

// Mutates the row: dispatcher_auto / dispatcher_why / zone / dispatcher_manual / dispatcher_eff.
function decorate(t) {
  const a = autoOf(t);
  const manual = validId(t.dispatcher);
  t.dispatcher_auto = a.id;
  t.dispatcher_why = a.why;
  t.zone = a.zone;
  t.dispatcher_manual = manual;
  t.dispatcher_eff = manual || a.id;
  return t;
}

module.exports = { DISPATCHERS, IDS, autoOf, decorate, validId, gpsZone, Z_NORTH, Z_SE, Z_SW };
