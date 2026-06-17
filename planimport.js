'use strict';
/*
 * Find + read the monthly dispatch order-sheet straight off the OneDrive-synced folder on THIS PC
 * (no Microsoft login needed — the file is local). Ported from the mobile server. Pure Node.
 * Used by main.js IPC nm:scanPlan / nm:readPlan.
 */
const fs = require('fs');
const path = require('path');
const sheet = require('./sheet');

const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Duplicate / non-canonical copies that must NEVER be picked over the live working sheet.
const JUNK_FILE = /(\b|_|-)(test|copy|backup|archive|old|template|draft|sample)(\b|_|-)|~\$/i;

// Windows OneDrive folders (esp. "OneDrive - <Company>" + SharePoint shortcuts) are reparse
// points → readdir reports them as neither file nor dir. Resolve via statSync.
function entKind(p, e) {
  let isDir = e ? e.isDirectory() : false, isFile = e ? e.isFile() : false;
  if (!isDir && !isFile) { try { const s = fs.statSync(p); isDir = s.isDirectory(); isFile = s.isFile(); } catch (x) {} }
  return { isDir, isFile };
}
function listOneDriveRoots() {
  const up = process.env.USERPROFILE || process.env.HOME || '';
  const out = [];
  try { fs.readdirSync(up, { withFileTypes: true }).forEach((d) => { if (/^OneDrive/i.test(d.name)) { const p = path.join(up, d.name); if (entKind(p, d).isDir) out.push(p); } }); } catch (e) {}
  return out;
}
function findPlanFiles(prefix, max) {
  const re = /(lease dispatch|dispatch|order sheet|load ?plan).*\.(xlsx|xlsm|csv)$/i;
  const hits = []; const cap = max || 60;
  const walk = (dir, depth) => {
    if (depth > 6 || hits.length >= cap) return;
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (/^[.$~]/.test(e.name)) continue;
      const p = path.join(dir, e.name); const k = entKind(p, e);
      if (k.isFile && re.test(e.name) && !JUNK_FILE.test(e.name)) {     // skip TEST/copy/backup duplicates
        let st = {}; try { st = fs.statSync(p); } catch (x) {}
        const folder = path.dirname(p).toLowerCase();                   // prefer a real dispatch/order-sheet FOLDER…
        const score = (/order sheet/.test(folder) ? 3 : 0) + (/dispatch/.test(folder) ? 1 : 0);  // …over a loose copy in the OneDrive root
        hits.push({ path: p, dir: dir, name: e.name, mtime: st.mtimeMs || 0, score: score });
      }
      else if (k.isDir && !JUNK_FILE.test(e.name)) walk(p, depth + 1);
    }
  };
  listOneDriveRoots().forEach((r) => walk(r, 0));
  hits.sort((a, b) => (b.score - a.score) || (b.mtime - a.mtime));   // canonical folder first, then most-recent
  return hits.slice(0, cap);
}
function pickMonthFile(dir, dateISO) {
  const d = new Date((dateISO || '') + 'T12:00:00'); if (isNaN(d)) return null;
  const m = MONTHS_FULL[d.getMonth()], ab = m.slice(0, 3), y = String(d.getFullYear());
  let ents = []; try { ents = fs.readdirSync(dir); } catch (e) { return null; }
  const xlsx = ents.filter((n) => /\.(xlsx|xlsm|csv)$/i.test(n) && !/^[~$]/.test(n) && !JUNK_FILE.test(n));
  const reM = new RegExp('(^|[^a-z])' + m + '([^a-z]|$)', 'i'), reA = new RegExp('(^|[^a-z])' + ab + '([^a-z]|$)', 'i');
  let cand = xlsx.filter((n) => reM.test(n) || reA.test(n));
  const withY = cand.filter((n) => n.indexOf(y) >= 0); if (withY.length) cand = withY;
  if (!cand.length) return null;
  cand.sort((a, b) => { try { return fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs; } catch (e) { return 0; } });
  return cand[0];
}

function scan(prefix) {
  return { roots: listOneDriveRoots(), files: findPlanFiles(prefix || 'Lease Dispatch').map((f) => ({ name: f.name, dir: f.dir, path: f.path })) };
}

// read the plan for dateISO. opts: { dir, file, prefix }. Self-heals: if the chosen file lacks the
// day's tab, scans other synced order sheets for one that has it.
function readPlan(dateISO, opts) {
  opts = opts || {};
  const day = dateISO || new Date().toISOString().slice(0, 10);
  const prefix = opts.prefix || 'Lease Dispatch';
  let dir = opts.dir;
  if (opts.file && fs.existsSync(opts.file)) dir = path.dirname(opts.file);
  if (!dir) { const found = findPlanFiles(prefix, 1); if (!found.length) return { error: 'No dispatch sheet synced to this PC yet — Sync the SharePoint folder in OneDrive first' }; dir = found[0].dir; }
  if (!fs.existsSync(dir)) return { error: 'Folder not found: ' + dir };
  let ents = []; try { ents = fs.readdirSync(dir); } catch (e) { return { error: 'Cannot read ' + dir }; }
  let target = (opts.file && fs.existsSync(opts.file) && path.dirname(opts.file) === dir ? path.basename(opts.file) : null) || pickMonthFile(dir, day);
  if (!target) return { error: 'No order sheet for that month in the folder', candidates: ents.filter((n) => /\.(xlsx|xlsm|csv)$/i.test(n)).slice(0, 20) };
  let buf; try { buf = fs.readFileSync(path.join(dir, target)); } catch (e) { return { error: 'Could not open ' + target + ' (still syncing?)' }; }
  let parsed = sheet.parsePlan(buf, day);
  let usedPath = path.join(dir, target);
  if (parsed.error) {                          // self-heal: find another synced sheet WITH this day's tab
    const others = findPlanFiles(prefix, 30).concat(findPlanFiles('TX Order Sheet', 30));
    const seen = {};
    for (const cand of others) {
      if (cand.path === usedPath || seen[cand.path]) continue; seen[cand.path] = 1;
      let b2; try { b2 = fs.readFileSync(cand.path); } catch (e) { continue; }
      const p2 = sheet.parsePlan(b2, day);
      if (p2 && !p2.error) { parsed = p2; usedPath = cand.path; target = cand.name; break; }
    }
  }
  if (parsed.error) return { error: parsed.error, file: target, tabs: parsed.tabs || null };
  return { file: target, dir: path.dirname(usedPath), format: parsed.format || parsed.mode, tab: parsed.tab || null, orders: parsed.orders || null, pairs: parsed.pairs || [] };
}

module.exports = { scan, readPlan, findPlanFiles, listOneDriveRoots, pickMonthFile };
