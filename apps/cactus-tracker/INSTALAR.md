# Cómo abrir el Cactus Tracker (paso a paso)

## Descargarlo

**Opción A — ZIP (sin git):**
1. Abre <https://github.com/dj0hnc/milestone-load-board/archive/refs/heads/claude/planning-tool-strategy-k3pvy9.zip>
   (descarga el ZIP de la rama).
2. Descomprímelo y entra a la carpeta `apps\cactus-tracker`.
3. Copia esa carpeta a donde quieras que viva (p. ej. `C:\CactusTracker`).

**Opción B — git (en la PC que ya tiene el repo del Load Board):**
```
git fetch origin claude/planning-tool-strategy-k3pvy9
git checkout claude/planning-tool-strategy-k3pvy9
cd apps\cactus-tracker
```

## Arrancarlo (PC de la oficina, Windows)

1. Si no tienes Node.js: instala el LTS de <https://nodejs.org> (versión 22+, todo por default).
2. Doble click a **`start-tracker.cmd`**.
   - La primera vez instala dependencias y carga los 161 trucks solo.
   - Se abre el navegador en `http://localhost:8791/cactus-tracker/`.
   - **No cierres la ventana negra**: esa ventana ES el servidor.

Con eso ya puedes usar TODO el board (marcas, notas, FALTAN, bajas, vacaciones,
historial) aunque todavía no conectes nada.

## Verlo en el celular

Doble click a **`tunel-celular.cmd`** (con el tracker corriendo). Te da una URL
`https://algo.trycloudflare.com` — ábrela en el cel y compártela al equipo. Esa URL
cambia en cada arranque; para URL fija, monta el tracker en el tunnel con nombre del
office bundle (ver README, sección "Montado dentro de mab-office-bundle").

## Conectar NewMile (una sola vez)

1. En `data\`, copia `config.template.json` → `config.json`.
2. Pon en `publicBase` la URL del tunnel (la de trycloudflare o la fija del bundle).
3. Reinicia el tracker, ábrelo por la URL del tunnel y toca **conectar** en la barra
   de arriba → login de NewMile → listo. El refresh token mantiene la sesión y los
   jobs (roster 4:30, actividad cada hora, RIP scan) corren solos.

Nota: el sign-in de NewMile necesita que lo abras por la URL pública del tunnel (no
por localhost), porque NewMile tiene que poder regresar al servidor.

## Conectar Samsara (una sola vez)

En `config.json`, en `samsara.tokensFile` pon la ruta del `newmile.config.json` del
Load Board de escritorio (ahí ya viven los tokens de "Cactus Express" y "CKJ
Transport") — o pega los tokens directo en `samsara.tokens`. Reinicia y ya: GPS de
dónde duermen + flags, para Cactus y KT.

## Problemas típicos

| Síntoma | Arreglo |
|---|---|
| "Falta Node.js" | instala el LTS de nodejs.org y vuelve a dar doble click |
| El cel no abre localhost | localhost solo sirve en la PC; usa la URL del túnel |
| "NewMile desconectado" | toca conectar (por la URL del túnel) |
| No sale nada de Samsara | falta el token/tokensFile en `config.json` |
| Quiero re-arrancar de cero | borra `data\cactus.db` y arranca de nuevo (recarga el seed) |
