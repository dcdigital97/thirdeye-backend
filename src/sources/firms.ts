import type { Config } from '../config';
import { Fire } from '../types';

// The worldwide FIRMS CSV is large and generated on demand, so allow a generous per-source
// timeout. Sources are fetched in parallel, so total poll time is ~this, not the sum.
const FETCH_TIMEOUT_MS = 120_000;

/** Normalise a FIRMS confidence value (VIIRS uses l/n/h; MODIS uses 0–100). */
function normConf(v: string): 'low' | 'nominal' | 'high' | null {
  const s = (v || '').trim().toLowerCase();
  if (s === 'l' || s === 'low') return 'low';
  if (s === 'n' || s === 'nominal') return 'nominal';
  if (s === 'h' || s === 'high') return 'high';
  const n = Number(s);
  if (Number.isFinite(n)) return n < 30 ? 'low' : (n < 80 ? 'nominal' : 'high');
  return null;
}

/** Combine FIRMS acq_date (YYYY-MM-DD) + acq_time (HHMM, UTC) into epoch ms. */
function parseAcq(date: string, time: string, now: number): number {
  if (!date) return now;
  const t = String(time || '0').padStart(4, '0');
  const ms = Date.parse(`${date}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`);
  return Number.isFinite(ms) ? ms : now;
}

/**
 * Pure parser for a FIRMS area-CSV response. Columns are looked up by header name so it
 * handles both the VIIRS shape (bright_ti4, confidence l/n/h) and the MODIS shape
 * (brightness, confidence 0–100). Returns [] for a non-CSV body (e.g. an error string).
 * `now` injected for testability.
 */
export function parseFirmsCsv(text: string, now: number): Fire[] {
  const lines = (text || '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const ix = (n: string) => header.indexOf(n);
  const iLat = ix('latitude'), iLon = ix('longitude');
  if (iLat < 0 || iLon < 0) return []; // not a data CSV (likely "Invalid MAP_KEY" etc.)
  const iFrp = ix('frp'), iConf = ix('confidence'), iSat = ix('satellite'), iInst = ix('instrument'),
    iDate = ix('acq_date'), iTime = ix('acq_time'), iDN = ix('daynight'),
    iBt4 = ix('bright_ti4'), iBri = ix('brightness');
  const out: Fire[] = [];
  for (let r = 1; r < lines.length; r++) {
    const c = lines[r].split(',');
    if (c.length < header.length) continue;
    const lat = Number(c[iLat]), lon = Number(c[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const frp = iFrp >= 0 ? Number(c[iFrp]) : NaN;
    const bright = iBt4 >= 0 ? Number(c[iBt4]) : (iBri >= 0 ? Number(c[iBri]) : NaN);
    const dn = iDN >= 0 ? c[iDN] : '';
    out.push({
      lat, lon,
      frp: Number.isFinite(frp) ? frp : null,
      conf: normConf(iConf >= 0 ? c[iConf] : ''),
      bright: Number.isFinite(bright) ? bright : null,
      sat: iSat >= 0 && c[iSat] ? c[iSat] : null,
      instrument: iInst >= 0 && c[iInst] ? c[iInst] : null,
      dn: dn === 'D' ? 'D' : (dn === 'N' ? 'N' : null),
      ts: parseAcq(iDate >= 0 ? c[iDate] : '', iTime >= 0 ? c[iTime] : '', now),
    });
  }
  return out;
}

/**
 * Polls the NASA FIRMS area-CSV API (server-held MAP_KEY) for near-real-time active-fire
 * detections, merges the configured sources, keeps the strongest (by FRP) up to a cap, and
 * exposes them for the /api/fires endpoint. A thermal-anomaly DETECTION, not a confirmed fire.
 */
export class FiresIngestor {
  private cfg: Config;
  private fires: Fire[] = [];
  private lastOk = false;
  private lastError: string | null = null;
  private lastUpdate = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(cfg: Config) { this.cfg = cfg; }

  start(): void {
    if (!this.cfg.firmsKey) {
      console.warn('[firms] FIRMS_MAP_KEY not set — active-fire layer disabled. Add it to enable fires.');
      return;
    }
    this.loop();
  }

  /** Fetch + parse one FIRMS source, worldwide. Long timeout — the global CSV is large
   *  and FIRMS generates it on demand, so the first request in particular can be slow. */
  private async fetchSource(src: string, now: number): Promise<Fire[]> {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${this.cfg.firmsKey}/${src}/world/${this.cfg.firmsDayRange}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ThirdEye/0.3 (+backend active-fire)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const parsed = parseFirmsCsv(text, now);
    if (!parsed.length && !/latitude/i.test(text.slice(0, 120))) {
      throw new Error(text.slice(0, 80).replace(/\s+/g, ' ')); // e.g. "Invalid MAP_KEY"
    }
    return parsed;
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    // Fetch every source in parallel and keep whatever succeeds — one slow or failed source
    // (these are big global downloads) must not sink the others.
    const settled = await Promise.allSettled(
      this.cfg.firmsSources.map((src) => this.fetchSource(src, now))
    );
    const merged: Fire[] = [];
    const errs: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') merged.push(...r.value);
      else errs.push(`${this.cfg.firmsSources[i]}: ${(r.reason as Error)?.message || r.reason}`);
    });
    if (!settled.some((r) => r.status === 'fulfilled')) {
      throw new Error(errs.join(' | ') || 'all FIRMS sources failed');
    }
    merged.sort((a, b) => (b.frp || 0) - (a.frp || 0));
    this.fires = merged.slice(0, this.cfg.maxFires);
    this.lastOk = true;
    this.lastError = errs.length ? errs.join(' | ') : null; // record any partial failures
    this.lastUpdate = now;
  }

  private loop(): void {
    this.poll()
      .catch((e) => {
        this.lastOk = false;
        this.lastError = (e as Error).message;
        console.error('[firms] poll error:', this.lastError);
      })
      .finally(() => { this.timer = setTimeout(() => this.loop(), this.cfg.firmsIntervalMs); });
  }

  all(): Fire[] { return this.fires; }

  status() {
    return {
      enabled: !!this.cfg.firmsKey,
      lastOk: this.lastOk,
      lastError: this.lastError,
      count: this.fires.length,
      updated: this.lastUpdate,
      sources: this.cfg.firmsSources,
      dayRange: this.cfg.firmsDayRange,
    };
  }
}
