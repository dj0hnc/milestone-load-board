'use strict';
/*
 * CLOUD report runner (GitHub Actions). Generates the SAME morning/night reports as the app,
 * reusing server/mapping.buildBoard + server/noshow.buildMorning/buildNight + server/mailer, with
 * the NewMile brain (../mcp-client.js) — fully headless, no PC.
 *
 * Auth: a DEDICATED NewMile token lives in .state/nm-token.json and SELF-ROTATES (mcp-client
 *       refreshes + persists it; the workflow commits it back each run). First run seeds it from
 *       the MAB_NM_TOKEN secret if the file is missing.
 * Config (endpoints + Samsara tokens + report groups): MAB_NM_CONFIG secret (JSON), or --local file.
 * Email: RESEND_KEY + REPORT_TO (+ REPORT_FROM) env.
 *
 * Usage in CI:
 *   node report-engine/report-cli.js morning --send --guard=7
 *   node report-engine/report-cli.js night   --send --guard=20
 * Local test:
 *   node report-engine/report-cli.js night --local --day=tomorrow --offsubs=11
 */
const fs = require('fs'), path = require('path');
const { NewMileClient } = require(path.join(__dirname, '..', 'mcp-client.js'));
const { buildBoard } = require('./server/mapping');
const { buildMorning, buildNight } = require('./server/noshow');
let samsara = null; try { samsara = require('./server/samsara'); } catch (e) {}
let mailer = null; try { mailer = require('./server/mailer'); } catch (e) {}

const arg = (n, d) => { const m = process.argv.find(a => a.startsWith('--' + n + '=')); return m ? m.split('=')[1] : (process.argv.includes('--' + n) ? true : d); };
const KIND = (process.argv[2] || 'night').toLowerCase();
const LOCAL = !!arg('local', false);
const SEND = !!arg('send', false);
const OFF = parseInt(arg('offsubs', process.env.MAB_OFFSUBS || '0'), 10) || 0;
const GUARD = arg('guard', '');   // if set, only proceed when the current Central hour === guard

const STATE_DIR = path.join(__dirname, '.state');
const TOKEN_FILE = path.join(STATE_DIR, 'nm-token.json');
const SENT_FILE = path.join(STATE_DIR, 'last-sent.json');
const FORCE = !!arg('force', false);   // bypass the once-per-day lock (manual test runs)

function sentToday(kind, dateStr) {
  try { return (JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')) || {})[kind] === dateStr; } catch (e) { return false; }
}
function markSent(kind, dateStr) {
  let m = {}; try { m = JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')) || {}; } catch (e) {}
  m[kind] = dateStr; try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(SENT_FILE, JSON.stringify(m, null, 2)); } catch (e) {}
}

function loadConfig() {
  if (LOCAL) return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'newmile.config.json'), 'utf8'));
  if (process.env.MAB_NM_CONFIG) return JSON.parse(process.env.MAB_NM_CONFIG);
  throw new Error('no config: set MAB_NM_CONFIG (or use --local)');
}
function seedTokenIfNeeded() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) {}
  if (LOCAL && !fs.existsSync(TOKEN_FILE)) {
    // local: seed from the dedicated login output if present
    const cand = path.join(__dirname, '..', '..', 'mab-mobile', 'cloud-newmile-token.json');
    if (fs.existsSync(cand)) fs.copyFileSync(cand, TOKEN_FILE);
  }
  if (!fs.existsSync(TOKEN_FILE) && process.env.MAB_NM_TOKEN) {
    fs.writeFileSync(TOKEN_FILE, process.env.MAB_NM_TOKEN);
  }
  if (!fs.existsSync(TOKEN_FILE)) throw new Error('no NewMile token: seed .state/nm-token.json or set MAB_NM_TOKEN');
}
function centralHour() { return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hour12: false }), 10); }
function centralDate(offsetDays) {
  const base = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  if (!offsetDays) return base;
  const d = new Date(base + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

(async () => {
  // once-per-day lock: a scheduled kind sends only ONCE per Central day, no matter how many times
  // the cron (or a retry) fires. --force bypasses it for manual test runs.
  if (SEND && !FORCE && sentToday(KIND, centralDate(0))) { console.log('already sent ' + KIND + ' today (' + centralDate(0) + ') — skipping'); return; }
  const cfg = loadConfig();
  seedTokenIfNeeded();
  const client = new NewMileClient({
    config: cfg, tokenPath: TOKEN_FILE,        // mcp-client refreshes + PERSISTS rotations here
    authorize: () => { throw new Error('headless: token expired/revoked — re-run login-cli to re-seed'); },
    onStatus: () => {}, onLog: (l) => { if (/refresh|connect|error/i.test(l)) console.log('  ' + l); }
  });
  const st = await client.resume();
  if (!st || !st.connected) throw new Error('NewMile token did not connect');

  const today = centralDate(0);
  const raw = await client.refreshAll(today);
  let sam = {};
  if (samsara && cfg.samsara && (cfg.samsara.tokens || []).length) {
    try { sam = await samsara.getSamsara('cloud-report', cfg, () => {}); } catch (e) { console.log('samsara skipped: ' + e.message); }
  }
  const board = buildBoard(raw, sam, cfg.groups || null);

  let rep, subject;
  if (KIND === 'morning') {
    rep = buildMorning(board, { offSubs: OFF, dateKey: today });
    subject = '🚛 Morning No-Show Report — ' + rep.count + ' not working (' + rep.dateStr + ' CT)';
    console.log('MORNING: not-working ' + rep.count + ' · working ' + rep.totalWorking + ' · off-app ' + OFF);
  } else {
    const dayParam = (arg('day', 'tomorrow') || 'tomorrow').toString();
    const dayIdx = dayParam === 'today' ? 4 : (dayParam === 'yesterday' ? 3 : 5);
    const dk = dayIdx === 4 ? centralDate(0) : (dayIdx === 3 ? centralDate(-1) : centralDate(1));
    rep = buildNight(board, { dayIdx: dayIdx, label: dayParam, offSubs: OFF, dateKey: dk });
    subject = '🌙 Nightly Fleet Assignment — ' + (rep.total + OFF) + ' trucks for tomorrow (' + rep.dateStr + ' CT)';
    console.log('NIGHT: ' + JSON.stringify(rep.fleetCounts) + ' · in-app ' + rep.total + ' · off-app ' + OFF + ' · GRAND ' + (rep.total + OFF));
  }

  if (SEND) {
    if (!mailer) throw new Error('mailer module missing');
    const reportCfg = { to: process.env.REPORT_TO || arg('to', '').toString(), from: process.env.REPORT_FROM || 'onboarding@resend.dev', resendKey: process.env.RESEND_KEY || arg('resend', '').toString() };
    if (!reportCfg.to) throw new Error('no recipient (REPORT_TO)');
    const m = await mailer.sendEmail(reportCfg, { subject: subject, html: rep.html, text: rep.text });
    console.log('email: ' + JSON.stringify(m));
    if (!m.ok) process.exit(1);
    markSent(KIND, centralDate(0));   // lock so it won't re-send today
  } else {
    console.log('(dry run — add --send to email)');
  }
})().catch(e => { console.error('FAIL: ' + e.message); process.exit(1); });
