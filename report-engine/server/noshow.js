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
function ctTime(ms) { return new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(/\s/g, ''); }
function haverMi(a1, o1, a2, o2) { const R = 3958.8, rad = Math.PI / 180, dA = (a2 - a1) * rad, dO = (o2 - o1) * rad; const s = Math.sin(dA / 2) ** 2 + Math.cos(a1 * rad) * Math.cos(a2 * rad) * Math.sin(dO / 2) ** 2; return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)); }
// one-line evidence: what the dispatcher would otherwise learn only by phoning the driver
function evLine(r) {
  const e = r.ev; const bits = [];
  if (e) {
    if (e.movedToday && e.lastMoveMs) bits.push('moved ' + ctTime(e.lastMoveMs)); else bits.push('NO movement today');
    if (e.engineOn === true) bits.push('engine ON'); else if (e.engineOn === false) bits.push('engine off');
  }
  if (r.distMi != null) bits.push(r.distMi <= 1.5 ? 'AT the pickup' : (Math.round(r.distMi) + ' mi from pickup'));
  return bits.join(' · ');
}
function mapsUrl(r) { const la = (r.ev && r.ev.lat != null) ? r.ev.lat : r.lat, lo = (r.ev && r.ev.lat != null) ? r.ev.lon : r.lon; return la != null ? ('https://maps.google.com/?q=' + la + ',' + lo) : null; }
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
  const nowHr = parseInt(new Date(now).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hour12: false }), 10) || 0;
  const off = parseInt(opts.offSubs, 10) || 0;
  const day = (board && board.dayMap && board.dayMap[4]) || [];
  const trucks = (board && board.trucks) || [];
  const byNum = {}; trucks.forEach(t => { byNum[(t.num || '').trim().toUpperCase()] = t; });
  const assigned = {};
  day.forEach(o => {
    if (o.completed) return;
    // per-order NewMile assignment status, so we can tell "accepted the job" from a true no-show
    const nmByNum = {};
    (o.nmAssigns || []).forEach(r => { const kk = (r.num || '').trim().toUpperCase(); if (kk) nmByNum[kk] = r; });
    (o.assigns || []).forEach(a => {
      const n = (a.num || '').trim(); if (!n) return; const k = n.toUpperCase();
      const rec = (assigned[k] = assigned[k] || { num: n, orders: [], done: 0, dueHr: null, accepted: false });
      rec.done += (typeof a.done === 'number' ? a.done : 0);
      const lbl = o.disp || ('#' + o.orderId); if (rec.orders.indexOf(lbl) < 0) rec.orders.push(lbl);
      // earliest start hour across this truck's orders — a truck whose order starts later is NOT late
      if (o.startHr != null) rec.dueHr = (rec.dueHr == null ? o.startHr : Math.min(rec.dueHr, o.startHr));
      // first available pickup coords → lets the report say "AT the pickup / 28 mi away"
      if (o.pickupLat != null && rec.pLat == null) { rec.pLat = o.pickupLat; rec.pLng = o.pickupLng; }
      const nm = nmByNum[k];
      // NewMile offer_status is 'offer_accepted' (raw); tolerate both spellings
      if (nm && /accepted/.test(String(nm.offer || ''))) rec.accepted = true;
    });
  });
  const totalAssigned = Object.keys(assigned).length;
  const rows = [];
  const notDue = [];        // assigned but the order start time hasn't arrived yet → not late
  const acceptedIdle = [];  // driver accepted the job in NewMile but no movement/loads yet
  const working = {};   // fleet label -> [{num, driver}] of trucks that ARE working
  const tallyWork = (t, num, ords) => { const f = fleetLabelFor(t, num); (working[f] = working[f] || []).push({ num: num, driver: (t && t.driver) || '', orders: ords || [] }); };
  Object.keys(assigned).forEach(k => {
    const a = assigned[k], t = byNum[k];
    if (a.done > 0) { tallyWork(t, a.num, a.orders); return; }   // hauled / worked hours today → working
    if (t && t.rolling) { tallyWork(t, a.num, a.orders); return; } // live load today → working
    let state, fleet = fleetLabelFor(t, a.num);
    if (!t) { state = 'review'; }
    else {
      const ageMin = t.gpsTime ? Math.round((now - new Date(t.gpsTime).getTime()) / 60000) : null;
      const hasGps = t.lat != null && ageMin != null && ageMin < 180;
      if (!hasGps) state = 'review';
      else if (t.mph != null && t.mph < 1) state = 'parked';
      else { tallyWork(t, a.num, a.orders); return; }             // has GPS and moving → working
    }
    // accepted the job in NewMile → engaged, just hasn't rolled yet (not a no-show to chase)
    if (a.accepted) { acceptedIdle.push({ num: a.num, driver: (t && t.driver) || '', orders: a.orders, fleet: fleet }); return; }
    // order start time hasn't arrived yet → not late, don't alarm the dispatcher
    if (a.dueHr != null && a.dueHr > nowHr) { notDue.push({ num: a.num, driver: (t && t.driver) || '', orders: a.orders, fleet: fleet, dueHr: a.dueHr }); return; }
    rows.push({ num: a.num, driver: (t && t.driver) || '', owner: (t && t.owner) || '', orders: a.orders, fleet: fleet, state: state, lat: (t && t.lat != null ? t.lat : null), lon: (t && t.lon != null ? t.lon : null), pLat: (a.pLat != null ? a.pLat : null), pLng: (a.pLng != null ? a.pLng : null) });
  });
  // MOVEMENT EVIDENCE (opts.evidence from samsara.movementEvidence): distinguish "staged at the
  // pit / just moved / engine running" (⏳ probably fine) from "dead since yesterday" (☎️ call).
  const evMap = opts.evidence || null;
  rows.forEach(r => {
    const e = evMap && evMap[r.num.trim().toUpperCase().replace(/\s+/g, ' ')];
    if (e) r.ev = e;
    const la = (e && e.lat != null) ? e.lat : r.lat, lo = (e && e.lat != null) ? e.lon : r.lon;
    if (r.pLat != null && la != null) r.distMi = Math.round(haverMi(la, lo, r.pLat, r.pLng) * 10) / 10;
    r.staged = !!((e && ((e.movedToday && e.lastMoveMs && (now - e.lastMoveMs) <= 45 * 60000) || e.engineOn === true)) || (r.distMi != null && r.distMi <= 1.5));
  });
  const callFirst = rows.filter(r => !r.staged).length, stagedN = rows.length - callFirst;
  const byFleet = {}; rows.forEach(r => { (byFleet[r.fleet] = byFleet[r.fleet] || []).push(r); });
  Object.keys(byFleet).forEach(f => byFleet[f].sort((a, b) => ((a.staged ? 1 : 0) - (b.staged ? 1 : 0)) || a.num.localeCompare(b.num, undefined, { numeric: true })));
  const fleets = orderFleets(Object.keys(byFleet));
  const workFleets = orderFleets(Object.keys(working));
  workFleets.forEach(f => working[f].sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true })));
  const totalWorking = Object.keys(working).reduce((n, f) => n + working[f].length, 0);
  const parked = rows.filter(r => r.state === 'parked').length, review = rows.filter(r => r.state === 'review').length;
  const dstr = ctStr(now);

  let text = 'MAB — MORNING NO-SHOW REPORT (' + dstr + ' CT)\n';
  text += 'Assigned today: ' + totalAssigned + '  |  Not working: ' + rows.length + '  (' + parked + ' parked, ' + review + ' no GPS)';
  if (evMap) text += '  |  ☎ CALL FIRST: ' + callFirst + ' · ⏳ likely staged: ' + stagedN;
  text += '  |  accepted, not moving yet: ' + acceptedIdle.length + '  |  not due yet: ' + notDue.length + '\n\n';
  fleets.forEach(f => { text += '== ' + f + ' — ' + byFleet[f].length + ' not working ==\n'; byFleet[f].forEach(r => { const ev = evLine(r); text += '  - ' + (evMap ? (r.staged ? '⏳ ' : '☎ ') : '') + r.num + (r.driver ? ' (' + r.driver + ')' : '') + ' · ' + (r.state === 'parked' ? 'PARKED, 0 loads' : 'NO GPS — call') + (ev ? ' · [' + ev + ']' : '') + ' -> ' + r.orders.join(', ') + '\n'; }); text += '\n'; });
  if (!rows.length) text += 'No confirmed no-shows to chase. ✅\n';
  text += '\n=== WORKING / ROLLING by fleet (' + totalWorking + ') ===\n';
  workFleets.forEach(f => { text += '  ' + f + ': ' + working[f].length + '\n'; });
  text += '  OFF-APP SUBS: ' + off + '\n';
  text += '  GRAND TOTAL WORKING (in-app + off-app): ' + (totalWorking + off) + '\n';
  if (acceptedIdle.length) { text += '\n--- Accepted in NewMile, not moving yet (' + acceptedIdle.length + ') ---\n'; acceptedIdle.forEach(r => { text += '  - ' + r.num + (r.driver ? ' (' + r.driver + ')' : '') + ' -> ' + (r.orders || []).join(', ') + '\n'; }); }
  if (notDue.length) { text += '\n--- Not due yet, later start (' + notDue.length + ') ---\n'; notDue.forEach(r => { text += '  - ' + r.num + (r.driver ? ' (' + r.driver + ')' : '') + ' -> ' + (r.orders || []).join(', ') + '\n'; }); }
  text += '\n';
  text += '--- Who is working (truck + driver + assignment) ---\n';
  workFleets.forEach(f => { text += '== ' + f + ' (' + working[f].length + ') ==\n'; working[f].forEach(w => { text += '  - ' + w.num + (w.driver ? ' (' + w.driver + ')' : '') + ' -> ' + (w.orders || []).join(', ') + '\n'; }); });

  const evCell = r => {
    const ev = evLine(r), url = mapsUrl(r);
    if (!ev && !url) return '<td style="padding:3px 9px;color:#99a">—</td>';
    return '<td style="padding:3px 9px;font-size:12px;color:#556">' + (evMap ? (r.staged ? '⏳ ' : '☎️ ') : '') + esc(ev || '') + (url ? ' <a href="' + esc(url) + '" style="color:#2c74b4">map</a>' : '') + '</td>';
  };
  const tbl = rs => '<table style="border-collapse:collapse;font-size:13px;width:100%;margin:2px 0 10px"><tr style="background:#f3f4f6"><td style="padding:3px 9px">Truck</td><td style="padding:3px 9px">Driver</td><td style="padding:3px 9px">Status</td><td style="padding:3px 9px">Evidence</td><td style="padding:3px 9px">Orders</td></tr>'
    + rs.map(r => '<tr' + (evMap && !r.staged ? ' style="background:#fdf3f1"' : '') + '><td style="padding:3px 9px;font-weight:700">' + esc(r.num) + '</td><td style="padding:3px 9px">' + esc(r.driver) + '</td><td style="padding:3px 9px;color:' + (r.state === 'parked' ? '#b4452e' : '#b8862b') + '">' + (r.state === 'parked' ? 'Parked · 0 loads' : 'No GPS — call') + '</td>' + evCell(r) + '<td style="padding:3px 9px">' + esc(r.orders.join(', ')) + '</td></tr>').join('') + '</table>';
  let html = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px">'
    + '<h2 style="margin:0 0 2px">🚛 Morning No-Show Report</h2>'
    + '<div style="color:#667;font-size:13px;margin-bottom:12px">' + esc(dstr) + ' CT &middot; assigned today: ' + totalAssigned + ' &middot; not working: <b>' + rows.length + '</b> (' + parked + ' parked, ' + review + ' no GPS)'
    + (evMap ? ' &middot; <b style="color:#b4452e">☎️ call first: ' + callFirst + '</b> &middot; ⏳ likely staged: ' + stagedN : '')
    + ' &middot; accepted, not moving yet: ' + acceptedIdle.length + ' &middot; not due yet: ' + notDue.length + '</div>'
    + (evMap ? '<div style="color:#667;font-size:12px;margin:-6px 0 10px">☎️ = no movement today / engine off / far from pickup — call these first. ⏳ = moved recently, engine running, or sitting AT the pickup — probably staged, check later.</div>' : '');
  if (!rows.length) html += '<div style="color:#3a9d6e;font-size:15px">No confirmed no-shows to chase. 🎉</div>';
  fleets.forEach(f => { html += '<h3 style="margin:14px 0 2px">' + esc(f) + ' <span style="color:#99a;font-weight:400">— ' + byFleet[f].length + ' not working</span></h3>' + tbl(byFleet[f]); });
  // MIDDLE: combined totals by fleet (not working | working)
  const allF = orderFleets(Array.from(new Set([].concat(Object.keys(byFleet), Object.keys(working)))));
  html += '<h3 style="margin:18px 0 6px">📊 Totals by fleet</h3>'
    + '<table style="border-collapse:collapse;font-size:14px;min-width:430px"><tr style="background:#f3f4f6"><td style="padding:5px 12px">Fleet</td><td style="padding:5px 12px;text-align:right;color:#b4452e">Not working</td><td style="padding:5px 12px;text-align:right;color:#3a9d6e">Working</td></tr>'
    + allF.map(f => '<tr><td style="padding:5px 12px;font-weight:700">' + esc(f) + '</td><td style="padding:5px 12px;text-align:right;font-weight:700;color:#b4452e">' + ((byFleet[f] || []).length) + '</td><td style="padding:5px 12px;text-align:right;font-weight:700;color:#3a9d6e">' + ((working[f] || []).length) + '</td></tr>').join('')
    + '<tr><td style="padding:5px 12px;font-weight:700">OFF-APP SUBS</td><td style="padding:5px 12px;text-align:right;color:#99a">—</td><td style="padding:5px 12px;text-align:right;font-weight:800;color:#b8862b">' + off + '</td></tr>'
    + '<tr style="border-top:2px solid #ddd"><td style="padding:5px 12px;font-weight:800">TOTAL</td><td style="padding:5px 12px;text-align:right;font-weight:800;color:#b4452e">' + rows.length + '</td><td style="padding:5px 12px;text-align:right;font-weight:800;color:#3a9d6e">' + (totalWorking + off) + '</td></tr></table>';
  // INFO buckets: accepted-but-idle and not-due-yet (context, not no-shows)
  const miniTbl = (title, color, arr) => arr.length ? ('<h3 style="margin:16px 0 4px;color:' + color + '">' + title + ' (' + arr.length + ')</h3>'
    + '<table style="border-collapse:collapse;font-size:13px;width:100%;margin-bottom:6px"><tr style="background:#f3f4f6"><td style="padding:3px 9px">Truck</td><td style="padding:3px 9px">Driver</td><td style="padding:3px 9px">Assigned to</td></tr>'
    + arr.slice().sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true })).map(r => '<tr><td style="padding:3px 9px;font-weight:700">' + esc(r.num) + '</td><td style="padding:3px 9px">' + esc(r.driver) + '</td><td style="padding:3px 9px">' + esc((r.orders || []).join(', ')) + '</td></tr>').join('') + '</table>') : '';
  html += miniTbl('🤝 Accepted in NewMile — not moving yet', '#2c74b4', acceptedIdle);
  html += miniTbl('🕒 Not due yet — later start', '#7a6', notDue);
  // BOTTOM: who is working — truck + driver + where assigned (same shape as the no-show table)
  html += '<h3 style="margin:18px 0 4px;color:#3a9d6e">✅ Who is working — truck, driver &amp; assignment (' + totalWorking + ')</h3>';
  workFleets.forEach(f => { html += '<div style="font-weight:700;margin:10px 0 2px">' + esc(f) + ' <span style="color:#99a;font-weight:400">(' + working[f].length + ')</span></div>'
    + '<table style="border-collapse:collapse;font-size:13px;width:100%;margin-bottom:6px"><tr style="background:#f3f4f6"><td style="padding:3px 9px">Truck</td><td style="padding:3px 9px">Driver</td><td style="padding:3px 9px">Assigned to</td></tr>'
    + working[f].map(w => '<tr><td style="padding:3px 9px;font-weight:700">' + esc(w.num) + '</td><td style="padding:3px 9px">' + esc(w.driver) + '</td><td style="padding:3px 9px">' + esc((w.orders || []).join(', ')) + '</td></tr>').join('') + '</table>'; });
  html += '<div style="color:#99a;font-size:11px;margin-top:12px">Milestone OS &middot; Samsara movement + NewMile assignments. "Parked" = assigned, 0 loads, not moving. "No GPS" = subhauler/no device — call to confirm. "Working" = hauled a load, rolling, or moving.</div></div>';
  return { kind: 'morning', count: rows.length, parked: parked, review: review, totalAssigned: totalAssigned, byFleet: byFleet, rows: rows, working: working, totalWorking: totalWorking, offSubs: off, grandTotalWorking: totalWorking + off, notDue: notDue, acceptedIdle: acceptedIdle, callFirst: callFirst, stagedN: stagedN, dateKey: opts.dateKey || '', text: text, html: html, dateStr: dstr };
}

// ---------- RE-CHECK (~9 AM): second pass over the morning call list. Who started working on
// their own since 7:30 (no call needed) and who is STILL down (the real call list). ----------
function buildRecheck(board, opts) {
  opts = opts || {}; const now = opts.nowMs || Date.now();
  const fl = opts.flagged || { rows: [], sentAt: 0 };
  const trucks = (board && board.trucks) || [];
  const byNum = {}; trucks.forEach(t => { byNum[(t.num || '').trim().toUpperCase()] = t; });
  const day = (board && board.dayMap && board.dayMap[4]) || [];
  const live = {};
  day.forEach(o => { if (o.completed) return; (o.assigns || []).forEach(a => { const k = (a.num || '').trim().toUpperCase(); if (!k) return; const rec = (live[k] = live[k] || { done: 0 }); rec.done += (typeof a.done === 'number' ? a.done : 0); }); });
  const evMap = opts.evidence || {};
  const resolved = [], still = [];
  (fl.rows || []).forEach(r0 => {
    const k = (r0.num || '').trim().toUpperCase();
    const t = byNum[k], lv = live[k], e = evMap[k.replace(/\s+/g, ' ')];
    const r = { num: r0.num, driver: r0.driver || (t && t.driver) || '', orders: r0.orders || [], fleet: r0.fleet || fleetLabelFor(t, r0.num) };
    let how = null;
    if (lv && lv.done > 0) how = 'hauled ' + lv.done + ' load' + (lv.done > 1 ? 's' : '');
    else if (t && t.rolling) how = 'live load in NewMile';
    else if (t && t.mph != null && t.mph >= 1) how = 'moving now (' + Math.round(t.mph) + ' mph)';
    else if (e && e.movedToday && e.lastMoveMs && fl.sentAt && e.lastMoveMs > fl.sentAt) how = 'moved at ' + ctTime(e.lastMoveMs);
    if (how) { r.how = how; resolved.push(r); return; }
    r.ev = e || null;
    r.lat = (e && e.lat != null) ? e.lat : (t && t.lat != null ? t.lat : null);
    r.lon = (e && e.lat != null) ? e.lon : (t && t.lon != null ? t.lon : null);
    r.line = e ? (((e.movedToday && e.lastMoveMs) ? ('last moved ' + ctTime(e.lastMoveMs)) : 'NO movement today') + (e.engineOn === true ? ' · engine ON' : (e.engineOn === false ? ' · engine off' : ''))) : 'no GPS data — phone only';
    still.push(r);
  });
  const dstr = ctStr(now);

  let text = 'MAB — MORNING RE-CHECK (' + dstr + ' CT)\n';
  text += 'Second pass on the ' + (fl.rows || []).length + ' trucks flagged at ' + (fl.sentAt ? ctTime(fl.sentAt) : '7:30am') + ':  ✅ now working: ' + resolved.length + '  ·  ☎ STILL DOWN: ' + still.length + '\n\n';
  if (still.length) { text += '== ☎ STILL DOWN — call these (' + still.length + ') ==\n'; still.forEach(r => { text += '  - ' + r.num + (r.driver ? ' (' + r.driver + ')' : '') + ' · ' + r.line + ' -> ' + r.orders.join(', ') + '\n'; }); text += '\n'; }
  else text += 'Everyone from the morning list is moving. 🎉\n\n';
  if (resolved.length) { text += '== ✅ Resolved on their own (' + resolved.length + ') ==\n'; resolved.forEach(r => { text += '  - ' + r.num + (r.driver ? ' (' + r.driver + ')' : '') + ' · ' + r.how + '\n'; }); }

  let html = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px">'
    + '<h2 style="margin:0 0 2px">🔁 Morning Re-check</h2>'
    + '<div style="color:#667;font-size:13px;margin-bottom:12px">' + esc(dstr) + ' CT &middot; second pass on the <b>' + (fl.rows || []).length + '</b> trucks flagged at ' + (fl.sentAt ? esc(ctTime(fl.sentAt)) : '7:30am') + ' &middot; ✅ now working: <b style="color:#3a9d6e">' + resolved.length + '</b> &middot; ☎️ still down: <b style="color:#b4452e">' + still.length + '</b></div>';
  if (still.length) {
    html += '<h3 style="margin:14px 0 2px;color:#b4452e">☎️ STILL DOWN — this is the real call list (' + still.length + ')</h3>'
      + '<table style="border-collapse:collapse;font-size:13px;width:100%;margin:2px 0 10px"><tr style="background:#f3f4f6"><td style="padding:3px 9px">Truck</td><td style="padding:3px 9px">Driver</td><td style="padding:3px 9px">Evidence</td><td style="padding:3px 9px">Orders</td></tr>'
      + still.map(r => { const url = (r.lat != null) ? ('https://maps.google.com/?q=' + r.lat + ',' + r.lon) : null; return '<tr style="background:#fdf3f1"><td style="padding:3px 9px;font-weight:700">' + esc(r.num) + '</td><td style="padding:3px 9px">' + esc(r.driver) + '</td><td style="padding:3px 9px;font-size:12px;color:#556">' + esc(r.line) + (url ? ' <a href="' + esc(url) + '" style="color:#2c74b4">map</a>' : '') + '</td><td style="padding:3px 9px">' + esc(r.orders.join(', ')) + '</td></tr>'; }).join('') + '</table>';
  } else html += '<div style="color:#3a9d6e;font-size:15px">Everyone from the morning list is moving. 🎉</div>';
  if (resolved.length) {
    html += '<h3 style="margin:16px 0 2px;color:#3a9d6e">✅ Resolved on their own (' + resolved.length + ')</h3>'
      + '<table style="border-collapse:collapse;font-size:13px;width:100%;margin:2px 0 10px"><tr style="background:#f3f4f6"><td style="padding:3px 9px">Truck</td><td style="padding:3px 9px">Driver</td><td style="padding:3px 9px">How</td></tr>'
      + resolved.map(r => '<tr><td style="padding:3px 9px;font-weight:700">' + esc(r.num) + '</td><td style="padding:3px 9px">' + esc(r.driver) + '</td><td style="padding:3px 9px;color:#3a9d6e">' + esc(r.how) + '</td></tr>').join('') + '</table>';
  }
  html += '<div style="color:#99a;font-size:11px;margin-top:12px">Milestone OS &middot; follow-up on the 7:30am no-show list. "Resolved" = hauled a load, live load, moving now, or moved since the morning email.</div></div>';
  return { kind: 'recheck', resolvedCount: resolved.length, stillCount: still.length, resolved: resolved, still: still, dateKey: opts.dateKey || '', text: text, html: html, dateStr: dstr };
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

module.exports = { buildMorning, buildNight, buildRecheck, buildNoShow: buildMorning };
