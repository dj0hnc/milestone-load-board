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

  // Resolve coords for each order's pickup (vendor_location) AND dropoff
  // (delivery_location): org_location names first, then the persistent cache, then
  // NewMile's geocode_address utility (capped per refresh).
  async resolvePickupCoords(orders) {
    const out = {};   // 'p'/'d' + order_id -> {lat, lng}
    const names = {}; // normalized location name -> {raw, ids:[key]}
    orders.forEach(o => {
      const p = this._geoNorm(o.vendor_location);
      if (p) (names[p] = names[p] || { raw: (o.vendor_location || '').trim(), ids: [] }).ids.push('p' + o.id);
      const d = this._geoNorm(o.delivery_location);
      if (d) (names[d] = names[d] || { raw: (o.delivery_location || '').trim(), ids: [] }).ids.push('d' + o.id);
    });
    const keys = Object.keys(names);
    if (!keys.length) return out;

    // 1) saved org locations (have lat/lng) — ALWAYS the signed-in user's own org
    const locIdx = {};
    try {
      const orgId = this._myOrgId();
      const r = await this.callTool('list_resources', { resource_type: 'org_location', filters: { org_id: orgId } });
      ((r && (r.locations || r.results)) || []).forEach(l => {
        if (l.lat == null || l.lng == null) return;
        // real street address from NewMile — Google links use it instead of just the name
        const addr = [l.address || l.address_1 || l.street_address || l.address_line_1 || '',
                      l.city || '', [l.state || '', l.zip || l.zip_code || ''].filter(Boolean).join(' ')]
                     .map(s => ('' + s).trim()).filter(Boolean).join(', ');
        locIdx[this._geoNorm(l.name)] = { lat: l.lat, lng: l.lng, addr: addr || null };
      });
    } catch (e) { this.log('org_location pull skipped: ' + e.message); }
    const locKeys = Object.keys(locIdx);

    const cache = this._geoLoad();
    let geocoded = 0, dirty = false;
    for (const k of keys) {
      let hit = locIdx[k] || cache[k] || null;
      if (!hit) { // fuzzy: org location name contained in pickup name or vice versa
        const fk = locKeys.find(lk => lk.length > 6 && (k.includes(lk) || lk.includes(k)));
        if (fk) hit = locIdx[fk];
      }
      if (!hit && geocoded < 15) { // geocode fallback, capped per refresh, cached forever
        try {
          const g = await this.callTool('call_utility', { utility_name: 'geocode_address', args: { address: names[k].raw + ', TX' } });
          const lat = g && (g.lat != null ? g.lat : (g.latitude != null ? g.latitude : null));
          const lng = g && (g.lng != null ? g.lng : (g.longitude != null ? g.longitude : null));
          if (lat != null && lng != null) { hit = { lat, lng }; cache[k] = hit; dirty = true; }
          geocoded++;
        } catch (e) { geocoded++; }
      }
      if (hit) names[k].ids.forEach(id => { out[id] = hit; });
    }
    if (dirty) this._geoSave();
    this.log('location coords: ' + Object.keys(out).length + ' pickup/dropoff points resolved across ' + orders.length + ' orders (' + geocoded + ' geocoded this run)');
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

    // roster (paged)
    let trucks = [], page = 1, totalPages = 1;
    do {
      const r = await this.listTrucks(page);
      trucks = trucks.concat((r && (r.trucks || r.results || r.rows)) || []);
      totalPages = (r && (r.total_pages || r.pages)) || 1; page++;
    } while (page <= totalPages && page <= 20);

    // rotation tickets (prior working day, all pages)
    let tickets = [];
    try {
      const first = await this.loadTickets(prior, 1);
      let tp = (first && (first.total_pages || first.pages)) || 1;
      tickets = (first && (first.rows || first.results)) || [];
      for (let pg = 2; pg <= tp && pg <= 10; pg++) {
        const more = await this.loadTickets(prior, pg);
        tickets = tickets.concat((more && (more.rows || more.results)) || []);
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
    noteTargets.forEach((oid, i) => {
      const d = detailRows[i]; if (!d) return;
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
    return { date: dateISO, priorDay: prior, orders: { y: oy, t: ot, tm: otm }, assignments, trucks, tickets, pickupCoords, dropCoords, orderNotes, orderMeta };
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
  async pushOrderBatch(orderId, assignments, useOrderDefault, removed) {
    const out = { order_id: orderId, created: [], updated: [], skipped: [], unresolved: [], confirmed: false, reordered: [], removed: [] };

    // 1) live state — what's already on the order
    let existing = [];
    try {
      const ex = await this.orderAssignments(orderId);
      existing = (ex && (ex.order_assignments || ex.results || ex.rows)) || [];
    } catch (e) { this.log('could not read existing assignments for ' + orderId + ': ' + e.message); }
    const existingByNum = {};
    existing.forEach(a => { existingByNum[this._normNum(a.truck_number)] = a; });

    // 2) diff: updates for existing trucks, creates for new ones
    const rate = this._rateBlock(useOrderDefault);
    const toCreate = [];        // {truck, truck_id, loads, sequence}
    for (const a of assignments) {
      const num = (a.truck || '').trim();
      if (!num) continue;
      const ex = existingByNum[this._normNum(num)];
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
      const tid = await this.resolveTruckId(num);
      if (!tid) { out.unresolved.push(num); continue; }
      toCreate.push({ truck: num, truck_id: tid, loads: a.loads, sequence: a.sequence || 1 });
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
    const objs = toCreate.map(t => {
      const o = Object.assign({ order_id: orderId, truck_id: t.truck_id }, rate);
      if (typeof t.loads === 'number' && t.loads > 0) o.load_limit = t.loads;   // omit when "open"
      return o;
    });
    const res = await this.callTool('call_utility', {
      utility_name: 'bulk_create_assignments',
      args: { assignments: objs }
    });
    const createdRows = (res && (res.assignments || res.created || res.results)) || [];
    const createdIds = createdRows.map(a => a.id).filter(Boolean);
    out.created = createdIds.length ? createdIds : (Array.isArray(res) ? res.map(a => a.id).filter(Boolean) : []);
    // map created ids back to trucks (by order) for reorder
    toCreate.forEach((t, i) => { t.assignment_id = createdRows[i] ? createdRows[i].id : out.created[i]; });

    // 4) confirm (this IS the finalize — draft -> pending; triggers auto-offer flow)
    if (out.created.length) {
      await this.callTool('call_utility', {
        utility_name: 'confirm_assignments',
        args: { order_assignment_ids: out.created }
      });
      out.confirmed = true;
    }

    // 5) seq-2 (blue) trucks -> reorder so the new assignment sits at the intended ordinal. Best-effort.
    const seq2 = toCreate.filter(t => (t.sequence || 1) > 1 && t.assignment_id);
    for (const t of seq2) {
      try {
        const all = await this.callTool('list_resources', { resource_type: 'order_assignment', filters: { truck_id: t.truck_id, page_size: 100 } });
        const rows = (all && (all.order_assignments || all.results || all.rows)) || [];
        const others = rows.filter(r => r.id !== t.assignment_id).map(r => r.id);
        const ordered = others.concat([t.assignment_id]);   // put the new (seq-2) assignment last
        if (ordered.length > 1) {
          await this.callTool('call_utility', { utility_name: 'reorder_assignments', args: { truck_id: t.truck_id, assignment_ids: ordered } });
          out.reordered.push(t.truck);
        }
      } catch (e) { this.log('reorder for ' + t.truck + ' skipped: ' + e.message); }
    }

    return out;
  }
}

module.exports = { NewMileClient };
