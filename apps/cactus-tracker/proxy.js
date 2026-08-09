'use strict';
/*
 * Mini reverse-proxy (sin dependencias) para servir DOS tools en UN solo dominio de
 * ngrok (el plan gratis solo da una URL). Reparte por RUTA:
 *   /cactus-tracker/*  ->  el tracker      (localhost:8791)
 *   todo lo demas      ->  el otro tool    (localhost:8090)
 *
 * ngrok apunta su dominio a ESTE proxy (puerto 8000). Los dos tools siguen corriendo
 * independientes en sus puertos; esto solo enruta.
 *
 * Puertos configurables por env: PROXY_PORT, TRACKER_PORT, OTHER_PORT.
 */
const http = require('http');
const net = require('net');

const LISTEN = Number(process.env.PROXY_PORT || 8000);
const TRACKER = { host: '127.0.0.1', port: Number(process.env.TRACKER_PORT || 8791) };
const OTHER = { host: '127.0.0.1', port: Number(process.env.OTHER_PORT || 8090) };
const pick = (url) => (url && url.startsWith('/cactus-tracker')) ? TRACKER : OTHER;

const server = http.createServer((req, res) => {
  const t = pick(req.url);
  const up = http.request(
    { host: t.host, port: t.port, method: req.method, path: req.url, headers: req.headers },
    (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); }
  );
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('upstream ' + t.port + ' no responde'); });
  req.pipe(up);
});

// WebSockets / upgrades (por si algun tool los usa)
server.on('upgrade', (req, socket, head) => {
  const t = pick(req.url);
  const up = net.connect(t.port, t.host, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(LISTEN, () => {
  console.log(`[proxy] escuchando en :${LISTEN}`);
  console.log(`[proxy]   /cactus-tracker/*  ->  localhost:${TRACKER.port}  (tracker)`);
  console.log(`[proxy]   todo lo demas      ->  localhost:${OTHER.port}  (otro tool)`);
  console.log('[proxy] apunta ngrok a este puerto ' + LISTEN + '. No cierres esta ventana.');
});
