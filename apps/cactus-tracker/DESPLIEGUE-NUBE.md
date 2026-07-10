# Nube con link fijo (sin depender de ninguna compu)

El tracker ya está preparado para esto: scheduler con **catch-up** (si el host estaba
dormido a las 4:30, los jobs corren al primer despertar del día), datos en un solo
directorio configurable (`CACTUS_DATA_DIR`) y seed a prueba de volúmenes.

## Ruta recomendada: Azure App Service (gratis, y ya tienen cuenta)

MAB ya corre el bridge de Samsara en Azure (`mab-samsara-mcp.azurewebsites.net`), así
que hay cuenta. El tier **F1 es gratis** y te da el link fijo
`https://cactus-tracker.azurewebsites.net`. Desde la carpeta `apps/cactus-tracker`:

```bash
az login
az webapp up --name cactus-tracker --resource-group MAB-Tracker \
  --runtime "NODE:22-lts" --os-type Linux --sku F1 --location southcentralus

az webapp config appsettings set --name cactus-tracker --resource-group MAB-Tracker --settings \
  CACTUS_DATA_DIR=/home/data \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true

az webapp config set --name cactus-tracker --resource-group MAB-Tracker \
  --startup-file "node server/index.js"
```

- `/home` en App Service es **persistente**: DB, notas, historial y tokens sobreviven
  reinicios y redeploys.
- En `config.json` (créalo en `/home/data/` via Kudu o FTP, o sube los settings como
  env) pon `publicBase: "https://cactus-tracker.azurewebsites.net"` para el OAuth de
  NewMile, y los tokens de Samsara en `samsara.tokens` (en la nube no hay tokensFile
  del desktop).
- **El F1 gratis duerme tras ~20 min sin visitas.** Dos arreglos:
  1. El catch-up ya hace que ninguna sync se pierda: tu primera visita de la mañana
     la dispara.
  2. Para que el roster de las 4:30 corra solito aunque nadie haya entrado: ponle un
     pinger gratis en cron-job.org (el mismo servicio que ya usan para los reportes
     del Load Board) a `https://cactus-tracker.azurewebsites.net/cactus-tracker/api/health`
     a las 4:10 y 4:30 AM CT.
  3. Si un día quieren cero siestas: subir al plan B1 (o colgarlo del plan donde ya
     vive el bridge = costo marginal $0) y prender Always On.

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
