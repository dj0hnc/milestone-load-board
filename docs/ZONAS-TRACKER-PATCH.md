# ZONAS: parche para el servidor de la oficina (mab-mobile / cactus-tracker)

**Qué es:** monta el mapa de Zonas de Despacho (Juan / Mary / Jimmy) dentro del tracker web,
en `https://milestonetx-os.ngrok.app/cactus-tracker/zonas`. La página es un solo archivo
autocontenido (`renderer/zonas.html` de este repo): mapa del noreste de Texas, reparto por
flota/terminal, tabla de las 327 trokas con actividad por zona (tickets de NewMile) y
**reasignación manual** por troka (se guarda en el navegador de cada quien).

## 1. Copiar el archivo

Copiar `renderer/zonas.html` de este repo a la carpeta del servidor de la oficina
(junto al archivo Express principal), con el nombre `zonas.html`:

```
mab-mobile/
  server.js        (o como se llame el Express principal)
  offapp.json
  zonas.html       <- ESTE archivo (renderer/zonas.html del load board)
```

## 2. Ruta en el servidor (Express) — pegar junto a las demás rutas

```js
// --- ZONAS: mapa del reparto de zonas de despacho (Juan / Mary / Jimmy) ---
app.get(['/cactus-tracker/zonas', '/zonas'], (req, res) => {
  res.sendFile(path.join(__dirname, 'zonas.html'));
});
```

(Si el archivo del servidor no tiene ya `const path = require('path')`, agregarlo arriba.)

## 3. Link en el tracker

En el HTML del cactus-tracker, agregar un link donde estén los demás botones/tabs:

```html
<a href="/cactus-tracker/zonas" title="Reparto de zonas Juan / Mary / Jimmy">🗺 Zonas</a>
```

## 4. Probar

```
curl -sI "http://localhost:PUERTO/cactus-tracker/zonas"    # 200 y content-type text/html
```

y por el túnel: `https://milestonetx-os.ngrok.app/cactus-tracker/zonas`.

## Actualizar los datos del mapa

La actividad por zona embebida en `zonas.html` viene de los tickets de NewMile del
17 ago – 1 sep 2026. Cuando se quiera refrescar, se regenera el archivo desde este repo
(el bloque `const ACT={...}` dentro de `zonas.html`) y se vuelve a copiar al servidor —
la ruta no cambia. Las reasignaciones manuales NO se pierden al actualizar el archivo:
viven en el localStorage del navegador de cada usuario.
