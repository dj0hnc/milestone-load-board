'use strict';
/*
 * Audit log + daily snapshots — "si regreso a un día pasado, veo cómo estaba ese día".
 *
 * truck_log:  append-only record of every field edit (old → new, who, when). Powers the
 *             per-truck "historial" view and answers "¿quién lo cambió?" in multi-user.
 * truck_days: one row per truck per date with how it ENDED that day (status, note,
 *             driver, area…). Upserted on every edit and refreshed by the hourly job,
 *             so the last write of the day is the day's snapshot. Viewing a past date
 *             overlays these values on the board.
 */
const { all, run, nowISO } = require('./db');
const { todayCT } = require('./util');

const SNAP_FIELDS = ['status', 'status_note', 'return_date', 'note', 'driver', 'division', 'area', 'rip_rap'];

function logChange(orgId, number, field, oldVal, newVal, by) {
  if (String(oldVal == null ? '' : oldVal) === String(newVal == null ? '' : newVal)) return;
  run(`INSERT INTO truck_log (ts, org_id, number, field, old_value, new_value, changed_by) VALUES (?,?,?,?,?,?,?)`,
    nowISO(), orgId, number, field, String(oldVal == null ? '' : oldVal), String(newVal == null ? '' : newVal), by || '');
}

function snapshotTruckDay(t, date) {
  const d = date || todayCT();
  run(`INSERT INTO truck_days (date, org_id, number, ${SNAP_FIELDS.join(', ')})
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(date, org_id, number) DO UPDATE SET
         ${SNAP_FIELDS.map(f => `${f} = excluded.${f}`).join(', ')}`,
    d, t.org_id, t.number, ...SNAP_FIELDS.map(f => t[f]));
}

// Refresh today's snapshot for every active truck (idempotent; the hourly sync calls it,
// so as the day moves every change keeps landing on today's row).
function snapshotAllToday() {
  const d = todayCT();
  for (const t of all('SELECT * FROM trucks WHERE archived = 0')) snapshotTruckDay(t, d);
}

function historyOf(orgId, number, limit) {
  return {
    changes: all(`SELECT ts, field, old_value, new_value, changed_by FROM truck_log
                  WHERE org_id = ? AND number = ? ORDER BY ts DESC LIMIT ?`, orgId, number, limit || 100),
    activity: all(`SELECT load_date, driver, loads FROM activity_log
                   WHERE org_id = ? AND number = ? ORDER BY load_date DESC LIMIT 30`, orgId, number),
    parking: all(`SELECT date, city FROM parking_log
                  WHERE org_id = ? AND number = ? ORDER BY date DESC LIMIT 14`, orgId, number)
  };
}

// Snapshot rows for a past date, keyed by truck number.
function daySnapshots(orgId, date) {
  const rows = all('SELECT * FROM truck_days WHERE org_id = ? AND date = ?', orgId, date);
  return new Map(rows.map(r => [r.number, r]));
}

module.exports = { logChange, snapshotTruckDay, snapshotAllToday, historyOf, daySnapshots, SNAP_FIELDS };
