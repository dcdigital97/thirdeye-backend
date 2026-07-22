# ThirdEye backend (Phase 2a)

A small always-on Node/TypeScript service that does the things the static globe can't:
holds secrets, keeps a live socket open, and fans one upstream feed out to every viewer.

**This build (Phase 2a) adds:**
- **Live AIS ship traffic** — ingests the [AISStream](https://aisstream.io/) WebSocket with a
  server-held key, normalises vessels, and pushes the ones in your viewport to the browser over
  `/stream`. The key never reaches the browser.
- **`/feeds/*` proxy** — the same feed rewrites the frontend uses on Netlify, ported here, so the
  frontend can optionally point its feeds at this backend instead.
- **`/api/health`** — status (AIS connection, vessel count, stream clients).

The 17 existing frontend layers keep working exactly as they are — this backend is additive.

## What you need to do (the two things I can't)

1. **Get a free AISStream key** — sign in at <https://aisstream.io/> (GitHub), create an API key.
   It goes in `.env` on the server, nowhere else.
2. **Deploy it** to a small VPS (a Hetzner CX22 at ~€5/mo or a DigitalOcean droplet is plenty).

## Deploy (VPS + Docker + automatic HTTPS)

The frontend is HTTPS (Netlify), and browsers won't open an insecure `ws://` from a secure page,
so the backend must be reachable over `https`/`wss`. The included Caddy service handles TLS for you.

**1. Point a domain at the server.** Add an `A` record, e.g. `api.thirdeye.yourdomain.com` → your
VPS IP. (You mentioned buying a domain — a subdomain of it is ideal.)

**2. On the VPS** (Ubuntu/Debian), install Docker:
```bash
curl -fsSL https://get.docker.com | sh
```

**3. Get the code onto the server.** Either push this `backend/` folder to a repo and
`git clone` it, or `scp` the folder up. Then:
```bash
cd thirdeye-backend
cp .env.example .env
nano .env          # set AISSTREAM_API_KEY, BACKEND_DOMAIN, CORS_ORIGIN
```

**4. Start it:**
```bash
docker compose up -d --build
```
Caddy fetches a TLS cert on first run (give it a minute). Check it:
```bash
curl https://api.thirdeye.yourdomain.com/api/health
```
You should see `"status":"ok"` and, once ships start arriving, a rising `vessels` count.

**5. (Optional) survive reboots via systemd** — see `systemd/thirdeye-backend.service`.
With `restart: unless-stopped` and Docker enabled on boot it already comes back, but the unit
gives you `systemctl start/stop/status`.

**Redeploys** after code changes: `./deploy.sh` (pull + rebuild + restart).

### Local test without a domain
Comment out the `caddy` service in `docker-compose.yml`, uncomment the backend `ports:` mapping,
and hit `http://SERVER_IP:8080/api/health`. (The live frontend can't use a plain-http backend —
that's only for poking the API directly.)

## Configuration (`.env`)

| Var | What |
|---|---|
| `AISSTREAM_API_KEY` | Your AISStream key (server-only). Empty = ships disabled, rest still runs. |
| `BACKEND_DOMAIN` | Domain Caddy gets a cert for and serves on. |
| `CORS_ORIGIN` | Allowed frontend origin(s). Set to your Netlify origin; `*` for testing. |
| `AIS_BBOX` | Ingestion box `latMin,lonMin,latMax,lonMax`. Default = NW Europe. Global is a firehose. |
| `PORT` | Internal port (8080; leave as-is for the compose setup). |
| `STREAM_INTERVAL_MS` / `MAX_VESSELS` / `VESSEL_TTL_SEC` | Fan-out tuning. |

## API

- `GET /api/health` → `{ status, uptimeSec, ais:{ connected, hasKey, vessels, bbox }, streamClients }`
- `GET /feeds/*` → same-origin proxy for the key-free feeds (adsb, usgs, celestrak, nhc, gdacs, ea, jpl, gpsjam, cables, metar)
- `WS /stream` → send `{"type":"viewport","bbox":[minLon,minLat,maxLon,maxLat]}`; receive
  `{"type":"ships","vessels":[{ mmsi, name, lat, lon, cog, sog, hdg, type, cat, nav, ts }]}` on a timer.

## Once it's live

Tell me the backend URL (e.g. `https://api.thirdeye.yourdomain.com`) and confirm `/api/health`
returns ok with a non-zero `vessels` count. I'll then wire the **Maritime → Ships** layer into the
frontend, pointed at your backend, and ships will start moving on the globe.

## Dev

```bash
npm install
npm run check   # type-check
npm test        # unit tests (AIS parsing, categorisation, bbox, feed rules)
npm run build && npm start
```

## Honesty note

Ships are labelled **DIRECT OBSERVATION (AIS)** — a real transponder signal — but AIS can be
switched off or spoofed, and AISStream is BETA with no SLA, so the layer should show an honest
"stream degraded" state when the socket drops. Non-commercial use; AIS data courtesy of AISStream.
