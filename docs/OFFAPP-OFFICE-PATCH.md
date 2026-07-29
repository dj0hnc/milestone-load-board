# OFF-APP: parche para el servidor de la oficina (mab-mobile)

**Problema:** el número de OFF-APP que se captura en el link del board (`/full`) o en la app
móvil se guarda solo en el navegador/teléfono de quien lo teclea (localStorage). Por eso "no
se guarda": cada dispositivo ve su propio número, el escritorio ve otro, y el email de la
nube nunca lo ve.

**Arreglo:** guardarlo UNA vez en el servidor de la oficina (un JSON por fecha) y exponerlo
en `/offapp`. La nube **ya está lista** para consumirlo: desde el PR #9 de
`milestone-load-board`, el email hace `GET $MAB_OFFICE_URL/offapp?date=YYYY-MM-DD` al enviar
(mañana pide la fecha de hoy; el nocturno pide la de mañana) y solo si la oficina no contesta
cae a la variable `MAB_OFFSUBS`.

## 1. Endpoint en el servidor (Express) — pegar junto a las demás rutas

```js
// --- OFF-APP subs: one shared per-day count for board + mobile + cloud email ---
const OFFAPP_FILE = path.join(__dirname, 'offapp.json');
function offappLoad() { try { return JSON.parse(fs.readFileSync(OFFAPP_FILE, 'utf8')) || {}; } catch (e) { return {}; } }

app.get('/offapp', (req, res) => {
  const m = offappLoad();
  const date = String(req.query.date || '').slice(0, 10) ||
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  res.json({ date: date, count: (m[date] != null ? m[date] : 0) });
});

app.post('/offapp', express.json(), (req, res) => {
  const date = String((req.body && req.body.date) || '').slice(0, 10);
  const count = parseInt(req.body && req.body.count, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(count) || count < 0 || count > 500) {
    return res.status(400).json({ error: 'need {date:"YYYY-MM-DD", count:0-500}' });
  }
  const m = offappLoad(); m[date] = count;
  fs.writeFileSync(OFFAPP_FILE, JSON.stringify(m, null, 1));
  res.json({ ok: true, date: date, count: count });
});

// phone-friendly setter: open in any browser, no app needed.
//   /offapp/set?count=26              -> sets TOMORROW (the night plan; most common use)
//   /offapp/set?count=26&date=today   -> sets today (feeds the 7:30am email)
//   /offapp/set?count=26&date=2026-08-02
app.get('/offapp/set', (req, res) => {
  const ct = tz => new Date(Date.now() + (tz === 'tomorrow' ? 86400000 : 0))
    .toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const q = String(req.query.date || 'tomorrow');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : ct(q === 'today' ? 'today' : 'tomorrow');
  const count = parseInt(req.query.count, 10);
  if (isNaN(count) || count < 0 || count > 500) return res.status(400).send('need ?count=0-500');
  const m = offappLoad(); m[date] = count;
  fs.writeFileSync(OFFAPP_FILE, JSON.stringify(m, null, 1));
  res.send('<h1 style="font-family:sans-serif">&#9989; OFF-APP ' + count + ' guardado para ' + date + '</h1>');
});
```

(Si el archivo del servidor no tiene ya `const path = require('path')` / `const fs = require('fs')`,
agregarlos arriba.)

## 2. El input de OFF-APP (board `/full` y modal PM de la móvil)

Donde hoy el input guarda en localStorage, cambiarlo a leer/escribir el servidor:

```js
// al cargar la vista (dateISO = la fecha del board, YYYY-MM-DD):
fetch('/offapp?date=' + dateISO).then(r => r.json()).then(j => { input.value = j.count; });

// al cambiar el input:
input.onchange = () => fetch('/offapp', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ date: dateISO, count: Number(input.value) || 0 })
});
```

Con eso: lo tecleas UNA vez en cualquier dispositivo → todos los demás lo ven → el email
lo jala solo. El PM/nocturno usa la fecha de MAÑANA (es el plan de mañana); el morning usa hoy.

## 3. Probar

```
curl -s "http://localhost:PUERTO/offapp?date=2026-07-30"
curl -s -X POST http://localhost:PUERTO/offapp -H "Content-Type: application/json" -d '{"date":"2026-07-30","count":26}'
```

y por el túnel: `https://bullion-magician-prancing.ngrok-free.dev/offapp?date=2026-07-30`.
Reiniciar el servidor de la oficina después de pegar el parche.
