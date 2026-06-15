'use strict';
/*
 * Fuel Surcharge engine — DESKTOP (Electron main process) twin of mab-mobile/server/fuel.js.
 * Same EIA fetch + per-customer programs + calculator + FSC fee merge. Storage lives in the
 * Electron userData dir (set via configure()), EIA key from newmile.config.json `fuel.eiaKey`.
 * Order search/apply are done by main.js (it holds the NewMile client); this module is the math
 * + the diesel index + the program store + the payable-fee merge helper.
 */
const fs = require('fs');
const path = require('path');

let DIR = null, EIA_KEY = '', ADMIN_CODE = '0605';
function configure(opts) {
  DIR = opts.dataDir; EIA_KEY = opts.eiaKey || EIA_KEY; if (opts.adminCode) ADMIN_CODE = opts.adminCode;
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {}
}
function adminCode() { return ADMIN_CODE; }
const _idx = () => path.join(DIR, 'fuel-index.json');
const _prog = () => path.join(DIR, 'fuel-programs.json');
function _read(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } }
function _write(f, d) { try { fs.writeFileSync(f, JSON.stringify(d, null, 1)); return true; } catch (e) { return false; } }

async function fetchOnce() {
  if (!EIA_KEY) throw new Error('no EIA key configured');
  const url = 'https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=' + encodeURIComponent(EIA_KEY)
    + '&frequency=weekly&data[0]=value&facets[product][]=EPD2D&facets[process][]=PTE&facets[duoarea][]=NUS'
    + '&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=1';
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('EIA HTTP ' + r.status);
  const j = await r.json();
  const row = ((j && j.response && j.response.data) || [])[0];
  if (!row) throw new Error('EIA no rows');
  const price = Number(row.value), week = String(row.period || '').slice(0, 10);
  if (!isFinite(price) || !week) throw new Error('EIA malformed');
  return { week_date: week, diesel_price: price };
}
async function fetchLatestDiesel() {
  let e = null;
  for (let i = 0; i < 3; i++) { try { return await fetchOnce(); } catch (x) { e = x; await new Promise(r => setTimeout(r, 1500 * (i + 1))); } }
  throw e || new Error('EIA failed');
}
async function refreshDieselIndex() {
  const out = { added: false, latest: latestDiesel() };
  try {
    const d = await fetchLatestDiesel();
    const idx = _read(_idx(), []);
    if (!idx.some(x => x.week_date === d.week_date)) {
      idx.push({ week_date: d.week_date, diesel_price: d.diesel_price, source: 'EIA weekly on-highway diesel (US avg)', created_at: new Date().toISOString() });
      idx.sort((a, b) => (a.week_date < b.week_date ? -1 : 1)); _write(_idx(), idx); out.added = true;
    }
    out.latest = latestDiesel();
  } catch (e) { out.error = e.message || String(e); }
  return out;
}
function dieselHistory() { return _read(_idx(), []); }
function latestDiesel() { const i = _read(_idx(), []); return i.length ? i[i.length - 1] : null; }

function allPrograms() { return _read(_prog(), {}); }
function getProgram(name) { const all = allPrograms(); const k = String(name || '').trim().toLowerCase(); for (const n of Object.keys(all)) if (n.trim().toLowerCase() === k) return Object.assign({ customer_name: n }, all[n]); return null; }
function saveProgram(name, p) {
  const all = allPrograms();
  all[String(name || '').trim()] = {
    enabled: p.enabled !== false, base_fuel_price: Number(p.base_fuel_price) || 0,
    calculation_type: ['PER_TON', 'PER_LOAD', 'HOURLY'].indexOf(p.calculation_type) >= 0 ? p.calculation_type : 'PER_TON',
    table: (Array.isArray(p.table) ? p.table : []).map(t => ({ diesel: Number(t.diesel), surcharge: Number(t.surcharge) })).filter(t => isFinite(t.diesel) && isFinite(t.surcharge)).sort((a, b) => a.diesel - b.diesel)
  };
  _write(_prog(), all); return all[String(name || '').trim()];
}
function deleteProgram(name) { const all = allPrograms(); delete all[String(name || '').trim()]; _write(_prog(), all); }
function surchargeForDiesel(table, diesel) { let p = 0; (table || []).slice().sort((a, b) => a.diesel - b.diesel).forEach(t => { if (diesel >= t.diesel) p = t.surcharge; }); return p; }
function calculateFuelSurcharge(customer, baseRate, quantity, dieselOverride) {
  const prog = getProgram(customer), latest = latestDiesel();
  const dieselPrice = dieselOverride != null ? Number(dieselOverride) : (latest ? latest.diesel_price : null);
  const out = { customer, dieselPrice, surchargePercent: 0, perUnitFsc: 0, surchargeAmount: 0, baseRate: Number(baseRate) || 0, quantity: Number(quantity) || 0, totalAmount: (Number(baseRate) || 0) * (Number(quantity) || 0), enabled: false, hasProgram: !!prog };
  if (!prog || prog.enabled === false || dieselPrice == null) { out.note = !prog ? 'no program' : (dieselPrice == null ? 'no diesel price' : 'disabled'); return out; }
  out.enabled = true; const pct = surchargeForDiesel(prog.table, dieselPrice);
  out.surchargePercent = pct; out.calculation_type = prog.calculation_type;
  out.perUnitFsc = +((Number(baseRate) || 0) * pct / 100).toFixed(4);
  out.surchargeAmount = +(out.perUnitFsc * (Number(quantity) || 0)).toFixed(2);
  out.totalAmount = +(out.baseRate * out.quantity + out.surchargeAmount).toFixed(2);
  return out;
}
// rebuild a COMPLETE payable_fees list with the FSC fee (fee_type_id 2) set/replaced/removed
function mergeFsc(existing, newRate, unitId) {
  const list = (existing || []).map(f => ({ id: f.id, fee_type_id: f.fee_type_id, rate: Number(f.rate), measurement_unit_id: f.measurement_unit_id }));
  const i = list.findIndex(f => f.fee_type_id === 2);
  if (newRate == null || Number(newRate) <= 0) { if (i >= 0) list.splice(i, 1); }
  else if (i >= 0) list[i].rate = Number(newRate);
  else list.push({ fee_type_id: 2, rate: Number(newRate), measurement_unit_id: unitId || 1 });
  return list;
}

module.exports = {
  configure, adminCode, fetchLatestDiesel, refreshDieselIndex, dieselHistory, latestDiesel,
  allPrograms, getProgram, saveProgram, deleteProgram, surchargeForDiesel, calculateFuelSurcharge, mergeFsc
};
