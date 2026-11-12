// ---------------------------------------------------------------------------
// 🦺 SAFE DUMPING TRAINING — Project Roadrunner · Milestone Supply
// App INDEPENDIENTE (Juan 2026-11-12: "fuera del tracker, rama aparte").
// Cero dependencias: node:http + node:sqlite — no hay npm install.
//
//   node server.js          → http://localhost:8792
//
// Páginas:  /            → entrenamiento del chofer (público, bilingüe)
//           /?code=RR-X  → verificación pública (el QR apunta aquí)
//           /admin       → panel admin (login con admin code propio)
// Datos:    data/safety.db (SQLite) + data/ videos, PDFs, sellos, config.json
// Llaves:   data/config.json {adminCode, uploadKey, staffCode} — se generan en
//           el primer arranque y se COPIAN a OneDrive\mab-deploy\safety-keys.json
//           (el canal de secretos de siempre; nunca viven en este repo público).
// Deploy:   la app revisa su rama (safety-roadrunner) cada 60 s; si hay commit
//           nuevo hace pull y se reinicia sola (run-safety.cmd la relanza).
// ---------------------------------------------------------------------------
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PUB = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8792);
const CERT_DAYS = 180;
const PASS_NEED = 7;
const WATCH_PCT = 0.9;
try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) {}

// ---------- config / llaves ----------
const CFG_FILE = path.join(DATA, 'config.json');
function randCode(n) { const AB = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < n; i++) s += AB[crypto.randomInt(AB.length)]; return s; }
let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (e) {}
let cfgDirty = false;
if (!CFG.adminCode) { CFG.adminCode = randCode(6); cfgDirty = true; }
if (!CFG.uploadKey) { CFG.uploadKey = crypto.randomBytes(24).toString('hex'); cfgDirty = true; }
if (cfgDirty) fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2));
// copia de llaves al canal OneDrive (solo en la office; en otra máquina no pasa nada)
try {
  const home = process.env.USERPROFILE || '';
  for (const od of fs.readdirSync(home).filter(d => /^OneDrive/i.test(d))) {
    const dep = path.join(home, od, 'mab-deploy');
    if (fs.existsSync(dep)) { fs.writeFileSync(path.join(dep, 'safety-keys.json'), JSON.stringify({ adminCode: CFG.adminCode, uploadKey: CFG.uploadKey, port: PORT, at: new Date().toISOString() }, null, 2)); break; }
  }
} catch (e) {}
const cookieOf = (code) => crypto.createHash('sha256').update('sd|' + code).digest('hex').slice(0, 40);
let ADMIN_COOKIE = cookieOf(CFG.adminCode);
function setAdminCode(code) {
  CFG.adminCode = code;
  ADMIN_COOKIE = cookieOf(code); // las sesiones viejas dejan de valer al instante
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2)); } catch (e) {}
}

// ---------- db ----------
const db = new DatabaseSync(path.join(DATA, 'safety.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS safety_certs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, token TEXT,
  name TEXT NOT NULL, truck TEXT NOT NULL, company TEXT NOT NULL,
  phone TEXT DEFAULT '', cdl TEXT DEFAULT '', lang TEXT DEFAULT 'es',
  status TEXT DEFAULT 'started', approve_mode TEXT DEFAULT 'auto', invite_key TEXT DEFAULT '',
  video_seconds REAL DEFAULT 0, video_dur REAL DEFAULT 0,
  quiz_score INTEGER DEFAULT 0, quiz_total INTEGER DEFAULT 0, quiz_tries INTEGER DEFAULT 0,
  signature TEXT DEFAULT '', signed_at TEXT DEFAULT '',
  certified_at TEXT DEFAULT '', expires_at TEXT DEFAULT '', sticker TEXT DEFAULT '',
  source TEXT DEFAULT 'web', added_by TEXT DEFAULT '', notes TEXT DEFAULT '',
  ua TEXT DEFAULT '', created_at TEXT, updated_at TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS safety_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cert_id INTEGER, ts TEXT, kind TEXT, detail TEXT DEFAULT '')`);
db.exec(`CREATE TABLE IF NOT EXISTS safety_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE,
  name TEXT DEFAULT '', truck TEXT DEFAULT '', company TEXT DEFAULT '', phone TEXT DEFAULT '',
  auto_approve INTEGER DEFAULT 1, ask_cdl INTEGER DEFAULT 0, note TEXT DEFAULT '',
  created_by TEXT DEFAULT '', created_at TEXT, used_cert_id INTEGER DEFAULT 0)`);
const get = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const metaGet = (k, d) => { const r = get('SELECT value FROM meta WHERE key = ?', k); return r ? r.value : (d === undefined ? null : d); };
const metaSet = (k, v) => run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));
const nowISO = () => new Date().toISOString();
if (!metaGet('safety_staff_code', '')) metaSet('safety_staff_code', CFG.staffCode || randCode(6));
// columna nueva sobre tabla ya creada (migración aditiva)
try { db.exec(`ALTER TABLE safety_certs ADD COLUMN ip TEXT DEFAULT ''`); } catch (e) {}

// 📍 ¿de dónde se conectó el chofer? Guardamos la IP real (la pasa ngrok en
// x-forwarded-for) y el dispositivo (user-agent) — TODO queda en nuestra base,
// nada se manda a servicios externos.
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xf || req.socket.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 45);
}
function deviceOf(ua) {
  ua = String(ua || '');
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'other';
  return os;
}

// ---------- helpers ----------
function log(m) { console.log(new Date().toISOString().slice(11, 19) + ' ' + m); }
function ev(certId, kind, detail) { run('INSERT INTO safety_events (cert_id, ts, kind, detail) VALUES (?,?,?,?)', certId, nowISO(), kind, String(detail || '').slice(0, 400)); }
function newCode() {
  for (let t = 0; t < 50; t++) { const s = 'RR-' + randCode(6); if (!get('SELECT id FROM safety_certs WHERE code = ?', s)) return s; }
  return 'RR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}
function effStatus(r) {
  if (r.status === 'revoked') return 'revoked';
  if (r.status === 'certified') { const today = new Date().toISOString().slice(0, 10); if (r.expires_at && r.expires_at < today) return 'expired'; return 'certified'; }
  return r.status;
}
function pubRow(r) {
  return { id: r.id, code: r.code, name: r.name, truck: r.truck, company: r.company,
    status: effStatus(r), certified_at: r.certified_at || '', expires_at: r.expires_at || '',
    sticker: r.sticker || '', lang: r.lang };
}
function certWindow() { const now = new Date(); return { at: now.toISOString(), exp: new Date(now.getTime() + CERT_DAYS * 86400e3).toISOString().slice(0, 10) }; }
const _hits = new Map();
function rateOk(req, kind, max) {
  const k = kind + '|' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?');
  const now = Date.now(); const e = _hits.get(k) || { n: 0, at: now };
  if (now - e.at > 3600e3) { e.n = 0; e.at = now; }
  e.n++; _hits.set(k, e); if (_hits.size > 5000) _hits.clear();
  return e.n <= max;
}
const QUIZ = [
  { id: 'wind', q: { en: 'The wind limit on this site is…', es: 'El límite de viento en este sitio es…' },
    o: { en: ['15 mph sustained / 25 mph gusts', '25 mph sustained / 35 mph gusts', 'There is no wind limit'],
         es: ['15 mph sostenido / 25 mph rachas', '25 mph sostenido / 35 mph rachas', 'No hay límite de viento'] }, a: 1 },
  { id: 'lean', q: { en: 'The bed starts leaning or the load hangs up on one side. You…', es: 'La caja se empieza a ladear o la carga se cuelga de un lado. Tú…' },
    o: { en: ['Rock the truck to shake it loose', 'Pull forward fast', 'Lower the bed right away'],
         es: ['Sacudes el troque para soltarla', 'Te adelantas rápido', 'Bajas la caja de inmediato'] }, a: 2 },
  { id: 'tip', q: { en: 'Your truck starts to tip over. You…', es: 'Tu troque se empieza a voltear. Tú…' },
    o: { en: ['Jump out as fast as you can', 'Stay in the cab with your seat belt on and brace', 'Climb to the high side'],
         es: ['Saltas tan rápido como puedas', 'Te quedas en la cabina con el cinturón puesto y te sujetas', 'Te pasas al lado alto'] }, a: 1 },
  { id: 'power', q: { en: 'Your truck contacts a power line. You…', es: 'Tu troque toca una línea eléctrica. Tú…' },
    o: { en: ['Get out immediately and run', 'Stay in the cab, warn others away, call 911 and dispatch', 'Back up and keep working'],
         es: ['Te bajas de inmediato y corres', 'Te quedas en la cabina, alejas a la gente, llamas al 911 y a dispatch', 'Te echas de reversa y sigues trabajando'] }, a: 1 },
  { id: 'spot', q: { en: 'Who picks your dump spot?', es: '¿Quién escoge tu punto de descarga?' },
    o: { en: ['You, wherever looks level', 'The spotter — and you still check it yourself', 'The last driver in line'],
         es: ['Tú, donde se vea parejo', 'El spotter — y tú igual lo revisas', 'El último chofer de la fila'] }, a: 1 },
  { id: 'sticker', q: { en: 'The Proof of Training sticker must be…', es: 'El sticker de Proof of Training debe estar…' },
    o: { en: ['In your wallet', 'In the glove box', 'On the truck window, visible from outside'],
         es: ['En tu cartera', 'En la guantera', 'En la ventana del troque, visible desde afuera'] }, a: 2 },
  { id: 'phone', q: { en: 'Phone use on this site is…', es: 'El uso del teléfono en el sitio está…' },
    o: { en: ['OK while queueing', 'OK while dumping', 'Not allowed on site'],
         es: ['Permitido en la fila', 'Permitido mientras dumpeas', 'Prohibido en el sitio'] }, a: 2 },
  { id: 'after', q: { en: 'Before moving off the pad after dumping…', es: 'Antes de moverte del pad después de dumpear…' },
    o: { en: ['Bed can stay up if you go slow', 'Bed all the way down, tailgate closed, lock pins seated', 'Just honk twice'],
         es: ['La caja puede ir arriba si vas despacio', 'Caja completamente abajo, tailgate cerrada y pernos asentados', 'Solo pitas dos veces'] }, a: 1 }
];
const DOCS = { sop: 'Safe_Dumping_Practices_SOP.pdf', infosheet: 'Safe_Dumping_Driver_Info_Sheet.pdf', plan: 'Safe_Dumping_Program_Plan.pdf', guide: 'Safe_Dumping_Platform_Guide.pdf' };
const IMGS = { seal: 'img_seal.jpg', bird: 'img_bird.jpg', rrlogo: 'img_rrlogo.png', mslogo: 'img_mslogo.webp' };
const IMG_CT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const filePath = (name) => DOCS[name] ? path.join(DATA, 'doc_' + name + '.pdf')
  : IMGS[name] ? path.join(DATA, IMGS[name])
  : (name === 'video_en' || name === 'video_es') ? path.join(DATA, name + '.mp4') : null;

// ---------- mini framework http ----------
function send(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); }
function readJson(req) {
  return new Promise((resolve) => {
    let b = '', dead = false;
    req.on('data', (c) => { b += c; if (b.length > 2 * 1048576 && !dead) { dead = true; resolve(null); req.destroy(); } });
    req.on('end', () => { if (dead) return; try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
function isAdmin(req) {
  const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith('sd_admin='));
  return !!(c && c.slice(9) === ADMIN_COOKIE);
}
function byToken(q, b) {
  const t = String((b && b.token) || (q && q.token) || '');
  if (!/^[a-f0-9]{32}$/.test(t)) return null;
  return get('SELECT * FROM safety_certs WHERE token = ?', t) || null;
}
function streamUpload(req, res, dest, capMB, done) {
  const tmp = dest + '.part';
  const ws = fs.createWriteStream(tmp);
  let bytes = 0, dead = false;
  req.on('data', (c) => { bytes += c.length; if (bytes > capMB * 1048576 && !dead) { dead = true; ws.destroy(); try { fs.unlinkSync(tmp); } catch (e) {}; send(res, 413, { error: 'too big (max ' + capMB + ' MB)' }); req.destroy(); } });
  req.pipe(ws);
  ws.on('finish', () => {
    if (dead) return;
    // Windows niega el rename si el archivo viejo está ABIERTO (p. ej. un chofer viendo el
    // video en ese momento) → EPERM. Reintentamos unos segundos (los streams de video son
    // cortos) y como último recurso copiamos encima.
    const land = (tries) => {
      try {
        try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (e) {}
        fs.renameSync(tmp, dest);
        return done(bytes);
      } catch (e) {
        if (tries > 0) return setTimeout(() => land(tries - 1), 700);
        try { fs.copyFileSync(tmp, dest); try { fs.unlinkSync(tmp); } catch (e2) {}; return done(bytes); }
        catch (e3) { return send(res, 500, { error: 'file is busy — try again in a minute (' + String(e3.message || e3) + ')' }); }
      }
    };
    land(8);
  });
  ws.on('error', (e) => { if (!dead) send(res, 500, { error: String(e.message || e) }); });
}
function serveFile(res, file, ct, extraHead) {
  const stat = fs.statSync(file);
  res.writeHead(200, Object.assign({ 'Content-Type': ct, 'Content-Length': stat.size }, extraHead || {}));
  fs.createReadStream(file).pipe(res);
}

// ---------- rutas ----------
let VERSION = 'dev';
try { VERSION = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch (e) {}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    // Detrás del proxy de la office la app vive bajo /safety (opción A de Juan):
    // /safety → /safety/ (para que las rutas relativas de la página resuelvan bien)
    // y el prefijo se pela aquí — la app es la misma sola o con prefijo.
    let p0 = u.pathname;
    if (p0 === '/safety') { res.writeHead(301, { Location: '/safety/' + (u.search || '') }); return res.end(); }
    if (p0.startsWith('/safety/')) p0 = p0.slice(7);
    const p = p0.replace(/\/+$/, '') || '/';
    const q = Object.fromEntries(u.searchParams);
    const M = req.method;

    // ---- páginas y estáticos ----
    if (M === 'GET' && (p === '/' || p === '/safety' || p === '/safety.html')) return serveFile(res, path.join(PUB, 'safety.html'), 'text/html; charset=utf-8');
    if (M === 'GET' && (p === '/admin' || p === '/safety-admin.html')) return serveFile(res, path.join(PUB, 'safety-admin.html'), 'text/html; charset=utf-8');
    if (M === 'GET' && /^\/img\/[A-Za-z0-9._-]+$/.test(p)) {
      const f = path.join(PUB, p);
      if (fs.existsSync(f)) return serveFile(res, f, 'image/png', { 'Cache-Control': 'public, max-age=86400' });
      res.writeHead(404); return res.end();
    }
    if (M === 'GET' && p === '/api/health') return send(res, 200, { ok: true, service: 'safe-dumping', version: VERSION, today: new Date().toISOString().slice(0, 10) });

    // ---- ADMIN login (abierto) ----
    if (M === 'POST' && p === '/api/safety/admin-login') {
      if (!rateOk(req, 'login', 30)) return send(res, 429, { error: 'too many tries' });
      const b = await readJson(req) || {};
      if (String(b.code || '').trim().toUpperCase() !== CFG.adminCode.toUpperCase()) return send(res, 401, { error: 'wrong code' });
      res.setHeader('Set-Cookie', `sd_admin=${ADMIN_COOKIE}; Path=/; Max-Age=15552000; HttpOnly; SameSite=Lax`);
      return send(res, 200, { ok: true });
    }

    // ---- CHOFER (abierto) ----
    if (M === 'GET' && p === '/api/safety/invite') {
      if (!rateOk(req, 'inv', 120)) return send(res, 429, { error: 'too many requests' });
      const inv = get('SELECT * FROM safety_invites WHERE key = ?', String(q.i || '').toUpperCase());
      if (!inv) return send(res, 200, { ok: true, found: false });
      return send(res, 200, { ok: true, found: true, prefill: { name: inv.name, truck: inv.truck, company: inv.company, phone: inv.phone }, ask_cdl: !!inv.ask_cdl, auto: !!inv.auto_approve });
    }
    if (M === 'POST' && p === '/api/safety/register') {
      if (!rateOk(req, 'reg', 40)) return send(res, 429, { error: 'too many requests' });
      const b = await readJson(req) || {};
      const name = String(b.name || '').trim().slice(0, 60);
      const truck = String(b.truck || '').trim().toUpperCase().slice(0, 20);
      const company = String(b.company || '').trim().slice(0, 60);
      if (name.length < 3 || !truck || company.length < 2) return send(res, 400, { error: 'name, truck and company are required' });
      const inv = b.invite ? get('SELECT * FROM safety_invites WHERE key = ?', String(b.invite).toUpperCase()) : null;
      const cdl = String(b.cdl || '').trim().toUpperCase().slice(0, 25);
      if (inv && inv.ask_cdl && cdl.length < 4) return send(res, 400, { error: 'cdl required' });
      const dup = all('SELECT * FROM safety_certs WHERE UPPER(truck) = ? ORDER BY id DESC LIMIT 5', truck)
        .find(r => r.name.trim().toLowerCase() === name.toLowerCase() && effStatus(r) === 'certified');
      if (dup) return send(res, 200, { ok: true, already: true, code: dup.code, expires_at: dup.expires_at });
      const token = crypto.randomBytes(16).toString('hex');
      const code = newCode();
      const r = run(`INSERT INTO safety_certs (code, token, name, truck, company, phone, cdl, lang, status, approve_mode, invite_key, ua, ip, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,'started',?,?,?,?,?,?)`,
        code, token, name, truck, company, String(b.phone || '').trim().slice(0, 20), cdl, b.lang === 'en' ? 'en' : 'es',
        inv && !inv.auto_approve ? 'manual' : 'auto', inv ? inv.key : '',
        String(req.headers['user-agent'] || '').slice(0, 160), clientIp(req), nowISO(), nowISO());
      if (inv) run('UPDATE safety_invites SET used_cert_id = ? WHERE id = ?', r.lastInsertRowid, inv.id);
      ev(r.lastInsertRowid, 'register', name + ' · ' + truck + ' · ' + company + (inv ? ' · via link ' + inv.key : ''));
      return send(res, 200, { ok: true, token, code });
    }
    const serveVideo = (lang) => {
      let file = filePath('video_' + lang);
      if (!fs.existsSync(file)) file = filePath('video_' + (lang === 'en' ? 'es' : 'en'));
      if (!fs.existsSync(file)) return send(res, 404, { error: 'video not uploaded yet' });
      const stat = fs.statSync(file);
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : Math.min(start + 4 * 1048576 - 1, stat.size - 1);
        if (isNaN(start) || start >= stat.size) { res.writeHead(416); return res.end(); }
        end = Math.min(end, stat.size - 1);
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    };
    if (M === 'GET' && p === '/api/safety/video') {
      const row = byToken(q);
      if (!row) return send(res, 401, { error: 'bad token' });
      return serveVideo(q.lang === 'en' ? 'en' : 'es');
    }
    if (M === 'GET' && p === '/api/safety/video-status') {
      const videos = {};
      for (const l of ['en', 'es']) { const f = filePath('video_' + l); videos[l] = fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1048576) : 0; }
      const docs = {};
      for (const n of Object.keys(DOCS)) docs[n] = fs.existsSync(filePath(n)) ? 1 : 0;
      return send(res, 200, { ok: true, videos, docs });
    }
    if (M === 'POST' && p === '/api/safety/beat') {
      const b = await readJson(req) || {};
      const row = byToken(q, b);
      if (!row) return send(res, 401, { error: 'bad token' });
      const dur = Math.max(0, Math.min(3600, Number(b.dur) || 0));
      const delta = Math.max(0, Math.min(16, Number(b.delta) || 0));
      const secs = Math.min((row.video_seconds || 0) + delta, dur || 3600);
      const doneNow = dur > 60 && secs >= dur * WATCH_PCT && row.status === 'started';
      run('UPDATE safety_certs SET video_seconds = ?, video_dur = ?, status = ?, updated_at = ? WHERE id = ?',
        secs, dur || row.video_dur, doneNow ? 'video_done' : row.status, nowISO(), row.id);
      if (doneNow) ev(row.id, 'video_done', Math.round(secs) + 's of ' + Math.round(dur) + 's');
      return send(res, 200, { ok: true, watched: Math.round(secs), need: Math.round((dur || 0) * WATCH_PCT), done: doneNow || row.status !== 'started' });
    }
    if (M === 'GET' && p === '/api/safety/quiz') {
      const row = byToken(q);
      if (!row) return send(res, 401, { error: 'bad token' });
      if (row.status === 'started') return send(res, 409, { error: 'watch the video first' });
      const lang = row.lang === 'en' ? 'en' : 'es';
      return send(res, 200, { ok: true, need: PASS_NEED, questions: QUIZ.map(x => ({ id: x.id, q: x.q[lang], o: x.o[lang] })) });
    }
    if (M === 'POST' && p === '/api/safety/quiz') {
      const b = await readJson(req) || {};
      const row = byToken(q, b);
      if (!row) return send(res, 401, { error: 'bad token' });
      if (row.status === 'started') return send(res, 409, { error: 'watch the video first' });
      const ans = b.answers || {};
      let score = 0; const wrong = [];
      for (const x of QUIZ) { if (Number(ans[x.id]) === x.a) score++; else wrong.push(x.id); }
      const passed = score >= PASS_NEED;
      run('UPDATE safety_certs SET quiz_score = ?, quiz_total = ?, quiz_tries = quiz_tries + 1, status = ?, updated_at = ? WHERE id = ?',
        score, QUIZ.length, passed ? 'passed' : row.status, nowISO(), row.id);
      ev(row.id, passed ? 'quiz_pass' : 'quiz_fail', score + '/' + QUIZ.length);
      return send(res, 200, { ok: true, passed, score, total: QUIZ.length, need: PASS_NEED, wrong: passed ? [] : wrong });
    }
    if (M === 'POST' && p === '/api/safety/sign') {
      const b = await readJson(req) || {};
      const row = byToken(q, b);
      if (!row) return send(res, 401, { error: 'bad token' });
      // quiz REMOVED (John Anderson 2026-11-12): se firma directo después del video + reglas
      if (!['video_done', 'passed', 'pending', 'certified'].includes(row.status)) return send(res, 409, { error: 'finish the video first' });
      const sig = String(b.signature || '');
      if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]{200,}$/.test(sig) || sig.length > 300000) return send(res, 400, { error: 'signature required' });
      if (row.approve_mode === 'manual') {
        run(`UPDATE safety_certs SET signature = ?, signed_at = ?, status = 'pending', updated_at = ? WHERE id = ?`, sig, nowISO(), nowISO(), row.id);
        ev(row.id, 'pending_approval', 'training done, waiting for Milestone');
        log('PENDING APPROVAL ' + row.name + ' · ' + row.truck + ' → ' + row.code);
        return send(res, 200, { ok: true, pending: true, code: row.code });
      }
      const w = certWindow();
      run(`UPDATE safety_certs SET signature = ?, signed_at = ?, status = 'certified', certified_at = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
        sig, nowISO(), w.at, w.exp, nowISO(), row.id);
      ev(row.id, 'certified', 'expires ' + w.exp);
      log('CERTIFIED ' + row.name + ' · ' + row.truck + ' · ' + row.company + ' → ' + row.code);
      return send(res, 200, { ok: true, code: row.code, certified_at: w.at, expires_at: w.exp });
    }
    if (M === 'GET' && p === '/api/safety/me') {
      const row = byToken(q);
      if (!row) return send(res, 401, { error: 'bad token' });
      return send(res, 200, { ok: true, cert: pubRow(row), watched: Math.round(row.video_seconds || 0), dur: Math.round(row.video_dur || 0) });
    }
    if (M === 'GET' && p === '/api/safety/verify') {
      if (!rateOk(req, 'ver', 200)) return send(res, 429, { error: 'too many requests' });
      const code = String(q.code || '').trim().toUpperCase();
      if (!/^RR-[A-Z0-9]{4,10}$/.test(code)) return send(res, 400, { error: 'bad code' });
      const row = get('SELECT * FROM safety_certs WHERE code = ?', code);
      if (!row) return send(res, 200, { ok: true, found: false });
      const st = effStatus(row);
      return send(res, 200, { ok: true, found: true, valid: st === 'certified', status: st,
        name: row.name, truck: row.truck, company: row.company,
        certified_at: (row.certified_at || '').slice(0, 10), expires_at: row.expires_at || '', sticker: row.sticker || '' });
    }
    // 🏷 MODO CAMPO (Miguel escanea el QR): aprobar + sticker con el código de staff
    if (M === 'POST' && p === '/api/safety/field') {
      if (!rateOk(req, 'field', 150)) return send(res, 429, { error: 'too many requests' });
      const b = await readJson(req) || {};
      if (String(b.staff || '').trim().toUpperCase() !== metaGet('safety_staff_code', '')) return send(res, 401, { error: 'bad staff code' });
      const row = get('SELECT * FROM safety_certs WHERE code = ?', String(b.code || '').trim().toUpperCase());
      if (!row) return send(res, 404, { error: 'not found' });
      const by = String(b.by || 'field staff').slice(0, 40);
      if (b.action === 'approve' && row.status === 'pending') {
        const w = certWindow();
        run(`UPDATE safety_certs SET status = 'certified', certified_at = ?, expires_at = ?, updated_at = ? WHERE id = ?`, w.at, w.exp, nowISO(), row.id);
        ev(row.id, 'approved', 'in the FIELD (QR scan) by ' + by);
        log('FIELD APPROVED ' + row.code);
      }
      if (typeof b.sticker === 'string' && b.sticker.trim()) {
        run('UPDATE safety_certs SET sticker = ?, updated_at = ? WHERE id = ?', b.sticker.trim().slice(0, 20), nowISO(), row.id);
        ev(row.id, 'sticker', b.sticker.trim() + ' issued in the FIELD by ' + by);
      }
      const r2 = get('SELECT * FROM safety_certs WHERE id = ?', row.id);
      return send(res, 200, { ok: true, status: effStatus(r2), sticker: r2.sticker || '', expires_at: r2.expires_at || '' });
    }
    if (M === 'GET' && p === '/api/safety/doc') {
      const f = DOCS[q.name] ? filePath(q.name) : null;
      if (!f || !fs.existsSync(f)) return send(res, 404, { error: 'doc not uploaded' });
      return serveFile(res, f, 'application/pdf', { 'Content-Disposition': 'inline; filename="' + DOCS[q.name] + '"', 'Cache-Control': 'public, max-age=3600' });
    }
    if (M === 'GET' && p === '/api/safety/img') {
      const f = IMGS[q.name] ? filePath(q.name) : null;
      if (!f || !fs.existsSync(f)) return send(res, 404, { error: 'img not uploaded' });
      const ct = IMG_CT[(IMGS[q.name].split('.').pop() || 'jpg')] || 'image/jpeg';
      return serveFile(res, f, ct, { 'Cache-Control': 'public, max-age=86400' });
    }
    // canal de máquinas (uploadKey): cambiar el admin code sin tocar la office
    if (M === 'POST' && p === '/api/safety/set-admin-code') {
      if (String(q.key || '') !== CFG.uploadKey) return send(res, 401, { error: 'bad key' });
      const b = await readJson(req) || {};
      const c = String(b.code || '').trim().toUpperCase().slice(0, 12);
      if (c.length < 4) return send(res, 400, { error: 'min 4 characters' });
      setAdminCode(c);
      log('admin code changed via machine channel');
      return send(res, 200, { ok: true });
    }
    // canal de máquinas (uploadKey): PDFs, sellos y videos sin sesión
    if (M === 'PUT' && p === '/api/safety/doc-upload') {
      if (String(q.key || '') !== CFG.uploadKey) return send(res, 401, { error: 'bad key' });
      const dest = filePath(String(q.name || ''));
      if (!dest) return send(res, 400, { error: 'name must be sop | infosheet | plan | seal | bird | video_en | video_es' });
      const isVideo = /video_/.test(q.name);
      return streamUpload(req, res, dest, isVideo ? 900 : 25, (bytes) => {
        log('upload ' + q.name + ': ' + Math.round(bytes / 1024) + ' KB');
        send(res, 200, { ok: true, name: q.name, kb: Math.round(bytes / 1024) });
      });
    }

    // ---- ADMIN (cookie del admin code) ----
    if (p.startsWith('/api/safety/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'login required' });
      if (M === 'GET' && p === '/api/safety/admin/list') {
        const rows = all('SELECT * FROM safety_certs ORDER BY id DESC');
        const today = new Date().toISOString().slice(0, 10);
        return send(res, 200, { ok: true, rows: rows.map(r => ({
          ...pubRow(r), phone: r.phone, cdl: r.cdl || '', mode: r.approve_mode || 'auto',
          ip: r.ip || '', device: deviceOf(r.ua),
          quiz: r.quiz_score + '/' + r.quiz_total, quiz_tries: r.quiz_tries,
          watched: Math.round(r.video_seconds || 0), dur: Math.round(r.video_dur || 0),
          source: r.source, added_by: r.added_by, notes: r.notes, created_at: r.created_at,
          signed: !!r.signature,
          days_left: (effStatus(r) === 'certified' && r.expires_at) ? Math.round((Date.parse(r.expires_at) - Date.parse(today)) / 86400e3) : null
        })) });
      }
      if (M === 'GET' && p === '/api/safety/admin/signature') {
        const row = get('SELECT signature FROM safety_certs WHERE id = ?', Number(q.id) || 0);
        const m = row && /^data:image\/(png|jpeg);base64,(.+)$/.exec(row.signature || '');
        if (!m) return send(res, 404, { error: 'no signature' });
        res.writeHead(200, { 'Content-Type': 'image/' + m[1] });
        return res.end(Buffer.from(m[2], 'base64'));
      }
      if (M === 'POST' && p === '/api/safety/admin/manual') {
        const b = await readJson(req) || {};
        const name = String(b.name || '').trim().slice(0, 60);
        const truck = String(b.truck || '').trim().toUpperCase().slice(0, 20);
        const company = String(b.company || '').trim().slice(0, 60);
        if (name.length < 3 || !truck || company.length < 2) return send(res, 400, { error: 'name, truck and company are required' });
        const w = certWindow();
        const certAt = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? b.date + 'T12:00:00.000Z' : w.at;
        const expAt = new Date(Date.parse(certAt) + CERT_DAYS * 86400e3).toISOString().slice(0, 10);
        const code = newCode();
        const r = run(`INSERT INTO safety_certs (code, token, name, truck, company, phone, lang, status, certified_at, expires_at, sticker, source, added_by, notes, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,'certified',?,?,?,?,?,?,?,?)`,
          code, crypto.randomBytes(16).toString('hex'), name, truck, company, String(b.phone || '').slice(0, 20),
          b.lang === 'en' ? 'en' : 'es', certAt, expAt, String(b.sticker || '').slice(0, 20), 'manual',
          String(b.by || 'admin').slice(0, 40), String(b.notes || '').slice(0, 200), nowISO(), nowISO());
        ev(r.lastInsertRowid, 'manual_cert', 'by ' + (b.by || 'admin'));
        return send(res, 200, { ok: true, code, expires_at: expAt });
      }
      if (M === 'POST' && p === '/api/safety/admin/update') {
        const b = await readJson(req) || {};
        const row = get('SELECT * FROM safety_certs WHERE id = ?', Number(b.id) || 0);
        if (!row) return send(res, 404, { error: 'not found' });
        const by = String(b.by || 'admin').slice(0, 40);
        if ('sticker' in b) { run('UPDATE safety_certs SET sticker = ?, updated_at = ? WHERE id = ?', String(b.sticker || '').slice(0, 20), nowISO(), row.id); ev(row.id, 'sticker', b.sticker + ' by ' + by); }
        if ('notes' in b) run('UPDATE safety_certs SET notes = ?, updated_at = ? WHERE id = ?', String(b.notes || '').slice(0, 200), nowISO(), row.id);
        if ('phone' in b) run('UPDATE safety_certs SET phone = ?, updated_at = ? WHERE id = ?', String(b.phone || '').slice(0, 20), nowISO(), row.id);
        if (b.action === 'approve') {
          const w = certWindow();
          run(`UPDATE safety_certs SET status = 'certified', certified_at = ?, expires_at = ?, updated_at = ? WHERE id = ?`, w.at, w.exp, nowISO(), row.id);
          ev(row.id, 'approved', 'by ' + by + ' · expires ' + w.exp);
        }
        if (b.action === 'revoke') { run(`UPDATE safety_certs SET status = 'revoked', updated_at = ? WHERE id = ?`, nowISO(), row.id); ev(row.id, 'revoked', 'by ' + by); }
        if (b.action === 'renew') {
          run(`UPDATE safety_certs SET status = 'started', video_seconds = 0, quiz_score = 0, quiz_tries = 0, signature = '', updated_at = ? WHERE id = ?`, nowISO(), row.id);
          ev(row.id, 'retrain', 'reset by ' + by);
        }
        if (b.action === 'delete') {
          // borrar la fila COMPLETA (Juan: para que el chofer pueda volver a registrarse
          // desde cero). Se va también su historial — esto no es archivado, es borrado.
          run('DELETE FROM safety_events WHERE cert_id = ?', row.id);
          run('DELETE FROM safety_certs WHERE id = ?', row.id);
          log('DELETED ' + row.code + ' (' + row.name + ' · ' + row.truck + ') by ' + by);
          return send(res, 200, { ok: true, deleted: true });
        }
        return send(res, 200, { ok: true, row: pubRow(get('SELECT * FROM safety_certs WHERE id = ?', row.id)) });
      }
      if (M === 'POST' && p === '/api/safety/admin/invite') {
        const b = await readJson(req) || {};
        let key = '';
        for (let t = 0; t < 50 && !key; t++) { const s = randCode(8); if (!get('SELECT id FROM safety_invites WHERE key = ?', s)) key = s; }
        run(`INSERT INTO safety_invites (key, name, truck, company, phone, auto_approve, ask_cdl, note, created_by, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          key, String(b.name || '').trim().slice(0, 60), String(b.truck || '').trim().toUpperCase().slice(0, 20),
          String(b.company || '').trim().slice(0, 60), String(b.phone || '').trim().slice(0, 20),
          b.auto === false ? 0 : 1, b.cdl ? 1 : 0, String(b.note || '').slice(0, 120),
          String(b.by || 'admin').slice(0, 40), nowISO());
        return send(res, 200, { ok: true, key });
      }
      if (M === 'GET' && p === '/api/safety/admin/invites') {
        const rows = all(`SELECT i.*, c.status AS cert_status, c.name AS cert_name, c.code AS cert_code
                          FROM safety_invites i LEFT JOIN safety_certs c ON c.id = i.used_cert_id ORDER BY i.id DESC LIMIT 60`);
        return send(res, 200, { ok: true, invites: rows.map(r => ({ key: r.key, name: r.name, truck: r.truck, company: r.company,
          auto: !!r.auto_approve, cdl: !!r.ask_cdl, note: r.note, by: r.created_by, created_at: r.created_at,
          used: !!r.used_cert_id, cert_status: r.cert_status || '', cert_name: r.cert_name || '', cert_code: r.cert_code || '' })) });
      }
      if (M === 'GET' && p === '/api/safety/admin/export.csv') {
        const rows = all('SELECT * FROM safety_certs ORDER BY id DESC');
        const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const head = ['Code', 'Name', 'Truck', 'Company', 'Phone', 'CDL', 'Status', 'Mode', 'Certified', 'Expires', 'Sticker', 'Quiz', 'Tries', 'VideoWatchedSec', 'Source', 'AddedBy', 'Notes', 'Created', 'IP', 'Device'];
        const lines = rows.map(r => [r.code, r.name, r.truck, r.company, r.phone, r.cdl || '', effStatus(r), r.approve_mode || 'auto', (r.certified_at || '').slice(0, 10), r.expires_at, r.sticker,
          r.quiz_score + '/' + r.quiz_total, r.quiz_tries, Math.round(r.video_seconds || 0), r.source, r.added_by, r.notes, (r.created_at || '').slice(0, 10), r.ip || '', deviceOf(r.ua)].map(esc).join(','));
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="roadrunner_safe_dumping_roster.csv"' });
        return res.end('﻿' + head.join(',') + '\n' + lines.join('\n'));
      }
      if (M === 'GET' && p === '/api/safety/admin/events') {
        return send(res, 200, { ok: true, events: all('SELECT ts, kind, detail FROM safety_events WHERE cert_id = ? ORDER BY id DESC LIMIT 50', Number(q.id) || 0) });
      }
      if (M === 'GET' && p === '/api/safety/admin/staff-code') return send(res, 200, { ok: true, code: metaGet('safety_staff_code', '') });
      if (M === 'POST' && p === '/api/safety/admin/staff-code') {
        const b = await readJson(req) || {};
        const c = String(b.code || '').trim().toUpperCase().slice(0, 12);
        if (c.length < 4) return send(res, 400, { error: 'min 4 characters' });
        metaSet('safety_staff_code', c);
        return send(res, 200, { ok: true });
      }
      if (M === 'GET' && p === '/api/safety/admin/video') return serveVideo(q.lang === 'en' ? 'en' : 'es'); // preview en el panel
      if (M === 'PUT' && p === '/api/safety/admin/video') {
        const lang = q.lang === 'en' ? 'en' : 'es';
        return streamUpload(req, res, filePath('video_' + lang), 900, (bytes) => {
          log('video ' + lang + ' uploaded: ' + Math.round(bytes / 1048576) + ' MB');
          send(res, 200, { ok: true, lang, mb: Math.round(bytes / 1048576) });
        });
      }
      return send(res, 404, { error: 'unknown admin route' });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    try { send(res, 500, { error: String(e.message || e) }); } catch (e2) {}
    log('ERROR ' + req.url + ' — ' + (e.stack || e));
  }
});

server.listen(PORT, () => {
  log('🦺 Safe Dumping app up on :' + PORT + ' (' + VERSION + ')');
  log('admin code in data/config.json · keys copied to OneDrive\\mab-deploy\\safety-keys.json when present');
});

// ---------- self-update: pull de la rama propia y reiniciar (el .cmd nos relanza) ----------
if (!process.env.SAFETY_NO_SELF_UPDATE) {
  setInterval(() => {
    try {
      execSync('git fetch origin safety-roadrunner', { cwd: ROOT, stdio: 'ignore', timeout: 30000 });
      const local = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
      const remote = execSync('git rev-parse origin/safety-roadrunner', { cwd: ROOT }).toString().trim();
      if (local !== remote) {
        execSync('git pull --ff-only origin safety-roadrunner', { cwd: ROOT, stdio: 'ignore', timeout: 30000 });
        log('self-update: new version pulled — restarting');
        process.exit(0);
      }
    } catch (e) {}
  }, 60000);
}
