#!/usr/bin/env node
'use strict';
/*
 * 🤝 Load a HubSpot export into the tracker's recruiting mirror — from the SAME PC the
 * tracker runs on (the states key is read straight from its SQLite, no copy-paste).
 *
 *   node import-recruits.js recruits.json
 *   node import-recruits.js recruits.json --replace          # the file IS the roster: deals not in
 *                                                             # it leave the mirror (Juan's worked
 *                                                             # deals always stay)
 *   node import-recruits.js recruits.json http://127.0.0.1:8791/cactus-tracker
 *
 * recruits.json = { "recruits": [ { deal_id, stage, stage_label, company, contact, phone,
 * email, hs_owner, trucks, truck_type, market, city, state, dot, ... } ] } — the shape
 * POST /api/recruit/import accepts (see server/routes.js). Claude produces this file from
 * the HubSpot connector; the tracker's own layer (checklist, notes, follow-ups, yard) is
 * never touched by an import.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const pos = args.filter(a => a !== '--replace');
const file = pos[0];
const base = (pos[1] || process.env.TRACKER_URL || 'http://127.0.0.1:8791/cactus-tracker').replace(/\/+$/, '');
if (!file) { console.error('uso: node import-recruits.js recruits.json [--replace] [http://127.0.0.1:8791/cactus-tracker]'); process.exit(2); }

let payload;
try { payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
catch (e) { console.error('no pude leer el JSON:', e.message); process.exit(2); }
const list = Array.isArray(payload) ? payload : payload.recruits;
if (!Array.isArray(list) || !list.length) { console.error('el archivo no trae recruits[]'); process.exit(2); }

// La llave de máquina vive en la tabla meta del tracker (misma PC → misma DB).
let key = process.env.STATES_KEY || '';
if (!key) {
  try { const db = require('./server/db'); db.open(); key = db.metaGet('states_key', ''); }
  catch (e) { console.error('no encontré la states key en la DB local:', e.message, '\n(pásala por env: set STATES_KEY=... o corre esto en la PC del tracker)'); process.exit(2); }
}
if (!key) { console.error('states key vacía — ¿ya arrancó el tracker al menos una vez?'); process.exit(2); }

(async () => {
  const r = await fetch(base + '/api/recruit/import?key=' + encodeURIComponent(key), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recruits: list, replace })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) { console.error('import falló:', r.status, JSON.stringify(j)); process.exit(1); }
  console.log(`✅ import OK — ${j.created} nuevos, ${j.updated} actualizados${j.removed ? ', ' + j.removed + ' quitados (no están en el archivo)' : ''} (${list.length} en el archivo)`);
})().catch(e => { console.error('error:', e.message); process.exit(1); });
