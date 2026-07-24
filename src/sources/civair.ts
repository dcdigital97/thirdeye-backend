import type { Config } from '../config';
import { Aircraft } from '../types';
 
const FT_TO_M = 0.3048;
const FPM_TO_MS = 0.00508; // 1 ft/min ≈ 0.00508 m/s
 
/**
 * Pure normaliser for one airplanes.live aircraft object -> our Aircraft shape
 * (altitude in metres, speed in knots, vrate in m/s — matching the OpenSky shape
 * the frontend already renders). `now` injected for testability.
 * Returns null for a bad fix, or for military aircraft when includeMilitary is false.
 */
export function normalizeAdsb(a: any, now: number, includeMilitary: boolean): Aircraft | null {
  if (!a || typeof a.lat !== 'number' || typeof a.lon !== 'number') return null;
  const mil = typeof a.dbFlags === 'number' && (a.dbFlags & 1) === 1;
  if (mil && !includeMilitary) return null;
 
  const onGround = a.alt_baro === 'ground';
  let alt: number | null = null;
  if (onGround) alt = 0;
  else if (typeof a.alt_baro === 'number') alt = a.alt_baro * FT_TO_M;
  else if (typeof a.alt_geom === 'number') alt = a.alt_geom * FT_TO_M;
 
  const track = typeof a.track === 'number' ? a.track
    : (typeof a.true_heading === 'number' ? a.true_heading : null);
  const cs = typeof a.flight === 'string' ? a.flight.trim() : '';
  const seen = typeof a.seen_pos === 'number' ? a.seen_pos : 0;
 
  return {
    icao24: String(a.hex || a.r || ''),
    callsign: cs || null,
    country: null,
    lat: a.lat,
    lon: a.lon,
    alt,
    onGround,
    vel: typeof a.gs === 'number' ? a.gs : null,           // already knots
    track,
    vrate: typeof a.baro_rate === 'number' ? a.baro_rate * FPM_TO_MS : null,
    squawk: typeof a.squawk === 'string' ? a.squawk : null,
    ts: now - seen * 1000,
  };
}
 
/**
 * Worldwide grid of poll centres. Each airplanes.live /v2/point query covers a 250 nm
 * (~460 km) radius, so these are placed over the busiest air-traffic regions — which is
 * also where community ADS-B receiver coverage is densest. Mid-ocean gaps are inherent to
 * ADS-B (no ground receivers out there), not a bug. Round-robined one at a time to respect
 * the API's ~1 req/s cap; the union is served to clients, filtered to their viewport.
 */
const GLOBAL_GRID: Array<[number, number]> = [
  // North America
  [47.5, -122.3], [37.7, -122.2], [34.0, -118.2], [33.4, -112.0], [39.7, -104.9],
  [32.8, -96.8], [41.9, -87.9], [33.7, -84.4], [25.8, -80.3], [40.7, -74.0], [43.7, -79.4],
  [19.4, -99.1],
  // South America
  [4.7, -74.1], [-12.0, -77.1], [-23.5, -46.6], [-34.6, -58.4],
  // Europe
  [51.5, -0.1], [48.9, 2.4], [50.0, 8.6], [40.4, -3.6], [41.9, 12.5],
  [52.2, 21.0], [59.3, 18.0], [41.0, 28.9], [55.7, 37.6],
  // Middle East & Africa
  [25.2, 55.3], [30.1, 31.4], [6.5, 3.3], [-1.3, 36.9], [-26.1, 28.2],
  // South & South-East Asia
  [28.6, 77.1], [19.1, 72.9], [13.7, 100.7], [1.4, 103.9], [-6.1, 106.7], [14.5, 121.0],
  // East Asia
  [22.3, 113.9], [31.2, 121.5], [40.1, 116.6], [37.5, 127.0], [35.6, 140.0],
  // Oceania
  [-33.9, 151.2], [-37.8, 144.9], [-31.9, 115.9],
];
 
export class CivAirIngestor {
  private cfg: Config;
  private craft = new Map<string, Aircraft>();
  private points: Array<[number, number]>;
  private idx = 0;
  private cycles = 0;
  private lastOk = false;
  private lastError: string | null = null;
  private consecErrors = 0;
  private timer: NodeJS.Timeout | null = null;
 
  constructor(cfg: Config) {
    this.cfg = cfg;
    // Grid mode (default) covers the world; point mode keeps the single configured centre.
    this.points = cfg.civairGrid ? GLOBAL_GRID.slice() : [[cfg.civairLat, cfg.civairLon]];
  }
 
  private get stepMs(): number {
    return this.cfg.civairGrid ? this.cfg.civairGridStepMs : this.cfg.civairIntervalMs;
  }
 
  start(): void {
    this.loop();
    setInterval(() => this.prune(), 60_000);
  }
 
  /** Fetch one grid point (round-robin) and merge its aircraft into the world state. */
  private async poll(): Promise<void> {
    const [lat, lon] = this.points[this.idx];
    const r = this.cfg.civairRadiusNm;
    const url = `https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ThirdEye/0.3 (+backend civil-aircraft)' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`airplanes.live HTTP ${res.status}`);
    const j: any = await res.json();
    const list: any[] = Array.isArray(j.ac) ? j.ac : (Array.isArray(j.aircraft) ? j.aircraft : []);
    const now = Date.now();
    for (const a of list) {
      const ac = normalizeAdsb(a, now, this.cfg.civairIncludeMilitary);
      if (ac && ac.icao24) this.craft.set(ac.icao24, ac);
    }
    this.lastOk = true;
    this.lastError = null;
    this.consecErrors = 0;
  }
 
  private loop(): void {
    this.poll()
      .catch((e) => {
        this.lastOk = false;
        this.consecErrors++;
        const cause = (e as any)?.cause;
        this.lastError = (e as Error).message + (cause ? ` | ${cause.code || cause.message || cause}` : '');
        console.error('[civair] poll error:', this.lastError);
      })
      .finally(() => {
        // Advance the round-robin; count a completed sweep of all points as one cycle.
        this.idx = (this.idx + 1) % this.points.length;
        if (this.idx === 0) this.cycles++;
        // Politeness: if we're getting errors (e.g. rate-limited), back off progressively.
        const backoff = this.consecErrors > 0 ? Math.min(this.consecErrors, 6) : 1;
        this.timer = setTimeout(() => this.loop(), this.stepMs * backoff);
      });
  }
 
  private prune(): void {
    const cutoff = Date.now() - this.cfg.aircraftTtlSec * 1000;
    for (const [id, a] of this.craft) if (a.ts < cutoff) this.craft.delete(id);
  }
 
  all(): Aircraft[] {
    const out: Aircraft[] = [];
    for (const a of this.craft.values()) if (Number.isFinite(a.lat) && Number.isFinite(a.lon)) out.push(a);
    return out;
  }
 
  status() {
    return {
      enabled: true,
      source: 'airplanes.live',
      lastOk: this.lastOk,
      lastError: this.lastError,
      aircraft: this.craft.size,
      mode: this.cfg.civairGrid ? 'grid' : 'point',
      regions: this.points.length,
      radiusNm: this.cfg.civairRadiusNm,
      sweeps: this.cycles,
      // In grid mode there is no single centre; expose it only in point mode.
      centre: this.cfg.civairGrid ? null : { lat: this.cfg.civairLat, lon: this.cfg.civairLon },
    };
  }
}
