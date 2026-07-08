'use strict';
/*
 * NewMile MCP client for the Milestone Load Board desktop app.
 *
 * Transport : MCP streamable HTTP (JSON-RPC 2.0 over POST), per spec 2025-06-18.
 * Auth      : OAuth 2.1 — RFC 8414 discovery, RFC 7591 dynamic client registration,
 *             PKCE (S256), refresh tokens, client_secret_post token auth.
 *
 * VERIFIED against the live NewMile server (app.newmile.com) on 2026-06-10:
 *   - /.well-known/oauth-protected-resource  -> authorization_servers: [app.newmile.com]
 *   - /.well-known/oauth-authorization-server:
 *        authorize = /oauth/authorize, token = /oauth/token,
 *        register  = /oauth/register (dynamic registration SUPPORTED),
 *        scopes    = "mcp:read mcp:write claudeai",
 *        token_endpoint_auth_method = client_secret_post, PKCE = S256.
 *   - Tools exposed: list_resources, query_report, call_utility, get_user_profile,
 *        get_workflow_guide, describe_resource, get_resource, ...
 *   - Push path (corrected vs the old build):
 *        bulk_create_assignments is a UTILITY (call_utility) and needs truck_id
 *        (resolved from truck number), confirm_assignments takes the array of
 *        created assignment IDs, and there is NO finalize_load_plan utility —
 *        confirm IS the finalize. ordinal is set by list order / reorder_assignments.
 *
 * The interactive authorize step is delegated to opts.authorize(authUrl, redirectUri),
 * which the main process implements with an in-app Electron BrowserWindow (the
 * "internal browser" login) and resolves with the final redirect URL.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_SCOPES = 'mcp:read mcp:write claudeai';

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

class NewMileClient {
  /**
   * @param {object}   opts
   * @param {object}   opts.config       parsed newmile.config.json
   * @param {string}   opts.tokenPath    where to persist tokens + registered client
   * @param {(authUrl:string, redirectUri:string)=>Promise<string>} opts.authorize
   *                                      open the in-app login window, resolve with the redirect URL
   * @param {(status:object)=>void} opts.onStatus  status change callback
   * @param {(line:string)=>void}   [opts.onLog]   optional diagnostic log sink
   */
  constructor(opts) {
    this.cfg = opts.config;
    this.tokenPath = opts.tokenPath;
    this.authorize = opts.authorize;
    this.onStatus = opts.onStatus || (() => {});
    this.onLog = opts.onLog || (() => {});

    this.mcpUrl = this.cfg.mcpUrl;
    this.origin = new URL(this.mcpUrl).origin;

    const saved = this._load();
    this.tokens = saved.tokens || null;          // { access_token, refresh_token, expires_at }
    this.clientId = (this.cfg.oauth && this.cfg.oauth.clientId) || saved.clientId || null;
    this.clientSecret = saved.clientSecret || null;
    this.geoCachePath = opts.geoCachePath || null;   // persistent pickup-name → coords cache
    this._geoCache = null;
    this.gpsLocPath = opts.gpsLocPath || null;       // GPS-verified location coords (from Samsara dwell) — top priority
    this.meta = null;                            // discovered AS metadata
    this.sessionId = null;                       // MCP session id
    this.connected = false;
    this.lastError = null;
    this.profile = null;                         // cached get_user_profile
    this._truckIdCache = new Map();              // normalized number -> truck_id
  }

  log(s) { try { this.onLog(String(s)); } catch (e) {} }

  // ---------- status ----------
  status() {
    return {
      connected: this.connected,
      hasToken: !!(this.tokens && this.tokens.access_token),
      hasClient: !!this.clientId,
      expiresAt: this.tokens ? this.tokens.expires_at : null,
      org: this.profile ? this.profile.current_org_name : (this.cfg.org && this.cfg.org.name) || null,
      user: this.profile ? (this.profile.first_name + ' ' + this.profile.last_name) : null,
      error: this.lastError,
      mcpUrl: this.mcpUrl
    };
  }
  _emit() { this.onStatus(this.status()); }

  // ---------- persistence ----------
  _load() {
    try { return JSON.parse(fs.readFileSync(this.tokenPath, 'utf8')) || {}; } catch (e) { return {}; }
  }
  _persist() {
    try { fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true }); } catch (e) {}
    const blob = { tokens: this.tokens, clientId: this.clientId, clientSecret: this.clientSecret };
    try { fs.writeFileSync(this.tokenPath, JSON.stringify(blob, null, 2)); } catch (e) { this.log('persist failed: ' + e.message); }
  }
  disconnect() {
    this.tokens = null; this.sessionId = null; this.connected = false;
    this.profile = null; this._truckIdCache.clear();
    // keep the registered client (clientId/secret) so reconnect is one click
    this._persist();
    this._emit();
    return this.status();
  }

  // ---------- OAuth ----------
  async _discover() {
    if (this.meta) return;
    const o = this.cfg.oauth || {};
    if (o.discovery === false && o.authorizationEndpoint && o.tokenEndpoint) {
      this.meta = {
        authorization_endpoint: o.authorizationEndpoint,
        token_endpoint: o.tokenEndpoint,
        registration_endpoint: o.registrationEndpoint || null,
        scopes_supported: o.scopes ? o.scopes.split(/\s+/) : undefined
      };
      return;
    }
    // 1) protected-resource metadata -> authorization server
    let asBase = this.origin;
    try {
      const prm = await fetch(this.origin + '/.well-known/oauth-protected-resource', { headers: { Accept: 'application/json' } });
      if (prm.ok) {
        const j = await prm.json();
        if (Array.isArray(j.authorization_servers) && j.authorization_servers[0]) {
          asBase = j.authorization_servers[0].replace(/\/$/, '');
        }
      }
    } catch (e) { /* fall through */ }

    // 2) authorization server metadata (RFC 8414)
    const tryUrls = [
      asBase + '/.well-known/oauth-authorization-server',
      asBase + '/.well-known/openid-configuration'
    ];
    for (const u of tryUrls) {
      try {
        const r = await fetch(u, { headers: { Accept: 'application/json' } });
        if (r.ok) { this.meta = await r.json(); this.log('discovered AS at ' + u); return; }
      } catch (e) { /* next */ }
    }
    // 3) last resort: hardwired known NewMile endpoints (verified 2026-06-10)
    this.meta = {
      authorization_endpoint: this.origin + '/oauth/authorize',
      token_endpoint: this.origin + '/oauth/token',
      registration_endpoint: this.origin + '/oauth/register'
    };
    this.log('discovery failed; using known NewMile endpoints');
  }

  _scopes() {
    const o = this.cfg.oauth || {};
    if (o.scopes) return o.scopes;
    if (this.meta && Array.isArray(this.meta.scopes_supported)) return this.meta.scopes_supported.join(' ');
    return DEFAULT_SCOPES;
  }

  _redirectUri() {
    const port = (this.cfg.oauth && this.cfg.oauth.redirectPort) || 8741;
    return 'http://127.0.0.1:' + port + '/callback';
  }

  async _registerClient() {
    if (this.clientId) return;
    if (!this.meta.registration_endpoint) {
      throw new Error('NewMile did not advertise dynamic registration and no clientId is configured. Add oauth.clientId to newmile.config.json.');
    }
    const body = {
      client_name: 'Milestone Load Board (desktop)',
      redirect_uris: [this._redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: this._scopes(),
      application_type: 'native'
    };
    const r = await fetch(this.meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('Dynamic client registration failed: ' + r.status + ' ' + (await r.text()));
    const j = await r.json();
    this.clientId = j.client_id;
    this.clientSecret = j.client_secret || null;   // may be a public client (no secret)
    this._persist();
    this.log('registered client_id ' + this.clientId + (this.clientSecret ? ' (confidential)' : ' (public)'));
  }

  // SILENT resume only — used at app launch so data loads without any popup.
  // Returns status on success, null when a sign-in would be needed.
  async resume() {
    if (!(this.tokens && (this.tokens.refresh_token || Date.now() < this.tokens.expires_at))) return null;
    try {
      await this._initializeSession();
      await this._loadProfile();
      this.connected = true; this._emit();
      this.log('resumed NewMile session silently (no sign-in needed)');
      return this.status();
    } catch (e) {
      this.log('silent resume failed (' + (e.message || e) + ')');
      return null;
    }
  }

  // Connect. Tries the silent resume first; only falls back to the interactive
  // in-app sign-in when the saved session can't be used.
  async connect() {
    this.lastError = null;
    const resumed = await this.resume();
    if (resumed) return resumed;
    try {
      await this._discover();
      await this._registerClient();

      const verifier = b64url(crypto.randomBytes(32));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
      const state = b64url(crypto.randomBytes(16));
      const redirectUri = this._redirectUri();

      const p = new URLSearchParams({
        response_type: 'code',
        client_id: this.clientId,
        redirect_uri: redirectUri,
        state,
        scope: this._scopes(),
        code_challenge: challenge,
        code_challenge_method: 'S256'
      });
      const authUrl = this.meta.authorization_endpoint + '?' + p.toString();

      // The main process opens the in-app window and returns the final redirect URL.
      const redirected = await this.authorize(authUrl, redirectUri);
      const q = new URL(redirected).searchParams;
      if (q.get('error')) throw new Error('Authorization denied: ' + (q.get('error_description') || q.get('error')));
      if (q.get('state') !== state) throw new Error('OAuth state mismatch (possible CSRF) — please try again.');
      const code = q.get('code');
      if (!code) throw new Error('No authorization code returned from NewMile.');

      await this._exchangeCode(code, verifier, redirectUri);
      await this._initializeSession();
      await this._loadProfile();
      this.connected = true; this._emit();
      this.log('connected to NewMile as ' + (this.status().user || '?'));
      return this.status();
    } catch (e) {
      this.connected = false; this.lastError = String(e.message || e); this._emit();
      this.log('connect error: ' + this.lastError);
      throw e;
    }
  }

  _tokenAuthParams(p) {
    p.set('client_id', this.clientId || (this.cfg.oauth && this.cfg.oauth.clientId) || '');
    if (this.clientSecret) p.set('client_secret', this.clientSecret); // client_secret_post
    return p;
  }

  async _exchangeCode(code, verifier, redirectUri) {
    const p = this._tokenAuthParams(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier
    }));
    const r = await fetch(this.meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: p.toString()
    });
    if (!r.ok) throw new Error('Token exchange failed: ' + r.status + ' ' + (await r.text()));
    this._storeTokenResponse(await r.json());
  }

  _storeTokenResponse(j) {
    const expires_at = Date.now() + ((j.expires_in || 3600) - 90) * 1000; // refresh 90s early
    this.tokens = {
      access_token: j.access_token,
      refresh_token: j.refresh_token || (this.tokens && this.tokens.refresh_token) || null,
      expires_at,
      token_type: j.token_type || 'Bearer'
    };
    this._persist();
  }

  async _ensureToken() {
    if (this.tokens && this.tokens.access_token && Date.now() < this.tokens.expires_at) return;
    if (this.tokens && this.tokens.refresh_token) {
      await this._discover();
      const p = this._tokenAuthParams(new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refresh_token
      }));
      const r = await fetch(this.meta.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: p.toString()
      });
      if (r.ok) { this._storeTokenResponse(await r.json()); this.log('access token refreshed'); return; }
      this.log('refresh failed: ' + r.status);
    }
    throw new Error('NOT_CONNECTED');
  }

  // ---------- MCP transport ----------
  // NewMile answers tool calls over an SSE stream that STAYS OPEN after the response
  // event (verified live 2026-06-10). So: read the stream incrementally, resolve on the
  // first JSON-RPC message carrying our id, then abort the request. Never await r.text()
  // on an event-stream — it hangs forever.
  async _rpc(method, params, opts) {
    opts = opts || {};
    await this._ensureToken();
    const isNotification = !!opts.notification;
    const id = isNotification ? null : crypto.randomUUID();
    const body = { jsonrpc: '2.0', method, params };
    if (!isNotification) body.id = id;

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': 'Bearer ' + this.tokens.access_token,
      'MCP-Protocol-Version': PROTOCOL_VERSION
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch (e) {} }, opts.timeoutMs || 90000);
    try {
      const r = await fetch(this.mcpUrl, {
        method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal
      });
      const sid = r.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;

      if (r.status === 401) {
        this.connected = false; this.sessionId = null; this._emit();
        throw new Error('NOT_CONNECTED');
      }
      if (!r.ok) throw new Error('MCP ' + method + ' failed: ' + r.status + ' ' + (await r.text()));

      // Notifications expect no response — don't wait on the stream.
      if (isNotification) { try { ac.abort(); } catch (e) {} return null; }

      const ct = (r.headers.get('content-type') || '');
      let msg;
      if (!ct.includes('text/event-stream')) {
        msg = await r.json();
      } else {
        // incremental SSE read
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        outer:
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const datas = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
            for (const d of datas) {
              try {
                const o = JSON.parse(d);
                if (o.id === id || o.error) { msg = o; break outer; }
              } catch (e) {}
            }
          }
        }
        try { ac.abort(); } catch (e) {}   // close the still-open stream
      }
      if (!msg) throw new Error('Empty MCP response for ' + method);
      if (msg.error) throw new Error('MCP error (' + method + '): ' + (msg.error.message || JSON.stringify(msg.error)));
      return msg.result;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('MCP ' + method + ' timed out');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async _initializeSession() {
    this.sessionId = null;
    await this._rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'MilestoneLoadBoard', version: '2.0.1' }
    }, { timeoutMs: 30000 });
    // true JSON-RPC notification: no id, no response expected
    try { await this._rpc('notifications/initialized', {}, { notification: true, timeoutMs: 10000 }); } catch (e) {}
  }

  // Generic tool call. Unwraps structured/text content into a JS value.
  async callTool(name, args) {
    const res = await this._rpc('tools/call', { name, arguments: args || {} });
    if (res && res.isError) {
      const t = Array.isArray(res.content) ? (res.content.find(c => c.type === 'text') || {}).text : '';
      throw new Error('Tool ' + name + ' error: ' + (t || 'unknown'));
    }
    if (res && res.structuredContent) return res.structuredContent;
    if (res && Array.isArray(res.content)) {
      const t = res.content.find(c => c.type === 'text');
      if (t) { try { return JSON.parse(t.text); } catch (e) { return t.text; } }
    }
    return res;
  }

  async _loadProfile() {
    try { this.profile = await this.callTool('get_user_profile', {}); } catch (e) { this.profile = null; }
    return this.profile;
  }
  // the signed-in user's org — every market gets ITS OWN data, never a hardcoded org
  _myOrgId() {
    const p = this.profile || {};
    return p.current_org_id || p.org_id || (this.cfg.org && this.cfg.org.orgId) || null;
  }

  // ---------- read helpers ----------
  listOrders(dateISO) {
    return this.callTool('list_resources', {
      resource_type: 'order',
      filters: { order_date_from: dateISO, order_date_to: dateISO, page_size: 100 }
    });
  }
  listTrucks(page = 1) {
    return this.callTool('list_resources', { resource_type: 'truck', filters: { page, page_size: 100 } });
  }
  loadTickets(dateISO, page = 1) {
    return this.callTool('query_report', {
      report_name: 'load_tickets',
      filters: { order_date_from: dateISO, order_date_to: dateISO },
      columns: ['truck_number', 'fleet'],
      page_size: 100, page
    });
  }
  // multi-day window WITH the date column → lets the board compute "days since last worked".
  // order_date is the verified date field (returns MM/DD/YY).
  loadTicketsRange(fromISO, toISO, page = 1) {
    return this.callTool('query_report', {
      report_name: 'load_tickets',
      filters: { order_date_from: fromISO, order_date_to: toISO },
      columns: ['truck_number', 'fleet', 'order_date'],
      page_size: 200, page
    });
  }
  orderAssignments(orderId) {
    return this.callTool('list_resources', {
      resource_type: 'order_assignment',
      filters: { order_id: orderId, page_size: 100 }
    });
  }

  // ---------- full-day refresh (orders Y/T/Tm + roster + rotation + per-order assignments) ----------
  _shiftISO(iso, days) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
  _priorWorkingDay(iso) { const d = new Date(iso + 'T12:00:00'); do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6); return d.toISOString().slice(0, 10); }

  async _pool(items, limit, fn) {
    const out = new Array(items.length); let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = null; this.log('pool item failed: ' + e.message); } }
    });
    await Promise.all(workers);
    return out;
  }

  async listOrdersAllPages(dateISO) {
    let rows = [], page = 1, totalPages = 1;
    do {
      const r = await this.callTool('list_resources', {
        resource_type: 'order',
        filters: { order_date_from: dateISO, order_date_to: dateISO, page: page, page_size: 100 }
      });
      rows = rows.concat((r && (r.orders || r.results || r.rows)) || []);
      totalPages = (r && (r.total_pages || r.pages)) || 1; page++;
    } while (page <= totalPages && page <= 5);
    return rows;
  }

  // ---------- pickup-location coordinates (deadhead planning) ----------
  _geoLoad() {
    if (this._geoCache) return this._geoCache;
    try { this._geoCache = JSON.parse(fs.readFileSync(this.geoCachePath, 'utf8')) || {}; }
    catch (e) { this._geoCache = {}; }
    return this._geoCache;
  }
  _geoSave() {
    if (!this.geoCachePath) return;
    try { fs.writeFileSync(this.geoCachePath, JSON.stringify(this._geoCache || {}, null, 1)); } catch (e) {}
  }
  _geoNorm(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim(); }
  // GPS-verified locations (written by the desktop's nm:gpsSaveLoc after a dispatcher confirms where
  // the trucks actually loaded/unloaded). Keyed by the SAME _geoNorm name. Highest-trust source.
  _gpsLocLoad() { if (!this.gpsLocPath) return {}; try { return JSON.parse(fs.readFileSync(this.gpsLocPath, 'utf8')) || {}; } catch (e) { return {}; } }

  // A NewMile geocode result is TRUSTWORTHY only if it resolved BELOW state level (has a city,
  // street, zip, or county). A bare {state, country} response is Google's "I only found the
  // state" centroid — using it would drop the pin in the middle of TX and invent a bogus route.
  // We reject those outright so the tool NEVER sends a truck to a guessed location.
  _geoQualityOK(g) { return !!this._geoTier(g); }
  // Tier a geocode result: 'street' (route/number/zip — a REAL pin) > 'city' (city/locality/county
  // only — Google's town centroid, usable but APPROXIMATE) > null (bare state → reject, never a pin).
  _geoTier(g) {
    if (!g) return null;
    const ac = g.address_components || g.components || {};
    if (ac.route || ac.street_number || ac.zip || ac.postal_code) return 'street';
    if (ac.city || ac.locality || ac.county) return 'city';
    return null;
  }
  // The location string often embeds the real place after "@" or "-"
  // (e.g. "Del Zotto @ Gladewater", "Hiland Dairy - Little Rock",
  //  "Winburn Milk Company @ 1101 Main St Sulphur Springs Tx"). Pull that tail out as a hint.
  _locHint(raw) {
    const s = String(raw || '').trim();
    let m = s.split(/\s+@\s+|\s+-\s+|@/).map(x => x.trim()).filter(Boolean);
    const tail = m.length > 1 ? m[m.length - 1] : '';
    return (tail && tail.length >= 3 && tail.toLowerCase() !== s.toLowerCase()) ? tail : '';
  }
  // Geocode one address string via NewMile (Google-backed); returns {lat,lng,addr} only when the
  // result passes the quality gate — otherwise null (caller treats as unresolved, never guesses).
  async _geocodeTrusted(addr) {
    if (!addr) return null;
    try {
      const g = await this.callTool('call_utility', { utility_name: 'geocode_address', args: { address: addr } });
      const tier = this._geoTier(g);
      if (!tier) return null;
      const lat = Number(g.lat != null ? g.lat : g.latitude);
      const lng = Number(g.lng != null ? g.lng : g.longitude);
      if (!isFinite(lat) || !isFinite(lng)) return null;
      // approx = Google only knew the town/county, not a street — UI flags it with ≈ so the
      // dispatcher never mistakes a centroid for the real plant address.
      return { lat, lng, addr: (g.formatted_address || '').trim() || null, approx: tier !== 'street' };
    } catch (e) { return null; }
  }

  // Resolve coords for each order's pickup (vendor_location) AND dropoff (delivery_location).
  // Order of trust: (1) the org's saved org_location book (real lat/lng + street address),
  // (2) persistent cache, (3) NewMile geocode of the FULL string, (4) geocode of the embedded
  // city/address hint. NEVER appends a fabricated ", TX" (locations cross state lines — Little
  // Rock is AR) and NEVER accepts a state-centroid result. Unresolved names get NO coords so the
  // UI shows "address not confirmed" instead of a wrong distance.
  async resolvePickupCoords(orders) {
    const out = {};   // 'p'/'d' + order_id -> {lat, lng, addr}
    const names = {}; // normalized location name -> {raw, ids:[key]}
    orders.forEach(o => {
      const p = this._geoNorm(o.vendor_location);
      if (p) (names[p] = names[p] || { raw: (o.vendor_location || '').trim(), ids: [] }).ids.push('p' + o.id);
      const d = this._geoNorm(o.delivery_location);
      if (d) (names[d] = names[d] || { raw: (o.delivery_location || '').trim(), ids: [] }).ids.push('d' + o.id);
    });
    const keys = Object.keys(names);
    if (!keys.length) return out;

    // 1) saved org locations (have lat/lng) — ALWAYS the signed-in user's own org. Most trusted.
    const locIdx = {};
    try {
      const orgId = this._myOrgId();
      const r = await this.callTool('list_resources', { resource_type: 'org_location', filters: { org_id: orgId, page_size: 500 } });
      ((r && (r.locations || r.results)) || []).forEach(l => {
        if (l.lat == null || l.lng == null) return;
        const addr = [l.address || l.address_1 || l.street_address || l.address_line_1 || '',
                      l.city || '', [l.state || '', l.zip || l.zip_code || ''].filter(Boolean).join(' ')]
                     .map(s => ('' + s).trim()).filter(Boolean).join(', ');
        locIdx[this._geoNorm(l.name)] = { lat: Number(l.lat), lng: Number(l.lng), addr: addr || null, src: 'org_location' };
      });
    } catch (e) { this.log('org_location pull skipped: ' + e.message); }
    const locKeys = Object.keys(locIdx);

    const cache = this._geoLoad();
    const gpsLoc = this._gpsLocLoad();   // GPS-verified (Samsara dwell) — beats everything below
    // Resolve the FULL day's distinct locations in one pass (each is then cached permanently, so the
    // cost doesn't repeat). GEO_CAP only guards a runaway. Audit buckets every name by how it resolved
    // so the UI can list which order locations still need a real address saved in NewMile.
    const GEO_CAP = 80;
    let geocoded = 0, dirty = false, unresolved = 0, approxN = 0, gpsN = 0;
    const audit = { saved: [], street: [], approx: [], missing: [], gps: [] };
    for (const k of keys) {
      const raw = names[k].raw;
      // (0) GPS-VERIFIED — where this order's trucks actually loaded/unloaded. Trumps geocode + book.
      const gv = gpsLoc[k];
      if (gv && gv.lat != null && gv.lng != null) {
        const hitG = { lat: Number(gv.lat), lng: Number(gv.lng), addr: gv.addr || null, src: 'gps', approx: false };
        names[k].ids.forEach(id => { out[id] = hitG; }); gpsN++; audit.gps.push(raw);
        continue;
      }
      // CANDIDATE names to match against the Locations tab (org_location). Dispatchers abbreviate
      // (RKH→R K HALL, QK→QUIKRETE, TXMAT→TEXAS MATERIALS). And Martin Marietta REBRANDED to Quikrete
      // for most plants (Juan 2026-06-17) — but a few stayed MM and the saved Location may use either
      // name, so when MM/Martin Marietta appears we try BOTH "Martin Marietta X" AND "Quikrete X".
      const base = ' ' + k + ' ';
      const cands = [k];
      if (/ RKH /.test(base)) cands.push(base.replace(/ RKH /g, ' R K HALL ').trim());
      if (/ QK /.test(base)) cands.push(base.replace(/ QK /g, ' QUIKRETE ').trim());
      if (/ TXMAT /.test(base)) cands.push(base.replace(/ TXMAT /g, ' TEXAS MATERIALS ').trim());
      if (/ (MM|MARTIN MARIETTA) /.test(base)) {
        cands.push(base.replace(/ MM /g, ' MARTIN MARIETTA ').trim());
        cands.push(base.replace(/ (MM|MARTIN MARIETTA) /g, ' QUIKRETE ').trim());
      }
      // (1) saved org_location book — MOST trusted (verified lat/lng + gate-code notes). Checked
      //     FIRST so adding a Location in NewMile instantly overrides any cached geocode guess.
      let hit = null, fromBook = false;
      for (let ci = 0; ci < cands.length && !hit; ci++) {
        const ck = cands[ci];
        if (locIdx[ck]) { hit = locIdx[ck]; break; }
        const fk = locKeys.find(lk => lk.length > 6 && (ck.includes(lk) || lk.includes(ck)));   // substring either way
        if (fk) { hit = locIdx[fk]; break; }
      }
      if (hit) { fromBook = true; audit.saved.push(raw); }
      // (2) persistent geocode cache. _v<3 = legacy entries (no quality tier) — distrust and
      //     re-resolve so previously-wrong / city-only pins get corrected and tier-flagged.
      if (!hit && cache[k] && cache[k]._v >= 3) hit = cache[k];
      // (3) live geocode — full string first (often carries the street address), then the embedded
      //     city/address hint after "@" / "-". Quality-gated; NEVER a fabricated ", TX" or a bare
      //     state centroid. Caps a runaway but covers a full day's distinct locations.
      if (!hit && geocoded < GEO_CAP) {
        hit = await this._geocodeTrusted(raw); geocoded++;
        if (!hit) { const h = this._locHint(raw); if (h && geocoded < GEO_CAP) { hit = await this._geocodeTrusted(h); geocoded++; } }
        if (hit) { cache[k] = Object.assign({ _v: 3 }, hit); dirty = true; }
      }
      if (hit) {
        names[k].ids.forEach(id => { out[id] = hit; });
        if (!fromBook) { if (hit.approx) { approxN++; audit.approx.push(raw); } else audit.street.push(raw); }
      } else { unresolved++; audit.missing.push(raw); this.log('location UNRESOLVED (no trusted coords): "' + raw + '"'); }
    }
    if (dirty) this._geoSave();
    this._lastLocAudit = audit;
    this.log('location coords: ' + Object.keys(out).length + ' resolved across ' + orders.length + ' orders ('
      + gpsN + ' GPS-verified, ' + audit.saved.length + ' saved-book, ' + audit.street.length + ' street, ' + approxN + ' approx, '
      + unresolved + ' unresolved; ' + geocoded + ' geocode calls)');
    return out;
  }

  // One call the UI uses per refresh. Pulls EVERYTHING the board needs to be in sync
  // with NewMile: yesterday + today + tomorrow orders, the full roster, rotation tickets
  // for the prior working day, and per-order assignments for today + tomorrow (so the
  // board shows what is already assigned and never double-assigns).
  async refreshAll(dateISO) {
    const yISO = this._shiftISO(dateISO, -1), tmISO = this._shiftISO(dateISO, +1);
    const prior = this._priorWorkingDay(dateISO);
    this.log('refreshAll ' + yISO + ' / ' + dateISO + ' / ' + tmISO + ' · rotation from ' + prior);

    const [oy, ot, otm] = await Promise.all([
      this.listOrdersAllPages(yISO), this.listOrdersAllPages(dateISO), this.listOrdersAllPages(tmISO)
    ]);

    // roster (paged) — page 1 tells us the count, then pull the rest IN PARALLEL (was serial = slow)
    let trucks = [];
    {
      const r1 = await this.listTrucks(1);
      trucks = (r1 && (r1.trucks || r1.results || r1.rows)) || [];
      const tp = Math.min((r1 && (r1.total_pages || r1.pages)) || 1, 20);
      if (tp > 1) {
        const pages = []; for (let p = 2; p <= tp; p++) pages.push(p);
        const more = await this._pool(pages, 6, (p) => this.listTrucks(p));
        more.forEach(r => { trucks = trucks.concat((r && (r.trucks || r.results || r.rows)) || []); });
      }
    }

    // rotation tickets (prior working day, all pages) — same parallel-after-first-page pattern
    let tickets = [];
    try {
      const first = await this.loadTickets(prior, 1);
      const tp = Math.min((first && (first.total_pages || first.pages)) || 1, 10);
      tickets = (first && (first.rows || first.results)) || [];
      if (tp > 1) {
        const pages = []; for (let pg = 2; pg <= tp; pg++) pages.push(pg);
        const more = await this._pool(pages, 6, (pg) => this.loadTickets(prior, pg));
        more.forEach(r => { tickets = tickets.concat((r && (r.rows || r.results)) || []); });
      }
    } catch (e) { this.log('rotation pull skipped: ' + e.message); }

    // per-order assignments for yesterday + today + tomorrow (concurrency 6) —
    // yesterday too, so day navigation shows REAL truck/fleet numbers, not zeros
    const targets = [].concat(oy.map(o => o.id), ot.map(o => o.id), otm.map(o => o.id));
    const lists = await this._pool(targets, 6, async (oid) => {
      const r = await this.orderAssignments(oid);
      return (r && (r.order_assignments || r.results || r.rows)) || [];
    });
    const assignments = {};
    targets.forEach((oid, i) => { assignments[oid] = lists[i] || []; });
    const asgCount = Object.values(assignments).reduce((n, a) => n + a.length, 0);

    // order DETAILS (driver/dispatch notes) for today + tomorrow — the list endpoint
    // doesn't return notes, only the single get does
    const noteTargets = [].concat(ot.map(o => o.id), otm.map(o => o.id));
    const detailRows = await this._pool(noteTargets, 6, async (oid) =>
      this.callTool('get_resource', { resource_type: 'order', id: oid }));
    const orderNotes = {}, orderMeta = {};
    // the LIST endpoint omits customer_name, truck_pay_rate, quantity_flex_allowed, payable_fees,
    // receivable_fees — only the single get returns them. Merge them onto the today/tomorrow orders
    // so the board shows LIVE pay / FSC / Flex / customer (verified: list rows lack these).
    const _byId = {}; ot.concat(otm).forEach(o => { _byId[o.id] = o; });
    const PRICE_KEYS = ['customer_name', 'truck_pay_rate', 'truck_pay_rate_measurement_unit', 'quantity_flex_allowed', 'quantity_measurement_unit', 'payable_fees', 'receivable_fees', 'purchase_order_id'];
    noteTargets.forEach((oid, i) => {
      const d = detailRows[i]; if (!d) return;
      const ord = _byId[oid]; if (ord) PRICE_KEYS.forEach(k => { if (d[k] != null) ord[k] = d[k]; });
      if (d.project_id) orderMeta[oid] = { project_id: d.project_id };   // for ⟲ crew-from-project
      const n = [];
      if (d.pick_up_notes) n.push({ l: 'Pickup notes (drivers)', t: d.pick_up_notes });
      if (d.drop_off_notes) n.push({ l: 'Dropoff notes (drivers)', t: d.drop_off_notes });
      if (d.pickup_location_notes) n.push({ l: 'Pickup location — gate codes etc.', t: d.pickup_location_notes });
      if (d.dropoff_location_notes) n.push({ l: 'Dropoff location — gate codes etc.', t: d.dropoff_location_notes });
      if (d.internal_memo) n.push({ l: 'Internal memo (not visible to drivers)', t: d.internal_memo });
      if (n.length) orderNotes[oid] = n;
    });
    this.log('order notes: ' + Object.keys(orderNotes).length + ' of ' + noteTargets.length + ' orders carry notes');

    // pickup + dropoff coordinates (deadhead planning + Google Maps route links)
    let pickupCoords = {}, dropCoords = {};
    try {
      const coords = await this.resolvePickupCoords([].concat(ot, otm));
      Object.keys(coords).forEach(k => {
        const id = k.slice(1);
        if (k[0] === 'p') pickupCoords[id] = coords[k]; else dropCoords[id] = coords[k];
      });
    } catch (e) { this.log('location coords skipped: ' + e.message); }

    this.log('refreshAll done: ' + oy.length + '/' + ot.length + '/' + otm.length + ' orders · ' + trucks.length + ' trucks · ' + tickets.length + ' tickets · ' + asgCount + ' live assignments');
    return { date: dateISO, priorDay: prior, orders: { y: oy, t: ot, tm: otm }, assignments, trucks, tickets, pickupCoords, dropCoords, orderNotes, orderMeta, locAudit: this._lastLocAudit || null };
  }

  // ---------- multi-day rotation ("días sin trabajar") ----------
  // Pull a window of load tickets (default 14 working/calendar days back from the day BEFORE
  // toISO) so the board can rank trucks by days-since-last-worked. LAZY by design — callers
  // invoke this only when opening the rotation view, NOT on every refresh (the window can run
  // many pages). Returns raw {truck_number, fleet, order_date} rows + the resolved window.
  async rotationHistory(toISO, days = 30) {
    const to = this._priorWorkingDay(toISO);                 // last completed working day
    const from = this._shiftISO(to, -(Math.max(1, days) - 1));
    let rows = [];
    // cap high enough that realistic windows (≤~60d ≈ 11k rows for a big org) pull COMPLETE —
    // a truncated pull would give stale last-worked dates and mislabel active trucks as idle.
    try {
      const first = await this.loadTicketsRange(from, to, 1);
      const tp = (first && (first.total_pages || first.pages)) || 1;
      rows = (first && (first.rows || first.results)) || [];
      for (let pg = 2; pg <= tp && pg <= 70; pg++) {
        const more = await this.loadTicketsRange(from, to, pg);
        rows = rows.concat((more && (more.rows || more.results)) || []);
      }
    } catch (e) { this.log('rotationHistory pull failed: ' + e.message); }
    this.log('rotationHistory ' + from + '..' + to + ' (' + days + 'd) → ' + rows.length + ' ticket rows');
    return { from, to, days, rows };
  }

  // ---------- ⟲ crew from project history ----------
  // Trucks that recently ran THIS project: recent orders by project_id → their live
  // assignments → unique trucks with last load_limit + how often they ran it.
  async projectTrucks(projectId, excludeOrderId) {
    if (!projectId) return { trucks: [] };
    const from = this._shiftISO(new Date().toISOString().slice(0, 10), -14);
    const to = new Date().toISOString().slice(0, 10);
    const r = await this.callTool('list_resources', {
      resource_type: 'order',
      filters: { project_id: projectId, order_date_from: from, order_date_to: to, sort: 'start_date', dir: 'desc', page_size: 25 }
    });
    const rows = ((r && (r.orders || r.results)) || []).filter(o => o.id !== excludeOrderId).slice(0, 6);
    // ONLY the most recent prior order that actually ran trucks — the dispatcher wants
    // last run's crew, not the whole 14-day history. Rows come sorted newest first.
    for (const o of rows) {
      const res = await this.orderAssignments(o.id);
      const asg = ((res || {}).order_assignments || (res || {}).results || res || []);
      const seen = {};
      (Array.isArray(asg) ? asg : []).forEach(a => {
        const num = (a.truck_number || '').trim(); if (!num) return;
        const k = num.toUpperCase();
        if (!seen[k]) seen[k] = { num: num, lastLL: a.load_limit, lastDate: o.start_date };
        else if (seen[k].lastLL == null && a.load_limit != null) seen[k].lastLL = a.load_limit;
      });
      const out = Object.values(seen);
      if (out.length) {
        this.log('crew: project ' + projectId + ' → ' + out.length + ' trucks from last run ' + (o.start_date || o.id));
        return { trucks: out, orders: 1, lastDate: o.start_date || '', lastDisp: o.dispatch_number || o.display_id || ('#' + o.id) };
      }
    }
    this.log('crew: project ' + projectId + ' → no prior order with trucks in 14 days');
    return { trucks: [], orders: 0 };
  }

  // ---------- 🚛 truck manager writes (verified: truck.on_call writeable, assignment delete exists) ----------
  async setOnCall(list) {   // [{truckId, onCall, num}] → per-truck results
    const out = [];
    for (const it of (list || [])) {
      try {
        await this.callTool('update_resource', { resource_type: 'truck', id: it.truckId, attrs: { on_call: !!it.onCall } });
        out.push({ num: it.num, ok: true });
        this.log('truck ' + it.num + ' → ' + (it.onCall ? 'ON' : 'OFF') + '-call');
      } catch (e) { out.push({ num: it.num, ok: false, error: e.message }); }
    }
    return out;
  }
  async deleteAssignments(ids) {
    const out = [];
    for (const id of (ids || [])) {
      try {
        await this.callTool('delete_resource', { resource_type: 'order_assignment', id: id });
        out.push({ id: id, ok: true });
      } catch (e) { out.push({ id: id, ok: false, error: e.message }); }
    }
    this.log('deleted ' + out.filter(x => x.ok).length + '/' + out.length + ' assignments');
    return out;
  }

  // ---------- 📇 directory (users / locations / haulers) ----------
  async pullDirectory() {
    const out = { users: [], locations: [], haulers: [] };
    // users (drivers + staff) — paged, carries phone_number / truck linkage
    let page = 1, totalPages = 1;
    do {
      const r = await this.callTool('list_resources', { resource_type: 'user', filters: { page, page_size: 100 } });
      out.users = out.users.concat((r && (r.users || r.results)) || []);
      totalPages = (r && (r.total_pages || r.pages)) || 1; page++;
    } while (page <= totalPages && page <= 15);
    try {
      const orgId = this._myOrgId();
      const l = await this.callTool('list_resources', { resource_type: 'org_location', filters: { org_id: orgId } });
      out.locations = (l && (l.locations || l.results)) || [];
    } catch (e) { this.log('directory locations skipped: ' + e.message); }
    try {
      const h = await this.callTool('list_resources', { resource_type: 'org', filters: { connection_type: 'hauler', page_size: 100 } });
      out.haulers = (h && (h.orgs || h.results)) || [];
    } catch (e) { this.log('directory haulers skipped: ' + e.message); }
    this.log('directory: ' + out.users.length + ' users · ' + out.locations.length + ' locations · ' + out.haulers.length + ' haulers');
    return out;
  }

  // ---------- truck number -> id resolution ----------
  _normNum(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, ' '); }
  async resolveTruckId(num) {
    const key = this._normNum(num);
    if (!key) return null;
    if (this._truckIdCache.has(key)) return this._truckIdCache.get(key);
    // search the roster for this truck number
    const r = await this.callTool('list_resources', { resource_type: 'truck', filters: { search: num, page_size: 50 } });
    const rows = (r && (r.trucks || r.rows || r.results)) || [];
    // 1) exact truck_number match wins. 2) else, if the typed number is CONTAINED in exactly
    // ONE truck's number, use it — this is the dispatcher's normal workflow: type the bare
    // number (e.g. "9483") and let it resolve to the single trucker that has it ("VT9483"),
    // prefix/suffix and all. Only refuse when it's AMBIGUOUS (multiple matches) or none, so we
    // never silently assign the wrong truck. dedupe candidates by id (search can repeat).
    let hit = rows.find(t => this._normNum(t.truck_number) === key);
    if (!hit) {
      const contains = rows.filter(t => this._normNum(t.truck_number).indexOf(key) >= 0);
      const ids = Array.from(new Set(contains.map(t => t.id)));
      if (ids.length === 1) hit = contains[0];
    }
    const id = hit ? hit.id : null;
    if (id != null) this._truckIdCache.set(key, id);   // don't cache misses — roster may refresh
    return id;
  }

  _rateBlock(useOrderDefault) {
    if (useOrderDefault) return { rate_source: 'order_default' };
    return {
      rate_source: 'contracted_rate',
      driver_pay_rate_source: 'custom',
      driver_pay_rate: 0,
      driver_pay_rate_measurement_unit_id: 1   // 1 = Ton
    };
  }

  // ---------- PUSH (diff-based; confirmed per-order in the UI before this runs) ----------
  // assignments: [{ truck, loads, sequence }]  (loads === null means "open" / no limit)
  // Diff vs live NewMile state:
  //   - truck NOT on the order            → create (+confirm)
  //   - truck ON the order, loads changed → update load_limit only
  //   - truck ON the order, unchanged     → never touched
  // Returns { created:[ids], updated:[{truck,from,to}], skipped:[{truck,reason}], unresolved:[truck], confirmed:Bool }
  // finalize: when TRUE (default, preserves desktop behaviour) created assignments are confirmed
  // (draft -> pending; triggers the driver auto-offer). When FALSE the assignments are left in
  // DRAFT so the dispatcher can review and finalize them later — nothing is offered to drivers.
  async pushOrderBatch(orderId, assignments, useOrderDefault, removed, finalize) {
    const doFinalize = (finalize === undefined) ? true : !!finalize;
    const out = { order_id: orderId, created: [], updated: [], skipped: [], unresolved: [], confirmed: false, draft: [], reordered: [], removed: [], finalize: doFinalize };

    // 1) live state — what's already on the order
    let existing = [];
    let readOk = false;   // did we actually read NewMile's current rows? (gate the "deleted externally" rule)
    try {
      const ex = await this.orderAssignments(orderId);
      existing = (ex && (ex.order_assignments || ex.results || ex.rows)) || [];
      readOk = true;
    } catch (e) { this.log('could not read existing assignments for ' + orderId + ': ' + e.message); }
    // index existing rows by their assignment id (aid) AND keep them list-addressable so we can
    // bind each board chip to ONE specific NewMile row — never collapse two sequences of the
    // same truck into one (the bug that duplicated / mis-sequenced loads).
    const rowById = {};
    existing.forEach(a => { if (a.id != null) rowById[a.id] = a; });
    const matchedRowIds = new Set();
    const _exTid = (r) => (r.truck_id != null ? r.truck_id : (r.truck && r.truck.id != null ? r.truck.id : null));
    const sameTruck = (r, a) => {
      if (a.truck_id != null && _exTid(r) != null) return Number(_exTid(r)) === Number(a.truck_id);
      return this._normNum(r.truck_number) === this._normNum(a.truck);
    };

    // PASS 1 — chips that carry an aid (came from NewMile) bind to that EXACT row. This pins
    // each sequence to its own assignment, so seq-1 stays seq-1 and seq-2 stays seq-2.
    for (const a of assignments) {
      if (a.aid != null && rowById[a.aid] && !matchedRowIds.has(a.aid)) {
        a._row = rowById[a.aid]; matchedRowIds.add(a.aid);
      }
    }
    // PASS 2 — chips with no usable aid bind to an as-yet-unmatched existing row of the SAME
    // truck (covers re-pushing a chip whose row now exists, so we never create a duplicate).
    // Trucks with NO free existing row fall through to create (a genuinely new sequence).
    for (const a of assignments) {
      if (a._row || !(a.truck || '').trim()) continue;
      const cand = existing.find(r => r.id != null && !matchedRowIds.has(r.id) && sameTruck(r, a));
      if (cand) { a._row = cand; matchedRowIds.add(cand.id); }
    }

    // 2) diff: update bound rows (load_limit only — NEVER ordinal/sequence); create the rest.
    const toCreate = [];        // {truck, truck_id, loads, sequence}
    for (const a of assignments) {
      const num = (a.truck || '').trim();
      if (!num) continue;
      const ex = a._row;
      if (ex) {
        const want = (typeof a.loads === 'number' && a.loads > 0) ? a.loads : null;
        const have = (ex.load_limit == null) ? null : ex.load_limit;
        if (want !== have) {   // covers set, change AND clear (want null = open / remove the limit)
          try {
            await this.callTool('update_resource', { resource_type: 'order_assignment', id: ex.id, attrs: { load_limit: want } });
            out.updated.push({ truck: num, from: (have == null ? 'open' : have), to: (want == null ? 'open' : want) });
            this.log('order ' + orderId + ': ' + num + ' load_limit ' + (have == null ? 'open' : have) + ' → ' + (want == null ? 'open' : want));
          } catch (e) { out.skipped.push({ truck: num, reason: 'update failed: ' + e.message }); }
        } else {
          out.skipped.push({ truck: num, reason: 'already on order — unchanged' });
        }
        continue;
      }
      // RESURRECTION GUARD: this chip carries an aid (it came from a real NewMile row) but matched
      // NO existing row now → that assignment was DELETED in NewMile (by the dispatcher or anyone).
      // Respect it — never recreate it. Only genuinely-new chips (added on the board, no aid) create.
      // This is what stopped trucks reappearing on every sync and duplicating.
      if (a.aid != null && readOk) {
        out.skipped.push({ truck: num, reason: 'removed in NewMile — not recreated' });
        this.log('order ' + orderId + ': ' + num + ' (aid ' + a.aid + ') gone in NewMile — NOT recreated');
        continue;
      }
      // honor an explicit truck_id (the dispatcher picked among same-numbered trucks); else resolve
      const tid = (a.truck_id != null ? a.truck_id : await this.resolveTruckId(num));
      if (!tid) { out.unresolved.push(num); continue; }
      // a.rate: '' = auto (contracted + auto-fallback), 'contracted' / 'order_default' = forced by dispatcher
      toCreate.push({ truck: num, truck_id: tid, loads: a.loads, sequence: a.sequence || 1, rateForce: (a.rate || '') });
    }

    // 2b) removals — trucks the dispatcher took OFF the order on the board/planner.
    // The board only sends aids it actually showed and the user explicitly removed,
    // and the push modal previews them. Safety: never delete once loads were hauled.
    for (const rm of (removed || [])) {
      const live = existing.find(x => x.id === rm.aid);
      if (!live) { out.skipped.push({ truck: rm.truck, reason: 'remove: no longer on the order' }); continue; }
      if ((live.load_count || 0) > 0) { out.skipped.push({ truck: rm.truck, reason: 'remove blocked: ' + live.load_count + ' load(s) already hauled' }); continue; }
      try {
        await this.callTool('delete_resource', { resource_type: 'order_assignment', id: rm.aid });
        out.removed.push(rm.truck);
        this.log('order ' + orderId + ': removed ' + rm.truck + ' (assignment ' + rm.aid + ')');
      } catch (e) { out.skipped.push({ truck: rm.truck, reason: 'remove failed: ' + e.message }); }
    }

    if (!toCreate.length) return out;

    // 3) bulk_create_assignments (utility). List order = ordinal, so create seq-1 before seq-2.
    toCreate.sort((x, y) => (x.sequence - y.sequence));
    const CONTRACTED = {
      rate_source: 'contracted_rate',
      driver_pay_rate_source: 'custom',
      driver_pay_rate: 0,
      driver_pay_rate_measurement_unit_id: 1   // 1 = Ton
    };
    const ORDER_DEFAULT = { rate_source: 'order_default' };
    // Standing rule (Juan): contracted_rate for ALL trucks; only trucks whose owner has no
    // subhauler contract with the order's hauler fall back to order_default — exactly what the
    // NewMile UI does (e.g. Indus tri-axles, EYK/Watercrest). useOrderDefault forces the whole
    // order to order_default from the start.
    // per-truck: a forced rate (dispatcher picked it on the chip) wins; otherwise follow the
    // order-level default, otherwise contracted (with the auto-fallback below for auto trucks).
    toCreate.forEach(t => {
      t.rate = (t.rateForce === 'order_default') ? ORDER_DEFAULT
             : (t.rateForce === 'contracted') ? CONTRACTED
             : (useOrderDefault ? ORDER_DEFAULT : CONTRACTED);
    });
    const buildObjs = () => toCreate.map(t => {
      const o = Object.assign({ order_id: orderId, truck_id: t.truck_id }, t.rate);
      if (typeof t.loads === 'number' && t.loads > 0) o.load_limit = t.loads;   // omit when "open"
      return o;
    });
    const tryCreate = () => this.callTool('call_utility', {
      utility_name: 'bulk_create_assignments', args: { assignments: buildObjs() }
    });
    let res = await tryCreate();
    // bulk_create is atomic: if ANY truck's contracted_rate is rejected (no contract for that
    // owner+hauler) the WHOLE batch fails and errors[].index/truck_id say which. Flip only the
    // rejected trucks to order_default and retry once — trucks that DO have a contract keep
    // contracted_rate.
    // only AUTO trucks (no forced rate) currently on contracted_rate participate in the flip —
    // a dispatcher who explicitly forced 'contracted' keeps it (the real error is surfaced instead).
    if (res && res.error) {
      const errs = res.errors || [];
      const badIdx = new Set(errs.map(e => e.index).filter(i => typeof i === 'number'));
      const badIds = new Set(errs.map(e => e.truck_id).filter(Boolean));
      const autoContracted = toCreate.filter(t => !t.rateForce && t.rate === CONTRACTED);
      let flipped = 0;
      toCreate.forEach((t, i) => {
        if (t.rateForce || t.rate !== CONTRACTED) return;
        if (badIdx.has(i) || badIds.has(t.truck_id)) { t.rate = ORDER_DEFAULT; flipped++; }
      });
      if (!flipped && autoContracted.length) { autoContracted.forEach(t => { t.rate = ORDER_DEFAULT; }); flipped = autoContracted.length; }   // couldn't pinpoint — flip all auto trucks
      if (flipped) {
        this.log('push: contracted_rate rejected — retrying ' + flipped + ' auto truck(s) with order_default');
        res = await tryCreate();
      }
    }
    if (res && res.error) {
      // bulk_create is ATOMIC: one bad truck (e.g. no rate contract) sinks the WHOLE batch and
      // NOTHING gets added. Rather than drop everyone, create each truck on its OWN — the good ones
      // still go in, and only the real offender(s) fail, with the reason surfaced per-truck.
      const firstMsg = (res.errors && res.errors[0] && res.errors[0].error) || res.error;
      this.log('push: batch create failed (' + firstMsg + ') — adding ' + toCreate.length + ' truck(s) one by one so the good ones still enter');
      const oneObj = (t, rate) => { const o = Object.assign({ order_id: orderId, truck_id: t.truck_id }, rate); if (typeof t.loads === 'number' && t.loads > 0) o.load_limit = t.loads; return o; };
      const createOne = async (t, rate) => {
        const r = await this.callTool('call_utility', { utility_name: 'bulk_create_assignments', args: { assignments: [oneObj(t, rate)] } });
        const rows = (r && (r.assignments || r.created || r.results)) || [];
        return { ok: !(r && r.error) && rows.length > 0, row: rows[0] || null, err: (r && r.errors && r.errors[0] && r.errors[0].error) || (r && r.error) || null };
      };
      for (const t of toCreate) {
        let attempt = await createOne(t, t.rate);
        // auto truck on contracted_rate that got rejected → one fallback to order_default (same as the batch flip)
        if (!attempt.ok && !t.rateForce && t.rate === CONTRACTED) attempt = await createOne(t, ORDER_DEFAULT);
        if (attempt.ok) { out.created.push(attempt.row.id); t.assignment_id = attempt.row.id; }
        else { out.skipped.push({ truck: t.truck, reason: attempt.err || 'create rejected' }); out.error = out.error || firstMsg; this.log('order ' + orderId + ': ' + t.truck + ' could NOT be added — ' + (attempt.err || firstMsg)); }
      }
    } else {
      const createdRows = (res && (res.assignments || res.created || res.results)) || [];
      const createdIds = createdRows.map(a => a.id).filter(Boolean);
      out.created = createdIds.length ? createdIds : (Array.isArray(res) ? res.map(a => a.id).filter(Boolean) : []);
      // map created ids back to trucks (by order) for reorder
      toCreate.forEach((t, i) => { t.assignment_id = createdRows[i] ? createdRows[i].id : out.created[i]; });
    }

    // 4) confirm — ONLY when finalizing. confirm_assignments is the finalize (draft -> pending)
    // and triggers the driver auto-offer. When syncing as draft we deliberately skip it so the
    // dispatcher reviews first; the created rows stay in draft and finalizeOrder() confirms later.
    if (out.created.length && doFinalize) {
      await this.callTool('call_utility', {
        utility_name: 'confirm_assignments',
        args: { order_assignment_ids: out.created }
      });
      out.confirmed = true;
    } else if (out.created.length) {
      out.draft = out.created.slice();   // synced as draft — awaiting finalize
      this.log('order ' + orderId + ': synced ' + out.created.length + ' assignment(s) as DRAFT (not finalized)');
    }

    // 5) sequences: DO NOT TOUCH. (Standing rule from Juan, 2026-06-14.)
    // We used to call reorder_assignments to push a new "seq-2" assignment to the right ordinal,
    // but that utility lists ALL of a truck's assignments across every order and rewrites their
    // order — which shuffled live sequences (it moved a real seq-2 onto seq-1 on an order).
    // bulk_create already appends each new assignment AFTER the truck's existing ones, so the
    // natural creation order IS the correct sequence. We never reorder existing rows again.
    out.reordered = [];

    return out;
  }

  // Finalize an order that was synced as DRAFT: confirm every draft assignment on it
  // (draft -> pending; triggers the driver auto-offer). Idempotent — already-pending rows are
  // left alone. Returns { order_id, confirmed:[ids], already:n, none:Bool }.
  async finalizeOrder(orderId) {
    const out = { order_id: orderId, confirmed: [], already: 0, none: false };
    let rows = [];
    try {
      const ex = await this.orderAssignments(orderId);
      rows = (ex && (ex.order_assignments || ex.results || ex.rows)) || [];
    } catch (e) { out.error = 'could not read assignments: ' + e.message; return out; }
    // NewMile's lifecycle field is `assignment_status` (enum: draft, pending, active,
    // order_assignment_completed, ...). Only 'draft' rows are unfinalized. (verified 2026-06-13)
    const statusOf = (r) => String(r.assignment_status || r.status || r.state || '').toLowerCase();
    const draftIds = rows.filter(r => statusOf(r) === 'draft').map(r => r.id).filter(Boolean);
    out.already = rows.length - draftIds.length;
    if (!draftIds.length) { out.none = true; return out; }   // nothing in draft to finalize
    try {
      await this.callTool('call_utility', { utility_name: 'confirm_assignments', args: { order_assignment_ids: draftIds } });
      out.confirmed = draftIds;
      this.log('finalized order ' + orderId + ': confirmed ' + draftIds.length + ' draft assignment(s)');
    } catch (e) { out.error = 'confirm failed: ' + e.message; }
    return out;
  }

  // Edit an order's ordered quantity and/or Flex straight in NewMile. Both quantity_requested and
  // quantity_flex_allowed are writeable (verified 2026-06-14). Applies immediately (not a draft).
  async updateOrderQuantity(orderId, quantity, flex) {
    const attrs = {};
    if (quantity != null && isFinite(Number(quantity))) attrs.quantity_requested = Number(quantity);
    if (flex != null && isFinite(Number(flex))) attrs.quantity_flex_allowed = Number(flex);
    if (!Object.keys(attrs).length) return { error: 'nothing to update' };
    try {
      const r = await this.callTool('update_resource', { resource_type: 'order', id: orderId, attrs });
      this.log('order ' + orderId + ' quantity_requested=' + attrs.quantity_requested + ' flex=' + attrs.quantity_flex_allowed);
      return { ok: true, result: r };
    } catch (e) { return { error: e.message || String(e) }; }
  }

  // Org-wide order search for the CS price editor: pull all orders in a date window (paged) and
  // return the full rows (incl. payable_fees / truck_pay_rate) so the UI can filter by customer /
  // project / PO client-side and preview FSC. Capped to keep it snappy.
  async searchOrdersWindow(fromISO, toISO, cap) {
    let rows = [], page = 1, totalPages = 1;
    do {
      const r = await this.callTool('list_resources', {
        resource_type: 'order',
        filters: { order_date_from: fromISO, order_date_to: toISO, page: page, page_size: 100 }
      });
      rows = rows.concat((r && (r.orders || r.results || r.rows)) || []);
      totalPages = (r && (r.total_pages || r.pages)) || 1; page++;
    } while (page <= totalPages && page <= 12 && rows.length < (cap || 800));
    // list rows already carry truck_pay_rate, customer_name, project_name, reference_number,
    // quantity_*, payable_fees/receivable_fees (verified live) — no per-order get needed.
    return rows;
  }

  // Full order details for a set of ids (get_resource is the ONLY source of customer_name,
  // truck_pay_rate, payable_fees, quantity_flex_allowed — the list endpoint omits them). Pooled.
  async getOrdersFull(ids, limit) {
    const list = (ids || []).slice(0, limit || 120);
    const rows = await this._pool(list, 6, async (id) => {
      const g = await this.callTool('get_resource', { resource_type: 'order', id });
      return (g && (g.order || g.result || g)) || null;
    });
    return rows;
  }

  // Write fees onto an order (FSC etc.). Pass the COMPLETE payable/receivable arrays — NewMile
  // REMOVES any existing fee not included. Each fee: {fee_type_id, rate, measurement_unit_id [, id]}.
  async updateOrderFees(orderId, payableFees, receivableFees) {
    const attrs = {};
    if (Array.isArray(payableFees)) attrs.payable_fees = payableFees;
    if (Array.isArray(receivableFees)) attrs.receivable_fees = receivableFees;
    if (!Object.keys(attrs).length) return { error: 'no fees to update' };
    try {
      const r = await this.callTool('update_resource', { resource_type: 'order', id: orderId, attrs });
      this.log('order ' + orderId + ' fees updated (' + (attrs.payable_fees ? attrs.payable_fees.length + ' payable' : '') + ')');
      return { ok: true, result: r };
    } catch (e) { return { error: e.message || String(e) }; }
  }

  // RE-ORDER (clone) an order: create a NEW order under the SAME purchase_order (which carries the
  // customer / material / pickup / dropoff / project), copying rate + flex + FSC, changing ONLY the
  // quantity and the needed date. customer/locations are NOT writeable at create — they come from
  // the PO, so cloning under purchase_order_id preserves them. (verified 2026-06-15)
  async reorderOrder(orderId, opts) {
    opts = opts || {};
    let o;
    try { const g = await this.callTool('get_resource', { resource_type: 'order', id: orderId }); o = (g && (g.order || g.result || g)) || null; }
    catch (e) { return { error: 'could not read the order: ' + e.message }; }
    if (!o) return { error: 'order not found' };
    if (o.purchase_order_id == null || o.hauler_id == null) return { error: 'esta orden no tiene PO/hauler — no se puede re-ordenar' };
    // new date: keep the original time-of-day + tz, swap the calendar date
    const swapDate = (orig, dISO) => {
      if (!dISO) return orig || null;
      const t = (orig && orig.indexOf('T') >= 0) ? orig.slice(orig.indexOf('T')) : 'T04:00:00-05:00';
      return dISO + t;
    };
    const unitId = o.truck_pay_rate_measurement_unit_id || ({ ton: 1, yard: 2, load: 3, hour: 4 }[String(o.quantity_measurement_unit || 'ton').toLowerCase()] || 1);
    const attrs = {
      purchase_order_id: o.purchase_order_id, hauler_id: o.hauler_id,
      quantity_requested: (opts.quantity != null && isFinite(Number(opts.quantity))) ? Number(opts.quantity) : Number(o.quantity_requested) || 0,
      truck_pay_rate: o.truck_pay_rate, truck_pay_rate_measurement_unit_id: unitId,
      start_date: swapDate(o.start_date, opts.dateISO), end_date: swapDate(o.end_date, opts.dateISO),
      reference_number: o.reference_number, priority: o.priority || 'medium',
      minimum_truck_count: o.minimum_truck_count || 0, maximum_truck_count: o.maximum_truck_count || 0, planned_truck_count: o.planned_truck_count || 0,
      indefinite_quantity: !!o.indefinite_quantity, preload_eligible: !!o.preload_eligible
    };
    if (o.quantity_flex_allowed != null) attrs.quantity_flex_allowed = Number(o.quantity_flex_allowed);
    let res;
    try { res = await this.callTool('create_resource', { resource_type: 'order', attrs }); }
    catch (e) { return { error: 'create failed: ' + e.message }; }
    if (res && res.error) return { error: res.error };
    const newId = res && (res.id || (res.order && res.order.id) || (res.result && res.result.id) || (res.data && res.data.id));
    if (!newId) return { error: 'NewMile no devolvió el id de la orden nueva' };
    // copy the FSC / fees (not writeable at create) onto the new order
    const fees = (o.payable_fees || []).map(f => ({ fee_type_id: f.fee_type_id, rate: Number(f.rate), measurement_unit_id: f.measurement_unit_id }));
    let feesCopied = false;
    if (fees.length) { try { const fr = await this.updateOrderFees(newId, fees); feesCopied = !fr.error; } catch (e) {} }
    this.log('reorder: cloned order ' + orderId + ' → ' + newId + ' (PO ' + o.purchase_order_id + ', qty ' + attrs.quantity_requested + ', date ' + (opts.dateISO || 'same') + ')');
    return { ok: true, newId, ref: o.reference_number, customer: o.customer_name, feesCopied, fees: fees.length };
  }

  // ---------- end-of-sync sequence reconciliation ----------
  // NewMile can't set `ordinal` at create — a freshly created assignment is just appended to the
  // truck's queue, so its per-truck order can drift from what the dispatcher laid out in the tool.
  // After a sync we make NewMile match the tool: for each truck, reorder ITS assignments so the
  // ones the tool manages follow the tool's intended sequence. Assignments the tool doesn't know
  // about (other days, in-progress, already hauled) are PINNED in their exact current slots — we
  // only permute the managed ones among their own positions, and we always send the truck's
  // COMPLETE id list. This is the safe replacement for the old blind "append it last" reorder.
  //
  // intentByTruck: { [truck_id]: { [order_id]: sequence } }  (sequence = the truck's intended
  //   order position for that order; lower = earlier).
  async reconcileSequences(intentByTruck) {
    const out = { checked: 0, reordered: [], skipped: 0, failed: [] };
    const entries = Object.entries(intentByTruck || {});
    const statusOf = (r) => String(r.assignment_status || r.status || r.state || '').toLowerCase();
    // can be INCLUDED in a reorder_assignments call — NewMile rejects the WHOLE call if any id is
    // not in one of these statuses, so completed/hauled rows must be left out of the list entirely.
    const REORDERABLE = ['draft', 'pending', 'missing_driver', 'pending_removal', 'active'];
    const reorderable = (r) => (r.load_count || 0) === 0 && REORDERABLE.indexOf(statusOf(r)) >= 0;
    // safe to actually REPOSITION (don't shuffle an active/in-progress truck — only fresh rows)
    const movable = (r) => (r.load_count || 0) === 0 && (statusOf(r) === 'draft' || statusOf(r) === 'pending');
    const oidOf = (r) => (r.order_id != null ? r.order_id : (r.order && r.order.id));
    // only trucks the tool put on 2+ orders can have a sequence to fix
    const candidates = entries.filter(([, orderSeq]) => orderSeq && Object.keys(orderSeq).length >= 2);
    out.skipped += entries.length - candidates.length;
    // PHASE 1 — list each candidate truck's CURRENT assignments IN PARALLEL. CRITICAL: filter by
    // assignment_status. A heavy truck can carry 800+ COMPLETED assignments; an unfiltered
    // page_size:100 list returned old/completed rows and BURIED the 2 current ones, so reconcile
    // never found them and silently did nothing (the "sequence won't change on push" bug). We only
    // ever reposition draft/pending and keep active in place, so fetch exactly those statuses —
    // that returns a handful of rows, never the whole history. (assignment_status takes ONE value
    // per call — array filters error — so fetch each and merge.)
    // MUST match REORDERABLE above: fetching fewer statuses than we reorder means a truck with a
    // missing_driver/pending_removal row gets an INCOMPLETE id list (or is silently skipped).
    const REO_STATUSES = ['pending', 'draft', 'active', 'missing_driver', 'pending_removal'];
    const listed = await this._pool(candidates, 6, async ([tidStr, orderSeq]) => {
      const tid = Number(tidStr);
      if (!tid) return null;
      try {
        let rows = [];
        for (const st of REO_STATUSES) {
          const r = await this.callTool('list_resources', { resource_type: 'order_assignment', filters: { truck_id: tid, assignment_status: st, page_size: 100 } });
          rows = rows.concat((r && (r.order_assignments || r.results || r.rows)) || []);
        }
        return { tid, orderSeq, rows };
      } catch (e) { out.failed.push({ truck_id: tid, reason: e.message }); return null; }
    });
    // PHASE 2 — decide the desired order locally (no API), collect only the trucks that need a change
    const reorders = [];
    for (const item of listed) {
      if (!item) continue;
      const { tid, orderSeq, rows } = item;
      if (rows.length < 2) { out.skipped++; continue; }
      // ONLY reorderable rows go in the list — a busy truck can carry dozens of completed loads
      // and including even one makes reorder_assignments reject the whole call.
      const ro = rows.filter(reorderable).sort((a, b) => ((a.ordinal || 0) - (b.ordinal || 0)));
      if (ro.length < 2) { out.skipped++; continue; }
      const managedIdx = [];
      ro.forEach((r, i) => { if (orderSeq[oidOf(r)] != null && movable(r)) managedIdx.push(i); });
      if (managedIdx.length < 2) { out.skipped++; continue; }   // need ≥2 managed to define an order
      const managedSorted = managedIdx.map(i => ro[i]).sort((a, b) => {
        const d = (orderSeq[oidOf(a)] - orderSeq[oidOf(b)]);
        return d || ((a.ordinal || 0) - (b.ordinal || 0));
      });
      const result = ro.slice();
      managedIdx.forEach((slot, k) => { result[slot] = managedSorted[k]; });
      const newIds = result.map(r => r.id);
      const curIds = ro.map(r => r.id);
      out.checked++;
      if (newIds.join(',') === curIds.join(',')) { out.skipped++; continue; }   // already correct — no API call
      reorders.push({ tid, newIds, curIds });
    }
    // PHASE 3 — apply the reorders IN PARALLEL
    await this._pool(reorders, 6, async (rq) => {
      try {
        await this.callTool('call_utility', { utility_name: 'reorder_assignments', args: { truck_id: rq.tid, assignment_ids: rq.newIds } });
        out.reordered.push(rq.tid);
        this.log('reconcile: truck ' + rq.tid + ' resequenced to match the tool (' + rq.curIds.join(',') + ' → ' + rq.newIds.join(',') + ')');
      } catch (e) { out.failed.push({ truck_id: rq.tid, reason: e.message }); }
    });
    return out;
  }
}

module.exports = { NewMileClient };
