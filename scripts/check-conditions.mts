// Ground-truth check for the trail conditions model (src/conditions/model.ts).
// Each case is a real observation; the model must reproduce it from that day's weather.
//
//   npx tsx scripts/check-conditions.mts            (uses the live site's cached terrain/soil APIs)
//   SITE=http://localhost:8787 npx tsx scripts/check-conditions.mts
//
// Add a case for every confirmed observation (see memory: trail-conditions-ground-truth).

import { readFileSync } from 'node:fs';
import { COARSE_Z, Dem, FINE_Z, pointTerrain } from '../src/conditions/terrain.ts';
import { SoilMap } from '../src/conditions/landcover.ts';
import { simulate, type State } from '../src/conditions/model.ts';

const SITE = process.env.SITE ?? 'https://weather.peterkrieg.com';

interface Case {
  name: string;
  observed: string;
  /** Midpoint of the nearest mapped trail segment and its bearing (degrees), as the app samples it. */
  lat: number;
  lon: number;
  bearing: number;
  canopy: number;
  cover: number; // national land cover class at the spot
  at: string; // local time of the observation (ISO with offset)
  weather: string; // fixture file
  expect: State[];
}

const CASES: Case[] = [
  {
    name: 'City Creek Pipeline Trail, north-facing hollow',
    observed: 'muddy (ran it 2026-11-15 1 pm)',
    lat: 40.80289, lon: -111.85847, bearing: -120, canopy: 0.56, cover: 41,
    at: '2026-11-15T13:00:00-07:00', weather: 'trailwx-2026-11-15-slc.json', expect: ['muddy'],
  },
  {
    name: 'City Creek Pipeline Trail, upper rib',
    observed: 'slightly damp, not muddy (2026-11-15 1 pm)',
    lat: 40.80094, lon: -111.85764, bearing: 151, canopy: 0.18, cover: 52,
    at: '2026-11-15T13:00:00-07:00', weather: 'trailwx-2026-11-15-slc.json', expect: ['damp', 'tacky'],
  },
];

const dem = new Dem(async (x, y, z) => {
  const r = await fetch(`${SITE}/api/dem2/${z}/${x}/${y}`);
  if (!r.ok) throw new Error(`dem ${r.status}`);
  return r.arrayBuffer();
});
const soil = new SoilMap(SITE);
let failed = 0;
for (const c of CASES) {
  const box = { west: c.lon - 0.002, south: c.lat - 0.002, east: c.lon + 0.002, north: c.lat + 0.002 };
  await Promise.all([dem.load(box, FINE_Z, 400), dem.load(box, COARSE_Z, 4200), soil.load(box)]);
  const wx = JSON.parse(readFileSync(new URL(`./fixtures/${c.weather}`, import.meta.url), 'utf8'));
  const terrain = pointTerrain(dem, c.lat, c.lon, (c.bearing * Math.PI) / 180);
  if (!terrain) throw new Error(`no terrain for ${c.name}`);
  const r = simulate({ terrain, soil: soil.at(c.lat, c.lon), canopy: c.canopy, cover: c.cover, surface: 'ground' }, wx, Date.parse(c.at) / 1000);
  const ok = c.expect.includes(r.state);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}: model ${r.state} (wetness ${r.wet.toFixed(2)}), observed ${c.observed}`);
}
process.exit(failed ? 1 : 0);
