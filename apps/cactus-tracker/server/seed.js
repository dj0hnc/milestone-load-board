'use strict';
/*
 * First-boot seed: loads data/roster_seed.json into the DB. Idempotent — runs only
 * when the trucks table is empty (or with --force to wipe and reload).
 *
 * Seed rules:
 *  - Orgs: CACTUS enabled (fleet 5, prefix C, Samsara org "Cactus Express");
 *    KT and SUBS are pre-created DISABLED as phase-2 placeholders. SUBS has samsara=0:
 *    subhaulers are NOT in Samsara, their info comes from NewMile only.
 *  - Subhauler trucks that today live inside the Cactus board (BT/BW/HS/AE/Livingston,
 *    per SPEC §2 shown under North/South areas) get is_sub=1 + SUBHAULER tag so the
 *    Samsara sync and the fleet-5 "¿de baja?" check never touch them.
 *  - Seed activity (Jul 6–9 sample) fills activity_log so days-since-last-load works
 *    from day one; the hourly NewMile job keeps it current after that.
 *  - Samsara name flags from the seed land in samsara_flag (pending my confirm).
 */
const fs = require('fs');
const path = require('path');
const { open, run, get, metaGet, metaSet, nowISO } = require('./db');
const { normNum, splitNameFlag } = require('./util');

// data/ puede estar tapado por un volumen en la nube — el seed también vive en seed-data/
const SEED_PATH = [
  process.env.CACTUS_SEED,
  path.join(__dirname, '..', 'data', 'roster_seed.json'),
  path.join(__dirname, '..', 'seed-data', 'roster_seed.json')
].filter(Boolean).find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });

// Areas that are actually subhauler groups parked inside the Cactus board today.
const SUB_AREAS = ['BUTLER / WALKER / LIVINGSTON', 'RKH SAWYER'];
// Letter-prefixed numbers of known sub fleets (Butler, Billy Walker, Hope Services, Arrowhead).
const SUB_PREFIX = /^(BT|BW|HS|AE)\d/i;

function isSubTruck(t) {
  if ((t.tg || '').toUpperCase() === 'SUBHAULER') return true;
  if (SUB_PREFIX.test(normNum(t.t))) return true;
  if (SUB_AREAS.includes(normNum(t.c || ''))) return true;
  return false;
}

function seedOrgs() {
  const orgs = [
    { id: 'CACTUS', label: 'Cactus Express', nm_fleet_id: 5, nm_fleet_names: JSON.stringify(['Cactus Express']), truck_prefix: 'C', samsara: 1, samsara_org: 'Cactus Express', enabled: 1, sort: 1 },
    // KT/CKJ: fleet 6, loads arrive as fleet "CKJ Transport" with numbers "CKJ7040" (4+ digits
    // = KT truck; CKJ### 3 digits = CKJ-affiliated sub, handled apart). Samsara org "CKJ Transport".
    { id: 'KT', label: 'CKJ / KT', nm_fleet_id: 6, nm_fleet_names: JSON.stringify(['CKJ Transport', 'Kennemer']), truck_prefix: 'CKJ', samsara: 1, samsara_org: 'CKJ Transport', enabled: 1, sort: 2 },
    { id: 'SUBS', label: 'Subhaulers', nm_fleet_id: null, nm_fleet_names: JSON.stringify(['Butler Trucking LLC', 'Billy Walker Trucking LLC', 'Hope Services Inc.', 'Arrowhead Earthworks LLC']), truck_prefix: '', samsara: 0 /* subs: NewMile only */, samsara_org: null, enabled: 0, sort: 3 }
  ];
  for (const o of orgs) {
    run(`INSERT INTO orgs (id,label,nm_fleet_id,nm_fleet_names,truck_prefix,samsara,samsara_org,enabled,sort)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO NOTHING`,
      o.id, o.label, o.nm_fleet_id, o.nm_fleet_names, o.truck_prefix, o.samsara, o.samsara_org, o.enabled, o.sort);
  }
  const divs = [
    { org: 'CACTUS', id: 'NORTH', label: 'Cactus NORTH', tag: '4218297', sort: 1 }, // Paris Terminal
    { org: 'CACTUS', id: 'SOUTH', label: 'Cactus SOUTH', tag: '4218296', sort: 2 }, // Lufkin Terminal
    // Terminales de KT — tag IDs verificados en vivo contra Samsara 7/10/26
    { org: 'KT', id: 'POWDERLY', label: 'KT POWDERLY', tag: '2706160', sort: 1 },
    { org: 'KT', id: 'RHOME', label: 'KT RHOME', tag: '3645002', sort: 2 },
    { org: 'KT', id: 'WHITEWRIGHT', label: 'KT WHITEWRIGHT', tag: '2706161', sort: 3 },
    { org: 'KT', id: 'ICS', label: 'CKJ ICS', tag: null, sort: 4 }
  ];
  for (const d of divs) {
    run(`INSERT INTO divisions (org_id,id,label,samsara_tag_id,sort) VALUES (?,?,?,?,?)
         ON CONFLICT(org_id,id) DO NOTHING`, d.org, d.id, d.label, d.tag, d.sort);
  }
}

function seedTrucks(seed) {
  const ins = open().prepare(`
    INSERT INTO trucks (org_id, number, display_number, division, area, driver, trailer_type, rip_rap, tags, is_sub,
                        status, note, is_new, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(org_id, number) DO NOTHING`);
  let n = 0;
  for (const [division, list] of [['NORTH', seed.north], ['SOUTH', seed.south]]) {
    for (const t of list || []) {
      const num = normNum(t.t);
      const sub = isSubTruck(t) ? 1 : 0;
      const tags = [t.tg, sub && (t.tg || '').toUpperCase() !== 'SUBHAULER' ? 'SUBHAULER' : ''].filter(Boolean).join(',');
      const note = t.n || '';
      const isNew = /NUEVO/i.test(note) ? 1 : 0;
      const status = t.st === 'd' ? 'down' : 'ok';
      ins.run('CACTUS', num, num, division, normNum(t.c || '(SIN YARD)'), t.d || '', t.tt || '',
        t.rip ? 1 : 0, tags, sub, status, note, isNew, nowISO());
      n++;
    }
  }
  return n;
}

function seedActivity(seed) {
  const act = seed.activity_sample_jul6_9 || {};
  const year = 2026;
  const ins = open().prepare(`
    INSERT INTO activity_log (org_id, number, load_date, driver, loads) VALUES (?,?,?,?,1)
    ON CONFLICT(org_id, number, load_date) DO NOTHING`);
  const upd = open().prepare(`
    UPDATE trucks SET last_load_date = ?, last_load_driver = ? WHERE org_id = ? AND number = ?
      AND (last_load_date IS NULL OR last_load_date < ?)`);
  let n = 0;
  for (const [num, [driver, md]] of Object.entries(act)) {
    const m = /^(\d{1,2})\/(\d{1,2})$/.exec(md || '');
    if (!m) continue;
    const iso = `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    const key = normNum(num);
    ins.run('CACTUS', key, iso, driver || '');
    upd.run(iso, driver || '', 'CACTUS', key, iso);
    n++;
  }
  return n;
}

function seedSamsaraFlags(seed) {
  const flags = seed.samsara_flags || {};
  let n = 0;
  for (const [rawNum, arr] of Object.entries(flags)) {
    const flag = Array.isArray(arr) ? arr.join(' ') : String(arr || '');
    const { number } = splitNameFlag(rawNum);
    // Only annotate trucks we actually track; unknown Samsara vehicles (deleased spares
    // not in fleet 5) are noise until the live sync proposes them properly.
    const r = run(`UPDATE trucks SET samsara_flag = ? WHERE org_id = 'CACTUS' AND number = ? AND is_sub = 0`, flag, number);
    if (r.changes) n++;
  }
  return n;
}

function main(force) {
  open();
  if (force) {
    run('DELETE FROM trucks'); run('DELETE FROM activity_log');
    run('DELETE FROM dispatch_state'); run('DELETE FROM orgs'); run('DELETE FROM divisions');
  }
  seedOrgs();
  // migración idempotente: DBs creadas antes de que KT existiera lo activan aquí
  if (!get(`SELECT 1 AS x FROM divisions WHERE org_id = 'KT'`)) {
    run(`UPDATE orgs SET enabled = 1, nm_fleet_names = ?, truck_prefix = 'CKJ' WHERE id = 'KT'`,
      JSON.stringify(['CKJ Transport', 'Kennemer']));
    for (const d of [['POWDERLY', '2706160', 1], ['RHOME', '3645002', 2], ['WHITEWRIGHT', '2706161', 3]]) {
      run(`INSERT INTO divisions (org_id,id,label,samsara_tag_id,sort) VALUES ('KT',?,?,?,?) ON CONFLICT(org_id,id) DO NOTHING`,
        d[0], 'KT ' + d[0], d[1], d[2]);
    }
  }
  // backfill de tag IDs para DBs que crearon las divisiones de KT sin ellos
  for (const d of [['POWDERLY', '2706160'], ['RHOME', '3645002'], ['WHITEWRIGHT', '2706161']]) {
    run(`UPDATE divisions SET samsara_tag_id = ? WHERE org_id = 'KT' AND id = ? AND samsara_tag_id IS NULL`, d[1], d[0]);
  }
  // terminal virtual para los CKJ ICs (independent contractors, CKJ### en las cargas)
  run(`INSERT INTO divisions (org_id,id,label,samsara_tag_id,sort) VALUES ('KT','ICS','CKJ ICS',NULL,4) ON CONFLICT(org_id,id) DO NOTHING`);
  run(`UPDATE divisions SET label = 'CKJ ICS' WHERE org_id = 'KT' AND id = 'ICS' AND label != 'CKJ ICS'`);
  // display_number para DBs anteriores a la columna
  run(`UPDATE trucks SET display_number = number WHERE display_number IS NULL OR display_number = ''`);
  // one-time: aplicar los tipos de trailer DE LAS LISTAS del despacho como base blindada
  // (trailer_override=1: el sync de NewMile ya no los pisa). Corre también en producción.
  if (!metaGet('mig_seed_trailers') && SEED_PATH) {
    try {
      const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
      let n = 0;
      for (const list of [seed.north, seed.south]) {
        for (const t of list || []) {
          if (!t.tt) continue;
          const r = run(`UPDATE trucks SET trailer_type = ?, trailer_override = 1, updated_at = ?
                         WHERE org_id = 'CACTUS' AND number = ? AND trailer_override = 0`,
            t.tt, nowISO(), normNum(t.t));
          n += r.changes;
        }
      }
      metaSet('mig_seed_trailers', '1');
      console.log(`seed: trailer types de la lista aplicados a ${n} trucks (blindados)`);
    } catch (e) { console.log('seed trailers migration falló: ' + e.message); }
  }
  const existing = get('SELECT COUNT(*) AS c FROM trucks').c;
  if (existing > 0) {
    console.log(`seed: DB already has ${existing} trucks — skipping (use --force to reload)`);
    return;
  }
  if (!SEED_PATH) { console.log('seed: no encontré roster_seed.json — arranco vacío (el sync de NewMile puebla el board)'); return; }
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const t = seedTrucks(seed);
  const a = seedActivity(seed);
  const f = seedSamsaraFlags(seed);
  console.log(`seed: ${t} trucks, ${a} activity rows, ${f} samsara flags`);
}

if (require.main === module) main(process.argv.includes('--force'));
module.exports = { main };
