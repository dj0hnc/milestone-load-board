'use strict';
/*
 * Samsara sync — flags + terminal tags. CACTUS ONLY (and later KT).
 *
 * HARD RULE: subhaulers are NOT in Samsara. Every query here filters is_sub = 0 and
 * only runs for orgs with samsara = 1; sub trucks are never matched, never flagged,
 * never suggested a division. Their info comes exclusively from NewMile.
 *
 * What it does (token scope: vehicles + tags only — no trips / driver-assignments):
 *  - GET /fleet/vehicles (paginated). Vehicle names carry the flags
 *    ("1023-IN SHOP 08/20/2025", "553-Deleased Need Camera"): parse → propose in
 *    samsara_flag. I confirm or dismiss from the UI; nothing changes status by itself.
 *  - Terminal tags → suggested_division for trucks I have not placed yet
 *    (Paris Terminal 4218297 = NORTH, Lufkin Terminal 4218296 = SOUTH). My manual
 *    assignment always wins — suggestions only fill the ⚑ NUEVO confirm form.
 *  - Phase 2 (later): 3–5 AM parking GPS → auto-classify South areas.
 */
const { all, get, run, metaSet, nowISO } = require('./db');
const { splitNameFlag } = require('./util');

function tokenFor(cfg, orgName) {
  const toks = (cfg.samsara && cfg.samsara.tokens) || [];
  const t = toks.find(x => x && x.name === orgName && x.token);
  return t ? t.token : null;
}

async function fetchVehicles(token) {
  let out = [], after = '', pages = 0;
  do {
    const url = 'https://api.samsara.com/fleet/vehicles?limit=512' + (after ? '&after=' + encodeURIComponent(after) : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!r.ok) throw new Error('Samsara vehicles HTTP ' + r.status);
    const j = await r.json();
    out = out.concat(j.data || []);
    after = (j.pagination && j.pagination.hasNextPage) ? j.pagination.endCursor : '';
    pages++;
  } while (after && pages < 20);
  return out;
}

async function syncSamsara(cfg) {
  const orgs = all('SELECT * FROM orgs WHERE enabled = 1 AND samsara = 1 ORDER BY sort');
  const summary = { vehicles: 0, matched: 0, flags: 0, suggestions: 0, skippedOrgs: [] };

  for (const org of orgs) {
    const token = tokenFor(cfg, org.samsara_org);
    if (!token) { summary.skippedOrgs.push(org.id + ' (sin token)'); continue; }

    const divs = all('SELECT * FROM divisions WHERE org_id = ?', org.id);
    const tagToDiv = new Map(divs.filter(d => d.samsara_tag_id).map(d => [String(d.samsara_tag_id), d.id]));

    const vehicles = await fetchVehicles(token);
    summary.vehicles += vehicles.length;

    for (const v of vehicles) {
      const { number, flag } = splitNameFlag(v.name || '');
      if (!number) continue;
      // subs are never in Samsara — the is_sub filter is belt & suspenders
      const row = get('SELECT * FROM trucks WHERE org_id = ? AND number = ? AND is_sub = 0', org.id, number);
      if (!row) continue;
      summary.matched++;

      const sets = [], vals = [];
      const sid = v.id != null ? String(v.id) : null;
      if (sid && sid !== row.samsara_id) { sets.push('samsara_id = ?'); vals.push(sid); }
      if (flag !== (row.samsara_flag || '')) { sets.push('samsara_flag = ?'); vals.push(flag); if (flag) summary.flags++; }

      // terminal tag → suggestion ONLY while the truck has no division (⚑ NUEVO)
      if (!row.division) {
        const tagIds = (v.tags || []).map(t => String(t.id));
        const div = tagIds.map(t => tagToDiv.get(t)).find(Boolean);
        if (div && div !== row.suggested_division) { sets.push('suggested_division = ?'); vals.push(div); summary.suggestions++; }
      }
      if (sets.length) {
        sets.push('updated_at = ?'); vals.push(nowISO());
        run(`UPDATE trucks SET ${sets.join(', ')} WHERE org_id = ? AND number = ?`, ...vals, org.id, row.number);
      }
    }
  }

  metaSet('last_sync_samsara', nowISO());
  metaSet('last_sync_samsara_summary', JSON.stringify(summary));
  return summary;
}

module.exports = { syncSamsara };
