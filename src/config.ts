import * as dotenv from 'dotenv';
dotenv.config();

export interface BBox { latMin: number; lonMin: number; latMax: number; lonMax: number; }

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Parse "latMin,lonMin,latMax,lonMax" into a BBox, falling back to a default. */
function parseBbox(v: string | undefined, def: BBox): BBox {
  if (!v) return def;
  const p = v.split(',').map(Number);
  if (p.length === 4 && p.every((x) => Number.isFinite(x))) {
    return { latMin: p[0], lonMin: p[1], latMax: p[2], lonMax: p[3] };
  }
  return def;
}

export const config = {
  port: num(process.env.PORT, 8080),
  // Comma-separated list of allowed origins, or "*" for any. The frontend origin(s).
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // --- AIS (AISStream) ---
  aisKey: process.env.AISSTREAM_API_KEY || '',
  // Ingestion bounding box. Default: NW Europe / North Sea / UK — a sane, non-firehose region.
  // Widen or move via AIS_BBOX="latMin,lonMin,latMax,lonMax". Global = "-90,-180,90,180".
  aisBbox: parseBbox(process.env.AIS_BBOX, { latMin: 40, lonMin: -20, latMax: 62, lonMax: 30 }),

  // --- /stream fan-out ---
  streamIntervalMs: num(process.env.STREAM_INTERVAL_MS, 3000),
  maxVesselsPerClient: num(process.env.MAX_VESSELS, 800),
  // Drop vessels we haven't heard from in this many seconds.
  vesselTtlSec: num(process.env.VESSEL_TTL_SEC, 1800),
};

export type Config = typeof config;
