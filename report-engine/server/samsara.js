'use strict';
/*
 * Samsara helpers — lifted verbatim (logic-wise) from the desktop main.js, but parameterized
 * by a per-session config instead of the Electron module-global appCfg. Vehicle names in
 * Samsara match NewMile truck numbers exactly. All caches are keyed by session id so each
 * market's keys never bleed into another's.
 */
const _samCache = new Map();   // sid -> {at, data}
const _drvCache = new Map();   // sid -> {at, data}

function tokensOf(cfg) {
  return ((cfg.samsara && cfg.samsara.tokens) || []).filter(t => t && t.token);
}

async function gpsSnapshot(cfg, log) {
  const toks = tokensOf(cfg);
  const out = {};
  for (let ti = 0; ti < toks.length; ti++) {
    const t = toks[ti];
    try {
      let after = '', pages = 0;
      do {
        const url = 'https://api.samsara.com/fleet/vehicles/stats?types=gps' + (after ? '&after=' + encodeURIComponent(after) : '');
        const r = await fetch(url, { headers: { Authorization: 'Bearer ' + t.token, Accept: 'application/json' } });
        if (!r.ok) { log && log('samsara ' + t.name + ': HTTP ' + r.status); break; }
        const j = await r.json();
        (j.data || []).forEach(v => {
          const g = v.gps; if (!g) return;
          const key = (v.name || '').trim().toUpperCase().replace(/\s+/g, ' ');
          if (key) out[key] = {
            speed: (g.speedMilesPerHour != null ? g.speedMilesPerHour : null),
            time: g.time || null,
            lat: (g.latitude != null ? g.latitude : null),
            lon: (g.longitude != null ? g.longitude : null),
            id: v.id != null ? String(v.id) : null,
            tok: ti
          };
        });
        after = (j.pagination && j.pagination.hasNextPage) ? j.pagination.endCursor : '';
        pages++;
      } while (after && pages < 20);
    } catch (e) { log && log('samsara ' + t.name + ' failed: ' + e.message); }
  }
  return out;
}

async function getSamsara(sid, cfg, log) {
  const c = _samCache.get(sid);
  if (c && c.data && (Date.now() - c.at) < 5 * 60 * 1000) return c.data;
  const data = await gpsSnapshot(cfg, log);
  if (Object.keys(data).length) _samCache.set(sid, { at: Date.now(), data });
  return data;
}
function clearCaches(sid) { _samCache.delete(sid); _drvCache.delete(sid); }

async function camera(sid, cfg, name, log) {
  const snap = await getSamsara(sid, cfg, log);
  const key = (name || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const ent = snap[key];
  if (!ent || !ent.id) return { error: 'Truck not found in Samsara' };
  const toks = tokensOf(cfg);
  const tok = toks[ent.tok] && toks[ent.tok].token;
  if (!tok) return { error: 'No Samsara token for this fleet' };

  const at = new Date(Date.now() - 20000).toISOString();
  const r1 = await fetch('https://api.samsara.com/cameras/media/retrieval', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ vehicleId: ent.id, startTime: at, endTime: at, inputs: ['dashcamRoadFacing'], mediaType: 'image' })
  });
  if (!r1.ok) return { error: 'Samsara HTTP ' + r1.status + ': ' + (await r1.text()).slice(0, 140) };
  const j1 = await r1.json();
  const rid = j1 && j1.data && j1.data.retrievalId;
  if (!rid) return { error: 'Samsara did not return a retrieval id' };

  for (let i = 0; i < 18; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const r2 = await fetch('https://api.samsara.com/cameras/media/retrieval?retrievalId=' + encodeURIComponent(rid), {
      headers: { Authorization: 'Bearer ' + tok }
    });
    if (!r2.ok) continue;
    const j2 = await r2.json();
    const media = (j2.data && j2.data.media) || [];
    const ok = media.find(m => m.status === 'available' && m.urlInfo && m.urlInfo.url);
    if (ok) return { url: ok.urlInfo.url };
    if (media.length && media.every(m => m.status === 'failed')) return { error: 'Camera reported failure — truck probably shut off' };
  }
  return { error: 'Timed out (~90s). The camera uploads on demand — try again while the truck is running.' };
}

async function drivers(sid, cfg, log) {
  const c = _drvCache.get(sid);
  if (c && c.data && (Date.now() - c.at) < 30 * 60 * 1000) return c.data;
  const toks = tokensOf(cfg);
  const out = [];
  for (let ti = 0; ti < toks.length; ti++) {
    try {
      let after = '', pages = 0;
      do {
        const u = 'https://api.samsara.com/fleet/drivers?limit=512' + (after ? '&after=' + encodeURIComponent(after) : '');
        const r = await fetch(u, { headers: { Authorization: 'Bearer ' + toks[ti].token } });
        if (!r.ok) { log && log('samsara drivers ' + toks[ti].name + ': HTTP ' + r.status); break; }
        const j = await r.json();
        (j.data || []).forEach(d => out.push({ id: d.id, name: d.name || '', phone: (d.phone || '').replace(/\D/g, '').slice(-10), tok: ti }));
        after = (j.pagination && j.pagination.hasNextPage) ? j.pagination.endCursor : '';
        pages++;
      } while (after && pages < 10);
    } catch (e) { log && log('samsara drivers failed: ' + e.message); }
  }
  _drvCache.set(sid, { at: Date.now(), data: out });
  return out;
}

async function testToken(token) {
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
}

// HOS clocks → remaining DRIVE minutes per driver (best-effort across Samsara shapes).
// Returns { driverNameLower: { driveMin, shiftMin } }. Used by the "find nearby trucks
// that still have drive time" finder. Cached 10 min per session.
const _hosCache = new Map();
function _ms2min(ms) { return (ms == null ? null : Math.round(ms / 60000)); }
function _findRemain(clocks, kind) {
  if (!clocks) return null;
  // walk the clocks object looking for a "remaining" duration under a drive/shift key
  const want = kind === 'drive' ? /driv/i : /shift|onduty|on_duty/i;
  let found = null;
  (function walk(o, keyCtx) {
    if (!o || typeof o !== 'object') return;
    for (const k in o) {
      const v = o[k];
      if (typeof v === 'object') walk(v, want.test(k) ? true : keyCtx);
      else if (keyCtx && /remain|remaining/i.test(k) && typeof v === 'number') { if (found == null) found = v; }
    }
  })(clocks, false);
  return found;
}
async function hosClocks(sid, cfg, log) {
  const c = _hosCache.get(sid);
  if (c && (Date.now() - c.at) < 10 * 60 * 1000) return c.data;
  const toks = tokensOf(cfg); const out = {};
  for (const t of toks) {
    try {
      const r = await fetch('https://api.samsara.com/fleet/hos/clocks?limit=512', { headers: { Authorization: 'Bearer ' + t.token, Accept: 'application/json' } });
      if (!r.ok) { log && log('samsara HOS ' + t.name + ': HTTP ' + r.status); continue; }
      const j = await r.json();
      (j.data || []).forEach(d => {
        const name = ((d.driver && d.driver.name) || d.name || '').trim().toLowerCase(); if (!name) return;
        const driveMs = _findRemain(d.clocks, 'drive'); const shiftMs = _findRemain(d.clocks, 'shift');
        out[name] = { driveMin: _ms2min(driveMs), shiftMin: _ms2min(shiftMs) };
      });
    } catch (e) { log && log('samsara HOS failed: ' + e.message); }
  }
  _hosCache.set(sid, { at: Date.now(), data: out });
  return out;
}

async function sendDriverMsg(cfg, { driverId, tok, text }) {
  const toks = tokensOf(cfg);
  const token = toks[tok] && toks[tok].token;
  if (!token) return { error: 'no token' };
  const r = await fetch('https://api.samsara.com/v1/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ driverIds: [Number(driverId)], text: String(text || '').slice(0, 1000) })
  });
  if (!r.ok) return { error: 'HTTP ' + r.status + ': ' + (await r.text()).slice(0, 120) };
  return { ok: true };
}

module.exports = { getSamsara, camera, drivers, testToken, sendDriverMsg, hosClocks, clearCaches };
