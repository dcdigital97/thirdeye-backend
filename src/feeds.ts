import type { Express, Request, Response } from 'express';

/**
 * The same-origin feed proxy, ported from the frontend's netlify.toml. When the frontend
 * points /feeds/* at this backend instead of Netlify, these serve the CORS-sensitive
 * upstreams server-side. No secrets involved here — these are all key-free feeds; the
 * proxy just removes the browser CORS problem and centralises egress.
 */
type Rule = { test: (path: string) => boolean; url: (path: string, qs: string) => string };

const rules: Rule[] = [
  { test: (p) => p.startsWith('/feeds/adsb/'), url: (p) => `https://api.airplanes.live/v2/${p.slice('/feeds/adsb/'.length)}` },
  { test: (p) => p === '/feeds/usgs/all_day', url: () => 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson' },
  { test: (p) => p.startsWith('/feeds/celestrak/'), url: (p) => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(p.slice('/feeds/celestrak/'.length))}&FORMAT=tle` },
  { test: (p) => p === '/feeds/nhc/storms', url: () => 'https://www.nhc.noaa.gov/CurrentStorms.json' },
  { test: (p) => p === '/feeds/gdacs/events', url: () => 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP' },
  { test: (p) => p === '/feeds/ea/floods', url: () => 'https://environment.data.gov.uk/flood-monitoring/id/floods' },
  { test: (p) => p === '/feeds/ea/floodAreas', url: () => 'https://environment.data.gov.uk/flood-monitoring/id/floodAreas' },
  { test: (p) => p === '/feeds/jpl/fireball', url: (_p, qs) => `https://ssd-api.jpl.nasa.gov/fireball.api${qs}` },
  { test: (p) => p.startsWith('/feeds/gpsjam/'), url: (p) => `https://gpsjam.org/data/${p.slice('/feeds/gpsjam/'.length)}` },
  { test: (p) => p.startsWith('/feeds/cables/'), url: (p) => `https://www.submarinecablemap.com/api/v3/${p.slice('/feeds/cables/'.length)}` },
  { test: (p) => p === '/feeds/metar', url: (_p, qs) => `https://aviationweather.gov/api/data/metar${qs}` },
];

function resolve(path: string, qs: string): string | null {
  for (const r of rules) if (r.test(path)) return r.url(path, qs);
  return null;
}

export function mountFeeds(app: Express): void {
  app.get('/feeds/*', async (req: Request, res: Response) => {
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const url = resolve(req.path, qs);
    if (!url) { res.status(404).json({ error: 'unknown feed', path: req.path }); return; }
    try {
      const upstream = await fetch(url, { headers: { 'User-Agent': 'ThirdEye/0.2 (+backend feed proxy)' } });
      res.status(upstream.status);
      const ct = upstream.headers.get('content-type');
      if (ct) res.setHeader('content-type', ct);
      res.setHeader('cache-control', 'public, max-age=30');
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch (e) {
      res.status(502).json({ error: 'upstream fetch failed', detail: (e as Error).message });
    }
  });
}

export { resolve as resolveFeed };
