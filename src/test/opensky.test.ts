import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState } from '../sources/opensky';

// A representative OpenSky state vector.
const S = [
  'a1b2c3',            // 0 icao24
  'BAW123  ',          // 1 callsign (padded)
  'United Kingdom',    // 2 origin_country
  1_700_000_000,       // 3 time_position
  1_700_000_050,       // 4 last_contact
  -0.45,               // 5 longitude
  51.47,               // 6 latitude
  11000,               // 7 baro_altitude
  false,               // 8 on_ground
  250,                 // 9 velocity m/s
  270.5,               // 10 true_track
  5.2,                 // 11 vertical_rate
  null,                // 12 sensors
  11582,               // 13 geo_altitude
  '2200',              // 14 squawk
  false,               // 15 spi
  0,                   // 16 position_source
];

test('normalizeState: maps fields, trims callsign, prefers geo altitude, m/s->kt', () => {
  const a = normalizeState(S, 999);
  assert.ok(a);
  assert.equal(a!.icao24, 'a1b2c3');
  assert.equal(a!.callsign, 'BAW123');
  assert.equal(a!.country, 'United Kingdom');
  assert.equal(a!.lon, -0.45);
  assert.equal(a!.lat, 51.47);
  assert.equal(a!.alt, 11582);                    // geo altitude preferred
  assert.equal(a!.onGround, false);
  assert.equal(Math.round(a!.vel!), 486);          // 250 m/s ≈ 486 kt
  assert.equal(a!.track, 270.5);
  assert.equal(a!.squawk, '2200');
  assert.equal(a!.ts, 1_700_000_050_000);          // last_contact * 1000
});

test('normalizeState: falls back to baro altitude and injected now', () => {
  const s = [...S]; s[13] = null; s[4] = null;
  const a = normalizeState(s, 42)!;
  assert.equal(a.alt, 11000);   // baro fallback
  assert.equal(a.ts, 42);       // injected now when no last_contact
});

test('normalizeState: rejects missing/invalid position', () => {
  const s = [...S]; s[5] = null;
  assert.equal(normalizeState(s, 1), null);
  const s2 = [...S]; s2[6] = 999;
  assert.equal(normalizeState(s2, 1), null);
  assert.equal(normalizeState(null as any, 1), null);
});

test('normalizeState: empty callsign becomes null', () => {
  const s = [...S]; s[1] = '   ';
  assert.equal(normalizeState(s, 1)!.callsign, null);
});
