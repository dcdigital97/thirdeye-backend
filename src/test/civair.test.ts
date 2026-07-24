import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdsb } from '../sources/civair';

const CIVIL = {
  hex: '40768a', flight: 'EZY45QR ', r: 'G-EZTA', t: 'A320',
  lat: 51.5, lon: -0.2, alt_baro: 36000, gs: 420, track: 275.3, baro_rate: -640, squawk: '2000', seen_pos: 3,
};

test('normalizeAdsb: civil aircraft -> metres/knots/(m/s)', () => {
  const a = normalizeAdsb(CIVIL, 1_000_000, false)!;
  assert.ok(a);
  assert.equal(a.icao24, '40768a');
  assert.equal(a.callsign, 'EZY45QR');            // trimmed
  assert.equal(Math.round(a.alt!), Math.round(36000 * 0.3048)); // ft -> m
  assert.equal(a.vel, 420);                        // gs already knots
  assert.equal(a.track, 275.3);
  assert.ok(Math.abs(a.vrate! - (-640 * 0.00508)) < 1e-6);      // fpm -> m/s
  assert.equal(a.squawk, '2000');
  assert.equal(a.ts, 1_000_000 - 3000);            // seen_pos applied
  assert.equal(a.onGround, false);
});

test('normalizeAdsb: on-ground and geom-altitude fallback', () => {
  const g = normalizeAdsb({ ...CIVIL, alt_baro: 'ground' }, 5, false)!;
  assert.equal(g.onGround, true);
  assert.equal(g.alt, 0);
  const geo = normalizeAdsb({ ...CIVIL, alt_baro: undefined, alt_geom: 1000 }, 5, false)!;
  assert.equal(Math.round(geo.alt!), Math.round(1000 * 0.3048));
});

test('normalizeAdsb: military filtered out unless included', () => {
  const milAc = { ...CIVIL, hex: 'ae1234', dbFlags: 1 };
  assert.equal(normalizeAdsb(milAc, 1, false), null);            // dropped by default
  assert.ok(normalizeAdsb(milAc, 1, true));                       // kept when includeMilitary
});

test('normalizeAdsb: true_heading fallback and bad fix', () => {
  const th = normalizeAdsb({ ...CIVIL, track: undefined, true_heading: 88 }, 1, false)!;
  assert.equal(th.track, 88);
  assert.equal(normalizeAdsb({ ...CIVIL, lat: undefined }, 1, false), null);
  assert.equal(normalizeAdsb(null, 1, false), null);
});
