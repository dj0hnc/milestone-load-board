'use strict';
/*
 * Weekly Service Failure report with GP DOLLARS OF LOST LOADS.
 *
 * Sources (all NewMile report API via query_report — same data the app's Reports tab exports):
 *   - service_failures : the week's logged failures (what dispatch records)
 *   - orders           : per-order Undelivered Qty, Est. Loads Lost, freight/material rates
 *   - po_margin        : realized margin per PO+material for the same week (revenue AND cost)
 *
 * The service_failures export carries NO dollar or tonnage columns, and the API's
 * has_service_failure filter on the orders report does not actually filter (verified
 * 2026-08-10: 426 rows with it, 426 without). So the join is done here instead:
 * the SF "Order" column equals the orders report's reference_number, and together with
 * the order date it matched 35/35 distinct failed orders on the 8/3-8/8 validation week.
 *
 * GP of lost loads per failed order = undelivered qty × per-unit realized margin, where
 * per-unit margin comes from the SAME WEEK's po_margin row for that PO+material
 * (margin_amount / delivered_quantity). Fallbacks, in order, when a PO row can't be
 * matched or has zero deliveries: the PO row's margin % × lost revenue, then the
 * org-wide weekly margin % × lost revenue. Lost revenue = undelivered × (freight+material rate).
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
    'undelivered_quantity', 'estimated_loads_lost', 'freight_rate', 'freight_rate_uom',
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

  const rows = [], unmatched = [];
  Array.from(failed.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1).forEach(pair => {
    const frows = pair[1];
    const o = oidx.get(pair[0]);
    if (!o) { unmatched.push(frows[0]); return; }
    const und = Math.max(0, num(o.undelivered_quantity));
    const rate = num(o.freight_rate) + num(o.material_rate);
    const lostRev = und * rate;
    const pm = pmProj.get(norm(o.project) + '|' + norm(o.material)) ||
               pmPo.get(norm(o.po_reference_number) + '|' + norm(o.material)) || null;
    let lostGp, method;
    if (pm && num(pm.delivered_quantity) > 0 && num(pm.margin_amount) !== 0) {
      lostGp = und * (num(pm.margin_amount) / num(pm.delivered_quantity)); method = 'PO per-unit margin';
    } else if (pm) {
      lostGp = lostRev * (num(pm.margin_percentage) / 100); method = 'PO margin %';
    } else {
      lostGp = lostRev * orgPct; method = 'org avg %';
    }
    const sev = frows.reduce((m, f) => Math.max(m, { low: 1, medium: 2, high: 3, critical: 4 }[norm(f.severity)] || 0), 0);
    rows.push({
      date: dateKey(o.order_start_date), order: o.reference_number, orderNumber: o.order_number,
      customer: o.customer, project: o.project, material: o.material,
      failures: frows.length, worstSeverity: ['', 'Low', 'Medium', 'High', 'Critical'][sev] || '',
      committed: num(o.quantity_requested), delivered: num(o.quantity_delivered),
      undelivered: und, uom: o.quantity_requested_uom || '',
      loadsLost: num(o.estimated_loads_lost),
      lostRevenue: lostRev, lostGp: lostGp, gpMethod: method
    });
  });
  rows.sort((a, b) => b.lostGp - a.lostGp);

  const T = {
    failures: failures.length,
    failedOrders: failed.size,
    critical: failures.filter(f => norm(f.severity) === 'critical').length,
    undeliveredTons: rows.filter(r => /ton/i.test(r.uom)).reduce((s, r) => s + r.undelivered, 0),
    loadsLost: rows.reduce((s, r) => s + r.loadsLost, 0),
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
    'Worst Severity', 'Qty Committed', 'Qty Delivered', 'Undelivered Qty', 'UOM', 'Est Loads Lost',
    'Lost Revenue $', 'Lost GP $', 'GP Method'];
  const gpCsv = [gpHead.join(',')].concat(rows.map(r => [
    r.date, r.order, r.orderNumber, r.customer, r.project, r.material, r.failures, r.worstSeverity,
    r.committed.toFixed(2), r.delivered.toFixed(2), r.undelivered.toFixed(2), r.uom, r.loadsLost,
    r.lostRevenue.toFixed(2), r.lostGp.toFixed(2), r.gpMethod
  ].map(csvCell).join(','))).join('\r\n');

  const sfHead = ['Entity Type', 'Order', 'Failure Type', 'Responsible Party', 'Severity', 'Impact Type',
    'Project', 'Customer', 'Hauler', 'Order Date', 'Truck', 'Driver', 'Truck Owner', 'Notes', 'Recorded By', 'Recorded At'];
  const sfKeys = ['entity_type', 'order_reference', 'failure_type', 'responsible_party', 'severity', 'impact_type',
    'project', 'customer', 'hauler', 'order_date', 'truck_number', 'driver_name', 'truck_owner', 'notes', 'recorded_by', 'recorded_at'];
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
    + kpi('GP Dollars of Lost Loads', fmtMoneyK(T.lostGp), 'gross profit on undelivered qty', RED)
    + kpi('Lost Revenue', fmtMoneyK(T.lostRevenue), 'undelivered × customer rate')
    + kpi('Est. Loads Lost', String(Math.round(T.loadsLost)), fmtQty(T.undeliveredTons) + ' tons undelivered')
    + '</tr><tr>'
    + kpi('Failures Recorded', String(T.failures), T.failedOrders + ' distinct orders')
    + kpi('Critical Severity', String(T.critical), Math.round(100 * T.critical / Math.max(1, T.failures)) + '% of all failures', RED)
    + kpi('Week Margin', (100 * T.orgPct).toFixed(1) + '%', 'realized, all POs this week')
    + '</tr></table>';

  html += '<h3 style="margin:18px 0 4px;color:' + DARK + '">GP dollars of lost loads — by order</h3>'
    + '<div style="color:' + GRAY + ';font-size:12px;margin-bottom:6px">Undelivered quantity × realized per-unit margin of the same PO+material this week. Orders with a logged failure but no undelivered quantity show $0.0 (the failure did not cost tonnage).</div>'
    + '<table style="border-collapse:collapse;font-size:12px;width:100%"><tr style="background:#f3f1ec">'
    + ['Date', 'Order', 'Customer', 'Undelivered', 'Loads Lost', 'Lost Revenue', 'Lost GP'].map(h => '<td style="padding:4px 8px;font-weight:700">' + h + '</td>').join('') + '</tr>'
    + rows.map(r => '<tr style="border-bottom:1px solid #eee">'
      + '<td style="padding:3px 8px;white-space:nowrap">' + esc(r.date) + '</td>'
      + '<td style="padding:3px 8px">' + esc(r.order) + (r.worstSeverity === 'Critical' ? ' <span style="color:' + RED + ';font-weight:700">●</span>' : '') + '</td>'
      + '<td style="padding:3px 8px">' + esc(String(r.customer || '').slice(0, 34)) + '</td>'
      + '<td style="padding:3px 8px;text-align:right;white-space:nowrap">' + fmtQty(r.undelivered) + ' ' + esc(r.uom) + '</td>'
      + '<td style="padding:3px 8px;text-align:right">' + Math.round(r.loadsLost) + '</td>'
      + '<td style="padding:3px 8px;text-align:right">' + fmtMoney(r.lostRevenue) + '</td>'
      + '<td style="padding:3px 8px;text-align:right;font-weight:800;color:' + (r.lostGp > 0 ? RED : GRAY) + '">' + fmtMoney(r.lostGp) + '</td></tr>').join('')
    + '<tr style="border-top:2px solid ' + DARK + '"><td colspan="3" style="padding:5px 8px;font-weight:800">TOTAL</td>'
    + '<td style="padding:5px 8px;text-align:right;font-weight:800">' + fmtQty(T.undeliveredTons) + ' Ton</td>'
    + '<td style="padding:5px 8px;text-align:right;font-weight:800">' + Math.round(T.loadsLost) + '</td>'
    + '<td style="padding:5px 8px;text-align:right;font-weight:800">' + fmtMoney(T.lostRevenue) + '</td>'
    + '<td style="padding:5px 8px;text-align:right;font-weight:800;color:' + RED + '">' + fmtMoney(T.lostGp) + '</td></tr></table>';

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
    'GP DOLLARS OF LOST LOADS: ' + fmtMoney(T.lostGp),
    'Lost revenue: ' + fmtMoney(T.lostRevenue) + ' · Undelivered: ' + fmtQty(T.undeliveredTons) + ' tons · Est. loads lost: ' + Math.round(T.loadsLost),
    'Failures recorded: ' + T.failures + ' (' + T.critical + ' critical) across ' + T.failedOrders + ' orders',
    '',
    'TOP LOSSES:',
  ].concat(rows.filter(r => r.lostGp > 0).slice(0, 12).map(r =>
    '  ' + r.date + '  ' + r.order + '  und ' + fmtQty(r.undelivered) + ' ' + r.uom + '  GP lost ' + fmtMoney(r.lostGp)
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

module.exports = { lastWeekRange, fetchWeek, buildServiceFailures };
