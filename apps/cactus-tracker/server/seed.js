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
const { open, run, get, nowISO } = require('./db');
const { normNum, splitNameFlag } = require('./util');

const SEED_PATH = path.join(__dirname, '..', 'data', 'roster_seed.json');

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
    // Phase 2 placeholders — enable + fill divisions when their module lands.
    { id: 'KT', label: 'CKJ / KT', nm_fleet_id: 6, nm_fleet_names: JSON.stringify(['Kennemer']), truck_prefix: '', samsara: 1, samsara_org: 'CKJ Transport', enabled: 0, sort: 2 },
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
    { org: 'CACTUS', id: 'SOUTH', label: 'Cactus SOUTH', tag: '4218296', sort: 2 }  // Lufkin Terminal
  ];
  for (const d of divs) {
    run(`INSERT INTO divisions (org_id,id,label,samsara_tag_id,sort) VALUES (?,?,?,?,?)
         ON CONFLICT(org_id,id) DO NOTHING`, d.org, d.id, d.label, d.tag, d.sort);
  }
}

function seedTrucks(seed) {
  const ins = open().prepare(`
    INSERT INTO trucks (org_id, number, division, area, driver, trailer_type, rip_rap, tags, is_sub,
                        status, note, is_new, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
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
      ins.run('CACTUS', num, division, normNum(t.c || '(SIN YARD)'), t.d || '', t.tt || '',
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
  const existing = get('SELECT COUNT(*) AS c FROM trucks').c;
  if (existing > 0) {
    console.log(`seed: DB already has ${existing} trucks — skipping (use --force to reload)`);
    return;
  }
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const t = seedTrucks(seed);
  const a = seedActivity(seed);
  const f = seedSamsaraFlags(seed);
  console.log(`seed: ${t} trucks, ${a} activity rows, ${f} samsara flags`);
}

if (require.main === module) main(process.argv.includes('--force'));
module.exports = { main };
