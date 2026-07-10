# Nube con link fijo (sin depender de ninguna compu)

El tracker ya está preparado para esto: scheduler con **catch-up** (si el host estaba
dormido a las 4:30, los jobs corren al primer despertar del día), datos en un solo
directorio configurable (`CACTUS_DATA_DIR`) y seed a prueba de volúmenes.

## HAZLO TÚ MISMO — todo desde el navegador, ~20 min, sin pedirle acceso a nadie

No necesitas instalar nada ni pedir permisos: cuenta propia gratis de Azure + Cloud
Shell (una terminal que vive en el navegador).

**1. Cuenta gratis** (una vez): <https://azure.microsoft.com/free> → "Start free".
Pide tarjeta para verificar identidad pero NO cobra nada; el tier F1 que usamos es
gratis permanente.

**2. Abre la terminal del navegador**: <https://shell.azure.com> (elige **Bash** la
primera vez).

**3. Pega estos comandos** (uno por uno; el nombre `cactus-tracker-mab` tiene que ser
único en el mundo — si está tomado, cámbiale una letra en TODOS los comandos):

```bash
git clone -b claude/planning-tool-strategy-k3pvy9 https://github.com/dj0hnc/milestone-load-board.git
cd milestone-load-board/apps/cactus-tracker

az webapp up --name cactus-tracker-mab --resource-group rg-cactus \
  --runtime "NODE:22-lts" --os-type Linux --sku F1 --location southcentralus

az webapp config set -n cactus-tracker-mab -g rg-cactus --startup-file "node server/index.js"

az webapp config appsettings set -n cactus-tracker-mab -g rg-cactus --settings \
  CACTUS_DATA_DIR=/home/data \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true \
  PUBLIC_BASE=https://cactus-tracker-mab.azurewebsites.net \
  SAMSARA_TOKEN_CACTUS=PEGA_AQUI_EL_TOKEN \
  SAMSARA_TOKEN_CKJ=PEGA_AQUI_EL_OTRO
```

Los dos tokens de Samsara los copias de tu `newmile.config.json` del Load Board de
escritorio (sección `samsara.tokens`). Si aún no los tienes a la mano, omite esas dos
líneas: todo lo demás funciona y los agregas después en Portal → tu app →
Configuration.

**4. Tu link fijo queda vivo**:
`https://cactus-tracker-mab.azurewebsites.net/cactus-tracker/` — ábrelo, toca
**conectar**, login de NewMile, y listo. Compártelo al equipo.

Notas:
- `/home` en App Service es **persistente**: DB, notas, historial y sesión de NewMile
  sobreviven reinicios y redeploys.
- Para actualizar el tracker después: en Cloud Shell,
  `cd milestone-load-board && git pull && cd apps/cactus-tracker && az webapp up -n cactus-tracker-mab -g rg-cactus`.
- **El F1 gratis duerme tras ~20 min sin visitas, y no importa**: abrir la app ES el
  sync. Al pedir el board, si la actividad tiene más de 20 min el server sincroniza
  solo en segundo plano y la pantalla se refresca solita ("⟳ actualizando…"). Tu
  visita de la mañana despierta el host, corre el catch-up de los jobs del día Y trae
  los datos frescos. El botón "Sync ahora" queda para forzarlo.
- Opcional (solo si quieres el board ya listo ANTES de abrirlo): pinger gratis en
  cron-job.org (el mismo que ya usan para reportes) a
  `https://cactus-tracker.azurewebsites.net/cactus-tracker/api/health` a las 4:10 y
  4:30 AM CT. O plan B1 / el plan del bridge con Always On para cero siestas.

## Alternativa 100% gratis para siempre: Oracle Cloud

Oracle Cloud "Always Free" regala una VM ARM (hasta 4 CPU / 24 GB) permanente. Ahí
corre con el Dockerfile:

```bash
docker build -t cactus-tracker .
docker run -d --restart unless-stopped -p 80:8791 -v cactus-data:/app/data cactus-tracker
```

Link fijo con la IP pública o un dominio gratis (DuckDNS). Más talacha de sysadmin,
pero cero dependencia de nadie.

## Las que NO (y por qué)

- **Render / Koyeb / Hugging Face gratis**: el disco NO es persistente en el tier
  gratis — cada reinicio borra marcas, notas e historial. Rompe la regla de oro.
- **Vercel / Netlify / Cloudflare Pages**: son serverless; no corren los jobs de las
  4:30 ni sostienen SQLite. No aplican para esto.
- **ngrok gratis**: el link cambia en cada arranque y depende de una compu prendida —
  justo lo que quieres evitar.

## Checklist post-deploy (una vez)

1. Abrir `https://cactus-tracker.azurewebsites.net/cactus-tracker/` → el board carga
   con los 161 trucks del seed.
2. Tocar **conectar** → login NewMile → los syncs quedan vivos.
3. Tokens de Samsara en el config → GPS y flags vivos.
4. Pinger de cron-job.org a las 4:10/4:30 CT.
5. Compartir el link al equipo (cada quien pone su nombre al primer uso).
