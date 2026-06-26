'use strict';
/*
 * Two fleet-grouped reports (ALWAYS English), using the same fleet buckets as the board (t.group):
 *   MORNING (7 AM)  — buildMorning(board): per fleet, the assigned trucks that are NOT working yet
 *                     (0 loads hauled today + parked, or no GPS signal) so the dispatcher can act.
 *   NIGHT  (~7 PM)  — buildNight(board): per fleet, how many trucks are assigned for TOMORROW (the
 *                     plan), plus the total.
 * Confirmed "not working" = assigned, 0 loads done, not rolling, and (has recent GPS but mph<1).
 * No-GPS assigned trucks (subhaulers w/o Samsara) are listed under "review — call to confirm".
 */
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
function ctStr(ms) { return new Date(ms || Date.now()).toLocaleString('en-US', { timeZone: 'America/Chicago' }); }
// SAME 4-bucket fleet split as the mobile report (CACTUS · CKJ · KT · SUBHAULERS).
const FLEET_ORDER = ['CE', 'CKJ', 'KT', 'SUB'];
function rptGrp(t) {
  const num = String((t && t.num) || '').trim().toUpperCase();
  const g = String((t && t.group) || '').toUpperCase();
  if ((t && t.fleet === 'cactus') || g === 'CE' || g === 'CACTUS') return 'CE';
  const isKtNum = num.indexOf('KT') >= 0;
  const isCkj = ((t && t.fleet === 'ckj') || g === 'KT' || g === 'CKJ' || g === 'CKJ_SUB' || g === 'CKJ SUB' || isKtNum);
  if (isCkj) return isKtNum ? 'KT' : 'CKJ';
  return 'SUB';
}
function grpLabel(k) { const u = String(k).toUpperCase(); return u === 'KT' ? 'KT' : (u === 'CE' || u === 'CACTUS') ? 'CACTUS' : (u === 'CKJ' || u === 'CKJ_SUB' || u === 'CKJ SUB') ? 'CKJ' : (u === 'SUB' || u === 'SUBHAULERS') ? 'SUBHAULERS' : k; }
function fleetLabelFor(t, num) { return grpLabel(rptGrp(t || { num: num })); }
function orderFleets(keys) { return keys.slice().sort((a, b) => { const ia = FLEET_ORDER.map(grpLabel).indexOf(a), ib = FLEET_ORDER.map(grpLabel).indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); }); }

// ---------- MORNING: who isn't working, grouped by fleet ----------
function buildMorning(board, opts) {
  if (typeof opts === 'number') opts = { nowMs: opts };
  opts = opts || {};
  const now = opts.nowMs || Date.now();
  const off = parseInt(opts.offSubs, 10) || 0;
  const day = (board && board.dayMap && board.dayMap[4]) || [];
  const trucks = (board && board.trucks) || [];
  const byNum = {}; trucks.forEach(t => { byNum[(t.num || '').trim().toUpperCase()] = t; });
  const assigned = {};
  day.forEach(o => { if (o.completed) return; (o.assigns || []).forEach(a => { const n = (a.num || '').trim(); if (!n) return; const k = n.toUpperCase(); (assigned[k] = assigned[k] || { num: n, orders: [], done: 0 }); assigned[k].done += (typeof a.done === 'number' ? a.done : 0); const lbl = o.disp || ('#' + o.orderId); if (assigned[k].orders.indexOf(lbl) < 0) assigned[k].orders.push(lbl); }); });
  const totalAssigned = Object.keys(assigned).length;
  const rows = [];
  const working = {};   // fleet label -> [{num, driver}] of trucks that ARE working
  const tallyWork = (t, num, ords) => { const f = fleetLabelFor(t, num); (working[f] = working[f] || []).push({ num: num, driver: (t && t.driver) || '', orders: ords || [] }); };
  Object.keys(assigned).forEach(k => {
    const a = assigned[k], t = byNum[k];
    if (a.done > 0) { tallyWork(t, a.num, a.orders); return; }   // hauled something → working
    if (t && t.rolling) { tallyWork(t, a.num, a.orders); return; } // actively rolling → working
    let state, fleet = fleetLabelFor(t, a.num);
    if (!t) { state = 'review'; }
    else {
      const ageMin = t.gpsTime ? Math.round((now - new Date(t.gpsTime).getTime()) / 60000) : null;
      const hasGps = t.lat != null && ageMin != null && ageMin < 180;
      if (!hasGps) state = 'review';
      else if (t.mph != null && t.mph < 1) state = 'parked';
      else { tallyWork(t, a.num, a.orders); return; }             // has GPS and moving → working
    }
    rows.push({ num: a.num, driver: (t && t.driver) || '', owner: (t && t.owner) || '', orders: a.orders, fleet: fleet, state: state });
  });
  const byFleet = {}; rows.forEach(r => { (byFleet[r.fleet] = byFleet[r.fleet] || []).push(r); });
  const fleets = orderFleets(Object.keys(byFleet));
  const workFleets = orderFleets(Object.keys(working));
  workFleets.forEach(f => working[f].sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true })));
  const totalWorking = Object.keys(working).reduce((n, f) => n + working[f].length, 0);
  const parked = rows.filter(r => r.state === 'parked').length, review = rows.filter(r => r.state === 'review').length;
  const dstr = ctStr(now);

  let text = 'MAB — MORNING NO-SHOW REPORT (' + dstr + ' CT)\n';
  text += 'Assigned today: ' + totalAssigned + '  |  Not working: ' + rows.length + '  (' + parked + ' parked, ' + review + ' no GPS)\n\n';
  fleets.forEach(f => { text += '== ' + f + ' — ' + byFleet[f].length + ' not working ==\n'; byFleet[f].forEach(r => { text += '  - ' + r.num + (r.driver ? ' (' + r.driver + ')' : '') + ' · ' + (r.state === 'parked' ? 'PARKED, 0 loads' : 'NO GPS — call') + ' -> ' + r.orders.join(', ') + '\n'; }); text += '\n'; });
  if (!rows.length) text += 'Everyone assigned is rolling. ✅\n';
  text += '\n=== WORKING / ROLLING by fleet (' + totalWorking + ') ===\n';
  workFleets.forEach(f => { text += '  ' + f + ': ' + working[f].length + '\n'; });
  text += '  OFF-APP SUBS: ' + off + '\n';
  text += '  GRAND TOTAL WORKING (in-app + off-app): ' + (totalWorking + off) + '\n\n';
  text += '--- Who is working (truck + driver + assignment) ---\n';
  workFleets.forEach(f => { text += '== ' + f + ' (' + working[f].length + ') ==\n'; working[f].forEach(w => { text += '  - ' + w.num + (w.driver ? ' (' + w.driver + ')' : '') + ' -> ' + (w.orders || []).join(', ') + '\n'; }); });

  const tbl = rs => '<table style="border-collapse:collapse;font-size:13px;width:100%;margin:2px 0 10px"><tr style="background:#f3f4f6"><td style="padding:3px 9px">Truck</td><td style="padding:3px 9px">Driver</td><td style="padding:3px 9px">Status</td><td style="padding:3px 9px">Orders</td></tr>'
    + rs.map(r => '<tr><td style="padding:3px 9px;font-weight:700">' + esc(r.num) + '</td><td style="padding:3px 9px">' + esc(r.driver) + '</td><td style="padding:3px 9px;color:' + (r.state === 'parked' ? '#b4452e' : '#b8862b') + '">' + (r.state === 'parked' ? 'Parked · 0 loads' : 'No GPS — call') + '</td><td style="padding:3px 9px">' + esc(r.orders.join(', ')) + '</td></tr>').join('') + '</table>';
  let html = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:720px">'
    + '<h2 style="margin:0 0 2px">🚛 Morning No-Show Report</h2>'
    + '<div style="color:#667;font-size:13px;margin-bottom:12px">' + esc(dstr) + ' CT &middot; assigned today: ' + totalAssigned + ' &middot; not working: <b>' + rows.length + '</b> (' + parked + ' parked, ' + review + ' no GPS)</div>';
  if (!rows.length) html += '<div style="color:#3a9d6e;font-size:15px">Everyone assigned is rolling. 🎉</div>';
  fleets.forEach(f => { html += '<h3 style="margin:14px 0 2px">' + esc(f) + ' <span style="color:#99a;font-weight:400">— ' + byFleet[f].length + ' not working</span></h3>' + tbl(byFleet[f]); });
  // MIDDLE: combined totals by fleet (not working | working)
  const allF = orderFleets(Array.from(new Set([].concat(Object.keys(byFleet), Object.keys(working)))));
  html += '<h3 style="margin:18px 0 6px">📊 Totals by fleet</h3>'
    + '<table style="border-collapse:collapse;font-size:14px;min-width:430px"><tr style="background:#f3f4f6"><td style="padding:5px 12px">Fleet</td><td style="padding:5px 12px;text-align:right;color:#b4452e">Not working</td><td style="padding:5px 12px;text-align:right;color:#3a9d6e">Working</td></tr>'
    + allF.map(f => '<tr><td style="padding:5px 12px;font-weight:700">' + esc(f) + '</td><td style="padding:5px 12px;text-align:right;font-weight:700;color:#b4452e">' + ((byFleet[f] || []).length) + '</td><td style="padding:5px 12px;text-align:right;font-weight:700;color:#3a9d6e">' + ((working[f] || []).length) + '</td></tr>').join('')
    + '<tr><td style="padding:5px 12px;font-weight:700">OFF-APP SUBS</td><td style="padding:5px 12px;text-align:right;color:#99a">—</td><td style="padding:5px 12px;text-align:right;font-weight:800;color:#b8862b">' + off + '</td></tr>'
    + '<tr style="border-top:2px solid #ddd"><td style="padding:5px 12px;font-weight:800">TOTAL</td><td style="padding:5px 12px;text-align:right;font-weight:800;color:#b4452e">' + rows.length + '</td><td style="padding:5px 12px;text-align:right;font-weight:800;color:#3a9d6e">' + (totalWorking + off) + '</td></tr></table>';
  // BOTTOM: who is working — truck + driver + where assigned (same shape as the no-show table)
  html += '<h3 style="margin:18px 0 4px;color:#3a9d6e">✅ Who is working — truck, driver &amp; assignment (' + totalWorking + ')</h3>';
  workFleets.forEach(f => { html += '<div style="font-weight:700;margin:10px 0 2px">' + esc(f) + ' <span style="color:#99a;font-weight:400">(' + working[f].length + ')</span></div>'
    + '<table style="border-collapse:collapse;font-size:13px;width:100%;margin-bottom:6px"><tr style="background:#f3f4f6"><td style="padding:3px 9px">Truck</td><td style="padding:3px 9px">Driver</td><td style="padding:3px 9px">Assigned to</td></tr>'
    + working[f].map(w => '<tr><td style="padding:3px 9px;font-weight:700">' + esc(w.num) + '</td><td style="padding:3px 9px">' + esc(w.driver) + '</td><td style="padding:3px 9px">' + esc((w.orders || []).join(', ')) + '</td></tr>').join('') + '</table>'; });
  html += '<div style="color:#99a;font-size:11px;margin-top:12px">Milestone OS &middot; Samsara movement + NewMile assignments. "Parked" = assigned, 0 loads, not moving. "No GPS" = subhauler/no device — call to confirm. "Working" = hauled a load, rolling, or moving.</div></div>';
  return { kind: 'morning', count: rows.length, parked: parked, review: review, totalAssigned: totalAssigned, byFleet: byFleet, rows: rows, working: working, totalWorking: totalWorking, offSubs: off, grandTotalWorking: totalWorking + off, dateKey: opts.dateKey || '', text: text, html: html, dateStr: dstr };
}

// ---------- NIGHT: trucks assigned per fleet (default TOMORROW; opts.dayIdx/label for previews) ----------
function buildNight(board, opts) {
  opts = opts || {}; const now = opts.nowMs || Date.now();
  const dayIdx = opts.dayIdx || 5, label = opts.label || 'tomorrow';
  const off = parseInt(opts.offSubs, 10) || 0;
  const tom = (board && board.dayMap && board.dayMap[dayIdx]) || [];
  const trucks = (board && board.trucks) || [];
  const byNum = {}; trucks.forEach(t => { byNum[(t.num || '').trim().toUpperCase()] = t; });
  const seen = {}, fleetSets = {}, orderSet = {};
  tom.forEach(o => { if (o.completed) return; orderSet[o.orderId] = 1; (o.assigns || []).forEach(a => { const n = (a.num || '').trim(); if (!n) return; const k = n.toUpperCase(); if (seen[k]) return; seen[k] = 1; const f = fleetLabelFor(byNum[k], n); (fleetSets[f] = fleetSets[f] || []).push(n); }); });
  const fleets = orderFleets(Object.keys(fleetSets));
  const total = Object.keys(seen).length, orders = Object.keys(orderSet).length;
  const dstr = ctStr(now);

  let text = 'MAB — NIGHTLY FLEET ASSIGNMENT REPORT (' + dstr + ' CT)\n';
  text += 'Trucks assigned for ' + label.toUpperCase() + ': ' + total + ' across ' + orders + ' orders\n\n';
  fleets.forEach(f => { text += '  ' + f + ': ' + fleetSets[f].length + ' trucks  (' + fleetSets[f].sort().join(', ') + ')\n'; });
  text += '  OFF-APP SUBS: ' + off + '\n';
  text += '  GRAND TOTAL (in-app + off-app): ' + (total + off) + '\n';
  if (!total) text += '  (No trucks assigned for ' + label + ' yet.)\n';

  let html = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:720px">'
    + '<h2 style="margin:0 0 2px">🌙 Nightly Fleet Assignment Report</h2>'
    + '<div style="color:#667;font-size:13px;margin-bottom:12px">' + esc(dstr) + ' CT &middot; assigned for ' + esc(label) + ': <b>' + total + '</b> trucks across ' + orders + ' orders</div>'
    + '<table style="border-collapse:collapse;font-size:14px;min-width:360px"><tr style="background:#f3f4f6"><td style="padding:5px 12px">Fleet</td><td style="padding:5px 12px;text-align:right">Trucks assigned</td></tr>'
    + fleets.map(f => '<tr><td style="padding:5px 12px;font-weight:700">' + esc(f) + '</td><td style="padding:5px 12px;text-align:right;font-weight:800;color:#b8862b">' + fleetSets[f].length + '</td></tr>').join('')
    + '<tr><td style="padding:5px 12px;font-weight:700">OFF-APP SUBS</td><td style="padding:5px 12px;text-align:right;font-weight:800;color:#b8862b">' + off + '</td></tr>'
    + '<tr style="border-top:2px solid #ddd"><td style="padding:5px 12px;font-weight:800">GRAND TOTAL</td><td style="padding:5px 12px;text-align:right;font-weight:800">' + (total + off) + '</td></tr></table>';
  if (!total) html += '<div style="color:#b8862b">No trucks assigned for ' + esc(label) + ' yet.</div>';
  html += '<div style="color:#99a;font-size:11px;margin-top:12px">Milestone OS &middot; NewMile assignments for ' + esc(label) + ', by fleet.</div></div>';
  return { kind: 'night', total: total, offSubs: off, grandTotal: total + off, orders: orders, byFleet: fleetSets, fleetCounts: fleets.reduce((m, f) => { m[f] = fleetSets[f].length; return m; }, {}), dateKey: opts.dateKey || '', text: text, html: html, dateStr: dstr };
}

module.exports = { buildMorning, buildNight, buildNoShow: buildMorning };
