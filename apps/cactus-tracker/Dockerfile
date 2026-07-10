# Cactus Tracker — imagen para dejarlo con LINK FIJO en cualquier nube
# (Azure App Service / Container Apps, Fly.io, Railway, un VPS…).
#
#   docker build -t cactus-tracker .
#   docker run -d -p 8791:8791 -v cactus-data:/app/data cactus-tracker
#
# El volumen /app/data guarda la DB, el config.json y los tokens de NewMile —
# sin él, cada redeploy arranca de cero (el seed recarga el roster, pero se
# pierden marcas, notas e historial).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY public ./public
COPY data/roster_seed.json data/config.template.json ./data/
# copia extra fuera del volumen: si /app/data se monta vacío, el seed sigue disponible
COPY data/roster_seed.json ./seed-data/
VOLUME /app/data
EXPOSE 8791
ENV PORT=8791
CMD ["node", "server/index.js"]
