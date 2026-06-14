'use strict';
/*
 * Multi-day rotation helper — "días sin trabajar".
 * Canonical (Node) implementation: turns a window of load-ticket rows
 * ({truck_number, fleet, order_date}) into a per-truck last-worked date, using the SAME
 * fleet-aware truck-number matching as shell.js/mapping.js `workedSet` (so it agrees with
 * the board's existing "worked yesterday" flag). The renderer (board.html) and the mobile
 * SPA (app.js) inline a byte-identical copy of buildLastWorked/parseTicketDate/daysBetween
 * because they run in the browser and can't require this module.
 *
 * order_date arrives as MM/DD/YY (verified live).
 */
function parseTicketDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const yr = m[3].length === 2 ? ('20' + m[3]) : m[3];
  return yr + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
}
function normNum(s) { return (String(s).replace(/^0+/, '') || '0'); }
function buildLastWorked(rows) {
  const CAC = {}, KT4 = {}, SUB3 = {}, EX = {};
  function put(map, key, iso) { if (iso && (!map[key] || iso > map[key])) map[key] = iso; }
  for (let i = 0; i < (rows || []).length; i++) {
    const r = rows[i]; const c = (r.truck_number || '').trim().toUpperCase(); const iso = parseTicketDate(r.order_date); let m;
    if ((m = /^C(\d+)$/.exec(c))) put(CAC, normNum(m[1]), iso);
    else if ((m = /^CKJ(\d{4})$/.exec(c))) put(KT4, normNum(m[1]), iso);
    else if ((m = /^CKJ(\d{3})$/.exec(c))) put(SUB3, normNum(m[1]), iso);
    else put(EX, c.replace(/\s+/g, ''), iso);
  }
  return function (numStr, fleet) {
    const n = (numStr || '').trim(), u = n.toUpperCase().replace(/\s+/g, ''); let c = [];
    if (fleet === 'cactus') c = [CAC[normNum(n)], EX[u]];
    else if (fleet === 'ckj') { const m = /^KT-(\d+)/.exec(n); if (m) c = [KT4[normNum(m[1])]]; else c = [SUB3[normNum(n)], KT4[normNum(n)]]; }
    else c = [EX[u], CAC[normNum(n)]];
    let best = null; for (let i = 0; i < c.length; i++) { if (c[i] && (!best || c[i] > best)) best = c[i]; }
    return best || null;
  };
}
function daysBetween(aISO, bISO) { return Math.round((new Date(bISO + 'T12:00:00') - new Date(aISO + 'T12:00:00')) / 86400000); }
// Stamp t.lastWorked / t.daysIdle / t.idleBeyond onto each truck. Trucks that DID work in the
// window get a real daysIdle; trucks NEVER seen get daysIdle=null + idleBeyond=true — those are
// mostly dormant subs (often most of the roster), so callers sink them to the bottom of the
// idle ranking instead of letting them flood the top. (windowDays kept for signature compat.)
function applyRotation(rows, trucks, todayISO, windowDays) {
  const lw = buildLastWorked(rows);
  (trucks || []).forEach(function (t) {
    const d = lw(t.num, t.fleet);
    t.lastWorked = d || null;
    if (d) { t.daysIdle = Math.max(0, daysBetween(d, todayISO)); t.idleBeyond = false; }
    else { t.daysIdle = null; t.idleBeyond = true; }
  });
  return trucks;
}
module.exports = { parseTicketDate, normNum, buildLastWorked, daysBetween, applyRotation };
