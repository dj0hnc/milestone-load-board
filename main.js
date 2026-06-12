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
      sandbox: false
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
app.whenReady().then(() => {
  const cfg = loadConfig();
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

function priorWorkingDay(dateISO) {
  const d = new Date(dateISO + 'T12:00:00');
  do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return d.toISOString().slice(0, 10);
}
