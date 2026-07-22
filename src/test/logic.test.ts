import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAisMessage, applyUpdate } from '../sources/ais';
import { shipCategory, inBbox } from '../types';
import { resolveFeed } from '../feeds';

test('parseAisMessage: PositionReport', () => {
  const raw = {
    MessageType: 'PositionReport',
    MetaData: { MMSI: 244660000, ShipName: 'EEMSHORN', latitude: 53.4, longitude: 6.8 },
    Message: { PositionReport: { Latitude: 53.4, Longitude: 6.8, Cog: 87.5, Sog: 12.1, TrueHeading: 90, NavigationalStatus: 0 } },
  };
  const u = parseAisMessage(raw, 1000);
  assert.ok(u);
  assert.equal(u!.mmsi, 244660000);
  assert.equal(u!.lat, 53.4);
  assert.equal(u!.cog, 87.5);
  assert.equal(u!.sog, 12.1);
  assert.equal(u!.hdg, 90);
  assert.equal(u!.name, 'EEMSHORN');
  assert.equal(u!.ts, 1000);
});

test('parseAisMessage: heading 511 and cog 360 become null', () => {
  const u = parseAisMessage({
    MessageType: 'PositionReport',
    MetaData: { MMSI: 1 },
    Message: { PositionReport: { Latitude: 10, Longitude: 10, Cog: 360, Sog: 102.3, TrueHeading: 511, NavigationalStatus: 15 } },
  }, 5);
  assert.equal(u!.hdg, null);
  assert.equal(u!.cog, null);
  assert.equal(u!.sog, null);
});

test('parseAisMessage: invalid coords rejected', () => {
  const u = parseAisMessage({
    MessageType: 'PositionReport', MetaData: { MMSI: 1 },
    Message: { PositionReport: { Latitude: 91, Longitude: 200 } },
  }, 5);
  assert.equal(u, null);
});

test('parseAisMessage: ShipStaticData carries type', () => {
  const u = parseAisMessage({
    MessageType: 'ShipStaticData', MetaData: { MMSI: 2, ShipName: 'CARGO ONE' },
    Message: { ShipStaticData: { Type: 70 } },
  }, 9);
  assert.equal(u!.type, 70);
  assert.equal(u!.lat, undefined);
});

test('parseAisMessage: junk returns null', () => {
  assert.equal(parseAisMessage(null, 1), null);
  assert.equal(parseAisMessage({ MessageType: 'x', MetaData: {} }, 1), null);
  assert.equal(parseAisMessage({ MessageType: 'PositionReport', MetaData: { MMSI: 0 }, Message: {} }, 1), null);
});

test('applyUpdate: static merge preserves position and sets category', () => {
  let v = applyUpdate(undefined, { mmsi: 3, lat: 1, lon: 2, cog: 10, sog: 5, hdg: 12, nav: 0, ts: 1 });
  assert.equal(v.cat, 'other');
  v = applyUpdate(v, { mmsi: 3, type: 80, name: 'TANKER', ts: 2 });
  assert.equal(v.lat, 1);            // position preserved
  assert.equal(v.type, 80);
  assert.equal(v.cat, 'tanker');
  assert.equal(v.name, 'TANKER');
  assert.equal(v.ts, 2);
});

test('shipCategory mapping', () => {
  assert.equal(shipCategory(30), 'fishing');
  assert.equal(shipCategory(35), 'military');
  assert.equal(shipCategory(65), 'passenger');
  assert.equal(shipCategory(74), 'cargo');
  assert.equal(shipCategory(84), 'tanker');
  assert.equal(shipCategory(null), 'other');
  assert.equal(shipCategory(999), 'other');
});

test('inBbox', () => {
  const b = { latMin: 50, lonMin: -5, latMax: 55, lonMax: 5 };
  assert.equal(inBbox({ lat: 52, lon: 0 }, b), true);
  assert.equal(inBbox({ lat: 60, lon: 0 }, b), false);
  assert.equal(inBbox({ lat: 52, lon: 10 }, b), false);
});

test('resolveFeed maps the ported netlify rules', () => {
  assert.equal(resolveFeed('/feeds/celestrak/starlink', ''), 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle');
  assert.equal(resolveFeed('/feeds/nhc/storms', ''), 'https://www.nhc.noaa.gov/CurrentStorms.json');
  assert.equal(resolveFeed('/feeds/gpsjam/2026-07-21-h3_4.csv', ''), 'https://gpsjam.org/data/2026-07-21-h3_4.csv');
  assert.equal(resolveFeed('/feeds/metar', '?format=json&bbox=35,-30,72,45'), 'https://aviationweather.gov/api/data/metar?format=json&bbox=35,-30,72,45');
  assert.equal(resolveFeed('/feeds/nope', ''), null);
});
