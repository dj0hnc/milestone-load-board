'use strict';
/*
 * ONE-COMMAND NewMile login for the CLOUD reports — generates a DEDICATED token so the
 * GitHub Actions reports stop sharing (and killing) the desktop app's session.
 *
 *   node report-engine/login-cli.js                 (uses ./newmile.config.json)
 *   node report-engine/login-cli.js --config=C:\path\to\newmile.config.json
 *
 * What it does:
 *   1. Opens your browser to the NewMile sign-in page (own OAuth client, own refresh token).
 *   2. Catches the redirect on http://127.0.0.1:<port>/callback locally.
 *   3. Writes cloud-newmile-token.json and PRINTS the exact blob to paste into the
 *      GitHub secret MAB_NM_TOKEN (repo -> Settings -> Secrets and variables -> Actions).
 *
 * Run it on any PC with a browser (the office PC works). Nothing else to install — plain Node.
 */
const fs = require('fs'), path = require('path'), http = require('http');
const { execFile } = require('child_process');
const { NewMileClient } = require(path.join(__dirname, '..', 'mcp-client.js'));

const arg = (n, d) => { const m = process.argv.find(a => a.startsWith('--' + n + '=')); return m ? m.split('=').slice(1).join('=') : d; };

function loadConfig() {
  const p = arg('config', '');
  if (p) return JSON.parse(fs.readFileSync(p, 'utf8'));
  if (process.env.MAB_NM_CONFIG) return JSON.parse(process.env.MAB_NM_CONFIG);
  const local = path.join(__dirname, '..', 'newmile.config.json');
  if (fs.existsSync(local)) return JSON.parse(fs.readFileSync(local, 'utf8'));
  console.error('No config found. Pass --config=<path to newmile.config.json> (the desktop app Settings can export it),');
  console.error('or place newmile.config.json next to package.json. A template is in newmile.config.template.json.');
  process.exit(1);
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try { execFile(cmd[0], cmd[1]); } catch (e) { /* user can copy-paste the printed URL */ }
}

// authorize(authUrl, redirectUri): serve the local callback, open the browser, resolve with the
// full redirect URL — the same contract the desktop app fulfills with its login window.
function authorize(authUrl, redirectUri) {
  return new Promise((resolve, reject) => {
    const u = new URL(redirectUri);
    const server = http.createServer((req, res) => {
      if (!req.url.startsWith(u.pathname)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2 style="font-family:sans-serif">&#9989; Login received &mdash; go back to the terminal.</h2>');
      server.close();
      resolve('http://127.0.0.1:' + u.port + req.url);
    });
    server.on('error', e => reject(new Error('Could not listen on ' + redirectUri + ': ' + e.message +
      ' (is the desktop app open? close it or set oauth.redirectPort to a free port in the config)')));
    server.listen(Number(u.port), '127.0.0.1', () => {
      console.log('\nOpening your browser to sign in to NewMile…');
      console.log('If it does not open, copy this URL manually:\n\n  ' + authUrl + '\n');
      openBrowser(authUrl);
    });
    setTimeout(() => { try { server.close(); } catch (e) {} reject(new Error('Timed out after 5 minutes waiting for the login.')); }, 5 * 60 * 1000).unref();
  });
}

(async () => {
  const cfg = loadConfig();
  const outFile = path.resolve(arg('out', path.join(__dirname, '..', 'cloud-newmile-token.json')));
  // fresh dedicated identity: never reuse the desktop's saved client/tokens
  try { fs.unlinkSync(outFile); } catch (e) {}
  const client = new NewMileClient({
    config: cfg, tokenPath: outFile,
    authorize: authorize,
    onStatus: () => {}, onLog: l => console.log('  ' + l)
  });
  const st = await client.connect();
  console.log('\n✅ Connected as ' + (st.user || '?') + ' · ' + (st.org || ''));
  const blob = fs.readFileSync(outFile, 'utf8');
  console.log('\n================= COPY EVERYTHING BETWEEN THE LINES =================');
  console.log(blob);
  console.log('======================================================================');
  console.log('\nPaste that into GitHub -> repo milestone-load-board -> Settings ->');
  console.log('Secrets and variables -> Actions -> MAB_NM_TOKEN -> Update secret.');
  console.log('(Also saved to ' + outFile + ' — delete it after pasting.)');
  process.exit(0);
})().catch(e => { console.error('\nFAIL: ' + (e.message || e)); process.exit(1); });
