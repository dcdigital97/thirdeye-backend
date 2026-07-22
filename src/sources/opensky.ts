import type { Config } from '../config';
import { Aircraft } from '../types';

const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const STATES_URL = 'https://opensky-network.org/api/states/all';

const MS_TO_KT = 1.94384;

/**
 * Pure normaliser for one OpenSky state-vector array.
 * Index map: 0 icao24, 1 callsign, 2 origin_country, 4 last_contact, 5 lon, 6 lat,
 * 7 baro_alt, 8 on_ground, 9 velocity(m/s), 10 true_track, 11 vertical_rate, 13 geo_alt, 14 squawk.
 * `now` injected for determinism/testability.
 */
export function normalizeState(s: any[], now: number): Aircraft | null {
  if (!Array.isArray(s)) return null;
  const lon = s[5], lat = s[6];
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const cs = typeof s[1] === 'string' ? s[1].trim() : '';
  const alt = typeof s[13] === 'number' ? s[13] : (typeof s[7] === 'number' ? s[7] : null);
  return {
    icao24: String(s[0]),
    callsign: cs || null,
    country: typeof s[2] === 'string' ? s[2] : null,
    lat, lon, alt,
    onGround: !!s[8],
    vel: typeof s[9] === 'number' ? s[9] * MS_TO_KT : null,
    track: typeof s[10] === 'number' ? s[10] : null,
    vrate: typeof s[11] === 'number' ? s[11] : null,
    squawk: typeof s[14] === 'string' ? s[14] : null,
    ts: typeof s[4] === 'number' ? s[4] * 1000 : now,
  };
}

export class OpenSkyIngestor {
  private cfg: Config;
  private token = '';
  private tokenExp = 0;
  private craft = new Map<string, Aircraft>();
  private lastOk = false;
  private remaining: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(cfg: Config) { this.cfg = cfg; }

  private get enabled(): boolean { return !!this.cfg.openskyClientId && !!this.cfg.openskyClientSecret; }

  start(): void {
    if (!this.enabled) {
      console.warn('[opensky] OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET not set — civil aircraft disabled.');
      return;
    }
    this.loop();
    setInterval(() => this.prune(), 60_000);
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExp) return this.token;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.cfg.openskyClientId,
      client_secret: this.cfg.openskyClientSecret,
    });
    const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!r.ok) throw new Error(`token HTTP ${r.status}`);
    const j: any = await r.json();
    this.token = j.access_token;
    this.tokenExp = Date.now() + Math.max(30, (j.expires_in || 300) - 60) * 1000; // refresh 60s early
    return this.token;
  }

  private async poll(): Promise<void> {
    const b = this.cfg.openskyBbox;
    const url = `${STATES_URL}?lamin=${b.latMin}&lomin=${b.lonMin}&lamax=${b.latMax}&lomax=${b.lonMax}`;
    const token = await this.getToken();
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const rem = r.headers.get('x-rate-limit-remaining');
    this.remaining = rem != null ? Number(rem) : this.remaining;
    if (r.status === 401) { this.token = ''; throw new Error('401 (token refresh)'); }
    if (r.status === 429) { throw new Error('429 rate-limited'); }
    if (!r.ok) throw new Error(`states HTTP ${r.status}`);
    const j: any = await r.json();
    const now = Date.now();
    const states: any[] = Array.isArray(j.states) ? j.states : [];
    for (const s of states) {
      const a = normalizeState(s, now);
      if (a) this.craft.set(a.icao24, a);
    }
    this.lastOk = true;
  }

  private loop(): void {
    this.poll()
      .catch((e) => { this.lastOk = false; console.error('[opensky] poll error:', (e as Error).message); })
      .finally(() => {
        // Credit-aware throttle: if we're running low, back right off until the window resets.
        let delay = this.cfg.openskyIntervalMs;
        if (this.remaining != null && this.remaining < 50) {
          delay = Math.max(delay, 600_000); // 10 min cool-down when near the cap
          console.warn(`[opensky] low credits (${this.remaining}) — backing off to ${Math.round(delay / 1000)}s`);
        }
        this.timer = setTimeout(() => this.loop(), delay);
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
    return { enabled: this.enabled, lastOk: this.lastOk, aircraft: this.craft.size, remaining: this.remaining, bbox: this.cfg.openskyBbox };
  }
}
