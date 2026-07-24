import express from 'express';
import http from 'http';
import { config } from './config';
import { mountFeeds } from './feeds';
import { AisIngestor } from './sources/ais';
import { CivAirIngestor } from './sources/civair';
import { FiresIngestor } from './sources/firms';
import { StreamHub } from './stream';

const app = express();
app.disable('x-powered-by');

// CORS — allow the frontend origin(s). CORS_ORIGIN="*" or a comma-separated allowlist.
const allowed = config.corsOrigin.split(',').map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (config.corsOrigin === '*') res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

const ais = new AisIngestor(config);
const air = new CivAirIngestor(config);
const fires = new FiresIngestor(config);
let hub: StreamHub;

mountFeeds(app);

app.get('/', (_req, res) => res.json({ service: 'thirdeye-backend', version: '0.2.0', endpoints: ['/api/health', '/feeds/*', '/stream (ws)'] }));

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    ais: ais.status(),
    aircraft: air.status(),
    fires: fires.status(),
    streamClients: hub ? hub.clientCount() : 0,
  });
});

// Active-fire detections (NASA FIRMS). Polled server-side (key stays server-side) and
// served as a compact snapshot the frontend polls every few minutes.
app.get('/api/fires', (_req, res) => {
  const s = fires.status();
  res.json({ ok: s.enabled, updated: s.updated, sources: s.sources, dayRange: s.dayRange, count: fires.all().length, fires: fires.all() });
});

const server = http.createServer(app);
hub = new StreamHub(server, { ais, air }, config);
ais.start();
air.start();
fires.start();

server.listen(config.port, () => {
  console.log(`ThirdEye backend listening on :${config.port}`);
  if (!config.aisKey) console.log('  ⚠  AISSTREAM_API_KEY not set — ships disabled until you add it to .env');
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
