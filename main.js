'use strict';
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { NewMileClient } = require('./mcp-client');

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
    title: 'Milestone Load Board',
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

/*
 * Per-user APP SETTINGS (userData/app-settings.json) — lets every market paste its OWN
 * Samsara API keys + updater PAT without rebuilding the exe. Anything set here OVERRIDES
 * the bundled newmile.config.json. Guarded in the UI by an admin code (sha-256; default
 * code is 0605 — same convention the team already knows).
 */
function settingsPath() { return path.join(app.getPath('userData'), 'app-settings.json'); }
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {}; } catch (e) { return {}; }
}
function applySettings(cfg, s) {
  if (!s) return cfg;
  if (Array.isArray(s.samsaraTokens) && s.samsaraTokens.some(t => t && t.token)) {
    cfg.samsara = cfg.samsara || {};
    cfg.samsara.tokens = s.samsaraTokens.filter(t => t && t.token);
  }
  if (s.githubToken) { cfg.github = cfg.github || {}; cfg.github.token = s.githubToken; }
  if (s.market) cfg.marketName = s.market;
  return cfg;
}
ipcMain.handle('nm:getSettings', () => {
  const s = loadSettings();
  return {
    market: s.market || '',
    samsaraTokens: (s.samsaraTokens || []).map(t => ({ name: t.name || '', token: t.token || '' })),
    bundledTokens: (((loadConfig().samsara || {}).tokens) || []).map(t => ({ name: t.name, has: !!t.token })),
    githubToken: s.githubToken || '',
    adminHash: s.adminHash || ''        // empty = default code 0605 (renderer hashes & compares)
  };
});
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
    authorize: authorizeInApp,
    onStatus: (st) => { if (win && !win.isDestroyed()) win.webContents.send('nm:status', st); },
    onLog: pushLog
  });
  createWindow();
  setTimeout(checkForUpdate, 30 * 1000);                 // first check shortly after launch
  setInterval(checkForUpdate, 4 * 60 * 60 * 1000);       // then every 4 hours
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------- IPC ----------
ipcMain.handle('nm:status', () => client.status());
ipcMain.handle('nm:config', () => appCfg);
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
ipcMain.handle('nm:deleteAssignments', (_e, ids) => client.deleteAssignments(ids));
ipcMain.handle('nm:pushOrder', (_e, { orderId, assignments, useOrderDefault }) =>
  client.pushOrderBatch(orderId, assignments, useOrderDefault));

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
    const r1 = await fetch('https://api.samsara.com/cameras/media/retrieval', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicleId: ent.id, startTime: at, endTime: at, inputs: ['dashcamRoadFacing'], mediaType: 'image' })
    });
    if (!r1.ok) return { error: 'Samsara HTTP ' + r1.status + ': ' + (await r1.text()).slice(0, 140) };
    const j1 = await r1.json();
    const rid = j1 && j1.data && j1.data.retrievalId;
    if (!rid) return { error: 'Samsara did not return a retrieval id' };
    pushLog('camera: snapshot requested for ' + name);

    for (let i = 0; i < 18; i++) {                            // poll up to ~90s
      await new Promise(r => setTimeout(r, 5000));
      const r2 = await fetch('https://api.samsara.com/cameras/media/retrieval?retrievalId=' + encodeURIComponent(rid), {
        headers: { Authorization: 'Bearer ' + tok }
      });
      if (!r2.ok) continue;
      const j2 = await r2.json();
      const media = (j2.data && j2.data.media) || [];
      const ok = media.find(m => m.status === 'available' && m.urlInfo && m.urlInfo.url);
      if (ok) { pushLog('camera: snapshot ready for ' + name); return { url: ok.urlInfo.url }; }
      if (media.length && media.every(m => m.status === 'failed')) return { error: 'Camera reported failure — truck probably shut off' };
    }
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
    if (!gh.token || !gh.owner || !gh.repo) { return; }
    const r = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/releases/latest`, {
      headers: { Authorization: 'Bearer ' + gh.token, Accept: 'application/vnd.github+json', 'User-Agent': 'MilestoneLoadBoard' }
    });
    if (!r.ok) { pushLog('updater: HTTP ' + r.status); return; }
    const j = await r.json();
    const latest = (j.tag_name || '').replace(/^v/, '');
    const cur = app.getVersion();
    if (!latest || !semverNewer(latest, cur)) { pushLog('updater: up to date (v' + cur + ')'); return; }
    const isMac = process.platform === 'darwin';
    const asset = (j.assets || []).find(a => isMac ? /\.dmg$/i.test(a.name) : /\.exe$/i.test(a.name));
    _updateInfo = { version: latest, current: cur, assetId: asset && asset.id, assetName: asset && asset.name, notes: j.body || '' };
    pushLog('updater: v' + latest + ' available (current v' + cur + ')');
    if (win && !win.isDestroyed()) win.webContents.send('nm:update', _updateInfo);
  } catch (e) { pushLog('updater check failed: ' + e.message); }
}
ipcMain.handle('nm:downloadUpdate', async () => {
  try {
    if (!_updateInfo || !_updateInfo.assetId) return { error: 'No update staged' };
    const gh = appCfg.github;
    const r = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/releases/assets/${_updateInfo.assetId}`, {
      headers: { Authorization: 'Bearer ' + gh.token, Accept: 'application/octet-stream', 'User-Agent': 'MilestoneLoadBoard' },
      redirect: 'follow'
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
