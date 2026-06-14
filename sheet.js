'use strict';
/*
 * Dispatch-sheet parser (ported from mab-mobile). Reads .xlsx/.xls/.csv → planner rows.
 *  - TX Order Sheet format: one tab per day ("6-13"); each row = an order with repeating TRK|LDS
 *    pairs = the trucks on that order. parsePlan() reads ONLY the day's tab (never flattens).
 *  - flat roster (Lease Dispatch): header-aware Truck#/Loads extraction, else a TRK/LDS walker.
 * Pure Node (xlsx only) so it runs identically in Electron main and the mobile server.
 */

// flat "TRK LDS" walker (was in ocr.js) — 1–2 digit number right after a truck = its load limit
function parsePairs(text) {
  const toks = String(text || '').split(/[\t\n\r ,;|]+/).map((s) => s.trim()).filter(Boolean);
  const isLoad = (s) => /^\d{1,2}$/.test(s);
  const out = []; let k = 0;
  while (k < toks.length) {
    const cur = toks[k];
    if (isLoad(cur)) { k++; continue; }
    const nxt = toks[k + 1];
    if (nxt != null && isLoad(nxt)) { out.push({ num: cur, lds: parseInt(nxt, 10) }); k += 2; }
    else { out.push({ num: cur, lds: '' }); k++; }
  }
  return out;
}

const HEADERS = {
  num: ['truck #', 'truck#', 'truck no', 'truck number', 'trk', 'truck', 'unit'],
  driver: ['driver', 'driver name'],
  owner: ['truck owner', 'owner'],
  dispatch: ['dispatch', 'destination', 'load', 'job', 'plan', 'assigned dispatch'],
  loads: ['loads assigned', 'loads', 'load count', 'lds', '# loads', 'qty'],
  location: ['location', 'last location']
};
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const looksLikeTruck = (s) => /[0-9]/.test(String(s || '')) && String(s).trim().length <= 12 && !/[@:]/.test(String(s));

function gridFromBuffer(buf) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  let best = null;
  (wb.SheetNames || []).forEach((sn) => {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: false, defval: '' });
    if (!best || grid.length > best.grid.length) best = { sheet: sn, grid };
  });
  return best || { sheet: null, grid: [] };
}
function findHeader(grid) {
  for (let r = 0; r < Math.min(grid.length, 40); r++) {
    const row = grid[r].map(norm); const map = {};
    Object.keys(HEADERS).forEach((field) => { const ci = row.findIndex((c) => HEADERS[field].includes(c)); if (ci >= 0) map[field] = ci; });
    if (map.num != null && (map.loads != null || map.dispatch != null)) return { headerRow: r, map };
  }
  return null;
}
function extractRows(grid) {
  const hit = findHeader(grid); if (!hit) return null;
  const { headerRow, map } = hit; const out = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r];
    const num = String((map.num != null ? row[map.num] : '') || '').trim();
    if (!num || !looksLikeTruck(num)) continue;
    const ldsRaw = map.loads != null ? row[map.loads] : '';
    const lds = /^\d{1,3}$/.test(String(ldsRaw).trim()) ? parseInt(ldsRaw, 10) : '';
    out.push({ num, lds, dispatch: map.dispatch != null ? String(row[map.dispatch] || '').trim() : '', driver: map.driver != null ? String(row[map.driver] || '').trim() : '' });
  }
  return out.length ? { headerRow, map, rows: out } : null;
}
function parseBuffer(buf) {
  const { sheet, grid } = gridFromBuffer(buf);
  const text = grid.map((row) => row.join('\t')).join('\n');
  const ex = extractRows(grid);
  if (ex) return { sheet, grid, rows: ex.rows, pairs: ex.rows.map((x) => ({ num: x.num, lds: x.lds })), text, mode: 'header' };
  return { sheet, grid, rows: [], pairs: parsePairs(text), text, mode: 'flat' };
}

// TX Order Sheet: per-day tab "M-D", each row = an order with repeating TRK|LDS pairs
function parseOrderSheet(buf, dateISO) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const d = new Date((dateISO || '') + 'T12:00:00'); if (isNaN(d)) return { error: 'bad date' };
  const want = (d.getMonth() + 1) + '-' + d.getDate();
  const sn = wb.SheetNames.find((s) => String(s).replace(/\s/g, '') === want);
  if (!sn) return { error: 'No day tab "' + want + '"', tabs: wb.SheetNames };
  const g = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: false, defval: '' });
  let hr = -1; const col = {}; const trkCols = [];
  for (let r = 0; r < Math.min(g.length, 12); r++) {
    const low = g[r].map((c) => String(c).trim().toLowerCase());
    if (low.some((c) => /disp/.test(c)) && low.indexOf('trk') >= 0) {
      hr = r;
      low.forEach((k, ci) => {
        if (/disp/.test(k) && col.disp == null) col.disp = ci;
        else if (/(customer|project)/.test(k) && col.cust == null) col.cust = ci;
        else if (/material/.test(k) && col.mat == null) col.mat = ci;
        else if (k === 'ordered' && col.ord == null) col.ord = ci;
        else if (/hours/.test(k) && col.hrs == null) col.hrs = ci;
        else if (/pickup/.test(k) && col.pick == null) col.pick = ci;
        if (k === 'trk') trkCols.push(ci);
      });
      break;
    }
  }
  if (hr < 0 || !trkCols.length) return { error: 'Could not read the order-sheet layout', tabs: wb.SheetNames };
  const orders = [];
  for (let r = hr + 1; r < g.length; r++) {
    const row = g[r];
    const cust = String(row[col.cust] || '').trim(), disp = String(row[col.disp] || '').trim(), mat = String(row[col.mat] || '').trim();
    const trucks = [];
    trkCols.forEach((tc) => { const numv = String(row[tc] || '').trim(); const ldv = String(row[tc + 1] || '').trim(); if (numv && !/^x+$/i.test(numv)) trucks.push({ num: numv, lds: /^\d{1,3}$/.test(ldv) ? parseInt(ldv, 10) : '' }); });
    if (!cust && !disp && !trucks.length) continue;
    orders.push({ disp, customer: cust, material: mat, pickup: String(row[col.pick] || '').trim(), hours: String(row[col.hrs] || '').trim(), ordered: row[col.ord], trucks });
  }
  const withTrucks = orders.filter((o) => o.trucks.length);
  return { format: 'order-sheet', tab: sn, orders, withTrucks, pairs: [].concat.apply([], withTrucks.map((o) => o.trucks)) };
}

// order-sheet (per-day tabs) vs flat roster. NEVER flatten an order-sheet workbook when the day
// tab is missing (e.g. Sundays) — return an error instead of dumping every truck across all days.
function parsePlan(buf, dateISO) {
  let wb;
  try { const XLSX = require('xlsx'); wb = XLSX.read(buf, { type: 'buffer', cellDates: false }); } catch (e) { return parseBuffer(buf); }
  const dayTabs = (wb.SheetNames || []).filter((s) => /^\s*\d{1,2}\s*-\s*\d{1,2}\s*$/.test(String(s)));
  if (dayTabs.length) {
    const os = parseOrderSheet(buf, dateISO);
    if (os && !os.error) return os;
    const d = new Date((dateISO || '') + 'T12:00:00');
    const want = isNaN(d) ? '?' : ((d.getMonth() + 1) + '-' + d.getDate());
    return { format: 'order-sheet', error: 'No dispatch tab for ' + want + " (that day isn't in the sheet — e.g. Sundays)", tabs: dayTabs, orders: [], pairs: [] };
  }
  return parseBuffer(buf);
}

module.exports = { parseBuffer, parseOrderSheet, parsePlan, parsePairs, gridFromBuffer, extractRows, findHeader };
