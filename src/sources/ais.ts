import WebSocket from 'ws';
import type { Config } from '../config';
import { Vessel, shipCategory } from '../types';

const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';

/** A partial vessel update parsed from one AISStream message (only the fields present). */
export interface AisUpdate {
  mmsi: number;
  lat?: number;
  lon?: number;
  cog?: number | null;
  sog?: number | null;
  hdg?: number | null;
  type?: number | null;
  name?: string | null;
  nav?: number | null;
  ts: number;
}

function validLat(x: unknown): x is number { return typeof x === 'number' && x >= -90 && x <= 90; }
function validLon(x: unknown): x is number { return typeof x === 'number' && x >= -180 && x <= 180; }

/**
 * Pure parser for an AISStream message. Returns an AisUpdate or null.
 * Handles PositionReport (kinematics) and ShipStaticData (identity/type).
 * `now` is injected so this is deterministic and unit-testable.
 */
export function parseAisMessage(raw: any, now: number): AisUpdate | null {
  if (!raw || typeof raw !== 'object') return null;
  const meta = raw.MetaData || raw.Metadata || {};
  const mmsi = Number(meta.MMSI ?? meta.MMSI_String);
  if (!Number.isFinite(mmsi) || mmsi <= 0) return null;
  const name = typeof meta.ShipName === 'string' && meta.ShipName.trim() ? meta.ShipName.trim() : undefined;
  const type = raw.MessageType;
  const body = raw.Message || {};

  if (type === 'PositionReport' && body.PositionReport) {
    const p = body.PositionReport;
    const lat = p.Latitude, lon = p.Longitude;
    if (!validLat(lat) || !validLon(lon)) return null;
    const cog = typeof p.Cog === 'number' && p.Cog < 360 ? p.Cog : null;
    const sog = typeof p.Sog === 'number' && p.Sog < 102.3 ? p.Sog : null;
    const hdg = typeof p.TrueHeading === 'number' && p.TrueHeading < 511 ? p.TrueHeading : null;
    const nav = typeof p.NavigationalStatus === 'number' ? p.NavigationalStatus : null;
    return { mmsi, lat, lon, cog, sog, hdg, nav, name, ts: now };
  }

  if (type === 'ShipStaticData' && body.ShipStaticData) {
    const s = body.ShipStaticData;
    const t = typeof s.Type === 'number' ? s.Type : null;
    const nm = name ?? (typeof s.Name === 'string' && s.Name.trim() ? s.Name.trim() : undefined);
    return { mmsi, type: t, name: nm, ts: now };
  }

  // Position via lat/lon in MetaData (some message types) — last resort.
  if (validLat(meta.latitude) && validLon(meta.longitude)) {
    return { mmsi, lat: meta.latitude, lon: meta.longitude, name, ts: now };
  }
  return null;
}

/** Merge an update into an existing vessel (or create one). Returns the merged vessel. */
export function applyUpdate(prev: Vessel | undefined, u: AisUpdate): Vessel {
  const v: Vessel = prev ?? {
    mmsi: u.mmsi, name: null, lat: NaN, lon: NaN, cog: null, sog: null, hdg: null,
    type: null, cat: 'other', nav: null, ts: u.ts,
  };
  if (u.lat != null) v.lat = u.lat;
  if (u.lon != null) v.lon = u.lon;
  if (u.cog !== undefined) v.cog = u.cog;
  if (u.sog !== undefined) v.sog = u.sog;
  if (u.hdg !== undefined) v.hdg = u.hdg;
  if (u.nav !== undefined) v.nav = u.nav;
  if (u.name) v.name = u.name;
  if (u.type !== undefined && u.type !== null) { v.type = u.type; v.cat = shipCategory(u.type); }
  v.ts = u.ts;
  return v;
}

export class AisIngestor {
  private cfg: Config;
  private ws: WebSocket | null = null;
  private connected = false;
  private backoff = 1000;
  private vessels = new Map<number, Vessel>();
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(cfg: Config) { this.cfg = cfg; }

  start(): void {
    if (!this.cfg.aisKey) {
      console.warn('[ais] AISSTREAM_API_KEY not set — AIS stream disabled. Set it in .env to enable ships.');
      return;
    }
    this.connect();
    this.pruneTimer = setInterval(() => this.prune(), 60_000);
  }

  private connect(): void {
    const b = this.cfg.aisBbox;
    let ws: WebSocket;
    try { ws = new WebSocket(AISSTREAM_URL); } catch (e) { this.scheduleReconnect(); return; }
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.backoff = 1000;
      const sub = {
        APIKey: this.cfg.aisKey,
        BoundingBoxes: [[[b.latMin, b.lonMin], [b.latMax, b.lonMax]]],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      };
      ws.send(JSON.stringify(sub));
      console.log(`[ais] connected; subscribed bbox lat[${b.latMin},${b.latMax}] lon[${b.lonMin},${b.lonMax}]`);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      let raw: any;
      try { raw = JSON.parse(data.toString()); } catch { return; }
      // AISStream sends {error: "..."} on a bad key/subscription — surface it once.
      if (raw && raw.error) { console.error('[ais] upstream error:', raw.error); return; }
      const u = parseAisMessage(raw, Date.now());
      if (!u) return;
      this.vessels.set(u.mmsi, applyUpdate(this.vessels.get(u.mmsi), u));
    });

    ws.on('close', () => { this.connected = false; this.scheduleReconnect(); });
    ws.on('error', (err) => { console.error('[ais] socket error:', (err as Error).message); });
  }

  private scheduleReconnect(): void {
    try { this.ws?.removeAllListeners(); } catch {}
    this.ws = null;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    console.warn(`[ais] reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(() => this.connect(), delay);
  }

  private prune(): void {
    const cutoff = Date.now() - this.cfg.vesselTtlSec * 1000;
    for (const [mmsi, v] of this.vessels) if (v.ts < cutoff) this.vessels.delete(mmsi);
  }

  /** All vessels with a valid fix. */
  all(): Vessel[] {
    const out: Vessel[] = [];
    for (const v of this.vessels.values()) if (Number.isFinite(v.lat) && Number.isFinite(v.lon)) out.push(v);
    return out;
  }

  status() {
    return { connected: this.connected, hasKey: !!this.cfg.aisKey, vessels: this.vessels.size, bbox: this.cfg.aisBbox };
  }
}
