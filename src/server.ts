import express from 'express';
import http from 'http';
import { config } from './config';
import { mountFeeds } from './feeds';
import { AisIngestor } from './sources/ais';
import { CivAirIngestor } from './sources/civair';
import { FiresIngestor } from './sources/firms';
import { WindyWebcams } from './sources/webcams';
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
const webcams = new WindyWebcams(config);
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
    traffic: { enabled: !!config.tomtomKey, source: 'tomtom', style: config.tomtomStyle },
    webcams: webcams.status(),
    streamClients: hub ? hub.clientCount() : 0,
  });
});

// Active-fire detections (NASA FIRMS). Polled server-side (key stays server-side) and
// served as a compact snapshot the frontend polls every few minutes.
app.get('/api/fires', (_req, res) => {
  const s = fires.status();
  res.json({ ok: s.enabled, updated: s.updated, sources: s.sources, dayRange: s.dayRange, count: fires.all().length, fires: fires.all() });
});

// TomTom live-traffic raster tiles, proxied so the key never reaches the browser.
app.get('/tiles/traffic/:z/:x/:y.png', async (req, res) => {
  if (!config.tomtomKey) { res.status(503).end(); return; }
  const { z, x, y } = req.params;
  if (!/^\d+$/.test(z) || !/^\d+$/.test(x) || !/^\d+$/.test(y)) { res.status(400).end(); return; }
  const url = `https://api.tomtom.com/traffic/map/4/tile/flow/${config.tomtomStyle}/${z}/${x}/${y}.png?key=${config.tomtomKey}&tileSize=256`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) { res.status(r.status).end(); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=120'); // TomTom flow updates roughly every 1–2 min
    res.end(buf);
  } catch { res.status(502).end(); }
});

// Public webcams near a viewport centre (Windy relay; key stays server-side).
app.get('/api/webcams', async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon), radius = Number(req.query.radius) || 150;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { res.status(400).json({ ok: false, error: 'lat/lon required', webcams: [] }); return; }
  try {
    const w = await webcams.nearby(lat, lon, radius);
    res.json({ ok: true, count: w.length, webcams: w });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message, webcams: [] });
  }
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
