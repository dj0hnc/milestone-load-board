'use strict';
/*
 * Dependency-free email sender for the morning no-show report.
 *  - sendEmail(cfg, msg) tries SMTP first (Office 365: smtp.office365.com:587 STARTTLS + AUTH LOGIN)
 *    when cfg.smtp.user+pass are set; if that fails (M365 often disables SMTP AUTH) and cfg.resendKey
 *    is set, falls back to Resend (https://api.resend.com — plain HTTPS, no dependency).
 *  - cfg = { to, from, smtp:{host,port,user,pass}, resendKey }
 *  - msg = { subject, html, text }
 *  Returns { ok, via, error }.
 */
const net = require('net');
const tls = require('tls');

// ---- raw SMTP over STARTTLS (works for Office 365 when SMTP AUTH is enabled on the mailbox) ----
// Sequential state machine. Handles multiline 250- EHLO replies, the mid-stream TLS upgrade, and
// MULTIPLE recipients (one RCPT TO per address).
function smtpSend(smtp, from, toArr, subject, text, html) {
  return new Promise((resolve) => {
    const host = smtp.host || 'smtp.office365.com', port = smtp.port || 587;
    const enc = s => Buffer.from(String(s), 'utf8').toString('base64');
    let rcptIdx = 0;
    const body = ['From: ' + from, 'To: ' + toArr.join(', '), 'Subject: ' + subject,
      'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', (html || text || '')].join('\r\n');
    let sock = net.connect(port, host), phase = 'greet', lineBuf = '', done = false;
    const finish = (ok, err) => { if (done) return; done = true; try { sock.end(); } catch (e) {} resolve({ ok: ok, error: err || null }); };
    const onErr = e => finish(false, String(e && e.message || e));
    const send = s => { try { sock.write(s + '\r\n'); } catch (e) { onErr(e); } };
    function handle(line) {
      const code = line.slice(0, 3), cont = line.charAt(3) === '-';   // 250- = multiline continuation
      switch (phase) {
        case 'greet': if (code !== '220') return finish(false, 'greet: ' + line); phase = 'ehlo1'; send('EHLO mab'); break;
        case 'ehlo1': if (code !== '250') return finish(false, 'ehlo1: ' + line); if (cont) return; phase = 'starttls'; send('STARTTLS'); break;
        case 'starttls': if (code !== '220') return finish(false, 'starttls: ' + line); upgradeTLS(); break;
        case 'ehlo2': if (code !== '250') return finish(false, 'ehlo2: ' + line); if (cont) return; phase = 'authlogin'; send('AUTH LOGIN'); break;
        case 'authlogin': if (code !== '334') return finish(false, 'auth: ' + line); phase = 'authuser'; send(enc(smtp.user)); break;
        case 'authuser': if (code !== '334') return finish(false, 'authuser: ' + line); phase = 'authpass'; send(enc(smtp.pass)); break;
        case 'authpass': if (code !== '235') return finish(false, 'login rejected (SMTP AUTH likely disabled by IT): ' + line); phase = 'mail'; send('MAIL FROM:<' + from + '>'); break;
        case 'mail': if (code !== '250') return finish(false, 'mail: ' + line); phase = 'rcpt'; rcptIdx = 0; send('RCPT TO:<' + toArr[0] + '>'); break;
        case 'rcpt': if (code !== '250' && code !== '251') return finish(false, 'rcpt: ' + line); rcptIdx++; if (rcptIdx < toArr.length) { send('RCPT TO:<' + toArr[rcptIdx] + '>'); } else { phase = 'data'; send('DATA'); } break;
        case 'data': if (code !== '354') return finish(false, 'data: ' + line); phase = 'body'; send(body + '\r\n.'); break;
        case 'body': if (code !== '250') return finish(false, 'send failed: ' + line); phase = 'done'; send('QUIT'); finish(true); break;
      }
    }
    function attach(s) {
      s.setTimeout(25000, () => finish(false, 'smtp timeout (' + phase + ')')); s.on('error', onErr);
      s.on('data', d => { lineBuf += d.toString('utf8'); let idx; while ((idx = lineBuf.indexOf('\n')) >= 0) { const line = lineBuf.slice(0, idx).replace(/\r$/, ''); lineBuf = lineBuf.slice(idx + 1); if (line) handle(line); } });
    }
    function upgradeTLS() { const plain = sock; plain.removeAllListeners('data'); plain.removeAllListeners('error'); lineBuf = ''; phase = 'ehlo2'; sock = tls.connect({ socket: plain, servername: host }, () => send('EHLO mab')); attach(sock); }
    attach(sock);
  });
}

// ---- Resend (plain HTTPS, no dependency) ----
// attachments: [{ filename, content }] where content is a utf8 string (CSV etc.) or a Buffer —
// Resend wants base64.
async function resendSend(key, from, toArr, subject, html, text, attachments) {
  try {
    const atts = (attachments || []).map(a => ({
      filename: a.filename,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(String(a.content), 'utf8').toString('base64')
    }));
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from, to: toArr, subject: subject, html: html || undefined, text: text || undefined, attachments: atts.length ? atts : undefined })
    });
    if (r.ok) return { ok: true };
    const j = await r.json().catch(() => ({}));
    return { ok: false, error: 'Resend ' + r.status + ': ' + ((j && j.message) || '') };
  } catch (e) { return { ok: false, error: 'Resend ' + (e.message || e) }; }
}

async function sendEmail(cfg, msg) {
  cfg = cfg || {}; msg = msg || {};
  // to can be a single string, a comma/semicolon-separated string, or an array
  const toArr = (Array.isArray(cfg.to) ? cfg.to : String(cfg.to || '').split(/[,;]/)).map(s => String(s).trim()).filter(Boolean);
  const from = cfg.from || toArr[0];
  if (!toArr.length) return { ok: false, error: 'no recipient (report.to) configured' };
  // attachments ride only on Resend (the raw SMTP path has no MIME multipart) — when the message
  // carries attachments and a Resend key exists, go straight to Resend so they aren't dropped.
  if (msg.attachments && msg.attachments.length && cfg.resendKey) {
    const r = await resendSend(cfg.resendKey, from, toArr, msg.subject || '', msg.html || '', msg.text || '', msg.attachments);
    if (r.ok) return { ok: true, via: 'resend', to: toArr };
    return { ok: false, via: 'resend', error: r.error };
  }
  // 1) try Office 365 SMTP if creds present
  let smtpErr;
  if (cfg.smtp && cfg.smtp.user && cfg.smtp.pass) {
    const r = await smtpSend(cfg.smtp, from, toArr, msg.subject || '', msg.text || '', msg.html || '');
    if (r.ok) return { ok: true, via: 'smtp', to: toArr };
    if (!cfg.resendKey) return { ok: false, via: 'smtp', error: r.error };
    smtpErr = r.error;   // SMTP failed but we have Resend → fall through
  }
  // 2) Resend fallback
  if (cfg.resendKey) {
    const r = await resendSend(cfg.resendKey, from, toArr, msg.subject || '', msg.html || '', msg.text || '');
    if (r.ok) return { ok: true, via: 'resend', to: toArr };
    return { ok: false, via: 'resend', error: r.error + (smtpErr ? ' (smtp also failed: ' + smtpErr + ')' : '') };
  }
  return { ok: false, error: 'no email method configured (need smtp user/pass or resendKey)' };
}

module.exports = { sendEmail, smtpSend, resendSend };
