# Cactus Truck Tracker

Board de cobertura diaria de despacho: **que jamás se pase un truck de Cactus Express**.
Mobile-first (se usa desde el cel en el yard), con sync automático de NewMile y Samsara.

Vive aquí como app autocontenida (`apps/cactus-tracker/`) — cero dependencias del
Electron del Load Board. Para moverlo a `mab-office-bundle` o a su propio repo, se copia
esta carpeta completa y listo.

## Correr

```bash
cd apps/cactus-tracker
npm install            # solo express; la DB es node:sqlite (Node >= 22.13, sin build nativo)
npm run seed           # carga los 161 trucks del roster inicial (idempotente)
npm start              # http://localhost:8791/cactus-tracker/
```

Config opcional: copia `data/config.template.json` a `data/config.json` y llena
`publicBase` (URL del tunnel) + Samsara. Para Samsara NO hace falta copiar tokens:
apunta `samsara.tokensFile` al `newmile.config.json` del Load Board de escritorio (o
al config del office bundle) y reutiliza los que ya viven ahí. Sin config el board
funciona igual (marcas, notas, FALTAN); solo los syncs quedan apagados.

Por truck se controla: status (OK / en shop / down / sin driver / **vacaciones** / de-leased)
con fecha de regreso, días fijos que no trabaja (Mon–Sat), nota libre, teléfono, tags,
rip-rap y división/área. El panel FALTAN agrupa los pendientes **por zona**, para jalar
rápido un truck libre del área donde se necesita.

### Montado dentro de mab-office-bundle

```js
const { createTracker } = require('./apps/cactus-tracker/server');
const t = createTracker({ config: require('./data/config.json') });
app.use('/cactus-tracker', t.router);
t.startScheduler();
```

## Conectar NewMile

Abrir el tracker → barra de status → **conectar**. Es el mismo OAuth 2.1 verificado del
Load Board (dynamic registration + PKCE); el redirect regresa a
`<publicBase>/cactus-tracker/api/newmile/callback`. Después del primer sign-in el
refresh token mantiene la sesión sola (los jobs corren sin intervención).

## Qué hace solo

**Abrir la app es el sync**: si el board tiene más de 20 min sin actualizar, el server
sincroniza solo en segundo plano al abrirlo y la pantalla se refresca sola. Los jobs
de abajo son el respaldo para cuando el server vive prendido:

| Cuándo (CT) | Job | Qué |
|---|---|---|
| 4:30 AM | Roster (NewMile fleet 5) | drivers/trailer types actualizados; badge 48 h si cambió driver; truck nuevo → banner rojo ⚑ NUEVO; truck desaparecido → ¿de baja? (nada se borra solo) |
| cada hora 4 AM–7 PM | Actividad (load_tickets + assignments de hoy) | última carga, días sin carga (⚠ ≥5, ⛔ ≥14), driver real de hoy; **auto-cover**: truck con carga hoy O ya asignado en NewMile (plan empujado desde el desktop) se marca ⚡ azul solo — FALTAN se vuelve el hueco real |
| 4:10 AM | Samsara (solo Cactus) | **GPS de dónde duerme cada truck** (ventana 3–6 AM): la mayoría de las últimas 7 noches sugiere el área correcta ("📍 duerme en TYLER", tú aceptas o descartas — nada se mueve solo); además flags en nombres de vehículo y tags de terminal para los NUEVOS |
| 4:30 AM | Scan RIP RAP (NewMile) | trucks que cargaron material rip rap en los últimos 14 días y no están marcados RIP → banner azul con evidencia (cargas, fechas, material); backfill manual: `POST /api/scan/riprap {days:30}`. Verificado en vivo 7/10/26: materiales "12\" Rip Rap" / "24\" Rip Rap" |

**Subhaulers: NO están en Samsara.** Todo lo de subs (BT, BW, HS, AE, Livingston) sale
exclusivamente de NewMile; el sync de Samsara los salta por diseño (`is_sub = 1`).

## Reglas de oro (implementadas)

1. Datos reales siempre: si la red falla, la UI muestra la última data buena con
   timestamp y encola los taps para subirlos al volver la señal. Nunca inventa.
2. Nada se borra solo: bajas se flaggean y tú decides (archivar conserva historial).
3. NewMile manda en drivers/trailer/actividad; tú mandas en división, área, rip-rap,
   notas, status y días de descanso (el sync jamás pisa tus campos).
4. Estado por fecha real (no por día de semana): el jueves pasado nunca se hereda; no
   hace falta job de reset a las 3 AM.

## Multi-usuario e historial

- **Cualquiera del equipo entra a la misma URL** y ve el mismo board vivo (notas, bajas,
  vacaciones, marcas). Al primer uso la app pregunta "¿quién eres?" y ese nombre viaja
  con cada cambio: el historial por truck (botón Historial en ✎) muestra quién cambió
  qué y cuándo. La conexión a NewMile es una sola (del server, para los syncs); no hace
  falta que cada usuario tenga cuenta.
- **Historial diario**: cada hora se guarda un snapshot de cómo quedó cada truck ese
  día. Con las flechas ◀ ▶ navegas semanas hacia atrás y al abrir un día pasado ves el
  board COMO ESTABA ese día (quién estaba down, qué nota tenía), no el estado de hoy.
- Auditoría completa en `truck_log` (cambios), `truck_days` (snapshots), `parking_log`
  (dónde durmió) y `dispatch_state.marked_by` (quién marcó cada truck).

## CKJ / KT (activo)

Tabs **KT POWDERLY / RHOME / WHITEWRIGHT** junto a los de Cactus. Sin seed manual: el
primer sync de NewMile (fleet 6) trae todos los trucks de KT como ⚑ NUEVO **ya con su
terminal sugerida** — la letra final del nombre es la terminal (verificado en vivo
7/10/26: "KT-7040 P"=Powderly, "KT-7044 W"=Whitewright, "KT-4799 R"=Rhome) y los tags
de Samsara la respaldan (Powderly 2706160, Rhome 3645002, Whitewright 2706161).
Samsara de CKJ funciona igual que el de Cactus: GPS de dónde duermen, sugerencia de
área y flags de nombres.
Normalización verificada contra el desktop: "KT-7040 P" (roster) = "CKJ7040" (loads) =
"KT-7040" (Samsara) = truck **7040**; los CKJ### de 3 dígitos son subs afiliados y otros
carriers (Arango) nunca se auto-crean en el board de KT.

## Fase 2 restante

- Módulo propio de **SUBS** (org pre-creada deshabilitada, NewMile only).

## Archivos

```
server/index.js          entry standalone + scheduler CT (sin dependencia de cron)
server/routes.js         API REST (board, state, edits, confirms, syncs, audit, OAuth)
server/db.js             SQLite (node:sqlite) — schema orgs/divisions/trucks/estado/actividad
server/seed.js           seed idempotente desde data/roster_seed.json
server/newmile-client.js cliente MCP OAuth server-side (recortado del desktop, mismas llamadas verificadas)
server/sync-newmile.js   jobs roster + actividad + auto-cover + detección de NUEVOS
server/sync-samsara.js   flags + tags de terminal (salta subs SIEMPRE)
server/util.js           normalización de truck numbers + helpers de hora Central
public/index.html        frontend (diseño canónico navy/gold/Barlow del v3)
data/roster_seed.json    89 North + 72 South con actividad Jul 6–9 y flags Samsara
spec/SPEC.md             spec original de referencia
```

## API rápida

```
GET  /api/board?org=CACTUS&date=2026-07-10   todo en 1 llamada
POST /api/state                              {date, org, number, state p|a|d}
POST /api/truck/CACTUS/:num                  {note?, status?, rest_days?, area?, division?, rip_rap?, phone?, tags?}
POST /api/truck/CACTUS/:num/confirm-new      {division, area?}
POST /api/truck/CACTUS/:num/resolve-removed  {action: archive|keep}
POST /api/truck/CACTUS/:num/flag             {source: samsara|newmile, action: accept|dismiss}
POST /api/reset                              {date, org, division?}
POST /api/sync/newmile · /api/sync/samsara   sync manual ("Sync ahora")
GET  /api/audit?org=CACTUS                   JSON tipo la auditoría del 7/9
GET  /api/newmile/connect                    sign-in web (una vez)
```
