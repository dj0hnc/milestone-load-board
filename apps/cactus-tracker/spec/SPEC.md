# CACTUS TRUCK TRACKER — Spec para Claude Code

**Owner:** Juan José de Alba — Dispatcher / NewMile Tech Lead, Milestone Supply – Texas
**Objetivo:** Que JAMÁS se me pase un truck de Cactus Express en el despacho diario.
**Dónde vive:** dentro de `mab-office-bundle` (Node.js + Cloudflare tunnel ya existentes) como ruta `/cactus-tracker`.

---

## 1. QUÉ HAY EN ESTE PAQUETE

| Archivo | Qué es |
|---|---|
| `data/roster_seed.json` | Seed inicial: 89 trucks North + 72 South con driver, área, trailer type, notas, flag rip-rap, actividad de muestra (Jul 6–9) y flags de Samsara. **Cargar a la DB en el primer arranque.** |
| `data/cactus_truck_tracker.html` | Frontend de referencia v3 (funcionando). La UI final debe verse y comportarse ASÍ. Reemplazar el data hardcodeado por fetch al API y window.storage por el API de estado. |
| `data/Cactus_Auditoria_Roster_Jul9.xlsx` | Auditoría del 7/9/26: lista vs actividad real, nuevos, y bajas del archivo viejo. Referencia de la lógica de veredictos. |
| `data/Cactus_Roster_North_South.xlsx` | Roster limpio imprimible (formato canónico de tabs). |

---

## 2. LÓGICA DE NEGOCIO (NO NEGOCIABLE)

### Fleets y fuentes
- **Cactus Express = fleet_id 5 en NewMile.** En el reporte de loads, `fleet == "Cactus Express"` y los truck numbers vienen con prefijo **"C"** (C1127 = truck 1127). SIEMPRE quitar el prefijo C al normalizar.
- El hauler en loads es **"Milestone Supply - Texas"** (no filtrar por hauler "Cactus" — regresa 0).
- **North vs South es división MÍA de despacho, no existe en NewMile.** El seed dice quién es de dónde. En Samsara sí existe: tag **"Paris Terminal" (id 4218297) = North**, tag **"Lufkin Terminal" (id 4218296) = South**. Usar tags como sugerencia al clasificar trucks nuevos, pero mi asignación manual siempre gana.
- **Subhaulers** (BT, BW, HS, AE, Livingston…) viven en fleets propios en NewMile (Butler Trucking LLC, Billy Walker Trucking LLC, Hope Services Inc., Arrowhead Earthworks LLC). Por ahora se muestran dentro del board (North trae a los de área Paris/Hugo), después serán su propio módulo.

### Áreas del South (agrupación del board)
TYLER, SULPHUR SPRINGS, DALLAS, CORSICANA, KAUFMAN, ATHENS, LONGVIEW, (SIN YARD).
- CORSICANA incluye bases Kerens/Ennis (1065, 1091, 1105, 1139 — encontrados 7/9/26).
- Futuro (fase 2): usar GPS de Samsara para autoclasificar por donde duerme el truck (punto de las 3–5 AM). Aquí en el server NO hay límite de payload como en el chat, así que `GET /fleet/vehicles/locations` de Samsara funciona directo.

### Trailer types
- El tipo de traila viene de NewMile (`truck_type` del recurso truck): Aluminum End Dump (AL-ED), End Dump (ED), Steel End Dump (ST-ED), Round Body End Dump (RB-ED), Super Dump w/ Steel Bed (SD Steel), Super Dump w/ Demo Bed (SD Demo), Belly Dump (BD), Aluminum Tractor Trailer (AL-TT), Demo.
- **RIP RAP es un flag aparte** (no un truck_type): lo marco yo por truck. Seed trae los actuales: North 972, 1007, 1079, 1083, 1118, 1143, 2011, 2022 · South 629, 669, 1013, 1061, 1062, 1318, 9321, 9322, 963, 973. Los RIP siempre visualmente destacados (franja azul) + contador "RIP libres".
- Tags extra: **3X8** y **SUBHAULER** (campo `tg` en el seed).

### Estados del despacho (por truck, por día)
- `p` pendiente (default) → 1 tap → `a` asignado (verde ✓) → tap regresa a `p`.
- Botón `✕` chico en la esquina → `d` down (rojo, tachado). Tap de nuevo lo regresa.
- **Estado independiente por día (Mon–Sat) y por fleet.** El sábado NO borra al viernes.
- Reset manual por día con confirm. Auto-reset opcional: cada día a las 3:00 AM CT arranca limpio (config).
- El panel **"FALTAN X"** (dorado, siempre visible) lista los pendientes con RIP primero; tap = scroll al truck. Cuando faltan 0 → verde "TODOS CUBIERTOS".

### Notas y flags (editables por mí desde la UI)
Cada truck necesita:
- **Nota libre** (texto): "en el shop", "DEL Zotto only", "no trabaja lun-mar", teléfono del owner, etc.
- **Flag de status**: `ok` | `shop` | `down` | `no_driver` | `deleased` — con fecha opcional de regreso ("regresa 7/13").
- **Días que no trabaja** (checkboxes Mon–Sat): si hoy es un día que no trabaja, el chip se muestra gris "descansa hoy" y NO cuenta en FALTAN.
- Todo editable inline (tap-hold o botón ✎ en el chip abre mini-form). Guardar al server, no localStorage.

### Sync con NewMile (el corazón)
**Job cada mañana 4:30 AM CT + botón "Sync ahora" en la UI:**
1. `GET` trucks de NewMile fleet_id 5 (paginado, ~170). Normalizar truck_number (quitar sufijos tipo "-DOWN 12/12/2024", "De-Leased…" — pero GUARDAR ese sufijo como flag detectado).
2. Por cada truck: actualizar `driver_name` y `truck_type` si cambiaron. **Si el driver cambió, marcar badge "driver cambió: antes X → ahora Y" por 48h** (así siempre tengo los nombres vigentes).
3. **Truck en fleet 5 que NO está en mi roster → crearlo con flag `⚑ NUEVO`** (rojo, arriba del board, no se quita hasta que yo lo asigne a North/South + área). ESTO ES CRÍTICO: nuevos jamás se me pueden pasar.
4. Truck en mi roster que ya no está en fleet 5 → flag `¿de baja?` para que yo confirme (no borrar solo).

**Job de actividad (cada hora en horario de despacho 4 AM–7 PM):**
- Reporte `load_tickets` de NewMile del día (filtro `order_date_relative: today`), columnas truck_number/driver_name/fleet. Guardar por truck: `last_load_date`, `loads_today`, `driver_actual_del_load`.
- Con historial acumulado en DB, calcular `days_since_last_load`. Chip muestra: 🟢 "última: 7/9" o ⚠ "X días sin carga" (amarillo ≥5 días, rojo ≥14).
- El driver del load de HOY manda sobre el driver estático del truck (rotan).

**Samsara (org "cactus"):**
- Vehículos: los flags vienen EN EL NOMBRE del vehículo ("1023-IN SHOP 08/20/2025", "553-Deleased Need Camera"). Parsear con regex `^(\w+)[\s-]*(.*)$` y proponer el flag automáticamente (yo confirmo).
- Tags de terminal para clasificar nuevos (Paris=North, Lufkin=South).
- Fase 2: parking GPS nocturno → área automática del South.
- NOTA: en el server usar la API de Samsara directo (los tokens ya viven en mab-office-bundle / el MCP azure bridge `mab-samsara-mcp.azurewebsites.net`). El token de cactus NO tiene scope de trips ni driver-assignments — usar vehicles + locations + tags.

---

## 3. ARQUITECTURA PROPUESTA

```
mab-office-bundle/
  apps/cactus-tracker/
    server/
      routes.js          # Express router montado en /cactus-tracker/api
      sync-newmile.js    # jobs de roster + actividad
      sync-samsara.js    # flags + tags (+ GPS fase 2)
      db.js              # SQLite (better-sqlite3) en ./data/cactus.db
      seed.js            # carga roster_seed.json si la DB está vacía
    public/
      index.html         # el tracker (base: data/cactus_truck_tracker.html)
    spec/                # este archivo + xlsx de referencia
```

### SQLite schema
```sql
CREATE TABLE trucks (
  number TEXT PRIMARY KEY,        -- sin prefijo C
  fleet TEXT CHECK(fleet IN ('NORTH','SOUTH','SUB')),
  area TEXT,                      -- TYLER, PARIS, CORSICANA...
  driver TEXT, driver_prev TEXT, driver_changed_at TEXT,
  trailer_type TEXT, rip_rap INTEGER DEFAULT 0, tags TEXT,
  phone TEXT, status TEXT DEFAULT 'ok',   -- ok|shop|down|no_driver|deleased
  status_note TEXT, return_date TEXT,
  rest_days TEXT DEFAULT '',      -- ej "Mon,Tue"
  note TEXT, is_new INTEGER DEFAULT 0, maybe_removed INTEGER DEFAULT 0,
  nm_truck_id INTEGER, samsara_id TEXT,
  last_load_date TEXT, loads_today INTEGER DEFAULT 0,
  updated_at TEXT
);
CREATE TABLE dispatch_state (      -- marcas del board
  day TEXT, fleet TEXT, truck TEXT, state TEXT,  -- p|a|d
  marked_at TEXT, PRIMARY KEY (day, fleet, truck)
);
CREATE TABLE activity_log (truck TEXT, load_date TEXT, driver TEXT, loads INTEGER,
  PRIMARY KEY (truck, load_date));
```

### API
```
GET  /api/board?fleet=NORTH&day=Thur   → trucks + estado + actividad (todo en 1 llamada)
POST /api/state {day, fleet, truck, state}
POST /api/truck/:number  {note?, status?, rest_days?, area?, fleet?, rip_rap?, phone?}
POST /api/truck/:number/confirm-new    → quita flag NUEVO
POST /api/sync/newmile   POST /api/sync/samsara   (manuales)
GET  /api/audit          → JSON tipo el xlsx de auditoría (activos/sin carga/nuevos/bajas)
```

### Frontend
- Partir de `data/cactus_truck_tracker.html` TAL CUAL (colores navy #1C2333 / gold #C8991F, Barlow Condensed, chips, píldora FALTAN, filtros de un tap). Solo cambiar:
  - Data hardcodeada → `fetch('/cactus-tracker/api/board?...')`
  - `window.storage` → `POST /api/state` (optimista, con reintento)
  - Agregar: botón ✎ por chip (editar nota/status/días), banner rojo arriba si hay trucks NUEVOS sin confirmar, botón "Sync ahora", indicador "última sync: hh:mm".
- Mobile-first: lo uso desde el cel en el yard.

---

## 4. REGLAS DE ORO (de mi flujo, no romper)
1. **Datos reales siempre, cero placeholders.** Si la sync falla, mostrar la última data buena con timestamp, nunca inventar.
2. **Nada se borra solo.** Trucks que desaparecen de NewMile se flaggean, yo decido.
3. Formato visual navy/gold/Barlow es canónico (igual que mis fleet reports).
4. NewMile es la verdad para drivers/trailer types/actividad; **yo soy la verdad para North/South, áreas, rip-rap, notas y status.**
5. Fase 2 (después de que esto jale): CKJ (KT con terminales Powderly/Rhome/Whitewright + ICs) y módulo de Subhaulers con contactos. Misma DB, tabs nuevos.

## 5. CÓMO EMPEZAR (primer prompt sugerido para Claude Code)
> "Lee spec/SPEC.md completo. Crea apps/cactus-tracker según la sección 3, monta el router en el server existente de mab-office-bundle, corre seed.js con data/roster_seed.json, y adapta public/index.html desde data/cactus_truck_tracker.html cambiando el data hardcodeado por el API. No cambies el diseño visual. Empieza por: db.js + seed.js + GET /api/board + el frontend conectado; los syncs de NewMile/Samsara van después."
