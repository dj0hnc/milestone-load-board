# Levantar el Milestone Tracker en la máquina de ngrok (sin Azure)

Úsalo cuando quieras correr el tracker en la MISMA máquina donde ya corre el otro
tool con ngrok. La base de datos vive en esa máquina (no se borra, no hay cuota).
Funciona mientras esa máquina y ngrok estén prendidos.

## 1. Bajar los archivos a esa máquina (una vez)
Si esa máquina ya tiene el repo (el otro tool sale de aquí), solo actualízalo:
```
git pull
```
Si no lo tiene:
```
git clone https://github.com/dj0hnc/milestone-load-board.git
```
Los archivos del tracker están en `milestone-load-board\apps\cactus-tracker`.

## 2. Arrancar el tracker
Doble click en **`start-tracker.cmd`** (dentro de apps\cactus-tracker).
- La primera vez instala dependencias solo (necesita Node.js 22+ de https://nodejs.org).
- Queda corriendo en `http://localhost:8791/cactus-tracker/`. NO cierres esa ventana.

## 3. Exponerlo con ngrok
Ya tienen ngrok para el otro tool, así que hay dos caminos:

### A) Rápido (túnel aparte)
En OTRA ventana, doble click en **`tunel-ngrok.cmd`**.
Toma la URL `Forwarding` (https://XXXX.ngrok-free.app) y ábrela en el cel agregándole
`/cactus-tracker/` al final. Esa URL la compartes al equipo. PIN de siempre: 2585.

Nota: el plan GRATIS de ngrok permite UNA sesión de agente a la vez. Si el otro tool
ya tiene un ngrok corriendo, usa el camino B para que UN solo ngrok sirva los dos.

### B) Un solo ngrok para los DOS tools (recomendado)
Edita el archivo de config de ngrok (normalmente
`%USERPROFILE%\AppData\Local\ngrok\ngrok.yml`) y déjalo así:
```yaml
version: "3"
agent:
  authtoken: TU_TOKEN_DE_NGROK
tunnels:
  otro-tool:
    proto: http
    addr: PUERTO_DEL_OTRO_TOOL      # el que ya usan
  tracker:
    proto: http
    addr: 8791
    # si tienes dominio reservado, agrega:  domain: tu-dominio.ngrok-free.app
```
Luego arranca los dos de un jalón:
```
ngrok start --all
```
Cada tool sale con su propia URL. La del tracker ábrela con `/cactus-tracker/` al final.

## Notas
- Los números, choferes y GPS se llenan solos con NewMile + Samsara (conéctate a
  NewMile una vez desde la app si sale el letrero rojo).
- El historial de marcas que quedó en Azure sigue allá; esta instancia arranca con el
  roster y se pobla en vivo. Si luego quieren, movemos ese historial.
- Para URL FIJA (que no cambie cada arranque) usa un dominio reservado de ngrok
  (gratis dan uno) con la opción `domain:` de arriba.
