'use strict';
/*
 * NewMile sync jobs — the heart of "que JAMÁS se me pase un truck".
 *
 * syncRoster (4:30 AM CT + "Sync ahora"):
 *   - Pull every truck, keep the ones whose fleet matches an enabled org (Cactus = fleet 5).
 *   - Update driver / trailer_type when NewMile changed them; a driver change leaves a
 *     48 h "driver cambió: antes X → ahora Y" badge.
 *   - Fleet-5 truck missing from my roster → created with ⚑ NUEVO (division NULL, red
 *     banner until I place it). Roster truck gone from fleet 5 → flagged ¿de baja?
 *     (maybe_removed) — NOTHING is ever deleted automatically.
 *   - Subs (is_sub=1) are exempt from the ¿de baja? check: they live in their own
 *     NewMile fleets, not in fleet 5.
 *
 * syncActivity (hourly 4 AM–7 PM CT):
 *   - load_tickets for a rolling window ending today. Cactus rows come as "C1127"
 *     (prefix stripped); sub rows match by raw number. Today's driver beats the
 *     static roster driver (trucks rotate).
 *   - Auto-cover: a truck with loads TODAY is marked 'a' (source 'auto') unless I
 *     already touched it manually — FALTAN becomes the real gap, not a tap list.
 *   - A load from an unknown Cactus/sub truck creates it with ⚑ NUEVO on the spot
 *     (this is how 1065/1091/1105/1139 were caught on 7/9/26).
 *   - PLUS today's order assignments: a truck already planned in NewMile (plan pushed
 *     from the desktop board or in NewMile itself) is auto-covered even before its
 *     first load lands — no double-marking a truck that is already dispatched.
 */
const { all, get, run, metaSet, nowISO } = require('./db');
const { normNum, splitNameFlag, canonicalTruckNumber, displayTruckNumber, ktDivisionHint, shortTrailer, normLoadTruck, ckjAliasKey, todayCT, shiftISO, reportDateToISO } = require('./util');

const ACTIVITY_WINDOW_DAYS = 21;   // enough history to compute "X días sin carga" up to red (>=14)

function enabledOrgs() {
  return all('SELECT * FROM orgs WHERE enabled = 1 ORDER BY sort').map(o => ({
    ...o, fleetNames: JSON.parse(o.nm_fleet_names || '[]')
  }));
}
// Sub fleet names are matched for activity even while the SUBS org/tab is still disabled,
// because sub trucks currently live inside the Cactus board (SPEC §2).
function subFleetNames() {
  const o = get('SELECT nm_fleet_names FROM orgs WHERE id = ?', 'SUBS');
  return o ? JSON.parse(o.nm_fleet_names || '[]') : [];
}

// Resolve a load/ticket row to a roster truck. Rules mirror the desktop's rotation.js:
//  - Cactus Express rows come prefixed "C1127" → 1127, auto-create NUEVO if unknown.
//  - CKJ Transport rows: "CKJ7040" (4+ digits) = KT truck → 7040, auto-create NUEVO;
//    "CKJ340" (3 digits) = CKJ-affiliated sub and other carriers riding the CKJ fleet
//    (e.g. "ARANGO - 1116") only match if already on my roster — never auto-created.
//  - Cactus sub fleets (Butler, Billy Walker, Hope, Arrowhead): raw number, auto-create.
//  - Any other fleet: match only if the number already exists somewhere in my roster.
function matchLoadRow(r, orgs, subNames) {
  const fleetName = (typeof r.fleet === 'string' ? r.fleet : (r.fleet && r.fleet.name)) || '';
  const orgHit = orgs.find(o => o.fleetNames.some(n => normNum(n) === normNum(fleetName)));
  if (orgHit) {
    let num = normLoadTruck(r.truck_number, fleetName, orgHit.fleetNames, orgHit.truck_prefix);
    if (orgHit.id === 'KT') {
      const digits = canonicalTruckNumber('KT', num);
      if (!/^\d{4,}$/.test(digits)) {
        const cand = normNum(r.truck_number).replace(/\s+/g, '');
        // CKJ IC (independent contractor): CKJ + 1-3 dígitos → truck propio bajo KT ICS,
        // con el número COMPLETO como llave y display (así lo ves en NewMile)
        if (/^CKJ\d{1,3}$/.test(cand)) {
          return { orgId: 'KT', num: cand, autoCreate: true, sub: true, tags: 'CKJ IC', suggestedDivision: 'ICS', display: cand.slice(3) };
        }
        // otros números ajenos rodando bajo el fleet CKJ (Arango…): por alias o tal cual
        const alias = ckjAliasKey(r.truck_number);
        const hit = get('SELECT org_id, number FROM trucks WHERE number IN (?, ?, ?)', alias, cand, digits);
        return hit ? { orgId: hit.org_id, num: hit.number, autoCreate: false } : null;
      }
      // CKJ#### de 4 dígitos: normalmente flota KT, pero si NO hay truck de flota con
      // esos dígitos y SÍ existe el IC (CKJ7078 descubierto por Samsara), es el IC
      if (!get(`SELECT 1 AS x FROM trucks WHERE org_id = 'KT' AND number = ?`, digits) &&
          get(`SELECT 1 AS x FROM trucks WHERE org_id = 'KT' AND number = ?`, 'CKJ' + digits)) {
        return { orgId: 'KT', num: 'CKJ' + digits, autoCreate: false };
      }
      num = digits;
    }
    return { orgId: orgHit.id, num, autoCreate: true };
  }
  if (subNames.some(n => normNum(n) === normNum(fleetName))) {
    return { orgId: 'CACTUS', num: normNum(r.truck_number), autoCreate: true, sub: true, tags: 'SUBHAULER' };
  }
  const cand = normNum(r.truck_number).replace(/\s+/g, '');
  const hit = get('SELECT org_id, number FROM trucks WHERE number = ?', cand);
  if (hit) return { orgId: hit.org_id, num: hit.number, autoCreate: false };
  // el display también cuenta ("LT245" guardado como display del sub "245")
  const hd = get('SELECT org_id, number FROM trucks WHERE display_number = ?', cand);
  if (hd) return { orgId: hd.org_id, num: hd.number, autoCreate: false };
  // ALIAS CKJ: los tickets de Arango llegan con SU PROPIO fleet y como "AT269", pero el
  // truck vive como ARANGO269 ("269 - Arango"). Sin esto se crearían subs duplicados.
  const ali = ckjAliasKey(r.truck_number);
  if (ali !== cand) {
    const ha = get('SELECT org_id, number FROM trucks WHERE number = ?', ali);
    if (ha) return { orgId: ha.org_id, num: ha.number, autoCreate: false };
  }
  const pm = /^([A-Z]{1,4})-?(\d{1,4})$/.exec(cand);
  if (pm) {
    // sub ya en el roster con el número INCOMPLETO (Livingston "245" vs NewMile "LT245"):
    // se matchea por los dígitos y de paso se le pone el número completo de NewMile
    const bare = get(`SELECT org_id, number, display_number FROM trucks WHERE number = ? AND is_sub = 1`, pm[2]);
    if (bare) {
      if (bare.display_number === bare.number) {
        run(`UPDATE trucks SET display_number = ?, updated_at = ? WHERE org_id = ? AND number = ?`, cand, nowISO(), bare.org_id, bare.number);
      }
      return { orgId: bare.org_id, num: bare.number, autoCreate: false };
    }
  }
  // SUBHAULER EXTERNO: verificado en vivo contra NewMile (7/15/26) que estos NUNCA traen
  // fleet vacío — cargan su PROPIA compañía ("AMP Transport LLC", "Salazar Logistics"…).
  // Por eso la regla es: cualquier fleet que NO sea de casa (Cactus Express / CKJ
  // Transport) ni un fleet de sub ya conocido = subhauler. Hay muchísimos, así que NO se
  // crea de golpe: se marca CANDIDATO y syncActivity adopta por FRECUENCIA los que
  // usamos seguido (a la zona SUBS de Cactus North). Los esporádicos se ignoran.
  if (normNum(fleetName)) {
    return { subCandidate: true, orgId: 'CACTUS', num: cand, sub: true, tags: 'SUBHAULER', fleet: String(fleetName).trim() };
  }
  return null;
}

// ---------- roster ----------
// ---- RECONCILIADOR DE ICs: NewMile manda, el board obedece ----
// Compara TODA la flota CKJ de NewMile (fleet 6 + trokes sin fleet de esos mismos dueños)
// contra el board: crea los ICs que falten bajo CKJ ICS, revive los archivados que siguen
// activos en NewMile, y reporta lo que quedó. Los "KT-" de Kennemer no se tocan aquí.
async function reconcileICs(client, opts) {
  const dry = !!(opts && opts.dry);
  const kt = get(`SELECT * FROM orgs WHERE id = 'KT'`);
  if (!kt) return { error: 'KT org not configured' };
  const fleetId = kt.nm_fleet_id;
  // la flota COMPLETA se pide filtrada en el servidor (no depende del tope de páginas)
  const inFleet = client.listTrucksByFleet ? await client.listTrucksByFleet(fleetId)
    : (await client.listTrucksAll()).filter(t => (t.fleet_id != null ? t.fleet_id : (t.fleet && t.fleet.id)) === fleetId);
  const owners = new Set(inFleet.map(t => t.owner_id).filter(x => x != null));
  const mine = inFleet.slice();
  const seenIds = new Set(inFleet.map(t => t.id));
  // completitud por dueño: Arango y otros traen fleet_id vacío en la mayoría de sus trokes
  const nmTrucks = await client.listTrucksAll();
  for (const t of nmTrucks) {
    const fid = t.fleet_id != null ? t.fleet_id : (t.fleet && t.fleet.id);
    if (!fid && t.owner_id != null && owners.has(t.owner_id) && !seenIds.has(t.id)) { mine.push(t); seenIds.add(t.id); }
  }
  const out = { nm_scanned: nmTrucks.length, nm_ckj_trucks: mine.length, created: [], restored: [], already: 0, kennemer_fleet: 0, retagged: [], skipped: [] };
  // IC vs SUB: un IC es un owner-operator con número PELÓN ("452", "314"). Una compañía
  // sub (Arango, DUMP-ER) trae su nombre en el número ("269 - Arango", "2011 - DUMP-Er").
  // Se decide por DUEÑO: si alguno de sus trokes trae letras, TODOS son subhauler — así
  // el "2018" pelón de DUMP-ER no se queda solo del lado equivocado.
  const companyOwners = new Set();
  for (const t of mine) {
    const raw = String(t.truck_number || '').trim();
    if (!raw || /^KT[-\s]/i.test(raw)) continue;
    if (/[A-Za-z]/.test(raw) && t.owner_id != null) companyOwners.add(t.owner_id);
  }
  for (const t of mine) {
    const raw = String(t.truck_number || '').trim();
    const ownerName = String(t.owner_name || (t.owner && t.owner.name) || '').trim();
    if (!raw) { out.skipped.push('(sin número) ' + ownerName); continue; }
    if (/^KT[-\s]/i.test(raw) || /kennemer/i.test(ownerName)) { out.kennemer_fleet++; continue; }
    // clave del IC: dígitos si el nombre es pelón ("452" → CKJ452); si trae letras
    // (Arango y compañía) se usa el nombre compactado en MAYÚSCULAS como llave estable
    const bare = normNum(raw).replace(/\s+/g, '');
    const key = ckjAliasKey(raw); // "01 - Arango"/"AT01" → ARANGO01 · "452" → CKJ452
    const display = /^\d{1,4}$/.test(bare) ? bare : raw;
    const driver = String(t.driver_name || t.driver || '').trim();
    const trailer = shortTrailer(t.truck_type || '');
    const nmId = t.id != null ? t.id : null;
    // compañía sub (Arango, DUMP-ER) vs IC de verdad (owner-operator con número pelón)
    const isSubCo = t.owner_id != null && companyOwners.has(t.owner_id);
    const tags = isSubCo ? 'SUBHAULER' : 'CKJ IC';
    const div = isSubCo ? null : 'ICS'; // los subs viven en su propio tab, no en ICS
    let row = get(`SELECT * FROM trucks WHERE org_id = 'KT' AND (number = ? OR nm_truck_id = ?)`, key, nmId);
    // NewMile a veces trae el MISMO camión dos veces: "2018" y "2018 - DUMP-Er". Si ya
    // existe uno del MISMO DUEÑO con los mismos dígitos, es el mismo truck: no duplicar.
    if (!row && t.owner_id != null) {
      const dig = (bare.match(/\d+/) || [''])[0];
      if (dig) {
        row = get(`SELECT * FROM trucks WHERE org_id = 'KT' AND owner_id = ?
                     AND (number = ? OR number = ? OR display_number = ?
                          OR (number LIKE ? AND REPLACE(REPLACE(number,'CKJ',''),'ARANGO','') = ?))`,
          t.owner_id, 'CKJ' + dig, key, raw, '%' + dig + '%', dig);
        if (row) out.skipped.push(display + ' = mismo truck que ' + (row.display_number || row.number) + ' (' + ownerName + ')');
      }
    }
    if (row) {
      if (row.archived) {
        if (!dry) run(`UPDATE trucks SET archived = 0, maybe_removed = 0, updated_at = ? WHERE org_id = 'KT' AND number = ?`, nowISO(), row.number);
        out.restored.push((row.display_number || row.number) + ' · ' + ownerName);
      } else out.already++;
      // completa datos que falten (dueño, id de NewMile, driver, tipo)
      if (!dry) {
        const sets = [], vals = [];
        if (nmId != null && nmId !== row.nm_truck_id) { sets.push('nm_truck_id = ?'); vals.push(nmId); }
        if (t.owner_id != null && t.owner_id !== row.owner_id) { sets.push('owner_id = ?'); vals.push(t.owner_id); }
        if (ownerName && ownerName !== row.owner_name) { sets.push('owner_name = ?'); vals.push(ownerName); }
        if (driver && driver !== row.driver) { sets.push('driver = ?'); vals.push(driver); }
        if (trailer && trailer !== row.trailer_type && !row.trailer_override) { sets.push('trailer_type = ?'); vals.push(trailer); }
        // re-clasifica lo que quedó del lado equivocado (Arango/DUMP-ER marcados IC)
        if ((row.tags || '') !== tags) {
          sets.push('tags = ?'); vals.push(tags);
          if (isSubCo && row.division === 'ICS') { sets.push('division = NULL'); }
          out.retagged.push((row.display_number || row.number) + ' → ' + (isSubCo ? 'SUB' : 'IC') + ' (' + ownerName + ')');
        }
        if (sets.length) { sets.push('updated_at = ?'); vals.push(nowISO()); run(`UPDATE trucks SET ${sets.join(', ')} WHERE org_id = 'KT' AND number = ?`, ...vals, row.number); }
      }
      continue;
    }
    if (!dry) {
      run(`INSERT INTO trucks (org_id, number, display_number, division, area, driver, trailer_type,
             nm_truck_id, owner_id, owner_name, tags, is_sub, is_new, updated_at)
           VALUES ('KT',?,?,?,'(SIN YARD)',?,?,?,?,?,?,1,0,?)`,
        key, display, div, driver, trailer, nmId, t.owner_id != null ? t.owner_id : null, ownerName, tags, nowISO());
    }
    out.created.push(display + ' · ' + ownerName + (driver ? ' · ' + driver : '') + (isSubCo ? ' [SUB]' : ' [IC]'));
  }
  return out;
}

async function syncRoster(client) {
  const orgs = enabledOrgs();
  const nmTrucks = await client.listTrucksAll();
  const summary = { updated: 0, driverChanges: 0, created: 0, flaggedRemoved: 0, detectedFlags: 0 };

  for (const org of orgs) {
    if (!org.nm_fleet_id) continue;
    const mine = nmTrucks.filter(t => {
      const fid = t.fleet_id != null ? t.fleet_id : (t.fleet && t.fleet.id);
      const fname = typeof t.fleet === 'string' ? t.fleet : (t.fleet && t.fleet.name);
      return fid === org.nm_fleet_id || org.fleetNames.some(n => normNum(n) === normNum(fname));
    });
    // COMPLETITUD POR DUEÑO: incluye trokes SIN fleet cuyo DUEÑO ya está en nuestra flota.
    // NewMile a veces deja un troke de un owner-operator sin fleet asignado (p.ej. Samantha
    // Williams 1084) y se caería del roster; así todos los trokes de un dueño quedan juntos.
    const fleetOwners = new Set(mine.map(t => t.owner_id).filter(x => x != null));
    for (const t of nmTrucks) {
      const fid = t.fleet_id != null ? t.fleet_id : (t.fleet && t.fleet.id);
      if (!fid && t.owner_id != null && fleetOwners.has(t.owner_id) && !mine.includes(t)) mine.push(t);
    }
    const seen = new Set();

    for (const t of mine) {
      const rawName = t.truck_number || t.number || '';
      const parsed = splitNameFlag(rawName);
      let number = canonicalTruckNumber(org.id, parsed.number); // "KT-7040 P" → 7040 (llave)
      let display = displayTruckNumber(rawName);                // "KT-7040 P" (como NewMile)
      const flag = parsed.flag;
      if (!number) continue;
      const driver = (t.driver_name || t.driver || '').trim();
      const trailer = shortTrailer(t.truck_type || t.trailer_type || ''); // "Aluminum End Dump" → AL-ED
      const nmId = t.id != null ? t.id : (t.truck_id != null ? t.truck_id : null);
      // DUEÑO: owner_id estable (join) + owner_name (display, sin el espacio final que
      // traen algunas orgs). Es la organización que POSEE el truck, no el chofer.
      const ownerId = t.owner_id != null ? t.owner_id : (t.owner && t.owner.id != null ? t.owner.id : null);
      const ownerName = String(t.owner_name || (t.owner && t.owner.name) || '').trim();

      // REGLA IC (verificada contra NewMile 8/9/26): en el fleet CKJ, un número PELÓN
      // (sin "KT-") cuyo DUEÑO no es Kennemer = independent contractor. Vive como
      // CKJ### (display pelón) bajo CKJ ICS — la misma llave que usa Samsara. Los
      // pelones DE Kennemer (1720, 3541… legacy) siguen como flota, salvo que Samsara
      // ya los haya clasificado como IC (respetamos su twin CKJ###).
      let isIC = false;
      if (org.id === 'KT' && /^\d{1,4}$/.test(number) && !/^KT/i.test(normNum(rawName))) {
        const twin = get(`SELECT 1 AS x FROM trucks WHERE org_id = 'KT' AND number = ?`, 'CKJ' + number);
        if (twin || !/kennemer/i.test(ownerName)) {
          isIC = true;
          display = number;          // se muestra pelón, como en NewMile/Samsara
          number = 'CKJ' + number;   // llave sin chocar con la flota
        }
      }
      seen.add(number);

      const row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', org.id, number);
      if (!row) {
        if (isIC) {
          // IC: directo al board bajo CKJ ICS (no es ⚑ NUEVO de flota); el GPS lo acomoda
          run(`INSERT INTO trucks (org_id, number, display_number, division, area, driver, trailer_type, detected_flag,
                 nm_truck_id, owner_id, owner_name, tags, is_sub, is_new, updated_at)
               VALUES (?,?,?,'ICS','(SIN YARD)',?,?,?,?,?,?,'CKJ IC',1,0,?)`,
            org.id, number, display, driver, trailer, flag, nmId, ownerId, ownerName, nowISO());
          summary.created++;
          continue;
        }
        // NEVER silently missing: create with ⚑ NUEVO, no division until I assign it.
        // KT names carry the terminal letter ("KT-7040 P") → pre-fill the suggestion.
        const hint = org.id === 'KT' ? ktDivisionHint(rawName) : null;
        run(`INSERT INTO trucks (org_id, number, display_number, division, area, driver, trailer_type, detected_flag,
               nm_truck_id, owner_id, owner_name, suggested_division, is_new, updated_at)
             VALUES (?,?,?,NULL,'(SIN YARD)',?,?,?,?,?,?,?,1,?)`,
          org.id, number, display, driver, trailer, flag, nmId, ownerId, ownerName, hint, nowISO());
        summary.created++;
        continue;
      }
      const sets = [], vals = [];
      if (ownerId != null && ownerId !== row.owner_id) { sets.push('owner_id = ?'); vals.push(ownerId); }
      if (ownerName && ownerName !== row.owner_name) { sets.push('owner_name = ?'); vals.push(ownerName); }
      if (driver && driver !== row.driver) {
        sets.push('driver_prev = ?', 'driver = ?', 'driver_changed_at = ?');
        vals.push(row.driver || '', driver, nowISO());
        summary.driverChanges++;
      }
      if (trailer && trailer !== row.trailer_type && !row.trailer_override) { sets.push('trailer_type = ?'); vals.push(trailer); }
      if (display && display !== row.display_number) { sets.push('display_number = ?'); vals.push(display); }
      if (nmId != null && nmId !== row.nm_truck_id) { sets.push('nm_truck_id = ?'); vals.push(nmId); }
      // mismo patrón que samsara_flag: lo ya revisado no rebota; texto nuevo sí propone
      if (flag && flag === (row.detected_flag_dismissed || '')) flag = row.detected_flag || '';
      else if (!flag && row.detected_flag_dismissed) sets.push("detected_flag_dismissed = ''");
      if (flag && flag !== row.detected_flag) { sets.push('detected_flag = ?'); vals.push(flag); summary.detectedFlags++; }
      if (row.maybe_removed) { sets.push('maybe_removed = 0'); } // it's back in the fleet
      if (sets.length) {
        sets.push('updated_at = ?'); vals.push(nowISO());
        run(`UPDATE trucks SET ${sets.join(', ')} WHERE org_id = ? AND number = ?`, ...vals, org.id, number);
        summary.updated++;
      }
    }

    // ¿de baja? — only fleet trucks (subs live in other fleets); flag, never delete.
    // Guard: a truncated/failed pull must never flag half the fleet — if NewMile
    // returned less than half of my active roster for this org, skip the check.
    const active = all(
      `SELECT number, baja_dismissed_at FROM trucks WHERE org_id = ? AND is_sub = 0 AND archived = 0 AND maybe_removed = 0`,
      org.id);
    if (active.length >= 4 && seen.size < active.length / 2) {
      summary.removalCheckSkipped = (summary.removalCheckSkipped || []).concat(
        `${org.id}: pull trajo ${seen.size} de ${active.length} activos`);
    } else {
      const bajaCut = shiftISO(todayCT(), -21); // "keep" reciente: le creo 21 días antes de volver a preguntar
      for (const r of active.filter(r => !seen.has(r.number))) {
        if (r.baja_dismissed_at && String(r.baja_dismissed_at).slice(0, 10) >= bajaCut) continue;
        run(`UPDATE trucks SET maybe_removed = 1, updated_at = ? WHERE org_id = ? AND number = ?`, nowISO(), org.id, r.number);
        summary.flaggedRemoved++;
      }
    }
  }

  metaSet('last_sync_newmile_roster', nowISO());
  metaSet('last_sync_newmile_roster_summary', JSON.stringify(summary));
  return summary;
}

// ---------- activity ----------
// days: ventana de load_tickets a jalar. Los syncs FRECUENTES (cada rato / al abrir) pasan
// una ventana corta (3 días) — barato, suficiente para auto-cover y para mover last_load
// hacia adelante. El sync DIARIO pasa 21 días para recalcular "X días sin carga". Menos
// CPU/red = el tier gratis de Azure aguanta sin deshabilitarse.
async function syncActivity(client, days) {
  const today = todayCT();
  const from = shiftISO(today, -(days || ACTIVITY_WINDOW_DAYS));
  const rows = await client.loadTicketsRangeAll(from, today);
  const orgs = enabledOrgs();
  const cactus = orgs.find(o => o.id === 'CACTUS');
  const subNames = subFleetNames();
  const summary = { tickets: rows.length, matched: 0, autoCovered: 0, createdNew: 0, subsAdopted: 0, unmatched: 0 };

  // rebuild the window: aggregate loads per (org, number, date) with the LAST driver seen
  const agg = new Map(); // key org|num|date -> {loads, driver}
  const autoMark = get(`SELECT value FROM meta WHERE key = 'auto_mark'`);
  const autoOn = !autoMark || autoMark.value !== '0';

  for (const r of rows) {
    const iso = reportDateToISO(r.order_date) || today;
    const m = matchLoadRow(r, orgs, subNames);
    if (!m) { summary.unmatched++; continue; }

    const key = m.orgId + '|' + m.num + '|' + iso;
    const cur = agg.get(key) || { loads: 0, rev: 0, driver: '', owner: '', m };
    cur.loads++;
    // 💰 freight ganado por carga (Tony). NewMile deja freight_rate_extended en $0 mientras
    // el ticket espera cantidad del driver ("Waiting for Driver") — en ese caso lo estimamos:
    // rate × toneladas del pickup ticket, o ×1 si el rate es por CARGA. El re-sync diario de
    // 21 días reemplaza el estimado con el número final cuando NewMile lo cierra.
    const _m = (x) => Number(String(x == null ? '' : x).replace(/[$,]/g, '')) || 0;
    let _rev = _m(r.freight_rate_extended);
    if (!_rev) {
      const _rate = _m(r.freight_rate);
      if (_rate) {
        const _uom = String(r.freight_rate_uom || '').toLowerCase();
        const _qty = _m(r.quantity) || _m(r.pickup_ticket_quantity) || (_uom.indexOf('load') >= 0 ? 1 : 0);
        _rev = _rate * _qty;
      }
    }
    cur.rev += _rev;
    if (r.driver_name) cur.driver = String(r.driver_name).trim();
    if (r.truck_owner) cur.owner = String(r.truck_owner).trim(); // dueño (denormalizado en el ticket)
    agg.set(key, cur);
  }

  // ADOPCIÓN DE SUBS POR FRECUENCIA: un subhauler externo (fleet ajeno, no en el roster)
  // que corre en >= SUB_REGULAR_DAYS días distintos de la ventana = "de los que usamos
  // siempre" → entra solo a Cactus North, zona SUBS (colapsable, al final). Los que solo
  // aparecen un par de veces NO se agregan (no queremos poner a todos).
  const SUB_REGULAR_DAYS = 3;
  const candDays = new Map(); // num -> Set(iso)
  for (const [key, v] of agg) {
    if (!v.m.subCandidate) continue;
    const iso = key.split('|')[2];
    if (get('SELECT 1 AS x FROM trucks WHERE org_id = ? AND number = ?', v.m.orgId, v.m.num)) continue; // ya existe
    (candDays.get(v.m.num) || candDays.set(v.m.num, new Set()).get(v.m.num)).add(iso);
  }
  const adopt = new Set([...candDays].filter(([, d]) => d.size >= SUB_REGULAR_DAYS).map(([n]) => n));
  // ⚑ SUBS NUEVOS AL INSTANTE (2026-08-26, el caso JT7531): un sub externo que corrió HOY o
  // AYER entra YA al board (zona SUBS de Cactus North, con bandera ⚑ NUEVO para revisarlo) —
  // Juan despacha para MAÑANA y un sub invisible sus primeros 3 días no sirve de nada. La
  // regla de frecuencia (>= 3 días distintos) se queda para adoptar SIN bandera; los
  // esporádicos VIEJOS de la ventana de 21 días siguen ignorados como hasta hoy.
  const fresh = new Set();
  {
    const yd = shiftISO(today, -1);
    for (const [num, dset] of candDays) if (!adopt.has(num) && (dset.has(today) || dset.has(yd))) fresh.add(num);
  }

  for (const [key, v] of agg) {
    const [orgId, num, iso] = key.split('|');
    let row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, num);
    if (!row) {
      const adoptThis = v.m.subCandidate && adopt.has(num);
      const freshThis = v.m.subCandidate && fresh.has(num);
      if (!v.m.autoCreate && !adoptThis && !freshThis) { summary.unmatched += v.loads; continue; }
      // Ran a load but is not on my roster → ⚑ NUEVO immediately (never wait for 4:30 AM).
      // Un sub adoptado o uno con lugar propio entra directo al board (NORTH / zona SUBS).
      const sub = v.m.sub || (orgId === 'CACTUS' && /^(BT|BW|HS|AE)\d/i.test(num)) ? 1 : 0;
      const division = (adoptThis || freshThis) ? 'NORTH' : (v.m.division || null);
      const area = (adoptThis || freshThis) ? 'SUBS' : (v.m.area || '(SIN YARD)');
      const placed = adoptThis || !!v.m.area; // fresh entra colocado PERO con ⚑ NUEVO para revisión
      run(`INSERT INTO trucks (org_id, number, display_number, division, area, driver, owner_name, tags, is_sub, suggested_division, is_new, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        orgId, num, v.m.display || num, division, area, v.driver || '', v.owner || v.m.fleet || '',
        v.m.tags || (sub ? 'SUBHAULER' : ''), sub, v.m.suggestedDivision || null, placed ? 0 : 1, nowISO());
      row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ?', orgId, num);
      if (adoptThis) summary.subsAdopted++;
      else if (freshThis) summary.subsFresh = (summary.subsFresh || 0) + 1;
      else summary.createdNew++;
    } else {
      if (row.archived) {
        // estaba archivado por inactividad pero VOLVIÓ a correr carga → regresa al board
        // en su mismo lugar (división/área que ya tenía)
        run(`UPDATE trucks SET archived = 0, maybe_removed = 0, updated_at = ? WHERE org_id = ? AND number = ?`, nowISO(), orgId, num);
        summary.resurfaced = (summary.resurfaced || 0) + 1;
      }
      if (v.owner && v.owner !== row.owner_name) {
        // dueño desde el ticket (para subs que el roster de flota no trae)
        run(`UPDATE trucks SET owner_name = ? WHERE org_id = ? AND number = ?`, v.owner, orgId, num);
      }
    }
    run(`INSERT INTO activity_log (org_id, number, load_date, driver, loads, revenue) VALUES (?,?,?,?,?,?)
         ON CONFLICT(org_id, number, load_date) DO UPDATE SET loads = excluded.loads, driver = excluded.driver, revenue = excluded.revenue`,
      orgId, num, iso, v.driver || '', v.loads, Math.round(v.rev * 100) / 100);
    summary.matched++;

    const isToday = iso === today;
    run(`UPDATE trucks SET
           last_load_date = CASE WHEN last_load_date IS NULL OR last_load_date < ? THEN ? ELSE last_load_date END,
           last_load_driver = CASE WHEN last_load_date IS NULL OR last_load_date <= ? THEN ? ELSE last_load_driver END,
           loads_today = CASE WHEN ? THEN ? ELSE loads_today END,
           updated_at = ?
         WHERE org_id = ? AND number = ?`,
      iso, iso, iso, v.driver || '', isToday ? 1 : 0, v.loads, nowISO(), orgId, num);

    // Auto-cover: hauling today = covered. Manual marks always win.
    if (autoOn && isToday) {
      const st = get('SELECT * FROM dispatch_state WHERE date = ? AND org_id = ? AND number = ?', today, orgId, num);
      if (!st) {
        run(`INSERT INTO dispatch_state (date, org_id, number, state, source, marked_at) VALUES (?,?,?,'a','auto',?)`,
          today, orgId, num, nowISO());
        summary.autoCovered++;
      } else if (st.source === 'auto' && st.state !== 'a') {
        run(`UPDATE dispatch_state SET state = 'a', marked_at = ? WHERE date = ? AND org_id = ? AND number = ? AND source = 'auto'`,
          nowISO(), today, orgId, num);
      }
    }
  }

  // Assignments: cover trucks that are PLANNED even if they haven't hauled yet — for
  // TODAY and for the NEXT WORKING DAY. La maquinaria vive a nivel módulo
  // (coverAssignmentsFor) para que el carril rápido de 3 min (syncAssignments) la use
  // sin cargar el sync pesado de tickets. Este alias conserva las llamadas de siempre.
  const coverFromAssignments = (dateISO, label) => coverAssignmentsFor(client, dateISO, label, summary, cactus, today);

  // corrió carga esta semana = ACTIVO → limpiar "¿de baja?" (falsas alarmas del roster)
  run(`UPDATE trucks SET maybe_removed = 0 WHERE maybe_removed = 1 AND last_load_date >= ?`, shiftISO(today, -7));

  // SOLO LOS QUE TRABAJAN: un truck sin carga en 30 días se ARCHIVA solo (no estorba en
  // el board). Regresa SOLO en cuanto corra carga o venga asignado (arriba). Protegidos:
  // ⭐ stars, ⚑ nuevos, editados hace poco, con time off vigente/futuro o marcas recientes.
  // Corre únicamente en el sync COMPLETO (ventana >= 21 d) y con pull sano, para que un
  // jalón fallido de NewMile no archive media flota.
  if ((days || ACTIVITY_WINDOW_DAYS) >= 21 && summary.matched >= 50) {
    const cutoff = shiftISO(today, -30);
    const r = run(`UPDATE trucks SET archived = 1
         WHERE archived = 0 AND is_new = 0 AND star = 0
           AND (last_load_date IS NULL OR last_load_date < ?)
           AND updated_at < ?
           AND NOT EXISTS (SELECT 1 FROM time_off o WHERE o.org_id = trucks.org_id AND o.number = trucks.number AND o.to_date >= ?)
           AND NOT EXISTS (SELECT 1 FROM dispatch_state s WHERE s.org_id = trucks.org_id AND s.number = trucks.number AND s.date >= ? AND s.source = 'manual')`,
      cutoff, cutoff + 'T00:00:00.000Z', today, shiftISO(today, -14));
    summary.dormantArchived = r.changes;

    // RUIDO FUERA: SIN CHOFER + dueño/org INACTIVO (ningún truck de ese dueño ha corrido
    // carga en 30 días) = no pinta en el board, aunque traiga bandera de NUEVO. Solo
    // flota propia (is_sub = 0): los SUBS no tienen Samsara y se rigen por la regla de
    // 30 días sin carga de arriba (su trabajo SÍ se ve en NewMile). Protegidos: ⭐ stars,
    // time off vigente y marcas manuales recientes. Regresan solos con carga/asignación.
    const noDrv = run(`UPDATE trucks SET archived = 1, is_new = 0
         WHERE archived = 0 AND star = 0 AND is_sub = 0
           AND (TRIM(COALESCE(driver, '')) = '' OR status = 'no_driver'
                OR driver LIKE '%SIN DRIVER%' OR driver LIKE '%NO DRIVER%')
           AND (last_load_date IS NULL OR last_load_date < ?)
           AND NOT EXISTS (SELECT 1 FROM time_off o WHERE o.org_id = trucks.org_id AND o.number = trucks.number AND o.to_date >= ?)
           AND NOT EXISTS (SELECT 1 FROM dispatch_state s WHERE s.org_id = trucks.org_id AND s.number = trucks.number AND s.date >= ? AND s.source = 'manual')
           AND (COALESCE(owner_name, '') = '' OR NOT EXISTS (
                SELECT 1 FROM trucks t2 WHERE t2.owner_name = trucks.owner_name AND t2.last_load_date >= ?))`,
      cutoff, today, shiftISO(today, -14), cutoff);
    summary.noDriverArchived = noDrv.changes;
  }

  if (autoOn) {
    await coverFromAssignments(today, 'today');
    const wd = new Date(today + 'T12:00:00Z').getUTCDay();
    const nextWork = shiftISO(today, wd === 6 ? 2 : 1); // sábado planea el lunes
    await coverFromAssignments(nextWork, 'tomorrow');
  }

  // zero out loads_today for trucks that had none today
  run(`UPDATE trucks SET loads_today = 0
       WHERE loads_today > 0 AND NOT EXISTS (
         SELECT 1 FROM activity_log a WHERE a.org_id = trucks.org_id AND a.number = trucks.number AND a.load_date = ?)`,
    today);

  metaSet('last_sync_newmile_activity', nowISO());
  metaSet('last_sync_newmile_activity_summary', JSON.stringify(summary));
  return summary;
}

// ---------- RIP RAP capability scan ----------
// "¿Qué trucks SÍ pueden cargar rip rap?" — la evidencia más dura es que ya lo cargaron.
// Scans load_tickets materials over a window; a roster truck that hauled rip rap but is
// not marked rip_rap gets rip_suggested + evidence (loads, dates, material names). I
// confirm from the UI (my rip-rap flag is the truth; this only proposes, never marks).
const RIP_RE = /rip\s*-?\s*rap|riprap/i;

async function scanRipRap(client, days) {
  const today = todayCT();
  const from = shiftISO(today, -(days || 30));
  const rows = await client.loadTicketsMaterialsAll(from, today);
  const orgs = enabledOrgs();
  const subNames = subFleetNames();

  const evidence = new Map(); // org|num -> {loads, first, last, materials:Set}
  for (const r of rows) {
    const mat = String(r.material || '') + ' | ' + String(r.alternative_material_name || '');
    if (!RIP_RE.test(mat)) continue;
    const m = matchLoadRow(r, orgs, subNames);
    if (!m) continue;
    const num = m.num;
    const iso = reportDateToISO(r.order_date) || today;
    const key = m.orgId + '|' + num;
    const e = evidence.get(key) || { loads: 0, first: iso, last: iso, materials: new Set() };
    e.loads++;
    if (iso < e.first) e.first = iso;
    if (iso > e.last) e.last = iso;
    e.materials.add((r.material || r.alternative_material_name || '').trim());
    evidence.set(key, e);
  }

  const summary = { window_days: days || 30, rip_loads: 0, trucks: [], suggested: 0, already_marked: 0, unknown: [] };
  for (const [key, e] of evidence) {
    const [orgId, num] = key.split('|');
    summary.rip_loads += e.loads;
    const t = { number: num, loads: e.loads, first: e.first, last: e.last, materials: [...e.materials] };
    summary.trucks.push(t);
    const row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ? AND archived = 0', orgId, num);
    if (!row) { summary.unknown.push(num); continue; }
    const ev = JSON.stringify({ loads: e.loads, first: e.first, last: e.last, materials: [...e.materials] });
    if (row.rip_rap) {
      summary.already_marked++;
      run(`UPDATE trucks SET rip_evidence = ? WHERE org_id = ? AND number = ?`, ev, orgId, num);
    } else if (row.rip_dismissed_last && e.last <= row.rip_dismissed_last) {
      // ya lo descarté y no hay cargas rip NUEVAS desde entonces: evidencia fresca, sin badge
      run(`UPDATE trucks SET rip_evidence = ? WHERE org_id = ? AND number = ?`, ev, orgId, num);
    } else {
      run(`UPDATE trucks SET rip_suggested = 1, rip_evidence = ?, updated_at = ? WHERE org_id = ? AND number = ?`,
        ev, nowISO(), orgId, num);
      summary.suggested++;
    }
  }
  summary.trucks.sort((a, b) => b.loads - a.loads);
  metaSet('last_scan_riprap', nowISO());
  metaSet('last_scan_riprap_summary', JSON.stringify(summary));
  return summary;
}

// ---------- COBERTURA DESDE ASIGNACIONES (nivel módulo) ----------
// Marca ⚡ asignado desde las órdenes de NewMile para un día (misma maquinaria de
// siempre: tolerancia de números, gaps, live status, confirmar/des-confirmar). La usan
// el sync pesado (syncActivity) y el carril RÁPIDO syncAssignments de abajo.
async function coverAssignmentsFor(client, dateISO, label, summary, cactus, today) {
    try {
      // Órdenes CON asignaciones: cubre trucks Y captura A DÓNDE va cada uno + los huecos
      let changed = 0; // escrituras REALES → bump de board_rev (el front recarga en <=8 s)
      const rows = await client.ordersForDate(dateISO);
      const nums = new Set();
      const matched = new Set(); // org|num de los que SÍ están en NewMile ese día
      const destByNum = new Map(); // num normalizado -> [{n,c,m,d}] (destinos del día)
      const metaByNum = new Map(); // num -> {fleet, owner, driver} (para crear el ⚑ NUEVO bien)
      const gaps = [];             // órdenes a las que les faltan trucks
      let assignCount = 0;
      for (const { order: o, assignments } of rows) {
        const info = {
          n: String(o.reference || o.project_name || o.customer_name || ('Order ' + o.id)).slice(0, 60),
          c: String(o.customer_name || '').slice(0, 40),
          m: String(o.material_name || o.material || '').slice(0, 40),
          d: String(o.dropoff_location_name || o.dropoff_org_location_name || o.dropoff_site_name || '').slice(0, 50)
        };
        const act = (assignments || []).filter(a => !/cancel/i.test(a.assignment_status || ''));
        assignCount += act.length;
        for (const a of act) {
          const raw = a.truck_number || (a.truck && (a.truck.truck_number || a.truck.number)) || '';
          if (!raw) continue;
          const key = normNum(raw).replace(/\s+/g, '');
          nums.add(key);
          (destByNum.get(key) || destByNum.set(key, []).get(key)).push(info);
          if (!metaByNum.has(key)) {
            const tk = a.truck || {};
            metaByNum.set(key, {
              raw: String(raw).trim(),   // número EXACTO como NewMile lo muestra (con su prefijo)
              fleet: String(a.fleet || tk.fleet || (tk.fleet && tk.fleet.name) || '').trim(),
              owner: String(a.truck_owner || tk.owner_name || tk.owner || '').trim(),
              driver: String(a.driver_name || a.driver || tk.driver_name || '').trim()
            });
          }
        }
        const planned = o.planned_truck_count != null ? Number(o.planned_truck_count) : null;
        if (planned && act.length < planned && !/cancel|complete|closed/i.test(o.status || '')) {
          gaps.push({ id: o.id, ...info, planned, assigned: act.length, gap: planned - act.length });
        }
      }
      metaSet('nm_gaps_' + dateISO, JSON.stringify(gaps.sort((a, b) => b.gap - a.gap).slice(0, 40)));
      // ESTADO DE LA CARGA EN CURSO (solo HOY): "driving to pickup", "at delivery"…
      // Se guarda por truck para pintarlo en el cuadrito. Las terminadas no cuentan.
      const liveStatus = new Map();
      if (dateISO === today && client.loadsForOrder) {
        const withAssign = rows.filter(r => (r.assignments || []).length).slice(0, 60);
        const lists = await Promise.all(withAssign.map(async (r) => {
          try { return await client.loadsForOrder(r.order.id); } catch (e) { return []; }
        }));
        for (const loads of lists) for (const ld of loads) {
          const st = String(ld.status || '');
          if (!st || /complete|cancel|void/i.test(st)) continue;
          const raw = ld.truck_number || '';
          if (raw) liveStatus.set(normNum(raw).replace(/\s+/g, ''), st);
        }
        summary[label + 'LiveLoads'] = liveStatus.size;
      }
      summary[label + 'Assignments'] = assignCount;
      if (gaps.length) summary[label + 'OrderGaps'] = gaps.length;
      for (const n of nums) {
        // assignment numbers usually match the truck resource, but tolerate the
        // load-report styles too: "C1127" (Cactus) and "KT-7040 P"/"CKJ7040" (KT)
        const candidates = [n, canonicalTruckNumber('KT', n)];
        if (cactus && cactus.truck_prefix && n.startsWith(cactus.truck_prefix) && /\d/.test(n.slice(cactus.truck_prefix.length))) {
          candidates.push(n.slice(cactus.truck_prefix.length));
        }
        // CKJ ICs: la asignación trae el número PELÓN ("211") pero el IC vive como CKJ211
        if (/^\d{1,4}$/.test(n)) candidates.push('CKJ' + n);
        // ALIAS ARANGO/CKJ: la asignación llega "AT269" / "269 - Arango" pero el troke vive como
        // "ARANGO269"/"ARANGO-269"/"AT269" (numeración inconsistente en NewMile). ckjAliasKey
        // normaliza a "ARANGO<dígitos>"; sin esto los Arango de Sanger quedaban sin contar.
        const alias = ckjAliasKey(n);
        if (alias && alias !== n) candidates.push(alias);
        let hit = null;
        for (const c of [...new Set(candidates)]) {
          hit = get('SELECT org_id, number, archived FROM trucks WHERE number = ?', c);
          if (hit) break;
        }
        // último recurso: display_number ("LT245" del sub 245, "211" del IC CKJ211)
        if (!hit) hit = get('SELECT org_id, number, archived FROM trucks WHERE display_number = ?', n);
        // ARANGO por DÍGITOS: el mismo troke está escrito de mil formas (AT269 / 269 - Arango /
        // ARANGO-269). Si trae "ARANGO"/"AT<díg>", matchea CUALQUIER troke Arango con esos
        // dígitos — así cuenta una vez y NO crea un duplicado nuevo.
        if (!hit && /ARANGO|^AT\d/i.test(n)) {
          const dig = (n.match(/\d+/) || [''])[0];
          if (dig) {
            for (const cand of all(`SELECT org_id, number, archived FROM trucks
                                    WHERE (UPPER(number) LIKE '%ARANGO%' OR UPPER(number) LIKE 'AT%')`)) {
              const cdig = (String(cand.number).match(/\d+/) || [''])[0];
              if (cdig && String(Number(cdig)) === String(Number(dig))) { hit = cand; break; }
            }
          }
        }
        // ⚑ PRIMERA VEZ QUE CORRE (2026-08-27, Juan): un troke ASIGNADO en NewMile que NO está
        // en la lista se CREA como ⚑ NUEVO para colocarlo en su zona — así cuadra con el board
        // (que cuenta toda asignación) y no se pierde ningún sub de primera vez.
        // ORG por su FLEET/organización de NewMile (matchLoadRow), NO por cómo está escrito el
        // número (Juan). DISPLAY = número EXACTO como NewMile lo muestra (con su prefijo).
        if (!hit) {
          if (!/^[A-Z]{0,4}\d{2,5}[A-Z]?$/i.test(n)) continue; // no parece número de troke → ignora
          const md = metaByNum.get(n) || {};
          const disp = (md.raw || n).toString().trim().slice(0, 40); // exacto de NewMile
          // clasifica por el FLEET de la asignación (misma lógica que los tickets)
          const m = matchLoadRow({ truck_number: md.raw || n, fleet: md.fleet || '', driver_name: md.driver || '', truck_owner: md.owner || '' }, enabledOrgs(), subFleetNames());
          const org = (m && m.orgId) || 'CACTUS';
          const isSub = m ? (m.sub ? 1 : 0) : 1;
          const tags = (m && m.tags) || (isSub ? 'SUBHAULER' : '');
          const keyNum = (m && m.num) ? String(m.num) : n.toUpperCase(); // llave interna (canónica)
          if (get('SELECT 1 AS x FROM trucks WHERE org_id = ? AND number = ?', org, keyNum)) { hit = get('SELECT org_id, number, archived FROM trucks WHERE org_id = ? AND number = ?', org, keyNum); }
          else {
            run(`INSERT INTO trucks (org_id, number, display_number, division, area, driver, owner_name, tags, is_sub, suggested_division, is_new, updated_at)
                 VALUES (?,?,?,NULL,'(SIN YARD)',?,?,?,?,?,1,?)`,
              org, keyNum, disp, md.driver || '', md.owner || md.fleet || '',
              tags, isSub, (m && m.suggestedDivision) || null, nowISO());
            hit = get('SELECT org_id, number, archived FROM trucks WHERE org_id = ? AND number = ?', org, keyNum);
            if (!hit) continue;
            summary[label + 'NewFromAssign'] = (summary[label + 'NewFromAssign'] || 0) + 1;
            changed++;
          }
        }
        matched.add(hit.org_id + '|' + hit.number);
        const dest = JSON.stringify((destByNum.get(n) || []).slice(0, 3));
        const lst = liveStatus.get(n) || '';
        // asignado en NewMile = claramente ACTIVO → fuera de "¿de baja?" y des-archivado
        // (falsas alarmas; el dispatcher no debe revisar trucks que están rodando)
        changed += (run(`UPDATE trucks SET maybe_removed = 0, archived = 0 WHERE org_id = ? AND number = ? AND (maybe_removed = 1 OR archived = 1)`, hit.org_id, hit.number).changes || 0);
        const st = get('SELECT * FROM dispatch_state WHERE date = ? AND org_id = ? AND number = ?', dateISO, hit.org_id, hit.number);
        if (!st) {
          run(`INSERT INTO dispatch_state (date, org_id, number, state, source, marked_at, nm_confirmed, nm_info, nm_load_status) VALUES (?,?,?,'a','auto',?,1,?,?)`,
            dateISO, hit.org_id, hit.number, nowISO(), dest, lst);
          summary[label + 'Covered'] = (summary[label + 'Covered'] || 0) + 1;
          changed++;
        } else if (st.state !== 'a' && st.source !== 'manual') {
          // ASIGNADO EN NEWMILE PERO EL ESTADO LOCAL NO ES 'a' (2026-08-31, caso 1090): un estado
          // AUTO/carry/pending viejo (down heredado, "open") dejaba al troke "sin asignar" aunque
          // estuviera en órdenes. Si NO fue marca MANUAL del dispatcher, súbelo a ASIGNADO — un
          // troke que NewMile tiene asignado debe salir asignado. Las marcas MANUALES (down/NW que
          // tú pusiste a propósito) NUNCA se pisan.
          changed += (run(`UPDATE dispatch_state SET state = 'a', source = 'auto', nm_confirmed = 1, nm_info = ?, nm_load_status = ?
               WHERE date = ? AND org_id = ? AND number = ?`,
            dest, lst, dateISO, hit.org_id, hit.number).changes || 0);
          summary[label + 'Covered'] = (summary[label + 'Covered'] || 0) + 1;
        } else {
          // el truck YA estaba marcado (a mano o ya asignado) → queda CONFIRMADO contra NewMile:
          // el ✓ del dispatcher se vuelve ⚡. La marca manual nunca se pisa, solo se verifica.
          // (condicionado: solo escribe si ALGO difiere — así el bump de rev es honesto)
          changed += (run(`UPDATE dispatch_state SET nm_confirmed = 1, nm_info = ?, nm_load_status = ?
               WHERE date = ? AND org_id = ? AND number = ?
                 AND (nm_confirmed <> 1 OR COALESCE(nm_info,'') <> ? OR COALESCE(nm_load_status,'') <> ?)`,
            dest, lst, dateISO, hit.org_id, hit.number, dest, lst).changes || 0);
        }
      }
      // los que estaban confirmados pero YA NO aparecen en NewMile pierden el ⚡ (p. ej.
      // borraron la asignación) — vuelven a ✓ "planeado aquí, no está en NewMile"
      for (const r of all('SELECT org_id, number FROM dispatch_state WHERE date = ? AND nm_confirmed = 1', dateISO)) {
        if (!matched.has(r.org_id + '|' + r.number)) {
          run(`UPDATE dispatch_state SET nm_confirmed = 0, nm_info = '' WHERE date = ? AND org_id = ? AND number = ?`, dateISO, r.org_id, r.number);
          changed++;
        }
      }
      if (changed) metaSet('board_rev', nowISO()); // 🔔 algo cambió → el front recarga en <=8 s
      metaSet('nm_assign_checked_' + dateISO, nowISO()); // este día SÍ se cotejó contra NewMile
    } catch (e) {
      summary[label + 'AssignmentsError'] = String(e.message || e); // best-effort
    }
  }

// ---------- SOLO ASIGNACIONES (rápido y barato) ----------
// Para que lo asignado en NewMile aparezca en el tracker CASI AL INSTANTE sin el sync
// pesado de tickets: corre cada 3 min en horario de despacho + al momento cuando el
// board avisa que acaba de push-ear (/api/sync-assignments). Solo hoy + siguiente día
// hábil, puro ordersForDate — baratísimo para NewMile.
async function syncAssignments(client) {
  const autoMark = get(`SELECT value FROM meta WHERE key = 'auto_mark'`);
  if (autoMark && autoMark.value === '0') return { skipped: 'auto_mark off' };
  const today = todayCT();
  const orgs = enabledOrgs();
  const cactus = orgs.find(o => o.id === 'CACTUS');
  const summary = {};
  await coverAssignmentsFor(client, today, 'today', summary, cactus, today);
  const wd = new Date(today + 'T12:00:00Z').getUTCDay();
  const nextWork = shiftISO(today, wd === 6 ? 2 : 1); // sábado planea el lunes
  await coverAssignmentsFor(client, nextWork, 'tomorrow', summary, cactus, today);
  return summary;
}

module.exports = { syncRoster, syncActivity, syncAssignments, scanRipRap, matchLoadRow, reconcileICs };
