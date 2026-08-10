'use strict';
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { NewMileClient } = require('./mcp-client');
const fuel = require('./fuel');
const ai = require('./ai');
const dwell = require('./geo-dwell');   // GPS dwell-clustering → real pickup/drop points
function gpsLocPath() { return path.join(app.getPath('userData'), 'gps-locations.json'); }
function gpsLocLoad() { try { return JSON.parse(fs.readFileSync(gpsLocPath(), 'utf8')) || {}; } catch (e) { return {}; } }
function gpsLocSave(m) { try { fs.writeFileSync(gpsLocPath(), JSON.stringify(m || {}, null, 1)); return true; } catch (e) { return false; } }
function gpsNorm(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim(); }

let win, client;
const recentLogs = [];
function pushLog(line) {
  const stamped = new Date().toISOString().slice(11, 19) + '  ' + line;
  recentLogs.push(stamped);
  if (recentLogs.length > 300) recentLogs.shift();
  if (win && !win.isDestroyed()) win.webContents.send('nm:log', stamped);
}

function loadConfig() {
  const p = path.join(__dirname, 'newmile.config.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 940, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0e1422',
    title: 'Milestone OS 1.0 (beta)',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true            // 💬 embedded NewMile messaging (persist:newmile-auth)
    }
  });
  win.removeMenu();
  // external links (Google Maps routes/pins) open in the system browser, never in-app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) { try { require('electron').shell.openExternal(url); } catch (e) {} }
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, 'renderer', 'shell.html'));
}

/*
 * The "internal browser" login. Opens a modal child window pointed at NewMile's
 * authorize URL and watches for the redirect back to our loopback redirect_uri.
 * We intercept the redirect BEFORE it loads (the 127.0.0.1 page never has to exist),
 * grab the ?code, and resolve. No system browser, no local web server, no open port.
 */
function authorizeInApp(authUrl, redirectUri) {
  return new Promise((resolve, reject) => {
    const authWin = new BrowserWindow({
      width: 520, height: 720, parent: win, modal: true, show: true,
      title: 'Sign in to NewMile',
      autoHideMenuBar: true,
      backgroundColor: '#0e1422',
      webPreferences: { contextIsolation: true, nodeIntegration: false, partition: 'persist:newmile-auth' }
    });
    authWin.removeMenu();

    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; try { authWin.destroy(); } catch (e) {} fn(arg); };

    const check = (url) => {
      if (url && url.startsWith(redirectUri)) { finish(resolve, url); return true; }
      return false;
    };
    const wc = authWin.webContents;
    wc.on('will-redirect', (e, url) => { if (check(url)) e.preventDefault(); });
    wc.on('will-navigate', (e, url) => { if (check(url)) e.preventDefault(); });
    // Some auth servers 302 to the loopback as a sub-resource / new request:
    wc.session.webRequest.onBeforeRequest({ urls: [redirectUri + '*'] }, (details, cb) => {
      if (check(details.url)) { cb({ cancel: true }); return; }
      cb({});
    });
    wc.on('did-fail-load', (e, code, desc, url) => {
      // a blocked loopback navigation can surface here — still try to read the code
      if (url && check(url)) return;
    });

    authWin.on('closed', () => { if (!done) { done = true; reject(new Error('Sign-in window closed before completing.')); } });
    pushLog('opening in-app NewMile sign-in');
    authWin.loadURL(authUrl).catch(err => finish(reject, new Error('Could not open sign-in: ' + err.message)));
  });
}

let appCfg = null;
// ---- GLOBAL / PRICE admin gate (separate from the 0605 Settings code) ----
// 9185 unlocks ALL price/order actions (create/reorder, qty/flex edit, FSC apply/programs) for the
// session + the Webmaster panel. Entered ONCE. The exe ENFORCES this — UI cannot bypass it.
let priceAdmin = false;
function globalAdminCode() { return (appCfg && appCfg.admin && appCfg.admin.globalCode) || '9185'; }
function maskKey(s) { s = String(s || ''); return s ? '••••' + s.slice(-4) : '—'; }
// reveal=true shows the FULL key (webmaster opted in with re-confirmation). Only honored while
// the global admin is unlocked. Otherwise everything is masked to last-4.
function webmasterStatus(reveal) {
  const show = (s) => (reveal && priceAdmin) ? (String(s || '') || '—') : maskKey(s);
  const sam = ((appCfg && appCfg.samsara && appCfg.samsara.tokens) || []).filter(t => t && (t.name || t.token));
  const gh = (appCfg && appCfg.github) || {};
  let nm = null; try { nm = client && client.status ? client.status() : null; } catch (e) {}
  const tok = (client && client.tokens) || null;
  return {
    priceAdmin, revealed: !!(reveal && priceAdmin),
    newmile: { connected: !!(nm && nm.connected), user: nm && nm.user, org: nm && nm.org, token: show(tok && tok.access_token), expires_at: tok && tok.expires_at || null },
    samsara: sam.map(t => ({ fleet: t.name || '(unnamed)', key: show(t.token) })),
    eia: { key: show((appCfg && appCfg.fuel && appCfg.fuel.eiaKey) || 'xSmnRXYvvybIc82acMIqwNa1dc9KZNFOHF8hU1Mq') },
    github: { repo: (gh.owner ? gh.owner + '/' + gh.repo : '—'), token: show(gh.token) },
    version: (function () { try { return require('./package.json').version; } catch (e) { return ''; } })()
  };
}

/*
 * Per-user APP SETTINGS (userData/app-settings.json) — lets every market paste its OWN
 * Samsara API keys + updater PAT without rebuilding the exe. Anything set here OVERRIDES
 * the bundled newmile.config.json. Guarded in the UI by an admin code (sha-256; default
 * code is 0605 — same convention the team already knows).
 */
function settingsPath() { return path.join(app.getPath('userData'), 'app-settings.json'); }
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8').replace(/^﻿/, '')) || {}; } catch (e) { return {}; }
}
function applySettings(cfg, s) {
  if (!s) return cfg;
  if (Array.isArray(s.samsaraTokens) && s.samsaraTokens.some(t => t && t.token)) {
    cfg.samsara = cfg.samsara || {};
    cfg.samsara.tokens = s.samsaraTokens.filter(t => t && t.token);
  }
  if (s.githubToken) { cfg.github = cfg.github || {}; cfg.github.token = String(s.githubToken).replace(/[^\x21-\x7E]/g, ''); }
  if (s.aiKey != null) cfg.aiKey = s.aiKey;
  if (s.aiModel) cfg.aiModel = s.aiModel;
  if (s.googleKey != null) cfg.googleKey = String(s.googleKey || '').trim();   // Google Distance Matrix (real-traffic ETA)
  if (s.market) cfg.marketName = s.market;
  try { ai.configure({ key: cfg.aiKey || '', model: cfg.aiModel || '' }); } catch (e) {}   // 🤖 copilot dormant until a key is set; model is user-pickable in Settings
  return cfg;
}
ipcMain.handle('nm:getSettings', () => {
  const s = loadSettings();
  return {
    market: s.market || '',
    samsaraTokens: (s.samsaraTokens || []).map(t => ({ name: t.name || '', token: t.token || '' })),
    bundledTokens: (((loadConfig().samsara || {}).tokens) || []).map(t => ({ name: t.name, has: !!t.token })),
    githubToken: s.githubToken || '',
    aiKey: s.aiKey || '',
    aiModel: s.aiModel || 'claude-sonnet-4-6',   // Miley's brain — user-pickable
    googleKey: s.googleKey || '',        // Google Distance Matrix key (real-traffic ETA)
    adminHash: s.adminHash || ''        // empty = default code 0605 (renderer hashes & compares)
  };
});
// 🤖 AI copilot — read-only chat over the live board. Renderer passes {messages, context}.
ipcMain.handle('nm:ai', async (_e, payload) => {
  try { const p = payload || {}; return await ai.chat(p.messages || [], p.context || '', p.tools || null); }
  catch (e) { return { error: e.message || String(e) }; }
});
ipcMain.handle('nm:aiStatus', () => ({ ready: ai.ready(), model: ai.model() }));
ipcMain.handle('nm:saveSettings', (_e, s) => {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(s || {}, null, 2));
    appCfg = applySettings(loadConfig(), s);
    _samCache = { at: 0, data: null };           // force fresh pulls with the new keys
    _drvCache = { at: 0, data: null };
    pushLog('settings saved — ' + (((s || {}).samsaraTokens || []).filter(t => t && t.token).length) + ' Samsara key(s) active' + (s.market ? (' · market ' + s.market) : ''));
    return { ok: true };
  } catch (e) { return { error: e.message || String(e) }; }
});

app.whenReady().then(() => {
  const cfg = applySettings(loadConfig(), loadSettings());
  appCfg = cfg;
  client = new NewMileClient({
    config: cfg,
    tokenPath: path.join(app.getPath('userData'), 'newmile-session.json'),
    geoCachePath: path.join(app.getPath('userData'), 'pickup-geocache.json'),
    gpsLocPath: gpsLocPath(),   // GPS-verified pickup/drop coords (from Samsara dwell), top-priority source
    authorize: authorizeInApp,
    onStatus: (st) => { if (win && !win.isDestroyed()) win.webContents.send('nm:status', st); },
    onLog: pushLog
  });
  // ⛽ Fuel Surcharge engine: configure storage + EIA key, refresh the diesel index on launch
  // (if stale) and every Monday-ish window. Key/admin from newmile.config.json `fuel`, with
  // the provisioned defaults as fallback.
  try {
    const fcfg = (cfg && cfg.fuel) || {};
    fuel.configure({
      dataDir: path.join(app.getPath('userData'), 'fuel-data'),
      eiaKey: fcfg.eiaKey || 'xSmnRXYvvybIc82acMIqwNa1dc9KZNFOHF8hU1Mq',
      adminCode: fcfg.adminCode || (appCfg.admin && appCfg.admin.code) || '0605'
    });
    const fuelTick = async () => {
      try {
        const latest = fuel.latestDiesel();
        const stale = !latest || ((Date.now() - new Date((latest.week_date || '1970-01-01') + 'T00:00:00Z')) > 8 * 24 * 3600 * 1000);
        const d = new Date(); const cstHour = (d.getUTCHours() + 18) % 24;   // UTC-6
        if (stale || (d.getUTCDay() === 1 && cstHour >= 6 && cstHour < 9)) { const r = await fuel.refreshDieselIndex(); pushLog('fuel index: ' + (r.added ? 'updated ' + (r.latest && r.latest.week_date) : 'up to date') + (r.error ? ' · ' + r.error : '')); }
      } catch (e) { pushLog('fuel tick: ' + e.message); }
    };
    setTimeout(fuelTick, 25 * 1000);
    setInterval(fuelTick, 60 * 60 * 1000);
  } catch (e) { pushLog('fuel configure failed: ' + e.message); }
  createWindow();
  // AUTO-update check runs ONLY when explicitly enabled (github.autoUpdate === true). Off by default
  // so nobody auto-pulls — Juan distributes the exe manually, then re-enables. The manual "Check for
  // updates" button (nm:checkUpdate) still works regardless.
  if (appCfg && appCfg.github && appCfg.github.autoUpdate === true) {
    setTimeout(checkForUpdate, 30 * 1000);                 // first check shortly after launch
    setInterval(checkForUpdate, 4 * 60 * 60 * 1000);       // then every 4 hours
  } else { pushLog('auto-updater: OFF (manual check only) — github.autoUpdate not enabled'); }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------- IPC ----------
ipcMain.handle('nm:status', () => client.status());
ipcMain.handle('nm:config', () => appCfg);
// What the UI SHOWS = friendly calendar label (displayVersion). The real semver
// (app.getVersion / package.json "version") stays the hidden, ever-increasing count that the
// auto-updater + our git history use — nobody "counts versions", but nothing is lost.
ipcMain.handle('nm:version', () => { try { return require('./package.json').displayVersion || app.getVersion(); } catch (e) { return app.getVersion(); } });
ipcMain.handle('nm:logs', () => recentLogs.slice(-120));
ipcMain.handle('nm:connect', async () => { await client.connect(); return client.status(); });
ipcMain.handle('nm:resume', () => client.resume());   // silent only — never opens sign-in
ipcMain.handle('nm:disconnect', () => client.disconnect());

// Full sync: Y/T/Tm orders + roster + rotation + per-order live assignments (one call).
ipcMain.handle('nm:refreshAll', (_e, dateISO) => client.refreshAll(dateISO));

ipcMain.handle('nm:pullDay', async (_e, dateISO) => {
  const orders = await client.listOrders(dateISO);

  // full roster (paged, capped)
  let trucks = [], page = 1, totalPages = 1;
  do {
    const r = await client.listTrucks(page);
    trucks = trucks.concat((r && (r.trucks || r.results || r.rows)) || []);
    totalPages = (r && (r.total_pages || r.pages)) || 1; page++;
  } while (page <= totalPages && page <= 20);

  // rotation: prior working day tickets
  const prior = priorWorkingDay(dateISO);
  let tickets = [];
  try {
    const first = await client.loadTickets(prior, 1);
    let tp = (first && (first.total_pages || first.pages)) || 1;
    tickets = (first && (first.rows || first.results)) || [];
    for (let pg = 2; pg <= tp && pg <= 10; pg++) {
      const more = await client.loadTickets(prior, pg);
      tickets = tickets.concat((more && (more.rows || more.results)) || []);
    }
  } catch (e) { pushLog('rotation pull skipped: ' + e.message); }

  return { date: dateISO, priorDay: prior, orders, trucks, tickets };
});

ipcMain.handle('nm:orderAssignments', (_e, orderId) => client.orderAssignments(orderId));
ipcMain.handle('nm:directory', () => client.pullDirectory());
ipcMain.handle('nm:setOnCall', (_e, list) => client.setOnCall(list));
ipcMain.handle('nm:projectTrucks', (_e, p) => client.projectTrucks(p.projectId, p.excludeOrderId));
ipcMain.handle('nm:rotationHistory', (_e, p = {}) => client.rotationHistory(p.date, p.days || 14));
ipcMain.handle('nm:zoom', (_e, factor) => {
  try { if (win && !win.isDestroyed()) win.webContents.setZoomFactor(Math.min(2, Math.max(0.5, factor))); return { ok: true }; }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle('nm:deleteAssignments', (_e, ids) => client.deleteAssignments(ids));
ipcMain.handle('nm:pushOrder', (_e, { orderId, assignments, useOrderDefault, removed, finalize }) =>
  client.pushOrderBatch(orderId, assignments, useOrderDefault, removed, finalize));
ipcMain.handle('nm:reconcileSeq', (_e, intentByTruck) => client.reconcileSequences(intentByTruck));
ipcMain.handle('nm:updateOrderQty', (_e, { orderId, quantity, flex }) => {
  if (!priceAdmin) return { error: 'Requiere admin global (código 9185) — desbloquéalo en el tab 💲 FSC.' };
  return client.updateOrderQuantity(orderId, quantity, flex);
});

// ⛽ Fuel Surcharge — one channel, routed by op. Read/program ops are local; orders/apply use the client.
ipcMain.handle('nm:fuel', async (_e, { op, args }) => {
  args = args || {};
  try {
    if (op === 'unlock') { if (String(args.code || '') === String(globalAdminCode())) { priceAdmin = true; return { ok: true, level: 'global' }; } return { ok: false, error: 'Código incorrecto' }; }
    if (op === 'status') return webmasterStatus(!!args.reveal);
    if (op === 'lock') { priceAdmin = false; return { ok: true }; }
    // WRITE / price ops require the global admin unlock (enforced here, not just in the UI)
    if (['apply', 'reorder', 'saveProgram', 'deleteProgram'].indexOf(op) >= 0 && !priceAdmin) return { error: 'Requiere admin global (código 9185) — desbloquéalo en el tab 💲 FSC.' };
    if (op === 'latest') return { latest: fuel.latestDiesel(), programs: Object.keys(fuel.allPrograms()).length };
    if (op === 'history') return { history: fuel.dieselHistory() };
    if (op === 'refresh') return await fuel.refreshDieselIndex();
    if (op === 'calculate') return fuel.calculateFuelSurcharge(args.customer, args.baseRate, args.quantity, args.diesel);
    if (op === 'programs') return { programs: fuel.allPrograms() };
    if (op === 'getProgram') return { program: fuel.getProgram(args.customer) };
    if (op === 'saveProgram') return { saved: fuel.saveProgram(args.customer, args.program) };
    if (op === 'deleteProgram') { fuel.deleteProgram(args.customer); return { ok: true }; }
    if (op === 'orders') {
      const q = String(args.q || '').trim().toLowerCase(), toks = q ? q.split(/\s+/).filter(Boolean) : [];
      const rows = await client.searchOrdersWindow(args.from, args.to);
      let pre = rows;
      if (toks.length) pre = rows.filter(o => toks.every(t => ((o.reference_number || '') + ' ' + (o.project_name || '') + ' ' + (o.material_name || '') + ' ' + (o.vendor_location || '') + ' ' + (o.delivery_location || '')).toLowerCase().indexOf(t) >= 0));
      const full = await client.getOrdersFull(pre.slice(0, 120).map(o => o.id));
      const uId = (u) => ({ ton: 1, yard: 2, load: 3, hour: 4 }[String(u || '').toLowerCase()] || 1);
      let orders = full.filter(Boolean).map(o => {
        const baseRate = Number(o.truck_pay_rate) || 0, qty = Number(o.quantity_requested) || 0, unit = o.quantity_measurement_unit || 'Ton';
        const calc = fuel.calculateFuelSurcharge(o.customer_name, baseRate, qty);
        const cur = (o.payable_fees || []).find(f => f.fee_type_id === 2);
        return { orderId: o.id, ref: (o.reference_number || '').trim(), customer: o.customer_name || '', project: o.project_name || '', po: o.purchase_order_id || null, baseRate, qty, unit, unitId: uId(unit), currentFsc: cur ? Number(cur.rate) : 0, suggestFsc: calc.perUnitFsc, pct: calc.surchargePercent, hasProgram: calc.hasProgram, payableFees: o.payable_fees || [] };
      });
      if (toks.length) orders = orders.filter(o => toks.every(t => (o.ref + ' ' + o.customer + ' ' + o.project + ' #' + (o.po || '')).toLowerCase().indexOf(t) >= 0));
      return { from: args.from, to: args.to, count: orders.length, total: rows.length, diesel: fuel.latestDiesel(), orders };
    }
    if (op === 'apply') {
      if (String(args.adminCode || '') !== String(fuel.adminCode())) return { error: 'Código admin incorrecto — los cambios de precio requieren el código.' };
      const items = Array.isArray(args.items) ? args.items : []; const results = [];
      for (const it of items) {
        const fees = fuel.mergeFsc(it.payableFees, it.newFscRate, it.unitId);
        const r = await client.updateOrderFees(it.orderId, fees, undefined);
        results.push({ orderId: it.orderId, ref: it.ref, ok: !r.error, error: r.error || null });
      }
      return { applied: results.filter(r => r.ok).length, total: items.length, results };
    }
    if (op === 'reorder') return await client.reorderOrder(args.orderId, { quantity: args.quantity, dateISO: args.dateISO });
    return { error: 'unknown fuel op: ' + op };
  } catch (e) { return { error: e.message || String(e) }; }
});

/*
 * Samsara GPS snapshot (Phase 2b move-check). Vehicle names in Samsara match the
 * NewMile truck numbers exactly (verified live: Cactus = plain numbers like "351",
 * CKJ = "KT-7040 P" style). Returns { NORMALIZED_NAME: {speed, time} }.
 */
async function samsaraGpsSnapshot(cfg) {
  const toks = ((cfg.samsara && cfg.samsara.tokens) || []).filter(t => t && t.token);
  const out = {};
  for (let ti = 0; ti < toks.length; ti++) {
    const t = toks[ti];
    try {
      let after = '', pages = 0;
      do {
        const url = 'https://api.samsara.com/fleet/vehicles/stats?types=gps' + (after ? '&after=' + encodeURIComponent(after) : '');
        const r = await fetch(url, { headers: { Authorization: 'Bearer ' + t.token, Accept: 'application/json' } });
        if (!r.ok) { pushLog('samsara ' + t.name + ': HTTP ' + r.status); break; }
        const j = await r.json();
        (j.data || []).forEach(v => {
          const g = v.gps; if (!g) return;
          const key = (v.name || '').trim().toUpperCase().replace(/\s+/g, ' ');
          if (key) out[key] = {
            speed: (g.speedMilesPerHour != null ? g.speedMilesPerHour : null),
            time: g.time || null,
            lat: (g.latitude != null ? g.latitude : null),
            lon: (g.longitude != null ? g.longitude : null),
            id: v.id != null ? String(v.id) : null,   // for camera media requests
            tok: ti                                    // which org token owns this vehicle
          };
        });
        after = (j.pagination && j.pagination.hasNextPage) ? j.pagination.endCursor : '';
        pages++;
      } while (after && pages < 20);
      pushLog('samsara ' + t.name + ': snapshot ok');
    } catch (e) { pushLog('samsara ' + t.name + ' failed: ' + e.message); }
  }
  return out;
}
// 5-min cache so refresh (parking) + move-check + camera share one Samsara pull
let _samCache = { at: 0, data: null };
async function getSamsara() {
  if (_samCache.data && (Date.now() - _samCache.at) < 5 * 60 * 1000) return _samCache.data;
  const data = await samsaraGpsSnapshot(appCfg || {});
  if (Object.keys(data).length) _samCache = { at: Date.now(), data };
  return data;
}
ipcMain.handle('nm:samsara', async () => {
  try { return await getSamsara(); }
  catch (e) { pushLog('samsara error: ' + e.message); return {}; }
});

// ---------- GPS-verified pickup/drop (Samsara history → dwell clusters) ----------
// Pull a vehicle set's GPS breadcrumbs for a time window. token owns the vehicles; ids are Samsara
// vehicle ids. Returns { vehicleId: [{lat,lng,speed,time,addr}] }.
async function vehicleGpsHistory(token, ids, startISO, endISO) {
  const out = {};
  if (!ids || !ids.length) return out;
  let after = '', pg = 0;
  do {
    const u = 'https://api.samsara.com/fleet/vehicles/stats/history?types=gps&startTime=' + encodeURIComponent(startISO)
      + '&endTime=' + encodeURIComponent(endISO) + '&vehicleIds=' + ids.map(encodeURIComponent).join(',') + (after ? '&after=' + encodeURIComponent(after) : '');
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!r.ok) { pushLog('gps history HTTP ' + r.status); break; }
    const j = await r.json();
    (j.data || []).forEach(v => {
      const id = String(v.id); out[id] = out[id] || [];
      (v.gps || []).forEach(g => out[id].push({ lat: g.latitude, lng: g.longitude, speed: g.speedMilesPerHour, time: g.time, addr: (g.reverseGeo && g.reverseGeo.formattedLocation) || '' }));
    });
    after = (j.pagination && j.pagination.hasNextPage) ? j.pagination.endCursor : ''; pg++;
  } while (after && pg < 14);
  return out;
}
// Match a NewMile truck_number to a Samsara snapshot key (handles "KT-7045 P" → "KT-7045", spacing,
// punctuation). Returns the snapshot entry {id, tok, lat, lon, ...} or null.
function matchVehicle(snap, num) {
  const n = String(num || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!n) return null;
  const cands = [n, n.replace(/\s*[PT]$/, '').trim(), n.replace(/[^A-Z0-9]/g, '')];
  for (const c of cands) { if (snap[c]) return snap[c]; }
  const an = n.replace(/[^A-Z0-9]/g, '');
  const k = Object.keys(snap).find(mn => mn.replace(/[^A-Z0-9]/g, '') === an);
  return k ? snap[k] : null;
}
// Verify an order's real pickup/drop from where its assigned trucks dwelled that day.
// payload: { truckNums:[], startISO, endISO, pickup:{lat,lng}, drop:{lat,lng} }
ipcMain.handle('nm:gpsVerify', async (_e, payload) => {
  try {
    const p = payload || {};
    const snap = await getSamsara();
    const toks = ((appCfg.samsara && appCfg.samsara.tokens) || []).filter(t => t && t.token);
    const byTok = {}; let matched = 0;
    (p.truckNums || []).forEach(num => {
      const v = matchVehicle(snap, num);
      if (v && v.id != null && v.tok != null) { (byTok[v.tok] = byTok[v.tok] || []).push(String(v.id)); matched++; }
    });
    if (!matched) return { error: 'No Samsara match for this order\'s trucks (' + (p.truckNums || []).length + ' assigned)' };
    let all = [];
    for (const ti of Object.keys(byTok)) {
      const t = toks[ti]; if (!t) continue;
      const hist = await vehicleGpsHistory(t.token, byTok[ti], p.startISO, p.endISO);
      Object.values(hist).forEach(arr => { all = all.concat(dwell.dwellClusters(arr, { minMin: 10 })); });
    }
    const merged = dwell.mergeClusters(all);
    const stops = dwell.assignStops(merged, p.pickup || null, p.drop || null);
    pushLog('gpsVerify: ' + matched + ' trucks · ' + merged.length + ' dwell clusters');
    return { ok: true, pickup: stops.pickup, drop: stops.drop, clusters: merged.slice(0, 8), matched: matched, trucks: (p.truckNums || []).length };
  } catch (e) { return { error: e.message || String(e) }; }
});
// Persist a dispatcher-confirmed real location (by name) so EVERY future order with that name uses
// the GPS-verified coords (read first by mcp-client.resolvePickupCoords).
ipcMain.handle('nm:gpsSaveLoc', (_e, payload) => {
  try {
    const p = payload || {}; const key = gpsNorm(p.name);
    if (!key || p.lat == null || p.lng == null) return { error: 'name + coords required' };
    const m = gpsLocLoad();
    m[key] = { lat: Number(p.lat), lng: Number(p.lng), addr: p.addr || null, raw: p.name || '', src: 'gps', at: new Date().toISOString() };
    gpsLocSave(m);
    pushLog('gps-location saved: "' + (p.name || '') + '" → ' + Number(p.lat).toFixed(4) + ',' + Number(p.lng).toFixed(4));
    return { ok: true };
  } catch (e) { return { error: e.message || String(e) }; }
});

// ---------- real-traffic ETA (Google Distance Matrix) ----------
// Returns {miles, min, traffic, src:'google'} when the key + billing are live, else null so the
// caller keeps its OSRM/straight-line estimate. departure_time=now + best_guess = live traffic.
async function googleEta(from, to) {
  const key = (appCfg && appCfg.googleKey) || '';
  if (!key || !from || !to || from.lat == null || to.lat == null) return null;
  try {
    const u = 'https://maps.googleapis.com/maps/api/distancematrix/json?origins=' + from.lat + ',' + from.lng
      + '&destinations=' + to.lat + ',' + to.lng + '&departure_time=now&traffic_model=best_guess&units=imperial&key=' + encodeURIComponent(key);
    const r = await fetch(u); const j = await r.json();
    if (j.status !== 'OK') { if (j.status === 'REQUEST_DENIED') pushLog('googleEta denied (enable Billing?): ' + (j.error_message || '').slice(0, 80)); return null; }
    const e = j.rows && j.rows[0] && j.rows[0].elements && j.rows[0].elements[0];
    if (!e || e.status !== 'OK') return null;
    const miles = e.distance ? e.distance.value / 1609.34 : null;
    const secs = e.duration_in_traffic ? e.duration_in_traffic.value : (e.duration ? e.duration.value : null);
    return { miles: miles != null ? Math.round(miles * 10) / 10 : null, min: secs != null ? Math.round(secs / 60) : null, traffic: !!e.duration_in_traffic, src: 'google' };
  } catch (e) { return null; }
}
ipcMain.handle('nm:routeEta', async (_e, payload) => {
  try { const p = payload || {}; return await googleEta(p.from, p.to); }
  catch (e) { return null; }
});
ipcMain.handle('nm:googleReady', () => ({ ready: !!(appCfg && appCfg.googleKey) }));
// Live status of the Google traffic ETA — so the UI can show "waiting on billing" until it flips
// green on its own. Caches 'ready' for 5 min; re-checks other states every ~45s so it self-heals.
let _googStat = { at: 0, state: null };
async function googleStatus() {
  const key = (appCfg && appCfg.googleKey) || '';
  if (!key) return { state: 'off' };
  const ttl = (_googStat.state === 'ready') ? 300000 : 40000;
  if (_googStat.state && (Date.now() - _googStat.at) < ttl) return { state: _googStat.state };
  try {
    const u = 'https://maps.googleapis.com/maps/api/distancematrix/json?origins=32.78,-96.80&destinations=32.71,-96.70&departure_time=now&key=' + encodeURIComponent(key);
    const j = await (await fetch(u)).json();
    const msg = (j.error_message || '');
    let st = 'denied';
    if (j.status === 'OK') st = 'ready';
    else if (j.status === 'REQUEST_DENIED' && /billing/i.test(msg)) st = 'billing';
    else if (j.status === 'REQUEST_DENIED' && /(not authorized|api .*not|disabled|enable)/i.test(msg)) st = 'apioff';
    else if (j.status === 'OVER_QUERY_LIMIT') st = 'quota';
    _googStat = { at: Date.now(), state: st };
    return { state: st, msg: msg.slice(0, 100) };
  } catch (e) { return { state: 'err' }; }
}
ipcMain.handle('nm:googleStatus', async () => { try { return await googleStatus(); } catch (e) { return { state: 'err' }; } });

/*
 * Dashcam snapshot (road-facing). Verified live flow: POST /cameras/media/retrieval
 * with startTime === endTime (images need 0 duration) and mediaType "image", then
 * poll until the camera uploads (usually 30-60s). Needs the "Media Retrieval" scope
 * on the Samsara token (confirmed enabled 2026-06-11).
 */
ipcMain.handle('nm:camera', async (_e, name) => {
  try {
    const snap = await getSamsara();
    const key = (name || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const ent = snap[key];
    if (!ent || !ent.id) return { error: 'Truck not found in Samsara' };
    const toks = ((appCfg.samsara && appCfg.samsara.tokens) || []).filter(t => t && t.token);
    const tok = toks[ent.tok] && toks[ent.tok].token;
    if (!tok) return { error: 'No Samsara token for this fleet' };

    const at = new Date(Date.now() - 20000).toISOString();   // a moment ago — freshest frame
    // Two cameras: road-facing (Frontal) + driver-facing cabin (Cabina). Request each as its own
    // retrieval so a missing/disabled cabin cam doesn't hold up the road shot.
    const CAMS = [
      { input: 'dashcamRoadFacing', label: 'Frontal' },
      { input: 'dashcamDriverFacing', label: 'Cabina' }
    ];
    const jobs = [];
    for (const cam of CAMS) {
      try {
        const r1 = await fetch('https://api.samsara.com/cameras/media/retrieval', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
          body: JSON.stringify({ vehicleId: ent.id, startTime: at, endTime: at, inputs: [cam.input], mediaType: 'image' })
        });
        if (!r1.ok) { jobs.push({ label: cam.label, err: 'HTTP ' + r1.status }); continue; }
        const j1 = await r1.json();
        const rid = j1 && j1.data && j1.data.retrievalId;
        if (!rid) { jobs.push({ label: cam.label, err: 'no retrieval id' }); continue; }
        jobs.push({ label: cam.label, rid, url: null, done: false });
      } catch (e) { jobs.push({ label: cam.label, err: e.message || String(e) }); }
    }
    if (!jobs.some(j => j.rid)) return { error: 'Samsara did not accept the snapshot request (' + jobs.map(j => j.label + ': ' + (j.err || '?')).join(', ') + ')' };
    pushLog('camera: snapshot requested for ' + name + ' (' + jobs.filter(j => j.rid).map(j => j.label).join(' + ') + ')');

    for (let i = 0; i < 18; i++) {                            // poll up to ~90s, return shots as they land
      await new Promise(r => setTimeout(r, 5000));
      for (const job of jobs) {
        if (!job.rid || job.done) continue;
        const r2 = await fetch('https://api.samsara.com/cameras/media/retrieval?retrievalId=' + encodeURIComponent(job.rid), {
          headers: { Authorization: 'Bearer ' + tok }
        });
        if (!r2.ok) continue;
        const j2 = await r2.json();
        const media = (j2.data && j2.data.media) || [];
        const ok = media.find(m => m.status === 'available' && m.urlInfo && m.urlInfo.url);
        if (ok) { job.url = ok.urlInfo.url; job.done = true; }
        else if (media.length && media.every(m => m.status === 'failed')) { job.err = 'no upload (truck off?)'; job.done = true; }
      }
      // stop early once every requested camera has resolved one way or another
      if (jobs.filter(j => j.rid).every(j => j.done)) break;
    }
    const shots = jobs.filter(j => j.url).map(j => ({ label: j.label, url: j.url }));
    if (shots.length) {
      pushLog('camera: ' + shots.length + ' shot(s) ready for ' + name);
      return { shots, url: shots[0].url };   // url kept for back-compat with older UI
    }
    const failed = jobs.filter(j => j.err && /off|fail/i.test(j.err)).length;
    if (failed) return { error: 'Camera reported no upload — truck is probably shut off.' };
    return { error: 'Timed out (~90s). The camera uploads on demand — try again while the truck is running.' };
  } catch (e) { return { error: e.message || String(e) }; }
});

/*
 * Auto-updater — checks the private GitHub repo's latest release (on launch + every 4h).
 * Needs a fine-grained read-only PAT in config.github.token (repo is private because the
 * release artifacts embed the Samsara tokens). No token → updater stays silently off.
 */
function semverNewer(a, b) {  // a > b ?
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
  return false;
}
let _updateInfo = null;
async function checkForUpdate() {
  try {
    const gh = (appCfg && appCfg.github) || {};
    if (!gh.owner || !gh.repo) { return; }                 // owner/repo ship in the config; token only needed if the repo is PRIVATE
    const hdr = { Accept: 'application/vnd.github+json', 'User-Agent': 'MilestoneLoadBoard' };
    const ghTok = (gh.token || '').replace(/[^\x21-\x7E]/g, ''); // strip BOM/zero-width/whitespace — a stray U+FEFF breaks the header ByteString
    if (ghTok) hdr.Authorization = 'Bearer ' + ghTok; // public releases → no token; private → PAT
    const r = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/releases/latest`, { headers: hdr });
    if (!r.ok) {
      pushLog('updater: HTTP ' + r.status + (gh.token ? '' : ' (no token — private repo needs a PAT, or make releases public)'));
      // 404/403 with no token almost always = private repo; tell the UI so it can guide the user
      return { status: 'http', code: r.status, needsToken: (!gh.token && (r.status === 404 || r.status === 403)) };
    }
    const j = await r.json();
    const latest = (j.tag_name || '').replace(/^v/, '');
    const cur = app.getVersion();
    if (!latest || !semverNewer(latest, cur)) { pushLog('updater: up to date (v' + cur + ')'); return { status: 'uptodate', current: cur }; }
    const isMac = process.platform === 'darwin';
    const asset = (j.assets || []).find(a => isMac ? /\.dmg$/i.test(a.name) : /\.exe$/i.test(a.name));
    _updateInfo = { version: latest, current: cur, assetId: asset && asset.id, assetName: asset && asset.name, notes: j.body || '' };
    pushLog('updater: v' + latest + ' available (current v' + cur + ')');
    if (win && !win.isDestroyed()) win.webContents.send('nm:update', _updateInfo);
    return { status: 'update', update: _updateInfo };
  } catch (e) { pushLog('updater check failed: ' + e.message); return { status: 'error', error: e.message || String(e) }; }
}
// manual "look for update now" — the ⬇ button in Settings (and the version label). Returns a precise
// status so the UI can say up-to-date / update available / private-needs-token / not configured.
ipcMain.handle('nm:checkUpdate', async () => {
  const gh = (appCfg && appCfg.github) || {};
  if (!gh.owner || !gh.repo) return { error: 'no-config', current: app.getVersion() };
  const r = await checkForUpdate();
  if (r && r.status === 'update') return { update: r.update };
  if (r && r.status === 'uptodate') return { upToDate: true, current: app.getVersion() };
  if (r && r.status === 'http') return { error: r.needsToken ? 'needs-token' : ('http-' + r.code), current: app.getVersion() };
  if (r && r.status === 'error') return { error: r.error, current: app.getVersion() };
  return _updateInfo ? { update: _updateInfo } : { upToDate: true, current: app.getVersion() };
});
ipcMain.handle('nm:downloadUpdate', async () => {
  try {
    if (!_updateInfo || !_updateInfo.assetId) return { error: 'No update staged' };
    const gh = appCfg.github;
    const dhdr = { Accept: 'application/octet-stream', 'User-Agent': 'MilestoneLoadBoard' };
    const ghTok = (gh.token || '').replace(/[^\x21-\x7E]/g, '');   // strip BOM/zero-width so the header doesn't throw
    if (ghTok) dhdr.Authorization = 'Bearer ' + ghTok;   // public release asset → no token needed
    const r = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/releases/assets/${_updateInfo.assetId}`, {
      headers: dhdr, redirect: 'follow'
    });
    if (!r.ok) return { error: 'download HTTP ' + r.status };
    const buf = Buffer.from(await r.arrayBuffer());
    const dest = path.join(app.getPath('downloads'), _updateInfo.assetName);
    fs.writeFileSync(dest, buf);
    pushLog('updater: downloaded ' + _updateInfo.assetName + ' (' + Math.round(buf.length / 1048576) + ' MB)');
    require('electron').shell.showItemInFolder(dest);
    return { ok: true, path: dest };
  } catch (e) { return { error: e.message || String(e) }; }
});

/*
 * ✉ Samsara driver messaging — list drivers (cached) + send. Drivers matched to
 * NewMile by phone number in the renderer. Uses the same org tokens as GPS.
 */
let _drvCache = { at: 0, data: null };
ipcMain.handle('nm:drivers', async () => {
  try {
    if (_drvCache.data && (Date.now() - _drvCache.at) < 30 * 60 * 1000) return _drvCache.data;
    const toks = ((appCfg.samsara && appCfg.samsara.tokens) || []).filter(t => t && t.token);
    const out = [];
    for (let ti = 0; ti < toks.length; ti++) {
      try {
        let after = '', pages = 0;
        do {
          const u = 'https://api.samsara.com/fleet/drivers?limit=512' + (after ? '&after=' + encodeURIComponent(after) : '');
          const r = await fetch(u, { headers: { Authorization: 'Bearer ' + toks[ti].token } });
          if (!r.ok) { pushLog('samsara drivers ' + toks[ti].name + ': HTTP ' + r.status); break; }
          const j = await r.json();
          (j.data || []).forEach(d => out.push({ id: d.id, name: d.name || '', phone: (d.phone || '').replace(/\D/g, '').slice(-10), tok: ti }));
          after = (j.pagination && j.pagination.hasNextPage) ? j.pagination.endCursor : '';
          pages++;
        } while (after && pages < 10);
      } catch (e) { pushLog('samsara drivers failed: ' + e.message); }
    }
    pushLog('samsara drivers: ' + out.length + ' loaded');
    _drvCache = { at: Date.now(), data: out };
    return out;
  } catch (e) { return []; }
});
// 🧪 instant key validation for the Admin panel — every market self-checks its token
ipcMain.handle('nm:testSamsara', async (_e, token) => {
  try {
    const t = String(token || '').trim();
    if (!t) return { error: 'empty token' };
    const r = await fetch('https://api.samsara.com/fleet/vehicles/stats?types=gps', {
      headers: { Authorization: 'Bearer ' + t, Accept: 'application/json' }
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 120);
      return { error: 'HTTP ' + r.status + (r.status === 401 ? ' — invalid/expired token or missing API scope' : '') + ' · ' + body };
    }
    const j = await r.json();
    const n = (j.data || []).length;
    const gps = (j.data || []).filter(v => v.gps && v.gps.latitude != null).length;
    return { ok: true, vehicles: n, withGps: gps };
  } catch (e) { return { error: e.message || String(e) }; }
});

ipcMain.handle('nm:sendDriverMsg', async (_e, { driverId, tok, text }) => {
  try {
    const toks = ((appCfg.samsara && appCfg.samsara.tokens) || []).filter(t => t && t.token);
    const token = toks[tok] && toks[tok].token;
    if (!token) return { error: 'no token' };
    const r = await fetch('https://api.samsara.com/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverIds: [Number(driverId)], text: String(text || '').slice(0, 1000) })
    });
    if (!r.ok) return { error: 'HTTP ' + r.status + ': ' + (await r.text()).slice(0, 120) };
    pushLog('driver message sent (driver ' + driverId + ')');
    return { ok: true };
  } catch (e) { return { error: e.message || String(e) }; }
});

/*
 * 🎯 Samsara HOS clocks — remaining DRIVE minutes per driver, for "find nearby trucks that
 * still have drive time". Defensive parse across Samsara shapes. 10-min cache.
 */
let _hosCache = { at: 0, data: null };
function _hosRemain(clocks, kind) {
  if (!clocks) return null;
  const want = kind === 'drive' ? /driv/i : /shift|onduty|on_duty/i;
  let found = null;
  (function walk(o, ctx) {
    if (!o || typeof o !== 'object') return;
    for (const k in o) { const v = o[k];
      if (typeof v === 'object') walk(v, want.test(k) ? true : ctx);
      else if (ctx && /remain/i.test(k) && typeof v === 'number' && found == null) found = v;
    }
  })(clocks, false);
  return found;
}
ipcMain.handle('nm:hos', async () => {
  try {
    if (_hosCache.data && (Date.now() - _hosCache.at) < 10 * 60 * 1000) return _hosCache.data;
    const toks = ((appCfg.samsara && appCfg.samsara.tokens) || []).filter(t => t && t.token);
    const out = {};
    for (const t of toks) {
      try {
        const r = await fetch('https://api.samsara.com/fleet/hos/clocks?limit=512', { headers: { Authorization: 'Bearer ' + t.token, Accept: 'application/json' } });
        if (!r.ok) { pushLog('samsara HOS ' + t.name + ': HTTP ' + r.status); continue; }
        const j = await r.json();
        (j.data || []).forEach(d => {
          const name = ((d.driver && d.driver.name) || d.name || '').trim().toLowerCase(); if (!name) return;
          const dm = _hosRemain(d.clocks, 'drive'), sm = _hosRemain(d.clocks, 'shift');
          out[name] = { driveMin: dm == null ? null : Math.round(dm / 60000), shiftMin: sm == null ? null : Math.round(sm / 60000) };
        });
      } catch (e) { pushLog('samsara HOS failed: ' + e.message); }
    }
    _hosCache = { at: Date.now(), data: out };
    return out;
  } catch (e) { return {}; }
});

/*
 * 💰 NewMile real rate calculators (drive time, loads/day, freight rate/margin) — passthrough
 * to call_utility, whitelisted. Powers the desktop Quoter with NewMile's own math.
 */
const CALC_OK = new Set(['calculate_drive_time', 'calculate_loads_per_day', 'calculate_freight_rate', 'calculate_freight_margin', 'calculate_material_rate', 'calculate_material_margin']);
ipcMain.handle('nm:calc', async (_e, { name, args }) => {
  try {
    if (!CALC_OK.has(name)) return { error: 'utility not allowed' };
    return await client.callTool('call_utility', { utility_name: name, args: args || {} });
  } catch (e) { return { error: e.message || String(e) }; }
});

/*
 * 📷 Read a photo of an Excel/plan sheet → {text, pairs:[{num,lds}]} (free OCR, tesseract.js).
 * Lazy-required so the app still runs if tesseract isn't bundled.
 */
let _ocrWorker = null;
function _ocrParse(text) {
  const toks = String(text || '').split(/[\t\n\r ,;|]+/).map(s => s.trim()).filter(Boolean);
  const isLoad = s => /^\d{1,2}$/.test(s); const out = []; let k = 0;
  while (k < toks.length) { const cur = toks[k]; if (isLoad(cur)) { k++; continue; }
    const nxt = toks[k + 1]; if (nxt != null && isLoad(nxt)) { out.push({ num: cur, lds: parseInt(nxt, 10) }); k += 2; } else { out.push({ num: cur, lds: '' }); k++; } }
  return out;
}
ipcMain.handle('nm:ocr', async (_e, { image }) => {
  try {
    if (!image) return { error: 'no image' };
    const { createWorker } = require('tesseract.js');
    if (!_ocrWorker) _ocrWorker = await createWorker('eng');
    const buf = Buffer.from(image, 'base64');
    const { data } = await _ocrWorker.recognize(buf);
    const text = (data && data.text) || '';
    return { text, pairs: _ocrParse(text) };
  } catch (e) {
    if (/Cannot find module 'tesseract/.test(String(e.message))) return { error: 'OCR engine not bundled in this build' };
    return { error: e.message || String(e) };
  }
});

/*
 * 📥 Read the monthly dispatch order-sheet straight off the OneDrive-synced folder on THIS PC
 * (no Microsoft login needed — the file is local). Auto-scans OneDrive + self-heals to the right
 * file (the one that has the requested day's tab). Returns {orders, pairs, file, tab} for matching.
 */
ipcMain.handle('nm:scanPlan', async () => { try { return require('./planimport').scan('Lease Dispatch'); } catch (e) { return { error: e.message || String(e) }; } });

/*
 * 📉 SERVICE FAILURE REPORT (GP dollars of lost loads) — the same weekly report the cloud
 * emails on Mondays (report-engine/server/servicefail.js), viewable and sendable ON DEMAND
 * from the app for ANY Mon-Sat week. Email needs report.resendKey (newmile.config.json
 * "report" block, or the SF window's settings); the recipient list is remembered per user.
 */
let sfWin = null, lastSf = null;
function openSfWindow() {
  if (sfWin && !sfWin.isDestroyed()) { sfWin.focus(); return; }
  sfWin = new BrowserWindow({
    width: 1000, height: 900, minWidth: 760, minHeight: 560,
    backgroundColor: '#0e1422',
    title: 'Service Failure Report — GP of Lost Loads',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  sfWin.removeMenu();
  sfWin.loadFile(path.join(__dirname, 'renderer', 'sfreport.html'));
  sfWin.on('closed', () => { sfWin = null; });
}
ipcMain.handle('nm:sfOpen', () => { openSfWindow(); return true; });
ipcMain.handle('nm:sfBuild', async (_e, p) => {
  try {
    const st = client && client.status ? client.status() : null;
    if (!st || !st.connected) return { error: 'Not connected to NewMile — connect in the main window first.' };
    const servicefail = require('./report-engine/server/servicefail');
    const range = (p && p.from && p.to) ? { from: p.from, to: p.to }
      : servicefail.lastWeekRange(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }));
    pushLog('SF report: pulling ' + range.from + ' -> ' + range.to);
    const raw = await servicefail.fetchWeek(client, range.from, range.to);
    const rep = servicefail.buildServiceFailures(raw, range);
    rep._failures = raw.failures;              // kept for the print/PDF layout (failure detail pages)
    lastSf = rep;
    const s = loadSettings();
    return {
      from: rep.from, to: rep.to, totals: rep.totals, html: rep.html,
      unmatched: rep.unmatched.map(f => ({ order: f.order_reference, date: f.order_date })),
      emailTo: s.sfEmailTo || ((appCfg.report || {}).to || ''),
      emailReady: !!((s.sfResendKey || (appCfg.report || {}).resendKey || '').trim())
    };
  } catch (e) { return { error: e.message || String(e) }; }
});
ipcMain.handle('nm:sfSend', async (_e, p) => {
  try {
    if (!lastSf) return { ok: false, error: 'Build the report first.' };
    const s = loadSettings();
    const key = ((p && p.resendKey) || s.sfResendKey || (appCfg.report || {}).resendKey || '').trim();
    if (!key) return { ok: false, error: 'No Resend key configured — paste one in the SF window (⚙) or in newmile.config.json "report".' };
    const to = String((p && p.to) || '').trim();
    if (!to) return { ok: false, error: 'No recipient.' };
    // remember recipient (+ key if typed here) without clobbering other per-user settings
    try {
      const merged = Object.assign({}, s, { sfEmailTo: to }, (p && p.resendKey) ? { sfResendKey: p.resendKey } : {});
      fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
    } catch (e) {}
    const mailer = require('./report-engine/server/mailer');
    const t = lastSf.totals;
    const gpK = '$' + (Math.abs(t.lostGp) >= 1000 ? (t.lostGp / 1000).toFixed(1) + 'K' : t.lostGp.toFixed(1));
    const subject = '📉 Service Failures ' + lastSf.from + ' → ' + lastSf.to + ' — ' + gpK + ' GP lost · ' + t.failures + ' failures';
    // attach the full Design-style PDF alongside the two CSVs (Tony reads the PDF)
    let atts = lastSf.attachments;
    try { atts = [{ filename: sfPdfName(), content: await sfMakePdf() }].concat(lastSf.attachments); }
    catch (e) { pushLog('SF pdf attach failed (sending CSVs only): ' + (e.message || e)); }
    const r = await mailer.sendEmail(
      { to: to, from: (appCfg.report || {}).from || 'onboarding@resend.dev', resendKey: key },
      { subject: subject, html: lastSf.html, text: lastSf.text, attachments: atts });
    pushLog('SF report email: ' + JSON.stringify(r));
    return r;
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});
// Render the print layout (the Design-style document + the GP section) to a PDF buffer with a
// hidden window — same doc whether saved to disk or attached to the email.
async function sfMakePdf() {
  const servicefail = require('./report-engine/server/servicefail');
  const html = servicefail.buildPrintHtml(lastSf, lastSf._failures || []);
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await w.webContents.printToPDF({
      pageSize: 'Letter', printBackground: true,
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: servicefail.printFooterTemplate(lastSf),
      margins: { top: 0.55, bottom: 0.85, left: 0.6, right: 0.6 }
    });
  } finally { try { w.destroy(); } catch (e) {} }
}
function sfPdfName() { return 'Milestone_Tx_SF_Report_' + lastSf.from + '_' + lastSf.to + '.pdf'; }
ipcMain.handle('nm:sfPdf', async () => {
  try {
    if (!lastSf) return { error: 'Build the report first.' };
    const { dialog } = require('electron');
    const res = await dialog.showSaveDialog(sfWin || win, { title: 'Save Service Failure Report PDF', defaultPath: sfPdfName(), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    fs.writeFileSync(res.filePath, await sfMakePdf());
    return { ok: true, saved: res.filePath };
  } catch (e) { return { error: e.message || String(e) }; }
});
ipcMain.handle('nm:sfSaveCsv', async () => {
  try {
    if (!lastSf) return { error: 'Build the report first.' };
    const { dialog } = require('electron');
    const res = await dialog.showOpenDialog(sfWin || win, { title: 'Save the two report CSVs to…', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const dir = res.filePaths[0], saved = [];
    lastSf.attachments.forEach(a => { const fp = path.join(dir, a.filename); fs.writeFileSync(fp, a.content); saved.push(fp); });
    return { ok: true, saved: saved };
  } catch (e) { return { error: e.message || String(e) }; }
});
ipcMain.handle('nm:readPlan', async (_e, { dateISO } = {}) => {
  try {
    const s = loadSettings() || {};
    return require('./planimport').readPlan(dateISO, { dir: s.planImportDir || undefined, file: s.planImportFile || undefined, prefix: s.planPrefix || 'Lease Dispatch' });
  } catch (e) {
    if (/Cannot find module 'xlsx/.test(String(e.message))) return { error: 'Excel reader not bundled in this build' };
    return { error: e.message || String(e) };
  }
});
// 🚩 SHARED truck availability/notes — proxied to the mab-mobile server (same PC) so the desktop
// and ALL phones share ONE store. Base URL from app-settings.notesServer (default localhost:8090).
// Best-effort: if the server is down (e.g. a coworker without it), the renderer falls back to its
// own localStorage so flagging never breaks.
ipcMain.handle('nm:truckNotes', async (_e, payload = {}) => {
  try {
    const s = loadSettings() || {};
    const base = (s.notesServer || 'http://localhost:8090').replace(/\/+$/, '');
    const op = (payload && payload.op) || 'get';
    const url = base + '/api/truck-notes' + (op === 'set' ? '/set' : op === 'log' ? '/log' : '');
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
    return await r.json();
  } catch (e) { return { error: String((e && e.message) || e), offline: true }; }
});
// Fallback when the OneDrive auto-find fails (file not synced on THIS PC, or no tab for the day):
// let the dispatcher pick the .xlsx/.csv by hand, parse it, and return per-order rows to match.
ipcMain.handle('nm:pickPlanFile', async (_e, { dateISO } = {}) => {
  try {
    const { dialog } = require('electron');
    const res = await dialog.showOpenDialog(win, {
      title: 'Selecciona la hoja de Excel del día',
      properties: ['openFile'],
      filters: [{ name: 'Excel / CSV', extensions: ['xlsx', 'xls', 'csv'] }]
    });
    if (res.canceled || !(res.filePaths && res.filePaths.length)) return { canceled: true };
    const buf = fs.readFileSync(res.filePaths[0]);
    const name = path.basename(res.filePaths[0]);
    const sheet = require('./sheet');
    if (dateISO) {
      try {
        const op = sheet.parsePlan(buf, dateISO);
        if (op && op.format === 'order-sheet' && !op.error && (op.orders || []).length) return { orderSheet: true, orders: op.orders, tab: op.tab, file: name };
        if (op && op.error) { /* not the day's tab → fall back to generic */ }
      } catch (e) {}
    }
    const pb = sheet.parseBuffer(buf);
    return { pairs: (pb && pb.pairs) || [], file: name };
  } catch (e) {
    if (/Cannot find module 'xlsx/.test(String(e.message))) return { error: 'Excel reader not bundled in this build' };
    return { error: e.message || String(e) };
  }
});

/*
 * Quoter route engine (main process = no CORS): geocode via Census then Nominatim,
 * road miles + minutes via the public OSRM router. In-memory cache per session.
 */
const _geoMem = {};
async function geocodeOne(q) {
  const key = q.trim().toUpperCase();
  if (_geoMem[key]) return _geoMem[key];
  try {
    const u = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' + encodeURIComponent(q);
    const r = await fetch(u, { headers: { 'User-Agent': 'MilestoneLoadBoard' } });
    const j = await r.json();
    const hit = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
    if (hit) return (_geoMem[key] = { lat: hit.coordinates.y, lng: hit.coordinates.x, src: 'census' });
  } catch (e) {}
  try {
    const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(q);
    const r = await fetch(u, { headers: { 'User-Agent': 'MilestoneLoadBoard/2.1 (dispatch tool)' } });
    const j = await r.json();
    if (j && j[0]) return (_geoMem[key] = { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), src: 'osm' });
  } catch (e) {}
  return null;
}
// geocode a free-text place (city, address) → {lat,lng} for the truck-rail "nearest to <city>" search
ipcMain.handle('nm:geocode', async (_e, q) => { try { const g = await geocodeOne(String(q || '').trim()); return g ? { lat: g.lat, lng: g.lng, src: g.src } : null; } catch (e) { return null; } });
ipcMain.handle('nm:route', async (_e, { from, to, fromCoords, toCoords }) => {
  try {
    const A = fromCoords || await geocodeOne(from);
    const B = toCoords || await geocodeOne(to);
    if (!A || !B) return { error: 'could not locate ' + (!A ? 'pickup' : 'dropoff') };
    try {
      const u = `https://router.project-osrm.org/route/v1/driving/${A.lng},${A.lat};${B.lng},${B.lat}?overview=false`;
      const r = await fetch(u, { headers: { 'User-Agent': 'MilestoneLoadBoard' } });
      const j = await r.json();
      const rt = j && j.routes && j.routes[0];
      if (rt) return { mi: rt.distance / 1609.34, min: rt.duration / 60, src: 'OSRM road' };
    } catch (e) {}
    const rad = Math.PI / 180, R = 3958.8;
    const dLa = (B.lat - A.lat) * rad, dLo = (B.lng - A.lng) * rad;
    const s = Math.sin(dLa / 2) ** 2 + Math.cos(A.lat * rad) * Math.cos(B.lat * rad) * Math.sin(dLo / 2) ** 2;
    const mi = R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)) * 1.27;
    return { mi, min: mi / 45 * 60, src: 'estimate ×1.27 @45mph' };
  } catch (e) { return { error: e.message || String(e) }; }
});

function priorWorkingDay(dateISO) {
  const d = new Date(dateISO + 'T12:00:00');
  do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return d.toISOString().slice(0, 10);
}
