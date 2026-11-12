// ---------------------------------------------------------------------------
// 🦺 SAFE DUMPING TRAINING — Project Roadrunner (Childress, TX)
// Plataforma de certificación de choferes: el chofer abre /safety desde su cel,
// se registra (nombre, truck #, company name ON the truck), ve el video SIN
// poder adelantarle (el server valida los segundos vistos, no el cliente),
// acepta las reglas del SOP, pasa un quiz corto, firma y queda CERTIFICADO
// 180 días con constancia + QR verificable. Juan administra en /safety-admin.html
// (PIN del tracker): dashboard, export CSV/print, certificación manual, sticker,
// revocar/renovar y subir los videos EN/ES (quedan en data/safety/ — nunca en el
// repo, que es público).
//
// Rutas ABIERTAS (sin PIN — ver el gate en routes.js): /safety, /safety.html y
// /api/safety/* EXCEPTO /api/safety/admin/* (esas van con PIN como todo lo demás).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { get, all, run, nowISO, DATA_DIR } = require('./db');
const { open } = require('./db');

const VIDEO_DIR = path.join(DATA_DIR, 'safety');
const CERT_DAYS = 180;           // SOP: refresher cada 180 días
const PASS_NEED = 7;             // quiz: 7 de 8 para pasar (reintentos ilimitados)
const WATCH_PCT = 0.9;           // hay que VER el 90% del video (medido en el server)

function migrate() {
  const d = open();
  d.exec(`CREATE TABLE IF NOT EXISTS safety_certs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    token TEXT,
    name TEXT NOT NULL,
    truck TEXT NOT NULL,
    company TEXT NOT NULL,
    phone TEXT DEFAULT '',
    lang TEXT DEFAULT 'es',
    status TEXT DEFAULT 'started',
    video_seconds REAL DEFAULT 0,
    video_dur REAL DEFAULT 0,
    quiz_score INTEGER DEFAULT 0,
    quiz_total INTEGER DEFAULT 0,
    quiz_tries INTEGER DEFAULT 0,
    signature TEXT DEFAULT '',
    signed_at TEXT DEFAULT '',
    certified_at TEXT DEFAULT '',
    expires_at TEXT DEFAULT '',
    sticker TEXT DEFAULT '',
    source TEXT DEFAULT 'web',
    added_by TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    ua TEXT DEFAULT '',
    created_at TEXT,
    updated_at TEXT
  )`);
  d.exec(`CREATE TABLE IF NOT EXISTS safety_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cert_id INTEGER,
    ts TEXT,
    kind TEXT,
    detail TEXT DEFAULT ''
  )`);
  try { fs.mkdirSync(VIDEO_DIR, { recursive: true }); } catch (e) {}
}

function ev(certId, kind, detail) {
  run('INSERT INTO safety_events (cert_id, ts, kind, detail) VALUES (?,?,?,?)', certId, nowISO(), kind, String(detail || '').slice(0, 400));
}
function newCode() {
  // RR-A7K3M9 — corto, legible, sin 0/O ni 1/I/L (se dicta por teléfono sin broncas)
  const AB = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 50; tries++) {
    let s = 'RR-';
    for (let i = 0; i < 6; i++) s += AB[crypto.randomInt(AB.length)];
    if (!get('SELECT id FROM safety_certs WHERE code = ?', s)) return s;
  }
  return 'RR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}
function effStatus(r) {
  if (r.status === 'revoked') return 'revoked';
  if (r.status === 'certified') {
    const today = new Date().toISOString().slice(0, 10);
    if (r.expires_at && r.expires_at < today) return 'expired';
    return 'certified';
  }
  return r.status; // started | video_done | passed
}
function pubRow(r) {
  return {
    id: r.id, code: r.code, name: r.name, truck: r.truck, company: r.company,
    status: effStatus(r), certified_at: r.certified_at || '', expires_at: r.expires_at || '',
    sticker: r.sticker || '', lang: r.lang
  };
}
function certWindow() {
  const now = new Date();
  const exp = new Date(now.getTime() + CERT_DAYS * 86400e3);
  return { at: now.toISOString(), exp: exp.toISOString().slice(0, 10) };
}

// ---------- QUIZ (las respuestas correctas viven SOLO aquí, nunca en el cliente) ----------
// 8 preguntas directas del SOP de Roadrunner; opciones en el idioma del chofer.
const QUIZ = [
  { id: 'wind',
    q: { en: 'The wind limit on this site is…', es: 'El límite de viento en este sitio es…' },
    o: { en: ['15 mph sustained / 25 mph gusts', '25 mph sustained / 35 mph gusts', 'There is no wind limit'],
         es: ['15 mph sostenido / 25 mph rachas', '25 mph sostenido / 35 mph rachas', 'No hay límite de viento'] }, a: 1 },
  { id: 'lean',
    q: { en: 'The bed starts leaning or the load hangs up on one side. You…', es: 'La caja se empieza a ladear o la carga se cuelga de un lado. Tú…' },
    o: { en: ['Rock the truck to shake it loose', 'Pull forward fast', 'Lower the bed right away'],
         es: ['Sacudes el troque para soltarla', 'Te adelantas rápido', 'Bajas la caja de inmediato'] }, a: 2 },
  { id: 'tip',
    q: { en: 'Your truck starts to tip over. You…', es: 'Tu troque se empieza a voltear. Tú…' },
    o: { en: ['Jump out as fast as you can', 'Stay in the cab with your seat belt on and brace', 'Climb to the high side'],
         es: ['Saltas tan rápido como puedas', 'Te quedas en la cabina con el cinturón puesto y te sujetas', 'Te pasas al lado alto'] }, a: 1 },
  { id: 'power',
    q: { en: 'Your truck contacts a power line. You…', es: 'Tu troque toca una línea eléctrica. Tú…' },
    o: { en: ['Get out immediately and run', 'Stay in the cab, warn others away, call 911 and dispatch', 'Back up and keep working'],
         es: ['Te bajas de inmediato y corres', 'Te quedas en la cabina, alejas a la gente, llamas al 911 y a dispatch', 'Te echas de reversa y sigues trabajando'] }, a: 1 },
  { id: 'spot',
    q: { en: 'Who picks your dump spot?', es: '¿Quién escoge tu punto de descarga?' },
    o: { en: ['You, wherever looks level', 'The spotter — and you still check it yourself', 'The last driver in line'],
         es: ['Tú, donde se vea parejo', 'El spotter — y tú igual lo revisas', 'El último chofer de la fila'] }, a: 1 },
  { id: 'sticker',
    q: { en: 'The Proof of Training sticker must be…', es: 'El sticker de Proof of Training debe estar…' },
    o: { en: ['In your wallet', 'In the glove box', 'On the truck window, visible from outside'],
         es: ['En tu cartera', 'En la guantera', 'En la ventana del troque, visible desde afuera'] }, a: 2 },
  { id: 'phone',
    q: { en: 'Phone use on this site is…', es: 'El uso del teléfono en el sitio está…' },
    o: { en: ['OK while queueing', 'OK while dumping', 'Not allowed on site'],
         es: ['Permitido en la fila', 'Permitido mientras dumpeas', 'Prohibido en el sitio'] }, a: 2 },
  { id: 'after',
    q: { en: 'Before moving off the pad after dumping…', es: 'Antes de moverte del pad después de dumpear…' },
    o: { en: ['Bed can stay up if you go slow', 'Bed all the way down, tailgate closed, lock pins seated', 'Just honk twice'],
         es: ['La caja puede ir arriba si vas despacio', 'Caja completamente abajo, tailgate cerrada y pernos asentados', 'Solo pitas dos veces'] }, a: 1 }
];

// rate limit sencillo para los endpoints abiertos (por IP, ventana 1 h)
const _hits = new Map();
function rateOk(req, kind, max) {
  const k = kind + '|' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?');
  const now = Date.now();
  const e = _hits.get(k) || { n: 0, at: now };
  if (now - e.at > 3600e3) { e.n = 0; e.at = now; }
  e.n++; _hits.set(k, e);
  if (_hits.size > 5000) _hits.clear();
  return e.n <= max;
}
function byToken(req) {
  const t = String((req.body || {}).token || (req.query || {}).token || '');
  if (!/^[a-f0-9]{32}$/.test(t)) return null;
  return get('SELECT * FROM safety_certs WHERE token = ?', t) || null;
}

function attach(router, { config, log }) {
  migrate();
  const say = (m) => { try { log('safety: ' + m); } catch (e) {} };

  // ---------- CHOFER (abierto) ----------
  router.post('/api/safety/register', (req, res) => {
    if (!rateOk(req, 'reg', 40)) return res.status(429).json({ error: 'too many requests' });
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60);
    const truck = String(b.truck || '').trim().toUpperCase().slice(0, 20);
    const company = String(b.company || '').trim().slice(0, 60);
    const phone = String(b.phone || '').trim().slice(0, 20);
    const lang = b.lang === 'en' ? 'en' : 'es';
    if (name.length < 3 || !truck || company.length < 2) return res.status(400).json({ error: 'name, truck and company are required' });
    // mismo chofer + mismo troque con cert vigente → regresarle su constancia en vez de duplicar
    const dup = all('SELECT * FROM safety_certs WHERE UPPER(truck) = ? ORDER BY id DESC LIMIT 5', truck)
      .find(r => r.name.trim().toLowerCase() === name.toLowerCase() && effStatus(r) === 'certified');
    if (dup) return res.json({ ok: true, already: true, code: dup.code, expires_at: dup.expires_at });
    const token = crypto.randomBytes(16).toString('hex');
    const code = newCode();
    const r = run(`INSERT INTO safety_certs (code, token, name, truck, company, phone, lang, status, ua, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,'started',?,?,?)`,
      code, token, name, truck, company, phone, lang, String(req.headers['user-agent'] || '').slice(0, 160), nowISO(), nowISO());
    ev(r.lastInsertRowid, 'register', name + ' · ' + truck + ' · ' + company);
    res.json({ ok: true, token, code });
  });

  // VIDEO con soporte de Range (iPhone/Safari lo exige) — solo con token válido
  router.get('/api/safety/video', (req, res) => {
    const row = byToken(req);
    if (!row) return res.status(401).json({ error: 'bad token' });
    const lang = req.query.lang === 'en' ? 'en' : 'es';
    let file = path.join(VIDEO_DIR, 'video_' + lang + '.mp4');
    if (!fs.existsSync(file)) file = path.join(VIDEO_DIR, 'video_' + (lang === 'en' ? 'es' : 'en') + '.mp4'); // fallback al otro idioma
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'video not uploaded yet' });
    const stat = fs.statSync(file);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : Math.min(start + 4 * 1024 * 1024 - 1, stat.size - 1);
      if (isNaN(start) || start >= stat.size) return res.status(416).end();
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    }
  });

  // ¿hay videos subidos? (el front lo pregunta para avisar en vez de tronar)
  router.get('/api/safety/video-status', (req, res) => {
    const st = {};
    for (const l of ['en', 'es']) {
      const f = path.join(VIDEO_DIR, 'video_' + l + '.mp4');
      st[l] = fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1048576) : 0; // MB
    }
    res.json({ ok: true, videos: st });
  });

  // HEARTBEAT del video: el cliente reporta cada ~10 s; el server acumula con tope
  // por latido (nadie puede "ver" 8 minutos en 3 latidos). Esto ES el registro de vistas.
  router.post('/api/safety/beat', (req, res) => {
    const row = byToken(req);
    if (!row) return res.status(401).json({ error: 'bad token' });
    const dur = Math.max(0, Math.min(3600, Number((req.body || {}).dur) || 0));
    const delta = Math.max(0, Math.min(16, Number((req.body || {}).delta) || 0)); // tope 16 s por latido
    const secs = Math.min((row.video_seconds || 0) + delta, dur || 3600);
    const doneNow = dur > 60 && secs >= dur * WATCH_PCT && row.status === 'started';
    run('UPDATE safety_certs SET video_seconds = ?, video_dur = ?, status = ?, updated_at = ? WHERE id = ?',
      secs, dur || row.video_dur, doneNow ? 'video_done' : row.status, nowISO(), row.id);
    if (doneNow) ev(row.id, 'video_done', Math.round(secs) + 's of ' + Math.round(dur) + 's');
    res.json({ ok: true, watched: Math.round(secs), need: Math.round((dur || 0) * WATCH_PCT), done: doneNow || row.status !== 'started' });
  });

  // QUIZ: preguntas sin respuestas → calificación en el server
  router.get('/api/safety/quiz', (req, res) => {
    const row = byToken(req);
    if (!row) return res.status(401).json({ error: 'bad token' });
    if (row.status === 'started') return res.status(409).json({ error: 'watch the video first' });
    const lang = row.lang === 'en' ? 'en' : 'es';
    res.json({ ok: true, need: PASS_NEED, questions: QUIZ.map(q => ({ id: q.id, q: q.q[lang], o: q.o[lang] })) });
  });
  router.post('/api/safety/quiz', (req, res) => {
    const row = byToken(req);
    if (!row) return res.status(401).json({ error: 'bad token' });
    if (row.status === 'started') return res.status(409).json({ error: 'watch the video first' });
    const ans = (req.body || {}).answers || {};
    let score = 0;
    const wrong = [];
    for (const q of QUIZ) {
      if (Number(ans[q.id]) === q.a) score++; else wrong.push(q.id);
    }
    const passed = score >= PASS_NEED;
    run('UPDATE safety_certs SET quiz_score = ?, quiz_total = ?, quiz_tries = quiz_tries + 1, status = ?, updated_at = ? WHERE id = ?',
      score, QUIZ.length, passed ? 'passed' : row.status, nowISO(), row.id);
    ev(row.id, passed ? 'quiz_pass' : 'quiz_fail', score + '/' + QUIZ.length);
    res.json({ ok: true, passed, score, total: QUIZ.length, need: PASS_NEED, wrong: passed ? [] : wrong });
  });

  // FIRMA → certificado 180 días. "Video record views = certificación": aquí se sella.
  router.post('/api/safety/sign', (req, res) => {
    const row = byToken(req);
    if (!row) return res.status(401).json({ error: 'bad token' });
    if (row.status !== 'passed' && row.status !== 'certified') return res.status(409).json({ error: 'pass the quiz first' });
    const sig = String((req.body || {}).signature || '');
    if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]{200,}$/.test(sig) || sig.length > 300000) return res.status(400).json({ error: 'signature required' });
    const w = certWindow();
    run(`UPDATE safety_certs SET signature = ?, signed_at = ?, status = 'certified', certified_at = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
      sig, nowISO(), w.at, w.exp, nowISO(), row.id);
    ev(row.id, 'certified', 'expires ' + w.exp);
    say('CERTIFIED ' + row.name + ' · ' + row.truck + ' · ' + row.company + ' → ' + row.code);
    res.json({ ok: true, code: row.code, certified_at: w.at, expires_at: w.exp });
  });

  // mi constancia (pantalla final / volver a entrar con el mismo link)
  router.get('/api/safety/me', (req, res) => {
    const row = byToken(req);
    if (!row) return res.status(401).json({ error: 'bad token' });
    res.json({ ok: true, cert: pubRow(row), watched: Math.round(row.video_seconds || 0), dur: Math.round(row.video_dur || 0) });
  });

  // VERIFICACIÓN PÚBLICA (el QR del sticker/constancia apunta aquí)
  router.get('/api/safety/verify', (req, res) => {
    if (!rateOk(req, 'ver', 200)) return res.status(429).json({ error: 'too many requests' });
    const code = String(req.query.code || '').trim().toUpperCase();
    if (!/^RR-[A-Z0-9]{4,10}$/.test(code)) return res.status(400).json({ error: 'bad code' });
    const row = get('SELECT * FROM safety_certs WHERE code = ?', code);
    if (!row) return res.json({ ok: true, found: false });
    const st = effStatus(row);
    res.json({ ok: true, found: true, valid: st === 'certified', status: st,
      name: row.name, truck: row.truck, company: row.company,
      certified_at: (row.certified_at || '').slice(0, 10), expires_at: row.expires_at || '', sticker: row.sticker || '' });
  });

  // ---------- ADMIN (detrás del PIN del tracker) ----------
  router.get('/api/safety/admin/list', (req, res) => {
    const rows = all('SELECT * FROM safety_certs ORDER BY id DESC');
    const today = new Date().toISOString().slice(0, 10);
    res.json({ ok: true, rows: rows.map(r => ({
      ...pubRow(r), phone: r.phone, quiz: r.quiz_score + '/' + r.quiz_total, quiz_tries: r.quiz_tries,
      watched: Math.round(r.video_seconds || 0), dur: Math.round(r.video_dur || 0),
      source: r.source, added_by: r.added_by, notes: r.notes, created_at: r.created_at,
      signed: !!r.signature,
      days_left: (effStatus(r) === 'certified' && r.expires_at) ? Math.round((Date.parse(r.expires_at) - Date.parse(today)) / 86400e3) : null
    })) });
  });
  router.get('/api/safety/admin/signature', (req, res) => {
    const row = get('SELECT signature FROM safety_certs WHERE id = ?', Number(req.query.id) || 0);
    if (!row || !row.signature) return res.status(404).json({ error: 'no signature' });
    const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(row.signature);
    if (!m) return res.status(404).json({ error: 'bad signature' });
    res.setHeader('Content-Type', 'image/' + m[1]);
    res.end(Buffer.from(m[2], 'base64'));
  });

  // Certificación MANUAL (nota de Juan: "manually add driver certification")
  router.post('/api/safety/admin/manual', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60);
    const truck = String(b.truck || '').trim().toUpperCase().slice(0, 20);
    const company = String(b.company || '').trim().slice(0, 60);
    if (name.length < 3 || !truck || company.length < 2) return res.status(400).json({ error: 'name, truck and company are required' });
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
    res.json({ ok: true, code, expires_at: expAt });
  });

  // sticker entregado / notas / revocar / renovar
  router.post('/api/safety/admin/update', (req, res) => {
    const b = req.body || {};
    const row = get('SELECT * FROM safety_certs WHERE id = ?', Number(b.id) || 0);
    if (!row) return res.status(404).json({ error: 'not found' });
    const by = String(b.by || 'admin').slice(0, 40);
    if ('sticker' in b) { run('UPDATE safety_certs SET sticker = ?, updated_at = ? WHERE id = ?', String(b.sticker || '').slice(0, 20), nowISO(), row.id); ev(row.id, 'sticker', b.sticker + ' by ' + by); }
    if ('notes' in b) run('UPDATE safety_certs SET notes = ?, updated_at = ? WHERE id = ?', String(b.notes || '').slice(0, 200), nowISO(), row.id);
    if ('phone' in b) run('UPDATE safety_certs SET phone = ?, updated_at = ? WHERE id = ?', String(b.phone || '').slice(0, 20), nowISO(), row.id);
    if (b.action === 'revoke') { run(`UPDATE safety_certs SET status = 'revoked', updated_at = ? WHERE id = ?`, nowISO(), row.id); ev(row.id, 'revoked', 'by ' + by + (b.reason ? ' — ' + b.reason : '')); }
    if (b.action === 'renew') {
      // re-entrenamiento: vuelve a 'started' (debe ver el video y pasar el quiz otra vez)
      run(`UPDATE safety_certs SET status = 'started', video_seconds = 0, quiz_score = 0, quiz_tries = 0, signature = '', updated_at = ? WHERE id = ?`, nowISO(), row.id);
      ev(row.id, 'retrain', 'reset by ' + by);
    }
    res.json({ ok: true, row: pubRow(get('SELECT * FROM safety_certs WHERE id = ?', row.id)) });
  });

  // export CSV (Excel lo abre directo; BOM para acentos)
  router.get('/api/safety/admin/export.csv', (req, res) => {
    const rows = all('SELECT * FROM safety_certs ORDER BY id DESC');
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = ['Code', 'Name', 'Truck', 'Company', 'Phone', 'Status', 'Certified', 'Expires', 'Sticker', 'Quiz', 'Tries', 'VideoWatchedSec', 'Source', 'AddedBy', 'Notes', 'Created'];
    const lines = rows.map(r => [r.code, r.name, r.truck, r.company, r.phone, effStatus(r), (r.certified_at || '').slice(0, 10), r.expires_at, r.sticker,
      r.quiz_score + '/' + r.quiz_total, r.quiz_tries, Math.round(r.video_seconds || 0), r.source, r.added_by, r.notes, (r.created_at || '').slice(0, 10)].map(esc).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="roadrunner_safe_dumping_roster.csv"');
    res.send('﻿' + head.join(',') + '\n' + lines.join('\n'));
  });

  // SUBIR VIDEO (EN/ES): stream directo a disco — no pasa por express.json porque
  // el content-type es video/mp4. PUT /api/safety/admin/video?lang=es
  router.put('/api/safety/admin/video', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'es';
    const tmp = path.join(VIDEO_DIR, 'upload_' + lang + '.part');
    const dest = path.join(VIDEO_DIR, 'video_' + lang + '.mp4');
    const ws = fs.createWriteStream(tmp);
    let bytes = 0, dead = false;
    req.on('data', (c) => { bytes += c.length; if (bytes > 900 * 1048576 && !dead) { dead = true; ws.destroy(); try { fs.unlinkSync(tmp); } catch (e) {} ; res.status(413).json({ error: 'file too big (max 900 MB)' }); req.destroy(); } });
    req.pipe(ws);
    ws.on('finish', () => {
      if (dead) return;
      try { fs.renameSync(tmp, dest); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
      say('video ' + lang + ' uploaded: ' + Math.round(bytes / 1048576) + ' MB');
      res.json({ ok: true, lang, mb: Math.round(bytes / 1048576) });
    });
    ws.on('error', (e) => { if (!dead) res.status(500).json({ error: String(e.message || e) }); });
  });

  router.get('/api/safety/admin/events', (req, res) => {
    const id = Number(req.query.id) || 0;
    res.json({ ok: true, events: all('SELECT ts, kind, detail FROM safety_events WHERE cert_id = ? ORDER BY id DESC LIMIT 50', id) });
  });

  // páginas
  router.get('/safety', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'safety.html')));
  say('Safe Dumping platform mounted (/safety)');
}

module.exports = { attach };
