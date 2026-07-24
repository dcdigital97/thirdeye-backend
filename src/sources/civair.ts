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

export class CivAirIngestor {
  private cfg: Config;
  private craft = new Map<string, Aircraft>();
  private lastOk = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(cfg: Config) { this.cfg = cfg; }

  start(): void {
    this.loop();
    setInterval(() => this.prune(), 60_000);
  }

  private async poll(): Promise<void> {
    const { civairLat: lat, civairLon: lon, civairRadiusNm: r } = this.cfg;
    const url = `https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ThirdEye/0.2 (+backend civil-aircraft)' },
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
  }

  private loop(): void {
    this.poll()
      .catch((e) => {
        this.lastOk = false;
        const cause = (e as any)?.cause;
        console.error('[civair] poll error:', (e as Error).message, cause ? `| cause: ${cause.code || cause.message || cause}` : '');
      })
      .finally(() => { this.timer = setTimeout(() => this.loop(), this.cfg.civairIntervalMs); });
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
      enabled: true, source: 'airplanes.live', lastOk: this.lastOk, aircraft: this.craft.size,
      centre: { lat: this.cfg.civairLat, lon: this.cfg.civairLon }, radiusNm: this.cfg.civairRadiusNm,
    };
  }
}
