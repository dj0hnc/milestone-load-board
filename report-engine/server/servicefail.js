'use strict';
/*
 * Weekly Service Failure report with GP DOLLARS OF LOST LOADS.
 *
 * Sources (all NewMile report API via query_report — same data the app's Reports tab exports):
 *   - service_failures : the week's logged failures (what dispatch records)
 *   - orders           : freight/material rates, delivered qty + load count (avg load size)
 *   - po_margin        : realized margin per PO+material for the same week (revenue AND cost)
 *
 * The service_failures export carries NO dollar or tonnage columns, and the API's
 * has_service_failure filter on the orders report does not actually filter (verified
 * 2026-08-10: 426 rows with it, 426 without). So the join is done here instead:
 * the SF "Order" column equals the orders report's reference_number, and together with
 * the order date it matched 35/35 distinct failed orders on the 8/3-8/8 validation week.
 *
 * GP is driven by the FAILURES THEMSELVES, never by the order's remaining tonnage
 * (an order can run short for reasons nobody logged as a failure, and can be over-covered
 * despite failures). Loads lost per failure row:
 *   - the count dispatch wrote in the note ("didn't finish two loads" = 2, "7 loads
 *     missed" = 7, "5/10 loads planned" = 5 lost, "6 dropped loads" = 6, "last load" = 1,
 *     "missed 60% of the order" = 60% of committed qty),
 *   - no count in the note: 1 load when the failure's impact type is Financial or the
 *     failure is a No Show (a committed truck that never ran), 0 for informational
 *     failures (Schedule/Operational/Reputation with no load count).
 * Per order+day, order-level and assignment-level failures often describe the SAME lost
 * loads ("6 dropped loads from KT fleet" + four per-truck "didn't finish last load"), so
 * loads lost = max(order-entity total, assignment-entity total), not the sum.
 * Quantity lost = loads × that order's ACTUAL average load size this day (delivered qty /
 * load count; fallback tonsPerLoad). GP = quantity × the PO+material's per-unit realized
 * margin from the same week's po_margin (fallbacks: PO margin %, then week margin %,
 * applied to lost revenue = quantity × customer rate).
 *
 * Every GP figure is reported as a RANGE: "GP Lost — Direct" (the floor above) and
 * "GP At Risk" (ceiling: every logged failure counts at least 1 load unless its note gave
 * the count — a failure's truck was planned somewhere, so even a covered failure displaces
 * capacity from another order that logs no failure).
 */

function num(v) { if (v == null || v === '') return 0; const n = parseFloat(String(v).replace(/[$,%\s]/g, '').replace(/,/g, '')); return isNaN(n) ? 0 : n; }
function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function dateKey(s) { return String(s || '').trim().split(' ')[0]; }   // "08/03/26 4:00am CDT" -> "08/03/26"
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function csvCell(s) { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

// MAB formatting: one decimal, parentheses for negatives, no minus signs.
function fmtMoney(n) {
  const neg = n < 0, a = Math.abs(n);
  const s = '$' + a.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return neg ? '(' + s + ')' : s;
}
function fmtMoneyK(n) {
  const neg = n < 0, a = Math.abs(n);
  const s = a >= 1000 ? '$' + (a / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 'K' : '$' + a.toFixed(1);
  return neg ? '(' + s + ')' : s;
}
function fmtQty(n) { return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }

// Loads lost stated in a failure note. Returns a load count, or null when the note names none.
// committedQty/avgLoad are needed only for the "missed N% of the order" form.
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
function parseLoadsFromNote(note, committedQty, avgLoad) {
  const t = String(note || '').toLowerCase();
  if (!t.trim()) return null;
  let m = t.match(/(\d+)\s*\/\s*(\d+)\s+loads?\s+planned/);          // "5/10 loads planned" -> 5 lost
  if (m) return Math.max(0, parseInt(m[2], 10) - parseInt(m[1], 10));
  m = t.match(/missed\s+(\d+)\s*%/);                                  // "missed 60% of the order"
  if (m && committedQty > 0 && avgLoad > 0) return Math.max(1, Math.round(committedQty * parseInt(m[1], 10) / 100 / avgLoad));
  m = t.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:dropped\s+)?loads?\b/);
  if (m) return NUM_WORDS[m[1]] || parseInt(m[1], 10);                // "7 loads missed", "didn't finish two loads", "6 dropped loads"
  if (/last\s+loads?\b/.test(t)) return 1;                            // "didn't finish last load", "dropping last load"
  return null;
}
// Loads lost for one failure row, two readings:
//   direct — the note's count when it names one; otherwise 1 for Financial-impact failures
//            and No Shows (a committed truck that never ran), 0 for informational rows.
//            This is the auditable FLOOR: loads documentedly lost.
//   risk   — same, but every logged failure counts at least 1 load unless the note itself
//            gave the count. A failure's truck was planned somewhere; even a "covered"
//            failure displaces capacity from another order (which logs no failure). CEILING.
function failureLoads(f, committedQty, avgLoad) {
  const parsed = parseLoadsFromNote(f.notes, committedQty, avgLoad);
  const direct = parsed != null ? parsed
    : ((norm(f.impact_type) === 'financial' || /no show/i.test(f.failure_type || '')) ? 1 : 0);
  const risk = parsed != null ? parsed : Math.max(1, direct);
  return { direct: direct, risk: risk };
}

// Last full Mon-Sat week strictly before todayISO (the report runs Mondays for the prior week).
function lastWeekRange(todayISO) {
  const d = new Date(todayISO + 'T12:00:00Z');
  const dow = d.getUTCDay();                                   // 0=Sun..6=Sat
  const back = dow === 0 ? 6 : dow - 1;                        // days back to THIS week's Monday
  d.setUTCDate(d.getUTCDate() - back - 7);                     // prior week's Monday
  const from = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 5);                            // its Saturday
  return { from: from, to: d.toISOString().slice(0, 10) };
}

// Pull every page of a report (query_report caps page_size at 100).
async function fetchAllPages(client, reportName, filters, columns) {
  const rows = []; let page = 1, totalPages = 1;
  do {
    const r = await client.callTool('query_report', {
      report_name: reportName, filters: filters, columns: columns, page_size: 100, page: page
    });
    const d = typeof r === 'string' ? JSON.parse(r) : r;
    (d.rows || []).forEach(x => rows.push(x));
    totalPages = d.total_pages || 1;
    page++;
  } while (page <= totalPages && page <= 40);
  return rows;
}

async function fetchWeek(client, fromISO, toISO) {
  const range = { date_type: 'absolute', order_date_from: fromISO, order_date_to: toISO };
  const failures = await fetchAllPages(client, 'service_failures', range, [
    'entity_type', 'order_reference', 'failure_type', 'responsible_party', 'severity', 'impact_type',
    'project', 'customer', 'hauler', 'order_date', 'truck_number', 'driver_name', 'truck_owner',
    'notes', 'recorded_by', 'recorded_at'
  ]);
  const orders = await fetchAllPages(client, 'orders', range, [
    'order_number', 'reference_number', 'customer', 'project', 'po_reference_number', 'material',
    'order_start_date', 'quantity_requested', 'quantity_requested_uom', 'quantity_delivered',
    'total_load_count', 'undelivered_quantity', 'freight_rate', 'freight_rate_uom',
    'material_rate', 'material_rate_uom', 'hauler'
  ]);
  const poMargin = await fetchAllPages(client, 'po_margin', range, [
    'po_reference', 'project_name', 'customer_name', 'material_name', 'delivered_quantity',
    'po_quantity_uom', 'delivered_freight_revenue', 'delivered_material_revenue',
    'delivered_freight_cost', 'delivered_material_cost', 'margin_amount', 'margin_percentage'
  ]);
  return { failures: failures, orders: orders, poMargin: poMargin };
}

function buildServiceFailures(raw, opts) {
  const from = opts.from, to = opts.to;
  const failures = raw.failures || [], orders = raw.orders || [], poMargin = raw.poMargin || [];

  // ---- index orders by (reference, order date) ----
  const oidx = new Map();
  orders.forEach(o => {
    const k = norm(o.reference_number) + '|' + dateKey(o.order_start_date);
    if (!oidx.has(k)) oidx.set(k, o);
  });

  // ---- index po_margin by (project, material) and (po ref, material) ----
  const pmProj = new Map(), pmPo = new Map();
  poMargin.forEach(p => {
    const kp = norm(p.project_name) + '|' + norm(p.material_name);
    if (!pmProj.has(kp)) pmProj.set(kp, p);
    if (p.po_reference) {
      const ko = norm(p.po_reference) + '|' + norm(p.material_name);
      if (!pmPo.has(ko)) pmPo.set(ko, p);
    }
  });
  let mSum = 0, rSum = 0;
  poMargin.forEach(p => {
    mSum += num(p.margin_amount);
    rSum += num(p.delivered_freight_revenue) + num(p.delivered_material_revenue);
  });
  const orgPct = rSum > 0 ? mSum / rSum : 0.15;                // org-wide realized margin % for the week

  // ---- distinct failed orders (many failure rows can hit one order+day) ----
  const failed = new Map();
  failures.forEach(f => {
    const k = norm(f.order_reference) + '|' + dateKey(f.order_date);
    if (!failed.has(k)) failed.set(k, []);
    failed.get(k).push(f);
  });

  const tonsPerLoad = (opts && opts.tonsPerLoad) || 25;   // fallback avg load size when the order hauled nothing
  const rows = [], unmatched = [];
  Array.from(failed.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1).forEach(pair => {
    const frows = pair[1];
    const o = oidx.get(pair[0]);
    if (!o) { unmatched.push(frows[0]); return; }
    const committed = num(o.quantity_requested);
    const uom = o.quantity_requested_uom || '';
    // actual average load size for THIS order/day; fallbacks: 1 for Load-UOM, tonsPerLoad for tons.
    const avgLoad = num(o.total_load_count) > 0 && num(o.quantity_delivered) > 0
      ? num(o.quantity_delivered) / num(o.total_load_count)
      : (/load/i.test(uom) ? 1 : (/hour/i.test(uom) ? 0 : tonsPerLoad));
    // loads lost comes from the FAILURE ROWS ONLY. Order-level and assignment-level failures
    // usually describe the same loads, so take the max of the two totals, not the sum.
    let orderLoads = 0, assignLoads = 0, orderRisk = 0, assignRisk = 0;
    frows.forEach(f => {
      const n = failureLoads(f, committed, avgLoad);
      f._loadsLost = n.direct;                             // per-failure counts, surfaced in the failure-log CSV
      f._loadsAtRisk = n.risk;
      if (/assignment/i.test(f.entity_type || '')) { assignLoads += n.direct; assignRisk += n.risk; }
      else { orderLoads += n.direct; orderRisk += n.risk; }
    });
    const loadsLost = Math.max(orderLoads, assignLoads);
    const loadsAtRisk = Math.max(orderRisk, assignRisk);
    const qtyLost = loadsLost * avgLoad;                   // 0 for hourly orders (no load size to price)
    const qtyAtRisk = loadsAtRisk * avgLoad;
    const rate = num(o.freight_rate) + num(o.material_rate);
    const lostRev = qtyLost * rate;
    const pm = pmProj.get(norm(o.project) + '|' + norm(o.material)) ||
               pmPo.get(norm(o.po_reference_number) + '|' + norm(o.material)) || null;
    let gpOf, method;
    if (pm && num(pm.delivered_quantity) > 0 && num(pm.margin_amount) !== 0) {
      const perUnit = num(pm.margin_amount) / num(pm.delivered_quantity);
      gpOf = q => q * perUnit; method = 'PO per-unit margin';
    } else if (pm) {
      const pct = num(pm.margin_percentage) / 100;
      gpOf = q => q * rate * pct; method = 'PO margin %';
    } else {
      gpOf = q => q * rate * orgPct; method = 'org avg %';
    }
    const lostGp = gpOf(qtyLost), gpAtRisk = gpOf(qtyAtRisk);
    const sev = frows.reduce((m, f) => Math.max(m, { low: 1, medium: 2, high: 3, critical: 4 }[norm(f.severity)] || 0), 0);
    rows.push({
      date: dateKey(o.order_start_date), order: o.reference_number, orderNumber: o.order_number,
      customer: o.customer, project: o.project, material: o.material,
      failures: frows.length, worstSeverity: ['', 'Low', 'Medium', 'High', 'Critical'][sev] || '',
      committed: committed, delivered: num(o.quantity_delivered),
      undeliveredRef: Math.max(0, num(o.undelivered_quantity)),   // reference only — NOT used in GP
      avgLoad: avgLoad, uom: uom,
      loadsLost: loadsLost, qtyLost: qtyLost,
      loadsAtRisk: loadsAtRisk, qtyAtRisk: qtyAtRisk, gpAtRisk: gpAtRisk,
      lostRevenue: lostRev, lostGp: lostGp, gpMethod: method
    });
  });
  rows.sort((a, b) => (b.lostGp - a.lostGp) || (b.gpAtRisk - a.gpAtRisk));

  const T = {
    failures: failures.length,
    failedOrders: failed.size,
    critical: failures.filter(f => norm(f.severity) === 'critical').length,
    taggedFinancial: failures.filter(f => norm(f.impact_type) === 'financial').length,
    lostTons: rows.filter(r => /ton/i.test(r.uom)).reduce((s, r) => s + r.qtyLost, 0),
    loadsLost: rows.reduce((s, r) => s + r.loadsLost, 0),
    loadsAtRisk: rows.reduce((s, r) => s + r.loadsAtRisk, 0),
    gpAtRisk: rows.reduce((s, r) => s + r.gpAtRisk, 0),
    lostRevenue: rows.reduce((s, r) => s + r.lostRevenue, 0),
    lostGp: rows.reduce((s, r) => s + r.lostGp, 0),
    orgPct: orgPct
  };

  // ---- counts for the by-type / by-customer sections ----
  const countBy = key => {
    const m = new Map();
    failures.forEach(f => { const k = f[key] || '(none)'; m.set(k, (m.get(k) || 0) + 1); });
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  };
  const byType = countBy('failure_type'), byCustomer = countBy('customer'), byParty = countBy('responsible_party');

  // ---- CSV attachments ----
  const gpHead = ['Order Date', 'Order', 'Order #', 'Customer', 'Project', 'Material', 'Failures Logged',
    'Worst Severity', 'Loads Lost (from failures)', 'Avg Load Size', 'Qty Lost', 'UOM',
    'Lost Revenue $', 'Lost GP $', 'Loads At Risk', 'GP At Risk $', 'GP Method', 'Order Undelivered Qty (ref only)'];
  const gpCsv = [gpHead.join(',')].concat(rows.map(r => [
    r.date, r.order, r.orderNumber, r.customer, r.project, r.material, r.failures, r.worstSeverity,
    r.loadsLost, r.avgLoad.toFixed(2), r.qtyLost.toFixed(2), r.uom,
    r.lostRevenue.toFixed(2), r.lostGp.toFixed(2), r.loadsAtRisk, r.gpAtRisk.toFixed(2), r.gpMethod, r.undeliveredRef.toFixed(2)
  ].map(csvCell).join(','))).join('\r\n');

  const sfHead = ['Entity Type', 'Order', 'Failure Type', 'Responsible Party', 'Severity', 'Impact Type',
    'Project', 'Customer', 'Hauler', 'Order Date', 'Truck', 'Driver', 'Truck Owner', 'Notes', 'Recorded By', 'Recorded At',
    'Loads Lost (parsed)', 'Loads At Risk (min 1)'];
  const sfKeys = ['entity_type', 'order_reference', 'failure_type', 'responsible_party', 'severity', 'impact_type',
    'project', 'customer', 'hauler', 'order_date', 'truck_number', 'driver_name', 'truck_owner', 'notes', 'recorded_by', 'recorded_at',
    '_loadsLost', '_loadsAtRisk'];
  const sfCsv = [sfHead.join(',')].concat(failures.map(f => sfKeys.map(k => csvCell(f[k])).join(','))).join('\r\n');

  // ---- HTML (Milestone: dark header, gold accent) ----
  const GOLD = '#b8862b', DARK = '#1c1a17', RED = '#b4452e', GRAY = '#667';
  const rangeStr = from + ' → ' + to;
  const kpi = (label, value, sub, color) =>
    '<td style="border:1px solid #e5e2dc;border-radius:6px;padding:10px 14px;vertical-align:top">' +
    '<div style="font-size:10px;letter-spacing:1px;color:' + GRAY + ';text-transform:uppercase">' + esc(label) + '</div>' +
    '<div style="font-size:24px;font-weight:800;color:' + (color || DARK) + '">' + value + '</div>' +
    '<div style="font-size:11px;color:' + GRAY + '">' + esc(sub) + '</div></td>';

  const bar = pairs => '<table style="border-collapse:collapse;font-size:13px;width:100%;margin:2px 0 12px">' +
    pairs.slice(0, 8).map(p => '<tr><td style="padding:2px 8px 2px 0;white-space:nowrap;font-weight:600">' + esc(p[0]) +
      '</td><td style="padding:2px 0;width:60%"><div style="background:' + GOLD + ';height:10px;border-radius:3px;width:' +
      Math.max(4, Math.round(100 * p[1] / pairs[0][1])) + '%"></div></td><td style="padding:2px 8px;font-weight:700">' + p[1] + '</td></tr>').join('') + '</table>';

  let html = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:860px">'
    + '<div style="background:' + DARK + ';color:#fff;border-radius:10px;padding:18px 22px;margin-bottom:14px">'
    + '<div style="font-size:11px;letter-spacing:2px;color:' + GOLD + ';font-weight:700">MILESTONE TX OPS · NEWMILE SERVICE FAILURES</div>'
    + '<div style="font-size:26px;font-weight:800;margin:2px 0">SERVICE FAILURE REPORT</div>'
    + '<div style="font-size:13px;color:#cfc9bf">Milestone Supply — Texas · ' + esc(rangeStr) + ' · ' + T.failures + ' failures · ' + T.failedOrders + ' orders hit</div></div>'
    + '<table style="border-collapse:separate;border-spacing:6px;width:100%"><tr>'
    + kpi('GP Lost — Direct', fmtMoneyK(T.lostGp), 'loads documentedly lost (floor)', RED)
    + kpi('GP At Risk — All Failures', fmtMoneyK(T.gpAtRisk), 'every failure ≥1 load (ceiling)', GOLD)
    + kpi('Lost Revenue', fmtMoneyK(T.lostRevenue), 'lost qty × customer rate')
    + '</tr><tr>'
    + kpi('Est. Loads Lost', Math.round(T.loadsLost) + ' / ' + Math.round(T.loadsAtRisk), fmtQty(T.lostTons) + ' tons direct · at-risk count second')
    + kpi('Failures Recorded', String(T.failures), T.failedOrders + ' distinct orders · ' + T.taggedFinancial + ' tagged Financial by dispatch')
    + kpi('Critical Severity', String(T.critical), Math.round(100 * T.critical / Math.max(1, T.failures)) + '% of all failures', RED)
    + '</tr></table>';

  html += '<h3 style="margin:18px 0 4px;color:' + DARK + '">GP dollars of lost loads — by order</h3>'
    + '<div style="color:' + GRAY + ';font-size:12px;margin-bottom:6px">Two readings, both priced at the order\'s actual avg load size × the PO+material\'s realized per-unit margin this week. LOST (floor): loads the failure notes document as lost (no count in the note = 1 if Financial impact or No Show, else 0). AT RISK (ceiling): every logged failure counts at least 1 load — even a covered failure displaces planned capacity from another order.</div>'
    + '<table style="border-collapse:collapse;font-size:12px;width:100%"><tr style="background:#f3f1ec">'
    + ['Date', 'Order', 'Customer', 'Loads Lost', 'Qty Lost', 'Lost Revenue', 'Lost GP', 'GP at Risk'].map(h => '<td style="padding:4px 8px;font-weight:700">' + h + '</td>').join('') + '</tr>'
    + rows.map(r => '<tr style="border-bottom:1px solid #eee">'
      + '<td style="padding:3px 8px;white-space:nowrap">' + esc(r.date) + '</td>'
      + '<td style="padding:3px 8px">' + esc(r.order) + (r.worstSeverity === 'Critical' ? ' <span style="color:' + RED + ';font-weight:700">●</span>' : '') + '</td>'
      + '<td style="padding:3px 8px">' + esc(String(r.customer || '').slice(0, 34)) + '</td>'
      + '<td style="padding:3px 8px;text-align:right">' + Math.round(r.loadsLost) + '</td>'
      + '<td style="padding:3px 8px;text-align:right;white-space:nowrap">' + fmtQty(r.qtyLost) + ' ' + esc(r.uom) + '</td>'
      + '<td style="padding:3px 8px;text-align:right">' + fmtMoney(r.lostRevenue) + '</td>'
      + '<td style="padding:3px 8px;text-align:right;font-weight:800;color:' + (r.lostGp > 0 ? RED : GRAY) + '">' + fmtMoney(r.lostGp) + '</td>'
      + '<td style="padding:3px 8px;text-align:right;color:' + (r.gpAtRisk > r.lostGp ? GOLD : GRAY) + '">' + fmtMoney(r.gpAtRisk) + '</td></tr>').join('')
    + '<tr style="border-top:2px solid ' + DARK + '"><td colspan="3" style="padding:5px 8px;font-weight:800">TOTAL</td>'
    + '<td style="padding:5px 8px;text-align:right;font-weight:800">' + Math.round(T.loadsLost) + '</td>'
    + '<td style="padding:5px 8px;text-align:right;font-weight:800">' + fmtQty(T.lostTons) + ' Ton</td>'
    + '<td style="padding:5px 8px;text-align:right;font-weight:800">' + fmtMoney(T.lostRevenue) + '</td>'
    + '<td style="padding:5px 8px;text-align:right;font-weight:800;color:' + RED + '">' + fmtMoney(T.lostGp) + '</td>'
    + '<td style="padding:5px 8px;text-align:right;font-weight:800;color:' + GOLD + '">' + fmtMoney(T.gpAtRisk) + '</td></tr></table>';

  if (unmatched.length) {
    html += '<h3 style="margin:16px 0 4px;color:' + RED + '">⚠ Failures that did not match an order (' + unmatched.length + ')</h3>'
      + '<div style="font-size:12px;color:' + GRAY + '">The Order name logged on the failure does not match any order reference that day — fix the name in NewMile so GP can be computed.</div>'
      + '<ul style="font-size:12px">' + unmatched.map(f => '<li>' + esc(f.order_reference) + ' · ' + esc(dateKey(f.order_date)) + '</li>').join('') + '</ul>';
  }

  html += '<table style="width:100%;border-collapse:collapse"><tr><td style="vertical-align:top;width:33%;padding-right:10px">'
    + '<h3 style="margin:14px 0 4px">Why service failed</h3>' + bar(byType)
    + '</td><td style="vertical-align:top;width:33%;padding-right:10px">'
    + '<h3 style="margin:14px 0 4px">Responsible party</h3>' + bar(byParty)
    + '</td><td style="vertical-align:top;width:33%">'
    + '<h3 style="margin:14px 0 4px">Customer impact</h3>' + bar(byCustomer)
    + '</td></tr></table>';

  html += '<div style="color:#99a;font-size:11px;margin-top:12px">Milestone OS · NewMile service_failures + orders + po_margin reports, order-date ' + esc(rangeStr)
    + '. GP method per order: per-unit realized margin of the matching PO+material this week; PO margin % or the week margin % when no PO row matches. Full detail in the attached CSVs.</div></div>';

  // ---- plain text ----
  const text = [
    'SERVICE FAILURE REPORT — Milestone Supply Texas — ' + rangeStr,
    '',
    'GP DOLLARS OF LOST LOADS: ' + fmtMoney(T.lostGp) + ' direct (floor) · ' + fmtMoney(T.gpAtRisk) + ' at risk counting every failure (ceiling)',
    'Lost revenue: ' + fmtMoney(T.lostRevenue) + ' · Lost: ' + fmtQty(T.lostTons) + ' tons · Loads lost (per failures): ' + Math.round(T.loadsLost),
    'Failures recorded: ' + T.failures + ' (' + T.critical + ' critical) across ' + T.failedOrders + ' orders',
    '',
    'TOP LOSSES:',
  ].concat(rows.filter(r => r.lostGp > 0).slice(0, 12).map(r =>
    '  ' + r.date + '  ' + r.order + '  ' + Math.round(r.loadsLost) + ' loads (' + fmtQty(r.qtyLost) + ' ' + r.uom + ')  GP lost ' + fmtMoney(r.lostGp)
  )).concat(unmatched.length ? ['', 'UNMATCHED FAILURES (fix order name in NewMile): ' + unmatched.map(f => f.order_reference).join('; ')] : []).join('\n');

  return {
    kind: 'sf', from: from, to: to, totals: T, rows: rows, unmatched: unmatched,
    html: html, text: text,
    attachments: [
      { filename: 'lost_loads_gp_' + from + '_' + to + '.csv', content: gpCsv },
      { filename: 'service_failures_' + from + '_' + to + '.csv', content: sfCsv }
    ]
  };
}

/*
 * Print/PDF version — the SAME document layout the team has been hand-building in Design
 * from the CSV export (dark Milestone header, executive summary cards, failures-by-day,
 * why/party/customer bars, driver no-shows, full failure detail), with ONE addition:
 * the GP DOLLARS OF LOST LOADS section and its executive-summary cards. Nothing removed.
 * Returns a full standalone HTML document sized for US Letter; render with Chromium
 * --print-to-pdf or Electron webContents.printToPDF.
 */
function shortCustomer(s) {
  s = String(s || '').trim().replace(/\.+$/, '');
  let m = s.match(/^Quikrete - (\w+) Texas Ready Mix District$/i);
  if (m) return 'Quikrete ' + m[1] + ' TX';
  if (/^Martin Marietta Southwest Division/i.test(s)) return 'Martin Marietta SW';
  if (/^Longview Bridge and Road/i.test(s)) return 'Longview Bridge and Road, Ltd';
  return s.length > 30 ? s.slice(0, 29) + '…' : s;
}
function mdLabel(iso) {  // 2026-08-03 -> "Aug 3"
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function buildPrintHtml(rep, failures) {
  const GOLD = '#b8862b', DARK = '#191713', INKDIM = '#8a8579', LINE = '#e8e4dc', RED = '#b02a1e';
  const rangeStr = mdLabel(rep.from) + ' → ' + mdLabel(rep.to);
  const T = rep.totals;
  const todayStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });

  // ---- aggregates over the failure log ----
  const cnt = (arr, key) => { const m = new Map(); arr.forEach(f => { const k = key(f); m.set(k, (m.get(k) || 0) + 1); }); return m; };
  const byDay = Array.from(cnt(failures, f => dateKey(f.order_date).slice(0, 5)).entries()).sort();
  const typeAll = cnt(failures, f => f.failure_type || '(none)');
  const typeCrit = cnt(failures.filter(f => norm(f.severity) === 'critical'), f => f.failure_type || '(none)');
  const byType = Array.from(typeAll.entries()).sort((a, b) => b[1] - a[1]);
  const byParty = Array.from(cnt(failures, f => {
    const p = String(f.responsible_party || '').trim(); return p && p.toLowerCase() !== 'none' ? p : 'None assigned';
  }).entries()).sort((a, b) => b[1] - a[1]);
  const byCust = Array.from(cnt(failures, f => shortCustomer(f.customer)).entries()).sort((a, b) => b[1] - a[1]);
  const noShows = failures.filter(f => /no show/i.test(f.failure_type || ''));
  const finImpact = failures.filter(f => norm(f.impact_type) === 'financial').length;
  const worstDay = byDay.slice().sort((a, b) => b[1] - a[1])[0] || ['—', 0];
  const topType = byType[0] || ['—', 0];
  const custHardest = byCust[0] ? byCust[0][0] : '—';
  const pct = n => Math.round(100 * n / Math.max(1, T.failures));

  const css = '@page{size:letter;margin:0.55in 0.6in 0.85in 0.6in}'
    + '*{box-sizing:border-box}body{margin:0;font-family:Segoe UI,Arial,Helvetica,sans-serif;color:' + DARK + ';font-size:12px}'
    + '.sec{font-size:9px;letter-spacing:2px;color:' + GOLD + ';font-weight:700;margin:26px 0 2px}'
    + 'h2{font-size:21px;letter-spacing:.5px;margin:0 0 3px;font-weight:800}'
    + '.sub{color:' + INKDIM + ';font-size:11px;margin:0 0 12px}'
    + 'table{border-collapse:collapse;width:100%;font-size:10.5px}'
    + 'td,th{padding:6px 8px;text-align:left;vertical-align:top}'
    + 'th{font-size:8.5px;letter-spacing:1.4px;color:' + INKDIM + ';text-transform:uppercase;font-weight:600;border-bottom:1px solid ' + LINE + '}'
    + 'tbody tr{border-bottom:1px solid #f0ede7}'
    + '.pill{display:inline-block;font-size:8px;font-weight:800;letter-spacing:.8px;padding:2px 9px;border-radius:9px;color:#fff}'
    + '.p-critical{background:' + RED + '}.p-high{background:#c47b1e}.p-medium{background:' + GOLD + '}.p-low{background:#9b968a}'
    + '.brk{page-break-before:always}.nobrk{page-break-inside:avoid}'
    + '.cards{display:flex;gap:10px;margin:8px 0}.card{flex:1;border:1px solid ' + LINE + ';border-radius:7px;padding:10px 13px}'
    + '.card .l{font-size:8px;letter-spacing:1.5px;color:' + INKDIM + ';text-transform:uppercase}'
    + '.card .v{font-size:23px;font-weight:800;margin:1px 0}'
    + '.card .s{font-size:9.5px;color:' + INKDIM + '}'
    + '.bars td{padding:3.5px 8px 3.5px 0;font-size:10.5px}.bars .n{font-weight:700;white-space:nowrap}'
    + '.track{background:#f0ede7;border-radius:3px;height:11px;width:100%}.fill{background:' + GOLD + ';border-radius:3px;height:11px}';

  const bars = (pairs, noteFn) => '<table class="bars">' + pairs.map(p =>
    '<tr><td style="width:150px;font-weight:600">' + esc(p[0]) + '</td>'
    + '<td><div class="track"><div class="fill" style="width:' + Math.max(3, Math.round(100 * p[1] / pairs.reduce((m, x) => Math.max(m, x[1]), 1))) + '%"></div></div></td>'
    + '<td class="n" style="width:110px">' + p[1] + (noteFn ? noteFn(p) : '') + '</td></tr>').join('') + '</table>';

  const card = (l, v, s, color) => '<div class="card"><div class="l">' + esc(l) + '</div>'
    + '<div class="v"' + (color ? ' style="color:' + color + '"' : '') + '>' + v + '</div><div class="s">' + esc(s) + '</div></div>';

  const sevPill = s => { const k = norm(s); return '<span class="pill p-' + (['critical', 'high', 'medium', 'low'].includes(k) ? k : 'low') + '">' + esc(String(s || '').toUpperCase()) + '</span>'; };

  let n = 0; const secNo = () => 'SECTION ' + String(++n).padStart(2, '0');

  let h = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Service Failure Report ' + esc(rangeStr) + '</title><style>' + css + '</style></head><body>'

    // ---- header (dark card) ----
    + '<div style="background:' + DARK + ';color:#fff;border-radius:12px;padding:26px 30px;margin-bottom:6px">'
    + '<div style="font-size:24px;font-weight:800;letter-spacing:3px;margin-bottom:14px"><span style="color:#fff">MILES</span><span style="color:' + GOLD + '">T</span><span style="color:#b9b3a6">ONE</span></div>'
    + '<div style="font-size:9px;letter-spacing:2.5px;color:' + GOLD + ';font-weight:700">MILESTONE TX OPS · NEWMILE SERVICE FAILURES</div>'
    + '<div style="font-size:31px;font-weight:800;letter-spacing:.5px;margin:4px 0 6px">SERVICE FAILURE REPORT</div>'
    + '<div style="font-size:12px;color:#d9d4c9">Milestone Supply — Texas · ' + esc(rangeStr) + '</div>'
    + '<div style="font-size:10px;color:#8f897c;margin-top:3px">' + T.failures + ' failures recorded · ' + byCust.length + ' customers · data as of ' + esc(todayStr) + ' · source: NewMile Service Failures + Orders + PO Margin</div>'
    + '</div>'

    // ---- 01 executive summary ----
    + '<div class="sec">' + secNo() + '</div><h2>EXECUTIVE SUMMARY</h2>'
    + '<div class="cards">'
    + card('GP Lost — Direct', fmtMoneyK(T.lostGp), 'loads documentedly lost (floor)', RED)
    + card('GP At Risk — All Failures', fmtMoneyK(T.gpAtRisk), 'every failure ≥1 load (ceiling)', GOLD)
    + card('Lost Revenue', fmtMoneyK(T.lostRevenue), 'lost qty × customer rate')
    + '</div><div class="cards">'
    + card('Est. Loads Lost', Math.round(T.loadsLost) + ' / ' + Math.round(T.loadsAtRisk), fmtQty(T.lostTons) + ' tons direct · at-risk count second')
    + card('Failures Recorded', String(T.failures), byDay.length + ' dispatch days · ' + rangeStr)
    + card('Critical Severity', String(T.critical), pct(T.critical) + '% of all failures', RED)
    + '</div><div class="cards">'
    + card('Top Failure Type', String(topType[1]), topType[0] + ' — largest driver of misses')
    + card('Driver No-Shows', String(noShows.length), 'trucks committed that never ran')
    + card('Customers Affected', String(byCust.length), custHardest + ' hit hardest')
    + '</div>'
    + '<div style="background:#faf6ee;border:1px solid #efe7d6;border-radius:7px;padding:11px 15px;font-size:11.5px;margin:8px 0 0">'
    + topType[1] + ' of ' + T.failures + ' failures were ' + esc(String(topType[0]).toLowerCase()) + 's. '
    + esc(worstDay[0]) + ' alone logged ' + worstDay[1] + ' failures, the worst day of the week. '
    + T.critical + ' failures (' + pct(T.critical) + '%) were critical, and ' + noShows.length + ' committed trucks never ran. '
    + '<b>The week\'s failures cost an estimated ' + fmtMoney(T.lostGp) + ' in gross profit</b> on ' + fmtQty(T.lostTons) + ' lost tons ('
    + fmtMoney(T.lostRevenue) + ' revenue, ~' + Math.round(T.loadsLost) + ' loads) — <b>up to ' + fmtMoney(T.gpAtRisk)
    + ' at risk</b> counting at least one displaced load for every logged failure. '
    + T.taggedFinancial + ' of ' + T.failures + ' failures (' + pct(T.taggedFinancial) + '%) were tagged Financial impact by dispatch; the GP range above prices every failure\'s loads, tagged or not.'
    + '</div>'

    // ---- 02 GP of lost loads (NEW — Tony's ask) ----
    + '<div class="brk"></div><div class="sec">' + secNo() + '</div><h2>GP DOLLARS OF LOST LOADS</h2>'
    + '<div class="sub">Per failed order, two readings priced at the order\'s actual avg load size × the PO+material\'s realized per-unit margin this week (NewMile PO Margin). LOST GP (floor): loads the failure notes document as lost — count written in the note; no count = 1 if Financial impact or No Show, 0 if informational; order-level vs truck-level counts deduped. GP AT RISK (ceiling): every logged failure counts at least 1 load — a failure\'s truck was planned somewhere, and even a covered failure displaces capacity from another order that logs no failure.</div>'
    + '<table><thead><tr><th>Date</th><th>Order</th><th>Customer</th><th style="text-align:right">Loads Lost</th><th style="text-align:right">Qty Lost</th><th style="text-align:right">Lost Revenue</th><th style="text-align:right">Lost GP</th><th style="text-align:right">GP at Risk</th></tr></thead><tbody>'
    + rep.rows.map(r => '<tr' + (r.lostGp > 0 ? '' : ' style="color:' + INKDIM + '"') + '>'
      + '<td style="white-space:nowrap">' + esc(r.date.slice(0, 5)) + '</td>'
      + '<td>' + esc(r.order) + '</td><td>' + esc(shortCustomer(r.customer)) + '</td>'
      + '<td style="text-align:right">' + Math.round(r.loadsLost) + '</td>'
      + '<td style="text-align:right;white-space:nowrap">' + fmtQty(r.qtyLost) + ' ' + esc(r.uom) + '</td>'
      + '<td style="text-align:right">' + fmtMoney(r.lostRevenue) + '</td>'
      + '<td style="text-align:right;font-weight:800' + (r.lostGp > 0 ? ';color:' + RED : '') + '">' + fmtMoney(r.lostGp) + '</td>'
      + '<td style="text-align:right' + (r.gpAtRisk > r.lostGp ? ';color:' + GOLD + ';font-weight:700' : '') + '">' + fmtMoney(r.gpAtRisk) + '</td></tr>').join('')
    + '<tr style="border-top:2px solid ' + DARK + '"><td colspan="3" style="font-weight:800">TOTAL</td>'
    + '<td style="text-align:right;font-weight:800">' + Math.round(T.loadsLost) + '</td>'
    + '<td style="text-align:right;font-weight:800;white-space:nowrap">' + fmtQty(T.lostTons) + ' Ton</td>'
    + '<td style="text-align:right;font-weight:800">' + fmtMoney(T.lostRevenue) + '</td>'
    + '<td style="text-align:right;font-weight:800;color:' + RED + '">' + fmtMoney(T.lostGp) + '</td>'
    + '<td style="text-align:right;font-weight:800;color:' + GOLD + '">' + fmtMoney(T.gpAtRisk) + '</td></tr></tbody></table>'
    + (rep.unmatched.length ? '<div style="color:' + RED + ';font-size:10.5px;margin-top:8px"><b>⚠ ' + rep.unmatched.length + ' failures did not match an order</b> (order name typo in NewMile — no GP computed): '
      + rep.unmatched.map(f => esc(f.order_reference) + ' (' + esc(dateKey(f.order_date)) + ')').join('; ') + '</div>' : '')

    // ---- 03 failures by day ----
    + '<div class="brk"></div><div class="sec">' + secNo() + '</div><h2>FAILURES BY DAY</h2>'
    + '<div class="sub">Recorded failures per dispatch day · all entity types</div>'
    + bars(byDay, p => p[1] === worstDay[1] ? ' · peak' : '')

    // ---- 04 why service failed ----
    + '<div class="nobrk"><div class="sec">' + secNo() + '</div><h2>WHY SERVICE FAILED</h2>'
    + '<div class="sub">Failure types by count · critical share noted per type</div>'
    + bars(byType, p => (typeCrit.get(p[0]) ? ' · ' + typeCrit.get(p[0]) + ' critical' : '')) + '</div>'

    // ---- 05 responsible party ----
    + '<div class="nobrk"><div class="sec">' + secNo() + '</div><h2>RESPONSIBLE PARTY</h2>'
    + '<div class="sub">Who owned each failure, as logged in NewMile</div>' + bars(byParty) + '</div>'

    // ---- 06 customer impact ----
    + '<div class="nobrk"><div class="sec">' + secNo() + '</div><h2>CUSTOMER IMPACT</h2>'
    + '<div class="sub">Failures by customer · count of recorded events</div>' + bars(byCust) + '</div>'

    // ---- 07 driver no-shows ----
    + '<div class="brk"></div><div class="sec">' + secNo() + '</div><h2>DRIVER NO-SHOWS</h2>'
    + '<div class="sub">Committed trucks and drivers that did not run</div>'
    + '<table><thead><tr><th>Date</th><th>Truck</th><th>Driver</th><th>Fleet / Owner</th><th>Customer</th><th>Notes</th></tr></thead><tbody>'
    + noShows.map(f => '<tr><td>' + esc(dateKey(f.order_date).slice(0, 5)) + '</td>'
      + '<td>' + esc(f.truck_number || '—') + '</td><td>' + esc(f.driver_name || '—') + '</td>'
      + '<td>' + esc(f.truck_owner || f.hauler || '—') + '</td><td>' + esc(shortCustomer(f.customer)) + '</td>'
      + '<td style="color:' + INKDIM + '">' + esc(String(f.notes || '—').trim() || '—') + '</td></tr>').join('') + '</tbody></table>'

    // ---- 08 failure detail ----
    + '<div class="brk"></div><div class="sec">' + secNo() + '</div><h2>FAILURE DETAIL</h2>'
    + '<div class="sub">All ' + T.failures + ' recorded failures, sorted by date · source: NewMile</div>'
    + '<table><thead><tr><th>Date</th><th>Order</th><th>Type</th><th>Sev</th><th>Customer</th><th>Notes</th></tr></thead><tbody>'
    + failures.slice().sort((a, b) => (dateKey(a.order_date) < dateKey(b.order_date) ? -1 : 1)).map(f =>
      '<tr><td style="white-space:nowrap">' + esc(dateKey(f.order_date).slice(0, 5)) + '</td>'
      + '<td style="min-width:105px">' + esc(f.order_reference) + '</td>'
      + '<td>' + esc(f.failure_type || '') + '</td><td>' + sevPill(f.severity) + '</td>'
      + '<td>' + esc(shortCustomer(f.customer)) + '</td>'
      + '<td style="color:' + INKDIM + '">' + esc(String(f.notes || '—').trim() || '—') + '</td></tr>').join('')
    + '</tbody></table>'
    + '</body></html>';
  return h;
}

// Native print footer (Chromium/Electron printToPDF footerTemplate) — every page carries the
// same confidential strip the hand-built Design PDF had. Pass with displayHeaderFooter:true
// and an empty headerTemplate.
function printFooterTemplate(rep) {
  const rangeStr = (mdLabel(rep.from) + ' → ' + mdLabel(rep.to)).toUpperCase();
  return '<div style="width:100%;font-size:7px;font-family:Segoe UI,Arial,sans-serif;color:#8a8579;'
    + 'letter-spacing:1.5px;display:flex;justify-content:space-between;padding:0 0.6in">'
    + '<span>MILESTONE SUPPLY — TEXAS · SERVICE FAILURE REPORT</span>'
    + '<span>' + esc(rangeStr) + ' · CONFIDENTIAL</span></div>';
}

module.exports = { lastWeekRange, fetchWeek, buildServiceFailures, buildPrintHtml, printFooterTemplate };
