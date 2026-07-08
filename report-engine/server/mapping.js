'use strict';
/*
 * Board data mapping — ports the desktop shell.js mapping verbatim so the mobile app sees
 * the SAME shapes the desktop board does. Turns the raw refreshAll payload (+ a Samsara
 * snapshot) into a clean { today, trucks[], dayMap:{3,4,5} } the mobile UI renders directly.
 * Pure functions, no DOM. groupsCfg comes from newmile.config.json "groups" (per-market).
 */
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function hourFromStart(s) { try { const h = parseInt(String(s).slice(11, 13), 10); return isNaN(h) ? 4 : h; } catch (e) { return 4; } }
function ampm(h) { const x = h % 12 || 12; return x + ':00 ' + (h < 12 ? 'AM' : 'PM'); }
function unitOf(o) {
  const u = (o.quantity_measurement_unit || '').toLowerCase();
  if (u === 'ton' || u === 'load' || u === 'hour') return u;
  const m = (o.material_name || '').toLowerCase(), ht = (o.haul_type || '').toLowerCase();
  if (m.indexOf('hourly') >= 0 || m.indexOf('onsite hauling') >= 0 || (ht === 'onsite' && m.indexOf('asphalt') >= 0)) return 'hour';
  if (m === 'milk' || m.indexOf('fill dirt') >= 0 || ht === 'export') return 'load';
  return 'ton';
}
function statusOf(s) { if (s === 'paused') return 'paused'; if (s === 'pending') return 'pending'; return 'active'; }

function mapAssigns(rows, numToId, unit) {
  const out = [];
  (rows || []).forEach(r => {
    const tid = numToId[(r.truck_number || '').trim().toLowerCase()];
    if (!tid) return;
    // driver ON THIS assignment (orgs run several drivers) + whether NewMile still lacks one
    const driver = (r.driver_name || '').trim();
    const noDriver = (String(r.assignment_status || '').toLowerCase() === 'missing_driver') || !driver;
    const base = { driver: driver, driverId: r.driver_id || null, noDriver: noDriver,
      pay: (r.truck_pay_rate != null ? num(r.truck_pay_rate) : null), payUnit: (r.truck_pay_rate_measurement_unit || ''), rateSrc: (r.rate_source || '') };
    if (unit === 'hour') out.push(Object.assign({ truck: tid, num: (r.truck_number || '').trim(), ll: 'hourly', done: Math.round(num(r.hours_worked)), seq: r.ordinal || 1, aid: r.id }, base));
    else out.push(Object.assign({ truck: tid, num: (r.truck_number || '').trim(), ll: (r.load_limit == null ? 'open' : r.load_limit), done: r.load_count || 0, seq: r.ordinal || 1, aid: r.id }, base));
  });
  return out;
}
function mapOrder(o, asgRows, numToId, nmNotes, coords) {
  const h = hourFromStart(o.start_date), nm = o.assignment_count || 0, unit = unitOf(o);
  const target = Math.round(num(o.quantity_requested)), deliv = num(o.weight_delivered);
  const assigns = mapAssigns(asgRows, numToId || {}, unit);
  const completed = (['completed', 'closed', 'cancelled'].indexOf(o.status) >= 0) || (unit === 'ton' && target > 0 && deliv >= target);
  const m = {
    id: 'o' + o.id, orderId: o.id, projectId: o.project_id || (coords && coords.projectId) || null, projectName: o.project_name || '',
    disp: (o.reference_number || '').trim(), cust: o.customer_name || o.material_name || '', mat: o.material_name || '',
    pickup: (o.vendor_location || '').trim(), drop: (o.delivery_location || '').trim(),
    unit: unit, target: target, flex: Math.round(num(o.quantity_flex_allowed)),
    payRate: (o.truck_pay_rate != null ? num(o.truck_pay_rate) : null), payUnit: (o.truck_pay_rate_measurement_unit || unit),
    fsc: (function () { const f = (o.payable_fees || []).find(x => x.fee_type_id === 2); return f ? { rate: num(f.rate), unit: f.measurement_unit || '', id: f.id } : null; })(),
    fscRecv: (function () { const f = (o.receivable_fees || []).find(x => x.fee_type_id === 2); return f ? { rate: num(f.rate), unit: f.measurement_unit || '', id: f.id } : null; })(),
    payableFees: (o.payable_fees || []), receivableFees: (o.receivable_fees || []),
    status: statusOf(o.status), nmStatus: o.status, completed: completed, startHr: h, time: ampm(h),
    nm: nm, deliv: deliv, loadsDone: o.load_count || 0,
    minTrucks: o.minimum_truck_count || 0, planTrucks: o.planned_truck_count || 0, priority: o.priority || 'medium',
    nmNotes: (nmNotes || []),
    finalized: assigns.length > 0, modified: false, assigns: assigns,
    nmAssigns: (asgRows || []).map(r => ({ aid: r.id, num: (r.truck_number || '').trim(), done: (unit === 'hour' ? 0 : (r.load_count || 0)), status: (r.assignment_status || r.status || '').toLowerCase(), offer: (r.offer_status || '').toLowerCase(), load: (r.load_status || '').toLowerCase(), final: /^(pending|active|order_assignment_completed)$/.test(String(r.assignment_status || '').toLowerCase()) }))
  };
  if (coords) {
    if (coords.pickup) { m.pickupLat = coords.pickup.lat; m.pickupLng = coords.pickup.lng; if (coords.pickup.addr) m.pickupAddr = coords.pickup.addr; m.pickupApprox = !!coords.pickup.approx; }
    if (coords.drop) { m.dropLat = coords.drop.lat; m.dropLng = coords.drop.lng; if (coords.drop.addr) m.dropAddr = coords.drop.addr; m.dropApprox = !!coords.drop.approx; }
  }
  return m;
}

const JUNK = /(DOWN|Camera|De-Leased|Train loads|Need)/i;
function dedupeTrucks(rows) {
  const seen = {}, out = [];
  for (const t of (rows || [])) {
    const n = (t.truck_number || '').trim(), own = (t.owner_name || '');
    if (!n || JUNK.test(n) || n.length > 18) continue;
    if (/ATX Bluewing/i.test(own)) continue;
    const k = n + '|' + own; if (seen[k]) continue; seen[k] = 1; out.push(t);
  }
  return out;
}
function fleetOf(t) { if (t.fleet_id === 5) return 'cactus'; if (t.fleet_id === 6) return 'ckj'; return 'sub'; }
const FLEET_ALIASES = { 'Cactus Express': 'CE', 'CKJ Transport': 'KT', 'Aggship': 'AGG+CT', 'Kennemer': 'KT' };
const RULE_LABELS = { 'CKJ_SUB': 'CKJ SUB', 'AGGCT': 'AGG+CT' };
function groupOfTruck(t, groupsCfg) {
  const als = Object.assign({}, FLEET_ALIASES, (groupsCfg && groupsCfg.fleet_aliases) || {});
  if (t.fleet_name) {
    if (als[t.fleet_name]) return als[t.fleet_name];
    const n = String(t.fleet_name).trim();
    return (n.length > 9 ? (n.slice(0, 8).trim().toUpperCase() + '…') : n.toUpperCase());
  }
  if (t.fleet_id === 6) return 'KT';
  if (t.fleet_id === 5) return 'CE';
  if (t.fleet_id === 4) return 'AGG+CT';
  const owner = (t.owner_name || '');
  if (groupsCfg) {
    const ov = groupsCfg.owner_overrides || {};
    if (ov[owner] && typeof ov[owner] === 'string' && ov[owner][0] !== '_') return RULE_LABELS[ov[owner]] || ov[owner];
    for (const r of (groupsCfg.owner_rules || [])) {
      if (r.contains && owner.toUpperCase().includes(String(r.contains).toUpperCase())) return RULE_LABELS[r.group] || r.group;
    }
  }
  return 'SUB';
}
function termOf(n) { const m = /^KT-\d+\s+([PRW])$/.exec((n || '').trim()); if (!m) return null; return { P: 'Powderly', R: 'Rhome', W: 'Whitewright' }[m[1]]; }
function mapTruck(t, worked, groupsCfg) {
  const n = (t.truck_number || '').trim(), fl = fleetOf(t), term = termOf(n);
  const o = {
    id: 't' + t.id, num: n, fleet: fl, group: groupOfTruck(t, groupsCfg),
    owner: (t.owner_name || (n.indexOf('KT-') === 0 ? 'Kennemer (KT)' : 'Owner-Op')),
    driver: t.driver_name || '', status: 'free', onCall: !!t.on_call,
    workedYest: worked(n, fl), prio: false
  };
  if (term) o.terminal = term;
  return o;
}
function normNum(s) { return (String(s).replace(/^0+/, '') || '0'); }
function workedSet(tickets) {
  const CAC = {}, KT4 = {}, SUB3 = {}, EX = {};
  for (const r of (tickets || [])) {
    const c = (r.truck_number || '').trim().toUpperCase(); let m;
    if ((m = /^C(\d+)$/.exec(c))) CAC[normNum(m[1])] = 1;
    else if ((m = /^CKJ(\d{4})$/.exec(c))) KT4[normNum(m[1])] = 1;
    else if ((m = /^CKJ(\d{3})$/.exec(c))) SUB3[normNum(m[1])] = 1;
    else EX[c.replace(/\s+/g, '')] = 1;
  }
  return function (numStr, fleet) {
    const n = (numStr || '').trim(), u = n.toUpperCase().replace(/\s+/g, '');
    if (fleet === 'cactus') return !!(CAC[normNum(n)] || EX[u]);
    if (fleet === 'ckj') { const m = /^KT-(\d+)/.exec(n); if (m) return !!KT4[normNum(m[1])]; return !!(SUB3[normNum(n)] || KT4[normNum(n)]); }
    return !!(EX[u] || CAC[normNum(n)]);
  };
}

// raw = client.refreshAll output; sam = Samsara GPS snapshot keyed by UPPER truck name
function buildBoard(raw, sam, groupsCfg) {
  raw = raw || {};
  const orders = raw.orders || { y: [], t: [], tm: [] };
  const assignments = raw.assignments || {};
  const notes = raw.orderNotes || {};
  const meta = raw.orderMeta || {};
  const pc = raw.pickupCoords || {}, dc = raw.dropCoords || {};

  const trucksRaw = dedupeTrucks(raw.trucks);
  const numToId = {}; trucksRaw.forEach(t => { numToId[(t.truck_number || '').trim().toLowerCase()] = 't' + t.id; });
  const worked = workedSet(raw.tickets);

  // rolling = a live load_status or loads hauled on a TODAY assignment ONLY (matches desktop
  // shell.js). Scanning y/t/tm marked trucks that hauled YESTERDAY as "rolling" today → the 7 AM
  // no-show report classified parked trucks as working and undercounted no-shows.
  const rolling = {};
  (orders.t || []).forEach(o => ((assignments[o.id]) || []).forEach(r => {
    if (r.load_status || (r.load_count || 0) > 0) rolling[(r.truck_number || '').trim().toLowerCase()] = 1;
  }));

  const trucks = trucksRaw.map(t => {
    const m = mapTruck(t, worked, groupsCfg);
    const key = m.num.toUpperCase().replace(/\s+/g, ' ');
    const g = sam && sam[key];
    if (g) { m.mph = g.speed; m.lat = g.lat; m.lon = g.lon; m.gpsTime = g.time; }
    if (rolling[m.num.toLowerCase()]) { m.rolling = true; m.status = 'rolling'; }
    return m;
  });

  function mapDay(list) {
    return (list || []).map(o => {
      const coords = { pickup: pc[o.id] || null, drop: dc[o.id] || null, projectId: (meta[o.id] && meta[o.id].project_id) || null };
      return mapOrder(o, assignments[o.id], numToId, notes[o.id], coords);
    });
  }

  return {
    today: raw.date,
    priorDay: raw.priorDay,
    trucks: trucks,
    dayMap: { 3: mapDay(orders.y), 4: mapDay(orders.t), 5: mapDay(orders.tm) }
  };
}

module.exports = { buildBoard };
