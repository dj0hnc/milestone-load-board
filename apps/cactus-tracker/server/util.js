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

module.exports = { normNum, splitNameFlag, canonicalTruckNumber, normLoadTruck, ctParts, todayCT, shiftISO, daysBetween, weekDatesCT, reportDateToISO, CT };
