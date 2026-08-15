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
 *   node report-engine/report-cli.js sf --send            (Mondays: last week's Mon-Sat service failures + GP of lost loads)
 * Local test:
 *   node report-engine/report-cli.js night --local --day=tomorrow --offsubs=11
 *   node report-engine/report-cli.js sf --local --from=2026-08-03 --to=2026-08-08
 */
const fs = require('fs'), path = require('path');
const { NewMileClient } = require(path.join(__dirname, '..', 'mcp-client.js'));
const { buildBoard } = require('./server/mapping');
const { buildMorning, buildNight } = require('./server/noshow');
const servicefail = require('./server/servicefail');
let samsara = null; try { samsara = require('./server/samsara'); } catch (e) {}
let mailer = null; try { mailer = require('./server/mailer'); } catch (e) {}

const arg = (n, d) => { const m = process.argv.find(a => a.startsWith('--' + n + '=')); return m ? m.split('=')[1] : (process.argv.includes('--' + n) ? true : d); };
const KIND = (process.argv[2] || 'night').toLowerCase();
const LOCAL = !!arg('local', false);
const SEND = !!arg('send', false);
const GUARD = arg('guard', '');   // if set, only proceed when the current Central hour === guard

// OFF-APP subs resolution, most-trusted first:
//   1. explicit --offsubs= arg or MAB_OFFSUBS_INPUT (a human typed it on this run)
//   2. the OFFICE server (where dispatch actually keys the number in): GET <MAB_OFFICE_URL>/offapp
//   3. the MAB_OFFSUBS repo variable (static fallback)
async function resolveOffSubs(dateStr) {
  const typed = arg('offsubs', process.env.MAB_OFFSUBS_INPUT || '');
  if (typed !== '' && typed != null && typed !== true) return { n: parseInt(typed, 10) || 0, src: 'input' };
  const base = (process.env.MAB_OFFICE_URL || '').replace(/\/$/, '');
  if (base) {
    try {
      const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 10000);
      const r = await fetch(base + '/offapp?date=' + encodeURIComponent(dateStr), {
        headers: { 'ngrok-skip-browser-warning': 'true', Accept: 'application/json' }, signal: ac.signal
      });
      clearTimeout(tm);
      if (r.ok) {
        const j = await r.json();
        const n = parseInt(j.count != null ? j.count : j.offApp, 10);
        if (!isNaN(n) && n >= 0) return { n: n, src: 'office' };
      } else { console.log('  office /offapp HTTP ' + r.status + ' — falling back'); }
    } catch (e) { console.log('  office /offapp unreachable (' + (e.message || e) + ') — falling back'); }
  }
  return { n: parseInt(process.env.MAB_OFFSUBS || '0', 10) || 0, src: 'variable' };
}

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
  const mkClient = () => new NewMileClient({
    config: cfg, tokenPath: TOKEN_FILE,        // mcp-client refreshes + PERSISTS rotations here
    authorize: () => { throw new Error('headless: token expired/revoked — re-run login-cli to re-seed'); },
    onStatus: () => {}, onLog: (l) => { if (/refresh|connect|error/i.test(l)) console.log('  ' + l); }
  });
  let client = mkClient();
  let st = await client.resume();
  if ((!st || !st.connected) && process.env.MAB_NM_TOKEN) {
    // SELF-HEAL: the rotating token cached in .state is dead (refresh 400). Overwrite it with the
    // MAB_NM_TOKEN secret (a fresh login) and try once more — so recovery is just "update the
    // secret", with no manual Actions-cache clearing required.
    console.log('  cached NewMile token failed to connect — re-seeding from MAB_NM_TOKEN secret and retrying');
    try { fs.writeFileSync(TOKEN_FILE, process.env.MAB_NM_TOKEN); } catch (e) {}
    client = mkClient();
    st = await client.resume();
  }
  if (!st || !st.connected) throw new Error('NewMile token did not connect — update the MAB_NM_TOKEN secret with a fresh NewMile login (the refresh token expired)');

  // Render the Design-style print layout to a PDF buffer, when a renderer is available:
  // puppeteer-core (workflow installs it to NODE_PATH, no browser download) + the runner's
  // Chrome (CHROME_PATH or a standard path). Missing either -> null, the email ships CSVs only.
  async function renderSfPdf(rep, failures) {
    let puppeteer; try { puppeteer = require('puppeteer-core'); } catch (e) { return null; }
    const exe = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']
      .filter(Boolean).find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
    if (!exe) return null;
    const browser = await puppeteer.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu'] });
    try {
      const page = await browser.newPage();
      await page.setContent(servicefail.buildPrintHtml(rep, failures), { waitUntil: 'load' });
      return await page.pdf({
        format: 'Letter', printBackground: true,
        displayHeaderFooter: true, headerTemplate: '<span></span>',
        footerTemplate: servicefail.printFooterTemplate(rep),
        margin: { top: '0.55in', bottom: '0.85in', left: '0.6in', right: '0.6in' }
      });
    } finally { try { await browser.close(); } catch (e) {} }
  }

  // WEEKLY SERVICE FAILURES + GP OF LOST LOADS — pure report-API pull, needs no board/Samsara/off-app.
  // Runs Mondays over the prior Mon-Sat; --from/--to override for reruns of any week.
  if (KIND === 'sf') {
    const range = (arg('from', '') && arg('to', ''))
      ? { from: String(arg('from')), to: String(arg('to')) }
      : servicefail.lastWeekRange(centralDate(0));
    console.log('SF week: ' + range.from + ' -> ' + range.to);
    const raw = await servicefail.fetchWeek(client, range.from, range.to);
    console.log('  pulled: ' + raw.failures.length + ' failures · ' + raw.orders.length + ' orders · ' + raw.poMargin.length + ' PO margin rows');
    const rep = servicefail.buildServiceFailures(raw, range);
    const t = rep.totals;
    const gpK = '$' + (Math.abs(t.lostGp) >= 1000 ? (t.lostGp / 1000).toFixed(1) + 'K' : t.lostGp.toFixed(1));
    const subject = '📉 Service Failures ' + range.from + ' → ' + range.to + ' — ' + gpK + ' GP lost · ' + t.failures + ' failures';
    console.log('SF: failures ' + t.failures + ' (' + t.critical + ' critical) · orders hit ' + t.failedOrders +
      ' · loads lost ' + Math.round(t.loadsLost) + ' · lost revenue $' + t.lostRevenue.toFixed(2) + ' · LOST GP $' + t.lostGp.toFixed(2));
    if (rep.unmatched.length) console.log('  UNMATCHED failures (order name typo in NewMile?): ' + rep.unmatched.map(f => f.order_reference).join('; '));
    if (SEND) {
      if (!mailer) throw new Error('mailer module missing');
      // REPORT_TO_SF lets the weekly GP report go to its own list (e.g. leadership) without
      // touching the morning/night recipients; falls back to the shared REPORT_TO.
      const reportCfg = { to: process.env.REPORT_TO_SF || process.env.REPORT_TO || arg('to', '').toString(), from: process.env.REPORT_FROM || 'onboarding@resend.dev', resendKey: process.env.RESEND_KEY || arg('resend', '').toString() };
      if (!reportCfg.to) throw new Error('no recipient (REPORT_TO_SF / REPORT_TO)');
      let atts = rep.attachments;
      try {
        const pdf = await renderSfPdf(rep, raw.failures);
        if (pdf) atts = [{ filename: 'Milestone_Tx_SF_Report_' + range.from + '_' + range.to + '.pdf', content: pdf }].concat(rep.attachments);
        console.log('  pdf attachment: ' + (pdf ? 'yes (' + pdf.length + ' bytes)' : 'no renderer available — sending CSVs only'));
      } catch (e) { console.log('  pdf render failed (sending CSVs only): ' + (e.message || e)); }
      const m = await mailer.sendEmail(reportCfg, { subject: subject, html: rep.html, text: rep.text, attachments: atts });
      console.log('email: ' + JSON.stringify(m));
      if (!m.ok) process.exit(1);
      markSent(KIND, centralDate(0));
    } else {
      console.log('(dry run — no email sent)\n');
      console.log('----- REPORT BEGIN -----\n' + rep.text + '\n----- REPORT END -----');
      try { fs.writeFileSync(path.join(STATE_DIR, 'sf-preview.html'), rep.html); console.log('html preview: report-engine/.state/sf-preview.html'); } catch (e) {}
    }
    return;
  }

  const today = centralDate(0);
  const raw = await client.refreshAll(today);
  let sam = {};
  if (samsara && cfg.samsara && (cfg.samsara.tokens || []).length) {
    try { sam = await samsara.getSamsara('cloud-report', cfg, () => {}); } catch (e) { console.log('samsara skipped: ' + e.message); }
  }
  const board = buildBoard(raw, sam, cfg.groups || null);
  // night plans TOMORROW's fleet, so its off-app count is tomorrow's too
  const offR = await resolveOffSubs(KIND === 'morning' ? today : centralDate(1));
  const OFF = offR.n;
  console.log('  off-app subs: ' + OFF + ' (source: ' + offR.src + ')');

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
    console.log('(dry run — no email sent)\n');
    console.log('----- REPORT BEGIN -----\n' + rep.text + '\n----- REPORT END -----');
  }
})().catch(e => { console.error('FAIL: ' + e.message); process.exit(1); });
