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
  CREATE TABLE IF NOT EXISTS calls (       -- 📞 BITÁCORA: todo lo hablado con el chofer, con
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- autor y hora. "Quien sea que hable con el driver
    ts TEXT NOT NULL,                      -- lo anota y todos saben qué pasa con él."
    org_id TEXT NOT NULL,
    number TEXT NOT NULL,
    author TEXT DEFAULT '',
    kind TEXT DEFAULT 'call',              -- 'call' | 'note'
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_calls_truck ON calls(org_id, number, id);
  CREATE TABLE IF NOT EXISTS truck_days (  -- daily snapshot: how the truck WAS that day
    date TEXT NOT NULL,
    org_id TEXT NOT NULL,
    number TEXT NOT NULL,
    status TEXT, status_note TEXT, return_date TEXT,
    note TEXT, driver TEXT, division TEXT, area TEXT, rip_rap INTEGER,
    PRIMARY KEY (date, org_id, number)
  );
  CREATE TABLE IF NOT EXISTS time_off (    -- scheduled unavailability: "vacation next week"
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- takes effect and returns BY DATE, on its own
    org_id TEXT NOT NULL,
    number TEXT NOT NULL,
    from_date TEXT NOT NULL,               -- ISO inclusive
    to_date TEXT NOT NULL,                 -- ISO inclusive
    reason TEXT DEFAULT 'vacation',        -- vacation|shop|down|personal
    note TEXT DEFAULT '',
    created_by TEXT DEFAULT '',
    created_at TEXT
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
  CREATE INDEX IF NOT EXISTS idx_time_off ON time_off (org_id, number, to_date);
  CREATE TABLE IF NOT EXISTS recruits (      -- 🤝 RECRUITING: HubSpot Subhauler-pipeline mirror.
    deal_id TEXT PRIMARY KEY,                -- Juan owns "Onboarding & NewMile Training": he
    pipeline TEXT DEFAULT '',                -- trains drivers/admins and creates orgs/trucks/
    stage TEXT DEFAULT '',                   -- users; this table is his working copy so nothing
    stage_label TEXT DEFAULT '',             -- (and no sub) falls through the cracks.
    company TEXT DEFAULT '',
    contact TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    hs_owner TEXT DEFAULT '',                -- recruiter (Tony/Elisa/Matthew/Grace)
    hs_modified TEXT DEFAULT '',
    stage_since TEXT DEFAULT '',             -- first time WE saw it in the current stage
    local_status TEXT DEFAULT '',            -- ''|graduated|paused (local, until HS write-back)
    next_follow TEXT DEFAULT '',             -- ISO date of the next follow-up Juan promised
    synced_at TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS recruit_steps ( -- onboarding checklist, one row per done step
    deal_id TEXT NOT NULL,
    step TEXT NOT NULL,                      -- org|trucks|users|drivers|admins|firstload
    done INTEGER DEFAULT 0,
    by TEXT DEFAULT '',
    ts TEXT DEFAULT '',
    PRIMARY KEY (deal_id, step)
  );
  CREATE TABLE IF NOT EXISTS recruit_notes ( -- follow-up log, same spirit as the truck calls
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    deal_id TEXT NOT NULL,
    author TEXT DEFAULT '',
    kind TEXT DEFAULT 'call',                -- 'call' | 'note'
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recruit_notes ON recruit_notes (deal_id, id);
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
  // movimiento real según Samsara: cuándo fue la ÚLTIMA vez que el truck se movió
  addCol(d, 'trucks', 'last_moved_at', "TEXT DEFAULT ''");
  addCol(d, 'trucks', 'last_lat', 'REAL');
  addCol(d, 'trucks', 'last_lon', 'REAL');
  // DUEÑO / organización del truck (NewMile: owner_id estable + owner_name). Para
  // agrupar por dueño y despachar juntos todos los de Elaine Raper, Dustin Smith, etc.
  addCol(d, 'trucks', 'owner_id', 'INTEGER');
  addCol(d, 'trucks', 'owner_name', "TEXT DEFAULT ''");
  // ⭐ STAR DRIVER: marca manual por truck para filtrar rápido a los mejores choferes
  addCol(d, 'trucks', 'star', 'INTEGER DEFAULT 0');
  // CONFIRMACIÓN NEWMILE: 1 = la asignación de ese día está VERIFICADA contra NewMile.
  // Un ✓ manual se vuelve ⚡ al confirmarse; si no confirma, es plan que NO llegó a NewMile.
  addCol(d, 'dispatch_state', 'nm_confirmed', 'INTEGER DEFAULT 0');
  // A DÓNDE VA: JSON compacto con la(s) orden(es) NewMile del truck ese día
  // [{n:orden, c:cliente, m:material, d:dropoff}] — el cuadrito muestra su destino.
  addCol(d, 'dispatch_state', 'nm_info', "TEXT DEFAULT ''");
  // HOS (Samsara /fleet/hos/clocks): cuánto manejo le queda HOY y cuántas horas del
  // CICLO semanal — para saber quién aguanta el fin de semana sin abrir Samsara.
  addCol(d, 'trucks', 'samsara_driver_id', 'TEXT');
  addCol(d, 'trucks', 'hos_drive_ms', 'INTEGER');
  addCol(d, 'trucks', 'hos_shift_ms', 'INTEGER');
  addCol(d, 'trucks', 'hos_cycle_ms', 'INTEGER');
  addCol(d, 'trucks', 'hos_cycle_tmrw_ms', 'INTEGER'); // horas que le REGRESAN mañana (ciclo rodante)
  // VIOLACIONES: cuánto se PASARON del límite (Samsara violations) — se pinta en negativo
  addCol(d, 'trucks', 'hos_viol_shift_ms', 'INTEGER');
  addCol(d, 'trucks', 'hos_viol_cycle_ms', 'INTEGER');
  addCol(d, 'trucks', 'hos_at', "TEXT DEFAULT ''");
  addCol(d, 'trucks', 'hos_driver', "TEXT DEFAULT ''");
  // ÚLTIMA SEÑAL GPS recibida: si tiene samsara_id pero lleva >24 h sin mandar señal,
  // la cámara/cableado está mal → el board lo grita para que el chofer lo arregle.
  addCol(d, 'trucks', 'samsara_seen_at', "TEXT DEFAULT ''");
  // RODANDO o PARADO ahorita (Samsara) + estado de la carga en curso (NewMile)
  addCol(d, 'trucks', 'moving', 'INTEGER DEFAULT 0');
  addCol(d, 'trucks', 'moving_at', "TEXT DEFAULT ''");
  addCol(d, 'dispatch_state', 'nm_load_status', "TEXT DEFAULT ''");
  // memoria de "ya lo revisé": un accept/dismiss del review no debe rebotar en el
  // siguiente sync mientras la condición siga idéntica (mismo texto, misma área,
  // mismas cargas). Solo algo NUEVO vuelve a proponer.
  addCol(d, 'trucks', 'samsara_flag_dismissed', "TEXT DEFAULT ''");
  addCol(d, 'trucks', 'detected_flag_dismissed', "TEXT DEFAULT ''");
  addCol(d, 'trucks', 'suggested_area_dismissed', "TEXT DEFAULT ''");
  addCol(d, 'trucks', 'rip_dismissed_last', "TEXT DEFAULT ''"); // última carga rip vista al descartar
  addCol(d, 'trucks', 'baja_dismissed_at', "TEXT DEFAULT ''"); // "keep" reciente: no re-avisar 21 días
  // segunda traila (ej. 1144: AL-ED + round bottom para rip rap). Manual, el sync no la toca.
  addCol(d, 'trucks', 'trailer_type2', "TEXT DEFAULT ''");
  // nombre/username del vehículo tal como aparece en Samsara (para cotejar en el lápiz)
  addCol(d, 'trucks', 'samsara_name', "TEXT DEFAULT ''");
  // de cuál fleet/org de Samsara salió el vehículo (CACTUS o KT/CKJ)
  addCol(d, 'trucks', 'samsara_fleet', "TEXT DEFAULT ''");
  // username del chofer para entrar al Driver App (viene de /fleet/drivers)
  addCol(d, 'trucks', 'samsara_username', "TEXT DEFAULT ''");
  // subida de cámara EN CURSO: Retake la retoma en vez de reiniciar el reloj de la subida
  addCol(d, 'trucks', 'camera_rid', "TEXT DEFAULT ''");
  addCol(d, 'trucks', 'camera_rid_at', "TEXT DEFAULT ''");
  addCol(d, 'trucks', 'camera_rid_meta', "TEXT DEFAULT ''"); // {at,live} del momento capturado
  // HISTORIAL HOS día a día (Samsara daily logs): cuánto MANEJÓ/TRABAJÓ cada driver
  // cada día — el board lo enseña por fecha y acumula la semana.
  d.exec(`CREATE TABLE IF NOT EXISTS hos_days (
    driver_id TEXT NOT NULL,
    date TEXT NOT NULL,
    name TEXT DEFAULT '',
    drive_ms INTEGER,
    duty_ms INTEGER,
    PRIMARY KEY (driver_id, date)
  )`);
  // JORNADA por día (Samsara engine states): a qué hora PRENDIÓ el truck y a qué hora
  // APAGÓ por última vez — "empezó a trabajar / terminó". ended_at NULL = sigue afuera.
  d.exec(`CREATE TABLE IF NOT EXISTS work_days (
    org_id TEXT NOT NULL,
    number TEXT NOT NULL,
    date TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    PRIMARY KEY (org_id, number, date)
  )`);
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
