import type { Config } from '../config';

/** Normalised public webcam (from Windy Webcams API v3). */
export interface Webcam {
  id: string | number;
  title: string | null;
  lat: number;
  lon: number;
  city: string | null;
  country: string | null;
  preview: string | null; // current still-image URL (token expires ~10 min on free tier)
  link: string | null;    // Windy detail page
}

/**
 * Windy Webcams relay. The API key stays server-side; the frontend asks this backend for
 * the public webcams near a viewport centre and gets back normalised records. Results are
 * cached briefly per location to stay light on the free tier (image tokens last ~10 min).
 */
export class WindyWebcams {
  private cfg: Config;
  private cache = new Map<string, { ts: number; data: Webcam[] }>();

  constructor(cfg: Config) { this.cfg = cfg; }

  async nearby(lat: number, lon: number, radiusKm: number): Promise<Webcam[]> {
    if (!this.cfg.windyKey) throw new Error('WINDY_KEY not set');
    const r = Math.max(1, Math.min(250, Math.round(radiusKm)));
    const key = `${lat.toFixed(2)},${lon.toFixed(2)},${r}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.ts < 60_000) return hit.data;

    const url = `https://api.windy.com/webcams/api/v3/webcams?nearby=${lat},${lon},${r}`
      + `&limit=50&include=images,location,urls&lang=en`;
    const res = await fetch(url, {
      headers: { 'x-windy-api-key': this.cfg.windyKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Windy HTTP ${res.status}`);
    const j: any = await res.json();
    const list: Webcam[] = (j.webcams || []).map((w: any) => {
      const loc = w.location || {};
      const img = (w.images && w.images.current) || {};
      const urls = w.urls || {};
      return {
        id: w.webcamId ?? w.id,
        title: w.title || null,
        lat: Number(loc.latitude),
        lon: Number(loc.longitude),
        city: loc.city || null,
        country: loc.country || null,
        preview: img.preview || img.thumbnail || null,
        link: urls.detail || null,
      };
    }).filter((w: Webcam) => Number.isFinite(w.lat) && Number.isFinite(w.lon));

    this.cache.set(key, { ts: now, data: list });
    return list;
  }

  status() { return { enabled: !!this.cfg.windyKey, source: 'windy.com' }; }
}
