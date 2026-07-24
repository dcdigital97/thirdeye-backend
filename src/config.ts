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

  // --- Civil aircraft (OpenSky Network) ---
  // OAuth2 client credentials from an OpenSky account (Account -> API clients).
  openskyClientId: process.env.OPENSKY_CLIENT_ID || '',
  openskyClientSecret: process.env.OPENSKY_CLIENT_SECRET || '',
  // Poll box. Default = UK / Ireland / North Sea (~10x10deg => 2 OpenSky credits/request).
  openskyBbox: parseBbox(process.env.OPENSKY_BBOX, { latMin: 49, lonMin: -11, latMax: 59, lonMax: 3 }),
  // Poll cadence. 45s with a 2-credit box ≈ 3,840 credits/day — just under the 4,000 authed budget.
  // Widen the box or shorten this and you risk the daily cap; the ingestor also self-throttles when low.
  openskyIntervalMs: num(process.env.OPENSKY_INTERVAL_MS, 45000),

  // --- Civil aircraft (airplanes.live point query) ---
  // OpenSky is unreachable from cloud hosts, so civil aircraft use airplanes.live's
  // /v2/point/{lat}/{lon}/{radius} endpoint — no key, no OAuth, reachable from the cloud.
  // Default centre = UK; radius max 250 nm. Poll ~10s (airplanes.live cap is ~1 req/s).
  civairLat: num(process.env.CIVAIR_LAT, 54.0),
  civairLon: num(process.env.CIVAIR_LON, -2.5),
  civairRadiusNm: Math.min(250, num(process.env.CIVAIR_RADIUS_NM, 250)),
  civairIntervalMs: num(process.env.CIVAIR_INTERVAL_MS, 10000),
  // Civil-only by default (the dedicated military layer already covers mil traffic).
  civairIncludeMilitary: (process.env.CIVAIR_INCLUDE_MILITARY || 'false') === 'true',

  // --- /stream fan-out ---
  streamIntervalMs: num(process.env.STREAM_INTERVAL_MS, 3000),
  maxVesselsPerClient: num(process.env.MAX_VESSELS, 800),
  maxAircraftPerClient: num(process.env.MAX_AIRCRAFT, 800),
  // Drop vessels we haven't heard from in this many seconds.
  vesselTtlSec: num(process.env.VESSEL_TTL_SEC, 1800),
  // Drop aircraft not seen in this many seconds (ADS-B fixes are frequent; short TTL).
  aircraftTtlSec: num(process.env.AIRCRAFT_TTL_SEC, 120),
};

export type Config = typeof config;
