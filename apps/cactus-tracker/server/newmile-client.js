'use strict';
/*
 * Server-side NewMile MCP client for the Cactus Tracker.
 *
 * Trimmed from the desktop's mcp-client.js (verified live against app.newmile.com
 * 2026-06-10): OAuth 2.1 with RFC 8414 discovery + RFC 7591 dynamic registration +
 * PKCE, MCP streamable HTTP where tool responses arrive on an SSE stream that stays
 * open (read incrementally, resolve on our id, abort).
 *
 * The interactive step is WEB based instead of an Electron window: routes.js sends
 * the phone/browser to beginAuth().authUrl and NewMile redirects back to
 * <publicBase>/cactus-tracker/api/newmile/callback, which calls finishAuth().
 * After the first sign-in the refresh token keeps the server connected unattended.
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
  constructor(opts) {
    this.cfg = opts.config || {};
    this.mcpUrl = this.cfg.mcpUrl || 'https://app.newmile.com/mcp';
    this.origin = new URL(this.mcpUrl).origin;
    this.tokenPath = opts.tokenPath || path.join(__dirname, '..', 'data', 'newmile-tokens.json');
    this.onLog = opts.onLog || (() => {});
    const saved = this._load();
    this.tokens = saved.tokens || null;
    this.clientId = (this.cfg.oauth && this.cfg.oauth.clientId) || saved.clientId || null;
    this.clientSecret = saved.clientSecret || null;
    this.meta = null;
    this.sessionId = null;
    this.connected = false;
    this.lastError = null;
    this.profile = null;
    this._pending = new Map(); // state -> { verifier, redirectUri, at }
  }

  log(s) { try { this.onLog(String(s)); } catch (e) {} }

  status() {
    return {
      connected: this.connected,
      hasToken: !!(this.tokens && this.tokens.access_token),
      hasRefresh: !!(this.tokens && this.tokens.refresh_token),
      user: (this.profile && (this.profile.name || this.profile.user_name || this.profile.email)) || null,
      lastError: this.lastError
    };
  }

  // ---------- persistence ----------
  _load() {
    try { return JSON.parse(fs.readFileSync(this.tokenPath, 'utf8')) || {}; } catch (e) { return {}; }
  }
  _persist() {
    try { fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true }); } catch (e) {}
    try {
      fs.writeFileSync(this.tokenPath, JSON.stringify({ tokens: this.tokens, clientId: this.clientId, clientSecret: this.clientSecret }, null, 2));
    } catch (e) { this.log('persist failed: ' + e.message); }
  }

  // ---------- OAuth ----------
  async _discover() {
    if (this.meta) return;
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
    for (const u of [asBase + '/.well-known/oauth-authorization-server', asBase + '/.well-known/openid-configuration']) {
      try {
        const r = await fetch(u, { headers: { Accept: 'application/json' } });
        if (r.ok) { this.meta = await r.json(); this.log('discovered AS at ' + u); return; }
      } catch (e) { /* next */ }
    }
    // verified fallback endpoints
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

  async _registerClient(redirectUri) {
    if (this.clientId) return;
    if (!this.meta.registration_endpoint) throw new Error('No dynamic registration and no oauth.clientId configured.');
    const r = await fetch(this.meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Cactus Truck Tracker',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: this._scopes(),
        application_type: 'web'
      })
    });
    if (!r.ok) throw new Error('Dynamic client registration failed: ' + r.status + ' ' + (await r.text()));
    const j = await r.json();
    this.clientId = j.client_id;
    this.clientSecret = j.client_secret || null;
    this._persist();
    this.log('registered client_id ' + this.clientId);
  }

  // Step 1 of the web sign-in: build the authorize URL for a browser redirect.
  async beginAuth(redirectUri) {
    await this._discover();
    await this._registerClient(redirectUri);
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    this._pending.set(state, { verifier, redirectUri, at: Date.now() });
    // drop stale attempts (10 min)
    for (const [k, v] of this._pending) if (Date.now() - v.at > 600000) this._pending.delete(k);
    const p = new URLSearchParams({
      response_type: 'code', client_id: this.clientId, redirect_uri: redirectUri,
      state, scope: this._scopes(), code_challenge: challenge, code_challenge_method: 'S256'
    });
    return { authUrl: this.meta.authorization_endpoint + '?' + p.toString(), state };
  }

  // Step 2: NewMile redirected back with ?code&state.
  async finishAuth(query) {
    if (query.error) throw new Error('Authorization denied: ' + (query.error_description || query.error));
    const pend = this._pending.get(query.state);
    if (!pend) throw new Error('OAuth state mismatch or expired — start the sign-in again.');
    this._pending.delete(query.state);
    if (!query.code) throw new Error('No authorization code returned from NewMile.');
    const p = this._tokenAuthParams(new URLSearchParams({
      grant_type: 'authorization_code', code: query.code,
      redirect_uri: pend.redirectUri, code_verifier: pend.verifier
    }));
    const r = await fetch(this.meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: p.toString()
    });
    if (!r.ok) throw new Error('Token exchange failed: ' + r.status + ' ' + (await r.text()));
    this._storeTokenResponse(await r.json());
    await this._initializeSession();
    await this._loadProfile();
    this.connected = true;
    this.lastError = null;
    this.log('connected to NewMile as ' + (this.status().user || '?'));
    return this.status();
  }

  // Silent resume with the saved refresh token — used at boot and by the cron jobs.
  async resume() {
    if (!(this.tokens && (this.tokens.refresh_token || Date.now() < (this.tokens.expires_at || 0)))) return null;
    try {
      await this._initializeSession();
      await this._loadProfile();
      this.connected = true;
      return this.status();
    } catch (e) {
      this.log('silent resume failed: ' + (e.message || e));
      return null;
    }
  }

  disconnect() {
    this.tokens = null; this.sessionId = null; this.connected = false; this.profile = null;
    this._persist(); // keeps clientId/secret so reconnect is one tap
    return this.status();
  }

  _tokenAuthParams(p) {
    p.set('client_id', this.clientId || '');
    if (this.clientSecret) p.set('client_secret', this.clientSecret);
    return p;
  }

  _storeTokenResponse(j) {
    const expires_at = Date.now() + ((j.expires_in || 3600) - 90) * 1000;
    this.tokens = {
      access_token: j.access_token,
      refresh_token: j.refresh_token || (this.tokens && this.tokens.refresh_token) || null,
      expires_at, token_type: j.token_type || 'Bearer'
    };
    this._persist();
  }

  async _ensureToken() {
    if (this.tokens && this.tokens.access_token && Date.now() < this.tokens.expires_at) return;
    if (this.tokens && this.tokens.refresh_token) {
      await this._discover();
      const p = this._tokenAuthParams(new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: this.tokens.refresh_token
      }));
      const r = await fetch(this.meta.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: p.toString()
      });
      if (r.ok) { this._storeTokenResponse(await r.json()); return; }
      this.log('refresh failed: ' + r.status);
    }
    this.connected = false;
    throw new Error('NOT_CONNECTED');
  }

  // ---------- MCP transport (SSE stream stays open after the response — abort after our id) ----------
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
      const r = await fetch(this.mcpUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
      const sid = r.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      if (r.status === 401) { this.connected = false; this.sessionId = null; throw new Error('NOT_CONNECTED'); }
      if (!r.ok) throw new Error('MCP ' + method + ' failed: ' + r.status + ' ' + (await r.text()));
      if (isNotification) { try { ac.abort(); } catch (e) {} return null; }

      const ct = r.headers.get('content-type') || '';
      let msg;
      if (!ct.includes('text/event-stream')) {
        msg = await r.json();
      } else {
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
        try { ac.abort(); } catch (e) {}
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
      clientInfo: { name: 'CactusTracker', version: '1.0.0' }
    }, { timeoutMs: 30000 });
    try { await this._rpc('notifications/initialized', {}, { notification: true, timeoutMs: 10000 }); } catch (e) {}
  }

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

  // ---------- read helpers (same verified shapes as the desktop) ----------
  async listTrucksAll() {
    let rows = [], page = 1, totalPages = 1;
    do {
      const r = await this.callTool('list_resources', { resource_type: 'truck', filters: { page, page_size: 100 } });
      rows = rows.concat((r && (r.trucks || r.results || r.rows)) || []);
      totalPages = (r && (r.total_pages || r.pages)) || 1;
      page++;
    } while (page <= totalPages && page <= 10);
    return rows;
  }

  // Today's orders + their assignments → trucks already planned in NewMile (covered even
  // before their first load lands). Same shapes the desktop uses for its full-day refresh.
  async listOrdersAllPages(dateISO) {
    let rows = [], page = 1, totalPages = 1;
    do {
      const r = await this.callTool('list_resources', {
        resource_type: 'order',
        filters: { order_date_from: dateISO, order_date_to: dateISO, page, page_size: 100 }
      });
      rows = rows.concat((r && (r.orders || r.results || r.rows)) || []);
      totalPages = (r && (r.total_pages || r.pages)) || 1;
      page++;
    } while (page <= totalPages && page <= 5);
    return rows;
  }

  async orderAssignments(orderId) {
    const r = await this.callTool('list_resources', {
      resource_type: 'order_assignment',
      filters: { order_id: orderId, page_size: 100 }
    });
    return (r && (r.order_assignments || r.assignments || r.results || r.rows)) || [];
  }

  async _pool(items, limit, fn) {
    const out = new Array(items.length); let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
      while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = null; this.log('pool item failed: ' + e.message); } }
    });
    await Promise.all(workers);
    return out;
  }

  // Every assignment of today's orders, flattened (order fan-out capped at 6 parallel).
  async assignmentsToday(dateISO) {
    const orders = await this.listOrdersAllPages(dateISO);
    const ids = orders.map(o => o.id != null ? o.id : o.order_id).filter(x => x != null);
    const lists = await this._pool(ids, 6, id => this.orderAssignments(id));
    return lists.filter(Boolean).flat();
  }

  // Load tickets WITH material columns (keys verified live via describe_report 2026-07-10:
  // 'material' + 'alternative_material_name') — powers the RIP RAP capability scan.
  async loadTicketsMaterialsAll(fromISO, toISO) {
    let rows = [], page = 1, totalPages = 1;
    do {
      const r = await this.callTool('query_report', {
        report_name: 'load_tickets',
        filters: { order_date_from: fromISO, order_date_to: toISO },
        columns: ['truck_number', 'fleet', 'material', 'alternative_material_name', 'order_date'],
        page_size: 200, page
      });
      rows = rows.concat((r && (r.rows || r.results || r.data)) || []);
      totalPages = (r && (r.total_pages || r.pages)) || 1;
      page++;
    } while (page <= totalPages && page <= 40);
    return rows;
  }

  // Multi-day load_tickets with order_date (returns MM/DD/YY) — activity + rotation driver.
  async loadTicketsRangeAll(fromISO, toISO) {
    let rows = [], page = 1, totalPages = 1;
    do {
      const r = await this.callTool('query_report', {
        report_name: 'load_tickets',
        filters: { order_date_from: fromISO, order_date_to: toISO },
        columns: ['truck_number', 'driver_name', 'fleet', 'truck_owner', 'order_date'],
        page_size: 200, page
      });
      rows = rows.concat((r && (r.rows || r.results || r.data)) || []);
      totalPages = (r && (r.total_pages || r.pages)) || 1;
      page++;
    } while (page <= totalPages && page <= 25);
    return rows;
  }
}

module.exports = { NewMileClient };
