'use strict';
/*
 * Shared normalization + Central-Time helpers.
 *
 * Truck-number matching follows the SAME verified rules as the desktop board
 * (rotation.js / mapping.js): Cactus loads come as "C1127" → 1127; NewMile truck
 * names can carry status suffixes ("1082-DOWN 12/12/2024", "553-Deleased Need
 * Camera") which are stripped for matching but KEPT as a detected flag.
 */

// Uppercase, collapse spaces. "bw813" → "BW813"
function normNum(s) {
  return String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, ' ');
}

// Nombre canónico de ZONA: sin estado. "PARIS, TX" y "PARIS" son la MISMA zona —
// el estado vive en parked_city ("CIUDAD, ST"), nunca en el nombre del área.
function canonArea(s) {
  return normNum(s).replace(/\s*,\s*[A-Z]{2}$/, '').trim();
}

// Llave para detectar zonas duplicadas por deletreo ("MT PLEASANT" vs "MOUNT PLEASANT").
function areaMergeKey(s) {
  return canonArea(s).replace(/^MOUNT\b/, 'MT').replace(/[^A-Z0-9 ]/g, '').trim();
}

// Split a NewMile/Samsara vehicle name into { number, flag }.
// "1082-DOWN 12/12/2024" → { number:'1082', flag:'DOWN 12/12/2024' }
// "553 Deleased Need Camera" → { number:'553', flag:'Deleased Need Camera' }
// "BW813" → { number:'BW813', flag:'' } · "KT-7045 P" → { number:'KT-7045', flag:'' }
function splitNameFlag(raw) {
  const s = normNum(raw);
  const m = /^([A-Z]{0,4}[\s-]*\d+[A-Z]*)[\s\-–—]*(.*)$/.exec(s);
  if (!m) return { number: s, flag: '' };
  let flag = (m[2] || '').trim();
  if (flag.length <= 1) flag = ''; // "KT-7045 P": the trailing letter is a type marker, not a flag
  return { number: m[1].replace(/\s+/g, ''), flag };
}

// KT names carry the terminal as a trailing letter (verified live vs Samsara 7/10/26:
// "KT-7040 P" = Powderly, "KT-7044 W" = Whitewright, "KT-4799 R" = Rhome).
function ktDivisionHint(raw) {
  const m = /^(?:KT|CKJ)-?\d+\s+([PRW])$/.exec(normNum(raw));
  if (!m) return null;
  return { P: 'POWDERLY', R: 'RHOME', W: 'WHITEWRIGHT' }[m[1]] || null;
}

// NewMile trailer names → los códigos cortos de las listas de despacho (SPEC §2).
const TRAILER_SHORT = {
  'ALUMINUM END DUMP': 'AL-ED', 'END DUMP': 'ED', 'STEEL END DUMP': 'ST-ED',
  'ROUND BODY END DUMP': 'RB-ED', 'SUPER DUMP W/ STEEL BED': 'SD Steel',
  'SUPER DUMP W/ DEMO BED': 'SD Demo', 'BELLY DUMP': 'BD',
  'ALUMINUM TRACTOR TRAILER': 'AL-TT', 'DEMO': 'Demo',
  // 2026-09-04: NewMile day-cab / sleeper-cab end dump types (Juan re-typed 23 CE trucks)
  'END DUMP W/ DAY CAB': 'ED-DC', 'END DUMP W/ SLEEPER CAB': 'ED-SC'
};
function shortTrailer(t) {
  const k = normNum(t);
  return TRAILER_SHORT[k] || String(t || '').trim();
}

// The number AS NEWMILE SHOWS IT: keeps prefixes and terminal letters ("KT-7040 P"),
// only drops status suffixes ("1082-DOWN 12/12/2024" → "1082").
function displayTruckNumber(raw) {
  const s = normNum(raw);
  const { flag } = splitNameFlag(s);
  if (!flag) return s;
  const i = s.indexOf(flag);
  return (i > 0 ? s.slice(0, i) : s).replace(/[\s\-–—]+$/, '');
}

// Org-specific canonical number. CKJ/KT trucks appear as "KT-7040 P" in the truck
// resource, "CKJ7040" in load tickets and "KT-7040" in Samsara — canonical is the
// bare digits (same rule as the desktop's rotation.js). Everything else as-is.
function canonicalTruckNumber(orgId, raw) {
  const s = normNum(raw).replace(/\s+/g, '');
  if (orgId === 'KT') {
    const m = /^(?:KT|CKJ)-?(\d{2,})/.exec(s);
    if (m) return m[1];
    const m2 = /^(\d{2,})$/.exec(s);
    if (m2) return m2[1];
  }
  return s;
}

// ALIAS DE LA FLOTA CKJ: el mismo camión llega con tres nombres según de dónde venga.
// Arango: registro "01 - Arango" / "069-Arango" / "ARANGO - 1116", tickets "AT01" /
// "AT269" / "ARANGO - 1105". Todo cae a UNA llave: ARANGO + dígitos (sin quitar ceros:
// "001" y "01" son camiones distintos). Los pelones son ICs → CKJ###.
function ckjAliasKey(raw) {
  const s = normNum(raw).replace(/\s+/g, '');
  const dig = (s.match(/\d+/) || [''])[0];
  if (dig && (/ARANGO/i.test(s) || /^AT\d+$/i.test(s))) return 'ARANGO' + dig;
  if (/^\d{1,4}$/.test(s)) return 'CKJ' + s;
  return s.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

// Normalize a load_tickets truck_number given the fleet it came from.
// Cactus Express rows arrive prefixed with "C" (C1127 = 1127). Everything else as-is.
function normLoadTruck(truckNumber, fleetName, cactusFleetNames, prefix) {
  let n = normNum(truckNumber);
  const isCactus = (cactusFleetNames || []).some(f => normNum(f) === normNum(fleetName));
  if (isCactus && prefix && n.startsWith(prefix) && /\d/.test(n.slice(prefix.length))) {
    n = n.slice(prefix.length);
  }
  return n;
}

// ---------- Central Time ----------
const CT = 'America/Chicago';

function ctParts(dt) {
  const d = dt || new Date();
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: CT, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  });
  const p = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return {
    dateISO: `${p.year}-${p.month}-${p.day}`,
    hour: parseInt(p.hour, 10) % 24,
    minute: parseInt(p.minute, 10),
    weekday: p.weekday // 'Mon'...'Sun'
  };
}

function todayCT() { return ctParts().dateISO; }

function shiftISO(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Days between two ISO dates (b - a).
function daysBetween(aISO, bISO) {
  return Math.round((new Date(bISO + 'T12:00:00Z') - new Date(aISO + 'T12:00:00Z')) / 86400000);
}

// Mon..Sat ISO dates of the week containing `iso` (CT semantics: week starts Monday).
function weekDatesCT(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const out = {};
  const names = ['Mon', 'Tue', 'Wed', 'Thur', 'Fri', 'Sat'];
  for (let i = 0; i < 6; i++) out[names[i]] = shiftISO(iso, mondayOffset + i);
  return out;
}

// Parse NewMile report dates ("MM/DD/YY" or "MM/DD/YYYY" or ISO) → ISO.
function reportDateToISO(s) {
  const t = String(s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (!m) return null;
  let y = parseInt(m[3], 10); if (y < 100) y += 2000;
  return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

module.exports = { normNum, canonArea, areaMergeKey, splitNameFlag, canonicalTruckNumber, displayTruckNumber, ktDivisionHint, shortTrailer, normLoadTruck, ckjAliasKey, ctParts, todayCT, shiftISO, daysBetween, weekDatesCT, reportDateToISO, CT };
