'use strict';
/*
 * SQLite layer for the Cactus Truck Tracker.
 *
 * Uses node:sqlite (built into Node >= 22.13, no native build) so the module runs
 * anywhere the office bundle runs. DB file lives in ../data/cactus.db.
 *
 * Schema notes vs the original SPEC:
 *  - `orgs` + `divisions` replace the old fleet CHECK('NORTH','SOUTH','SUB'): the company
 *    (CACTUS / KT / SUBS) is separate from the dispatch division (NORTH/SOUTH...), so
 *    phase 2 (CKJ/KT, subhauler module) is config rows + a tab, not a schema rewrite.
 *  - `dispatch_state` is keyed by REAL ISO DATE, not weekday. The UI maps Mon–Sat of the
 *    current week to dates; old weeks simply never show, so no 3 AM auto-reset job is
 *    needed and a failed reset can never leak last Thursday into this Thursday.
 *  - `is_sub` marks subhauler trucks. Subs are NOT in Samsara — every Samsara sync skips
 *    them; their activity comes exclusively from NewMile load tickets.
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// CACTUS_DATA_DIR: en la nube apúntalo al disco persistente. En Azure App Service ni
// hace falta: se detecta solo (WEBSITE_INSTANCE_ID) y usa /home/data, que sobrevive
// reinicios y redeploys (wwwroot se reemplaza en cada zip deploy; /home/data no).
const onAzure = !!process.env.WEBSITE_INSTANCE_ID;
const DATA_DIR = process.env.CACTUS_DATA_DIR || (onAzure ? '/home/data' : path.join(__dirname, '..', 'data'));
const DB_PATH = process.env.CACTUS_DB || path.join(DATA_DIR, 'cactus.db');

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  // /home en Azure App Service es un share SMB: WAL sobre red es frágil (locking) —
  // ahí usamos TRUNCATE. En disco local, WAL normal.
  db.exec(onAzure ? 'PRAGMA journal_mode = TRUNCATE;' : 'PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

// Snapshot consistente de la DB (VACUUM INTO es atómico aunque haya escrituras).
function backupTo(destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  try { fs.unlinkSync(destPath); } catch (e) {}
  open().exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
}

function migrate(d) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS orgs (
    id TEXT PRIMARY KEY,              -- 'CACTUS' | 'KT' | 'SUBS' (phase 2)
    label TEXT NOT NULL,
    nm_fleet_id INTEGER,              -- NewMile fleet id (Cactus Express = 5)
    nm_fleet_names TEXT DEFAULT '[]', -- JSON: fleet names as they appear in load_tickets
    truck_prefix TEXT DEFAULT '',     -- 'C' → C1127 means truck 1127 in loads
    samsara INTEGER DEFAULT 0,        -- 0 = org has NO Samsara (subs: NewMile only)
    samsara_org TEXT,                 -- token name in config.samsara.tokens
    enabled INTEGER DEFAULT 1,
    sort INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS divisions (
    org_id TEXT NOT NULL,
    id TEXT NOT NULL,                 -- 'NORTH' | 'SOUTH' ...
    label TEXT NOT NULL,
    samsara_tag_id TEXT,              -- Paris Terminal 4218297 = NORTH, Lufkin 4218296 = SOUTH
    sort INTEGER DEFAULT 0,
    PRIMARY KEY (org_id, id)
  );
  CREATE TABLE IF NOT EXISTS trucks (
    org_id TEXT NOT NULL,
    number TEXT NOT NULL,             -- canonical key for matching (no prefixes/suffixes)
    display_number TEXT DEFAULT '',   -- the number EXACTLY as NewMile shows it ("KT-7040 P")
    division TEXT,                    -- NULL while ⚑ NUEVO (until I assign it)
    area TEXT,
    driver TEXT DEFAULT '',
    driver_prev TEXT,
    driver_changed_at TEXT,           -- ISO datetime; badge shows for 48 h
    trailer_type TEXT DEFAULT '',
    trailer_override INTEGER DEFAULT 0, -- lo corregí a mano: el sync de NewMile no lo pisa
    rip_rap INTEGER DEFAULT 0,
    tags TEXT DEFAULT '',             -- '3X8', 'SUBHAULER' (comma separated)
    is_sub INTEGER DEFAULT 0,         -- subhauler: Samsara sync skips, fleet-5 baja check skips
    phone TEXT DEFAULT '',
    status TEXT DEFAULT 'ok',         -- ok|shop|down|no_driver|deleased
    status_note TEXT DEFAULT '',
    return_date TEXT DEFAULT '',      -- 'regresa 7/13'
    rest_days TEXT DEFAULT '',        -- 'Mon,Tue' → gray chip, excluded from FALTAN
    note TEXT DEFAULT '',
    is_new INTEGER DEFAULT 0,         -- ⚑ NUEVO: never auto-cleared, I confirm
    maybe_removed INTEGER DEFAULT 0,  -- ¿de baja?: flagged, never auto-deleted
    archived INTEGER DEFAULT 0,       -- confirmed baja (kept for history)
    detected_flag TEXT DEFAULT '',    -- suffix found in the NewMile truck name ('DOWN 12/12/2024')
    samsara_flag TEXT DEFAULT '',     -- flag parsed from the Samsara vehicle name (pending my confirm)
    suggested_division TEXT,          -- from Samsara terminal tag; my assignment always wins
    nm_truck_id INTEGER,
    samsara_id TEXT,
    last_load_date TEXT,              -- ISO
    last_load_driver TEXT,            -- driver of the latest load (rotations: beats static driver)
    loads_today INTEGER DEFAULT 0,
    rip_suggested INTEGER DEFAULT 0,  -- hauled RIP RAP in NewMile but not marked rip_rap; I confirm
    rip_evidence TEXT DEFAULT '',     -- JSON {loads, first, last, materials}
    parked_city TEXT DEFAULT '',      -- last Samsara position (reverse-geo city)
    parked_at TEXT DEFAULT '',
    suggested_area TEXT DEFAULT '',   -- from overnight GPS majority; I accept/dismiss
    updated_at TEXT,
    PRIMARY KEY (org_id, number)
  );
  CREATE TABLE IF NOT EXISTS dispatch_state (
    date TEXT NOT NULL,               -- real ISO date '2026-07-10'
    org_id TEXT NOT NULL,
    number TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('p','a','d')),
    source TEXT DEFAULT 'manual',     -- 'manual' | 'auto' (from NewMile loads today)
    marked_by TEXT DEFAULT '',        -- multi-user: who tapped it
    marked_at TEXT,
    PRIMARY KEY (date, org_id, number)
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    org_id TEXT NOT NULL,
    number TEXT NOT NULL,
    load_date TEXT NOT NULL,          -- ISO
    driver TEXT DEFAULT '',
    loads INTEGER DEFAULT 0,
    PRIMARY KEY (org_id, number, load_date)
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS truck_log (   -- audit: every edit, who and when
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    org_id TEXT NOT NULL,
    number TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT DEFAULT '',
    new_value TEXT DEFAULT '',
    changed_by TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS truck_days (  -- daily snapshot: how the truck WAS that day
    date TEXT NOT NULL,
    org_id TEXT NOT NULL,
    number TEXT NOT NULL,
    status TEXT, status_note TEXT, return_date TEXT,
    note TEXT, driver TEXT, division TEXT, area TEXT, rip_rap INTEGER,
    PRIMARY KEY (date, org_id, number)
  );
  CREATE TABLE IF NOT EXISTS parking_log ( -- where the truck slept (3-5 AM GPS point)
    org_id TEXT NOT NULL,
    number TEXT NOT NULL,
    date TEXT NOT NULL,
    city TEXT DEFAULT '',
    lat REAL, lon REAL,
    PRIMARY KEY (org_id, number, date)
  );
  CREATE INDEX IF NOT EXISTS idx_activity_num ON activity_log (org_id, number, load_date DESC);
  CREATE INDEX IF NOT EXISTS idx_truck_log ON truck_log (org_id, number, ts DESC);
  `);
  // additive migrations for DBs created before these columns existed
  addCol(d, 'trucks', 'rip_suggested', 'INTEGER DEFAULT 0');
  addCol(d, 'trucks', 'rip_evidence', "TEXT DEFAULT ''");
  addCol(d, 'trucks', 'parked_city', "TEXT DEFAULT ''");
  addCol(d, 'trucks', 'parked_at', "TEXT DEFAULT ''");
  addCol(d, 'trucks', 'suggested_area', "TEXT DEFAULT ''");
  addCol(d, 'dispatch_state', 'marked_by', "TEXT DEFAULT ''");
  addCol(d, 'trucks', 'trailer_override', 'INTEGER DEFAULT 0');
  addCol(d, 'trucks', 'display_number', "TEXT DEFAULT ''");
}

function addCol(d, table, col, decl) {
  try { d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`); } catch (e) { /* already there */ }
}

// ---------- tiny helpers ----------
function get(sql, ...params) { return open().prepare(sql).get(...params); }
function all(sql, ...params) { return open().prepare(sql).all(...params); }
function run(sql, ...params) { return open().prepare(sql).run(...params); }

function metaGet(key, dflt) {
  const r = get('SELECT value FROM meta WHERE key = ?', key);
  return r ? r.value : (dflt === undefined ? null : dflt);
}
function metaSet(key, value) {
  run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

function nowISO() { return new Date().toISOString(); }

module.exports = { open, get, all, run, metaGet, metaSet, nowISO, backupTo, DB_PATH, DATA_DIR };
