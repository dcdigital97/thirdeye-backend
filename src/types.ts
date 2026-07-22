import type { BBox } from './config';

/** Normalised vessel record kept in the world state (compact wire shape). */
export interface Vessel {
  mmsi: number;
  name: string | null;
  lat: number;
  lon: number;
  cog: number | null;   // course over ground, degrees
  sog: number | null;   // speed over ground, knots
  hdg: number | null;   // true heading, degrees (511 => not available => null)
  type: number | null;  // raw AIS ship type code
  cat: string;          // coarse category (cargo, tanker, passenger, ...)
  nav: number | null;   // navigational status code
  ts: number;           // last update, epoch ms
}

/** Normalised civil-aircraft record (from OpenSky state vectors). */
export interface Aircraft {
  icao24: string;
  callsign: string | null;
  country: string | null;
  lat: number;
  lon: number;
  alt: number | null;     // metres (geometric if available, else barometric)
  onGround: boolean;
  vel: number | null;     // knots
  track: number | null;   // degrees
  vrate: number | null;   // m/s (climb +, descend -)
  squawk: string | null;
  ts: number;             // last contact, epoch ms
}

export type ViewportMsg = {
  type: 'viewport';
  bbox: [number, number, number, number]; // [minLon,minLat,maxLon,maxLat]
  want?: string[];                         // e.g. ['ships','aircraft']; absent => both
};

export function inBbox(v: { lat: number; lon: number }, b: BBox): boolean {
  return v.lat >= b.latMin && v.lat <= b.latMax && v.lon >= b.lonMin && v.lon <= b.lonMax;
}

/** Map an AIS ship-type code to a coarse OSINT-friendly category. */
export function shipCategory(type: number | null | undefined): string {
  if (type == null) return 'other';
  if (type === 30) return 'fishing';
  if (type === 35) return 'military';
  if (type === 36) return 'sailing';
  if (type === 37) return 'pleasure';
  if (type === 51) return 'sar';
  if (type === 52) return 'tug';
  if (type === 55) return 'law';
  if (type >= 31 && type <= 32) return 'tug';
  if (type >= 40 && type <= 49) return 'highspeed';
  if (type >= 60 && type <= 69) return 'passenger';
  if (type >= 70 && type <= 79) return 'cargo';
  if (type >= 80 && type <= 89) return 'tanker';
  return 'other';
}
