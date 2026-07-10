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

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.CACTUS_DB || path.join(DATA_DIR, 'cactus.db');

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
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
    number TEXT NOT NULL,             -- normalized: no C prefix, no name suffixes
    division TEXT,                    -- NULL while ⚑ NUEVO (until I assign it)
    area TEXT,
    driver TEXT DEFAULT '',
    driver_prev TEXT,
    driver_changed_at TEXT,           -- ISO datetime; badge shows for 48 h
    trailer_type TEXT DEFAULT '',
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
    updated_at TEXT,
    PRIMARY KEY (org_id, number)
  );
  CREATE TABLE IF NOT EXISTS dispatch_state (
    date TEXT NOT NULL,               -- real ISO date '2026-07-10'
    org_id TEXT NOT NULL,
    number TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('p','a','d')),
    source TEXT DEFAULT 'manual',     -- 'manual' | 'auto' (from NewMile loads today)
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
  CREATE INDEX IF NOT EXISTS idx_activity_num ON activity_log (org_id, number, load_date DESC);
  `);
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

module.exports = { open, get, all, run, metaGet, metaSet, nowISO, DB_PATH };
