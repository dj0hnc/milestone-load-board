'use strict';
/*
 * Fusiona la base de datos rescatada de Azure con la LOCAL (la de esta máquina).
 * Uso:  node merge-azure.js C:\ruta\a\cactus-azure.db
 *
 * Regla: LO LOCAL GANA. Azure solo RELLENA lo que aquí está vacío/default:
 *  - trucks: star, status(+nota/fecha), note, phone, tags, rip_rap, rest_days,
 *    trailer_type (si allá estaba blindado), area/division solo si aquí no hay
 *  - time_off: rangos que no existan aquí
 *  - dispatch_state: días completos que aquí no existan (historial de marcas)
 *  - activity_log / truck_log / parking_log: historial (insert-or-ignore)
 * Es seguro correrlo con el tracker prendido (transacciones cortas, busy_timeout).
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const src = process.argv[2];
if (!src) { console.error('Uso: node merge-azure.js <ruta a cactus-azure.db>'); process.exit(1); }

const localPath = process.env.CACTUS_DATA_DIR
  ? path.join(process.env.CACTUS_DATA_DIR, 'cactus.db')
  : path.join(__dirname, 'data', 'cactus.db');
const db = new DatabaseSync(localPath);
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`ATTACH DATABASE '${String(src).replace(/'/g, "''")}' AS az`);

const one = (q, ...p) => db.prepare(q).get(...p);
const runq = (q, ...p) => db.prepare(q).run(...p);
const azCols = new Set(db.prepare(`SELECT name FROM az.pragma_table_info('trucks')`).all().map(r => r.name));
const has = c => azCols.has(c);
let stats = { stars: 0, status: 0, fields: 0, timeoff: 0, dispatch: 0, activity: 0, log: 0, parking: 0 };

// ---- trucks: rellenar campos manuales donde lo local está vacío/default ----
for (const a of db.prepare('SELECT * FROM az.trucks').all()) {
  const l = one('SELECT * FROM trucks WHERE org_id = ? AND number = ?', a.org_id, a.number);
  if (!l) continue; // truck que ya no existe aquí: no lo revivimos
  const sets = [], vals = [];
  if (has('star') && a.star === 1 && !l.star) { sets.push('star = 1'); stats.stars++; }
  if (a.status && a.status !== 'ok' && (!l.status || l.status === 'ok')) {
    sets.push('status = ?', 'status_note = ?', 'return_date = ?');
    vals.push(a.status, a.status_note || '', a.return_date || '');
    stats.status++;
  }
  for (const f of ['note', 'phone', 'tags', 'rest_days']) {
    if (a[f] && !l[f]) { sets.push(`${f} = ?`); vals.push(a[f]); stats.fields++; }
  }
  if (a.rip_rap === 1 && !l.rip_rap) { sets.push('rip_rap = 1'); stats.fields++; }
  if (has('trailer_override') && a.trailer_override === 1 && a.trailer_type && !l.trailer_override) {
    sets.push('trailer_type = ?', 'trailer_override = 1'); vals.push(a.trailer_type); stats.fields++;
  }
  if (a.area && a.area !== '(SIN YARD)' && (!l.area || l.area === '(SIN YARD)')) { sets.push('area = ?'); vals.push(a.area); stats.fields++; }
  if (a.division && !l.division) { sets.push('division = ?'); vals.push(a.division); stats.fields++; }
  if (has('owner_name') && a.owner_name && !l.owner_name) { sets.push('owner_name = ?'); vals.push(a.owner_name); stats.fields++; }
  if (sets.length) runq(`UPDATE trucks SET ${sets.join(', ')} WHERE org_id = ? AND number = ?`, ...vals, a.org_id, a.number);
}

// ---- time_off: rangos faltantes ----
for (const o of db.prepare('SELECT * FROM az.time_off').all()) {
  const dup = one('SELECT 1 AS x FROM time_off WHERE org_id = ? AND number = ? AND from_date = ? AND to_date = ?',
    o.org_id, o.number, o.from_date, o.to_date);
  if (dup) continue;
  runq(`INSERT INTO time_off (org_id, number, from_date, to_date, reason, note, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?)`, o.org_id, o.number, o.from_date, o.to_date, o.reason, o.note || '', o.created_by || '', o.created_at || '');
  stats.timeoff++;
}

// ---- dispatch_state: solo DÍAS que aquí no existen (historial viejo) ----
const localDays = new Set(db.prepare('SELECT DISTINCT date FROM dispatch_state').all().map(r => r.date));
for (const s of db.prepare('SELECT * FROM az.dispatch_state').all()) {
  if (localDays.has(s.date)) continue; // ese día ya se trabaja aquí: no mezclar
  runq(`INSERT OR IGNORE INTO dispatch_state (date, org_id, number, state, source, marked_by, marked_at)
        VALUES (?,?,?,?,?,?,?)`, s.date, s.org_id, s.number, s.state, s.source || 'manual', s.marked_by || '', s.marked_at || '');
  stats.dispatch++;
}

// ---- historial puro: insert-or-ignore ----
for (const r of db.prepare('SELECT * FROM az.activity_log').all()) {
  const c = runq(`INSERT OR IGNORE INTO activity_log (org_id, number, load_date, driver, loads) VALUES (?,?,?,?,?)`,
    r.org_id, r.number, r.load_date, r.driver || '', r.loads || 1);
  stats.activity += c.changes;
}
try {
  for (const r of db.prepare('SELECT * FROM az.truck_log').all()) {
    const c = runq(`INSERT OR IGNORE INTO truck_log (org_id, number, ts, field, old_value, new_value, by)
          VALUES (?,?,?,?,?,?,?)`, r.org_id, r.number, r.ts, r.field, r.old_value, r.new_value, r.by || '');
    stats.log += c.changes;
  }
} catch (e) { console.log('truck_log: ' + e.message); }
try {
  for (const r of db.prepare('SELECT * FROM az.parking_log').all()) {
    const c = runq(`INSERT OR IGNORE INTO parking_log (org_id, number, date, city, lat, lon) VALUES (?,?,?,?,?,?)`,
      r.org_id, r.number, r.date, r.city, r.lat, r.lon);
    stats.parking += c.changes;
  }
} catch (e) { console.log('parking_log: ' + e.message); }

db.exec('DETACH DATABASE az');
console.log('FUSION LISTA →', JSON.stringify(stats));
console.log('Reinicia el tracker (o espera al siguiente refresh) para ver todo.');
