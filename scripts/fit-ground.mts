// Fit the ground heat constants (GROUND in src/conditions/model.ts) to SNOTEL / SCAN 2" soil
// temperatures near a spot. Each station is left out of the station corrections when it's the
// one being checked, so the fit can't just copy its own readings.
//   npx tsx scripts/fit-ground.mts [lat] [lon]        (defaults: Salt Lake foothills)
import { COARSE_Z, Dem, FINE_Z, pointTerrain } from '../src/conditions/terrain.ts';
import { GROUND, simulate } from '../src/conditions/model.ts';
import { applyStations, type Ground } from '../src/conditions/stations.ts';

const SITE = process.env.SITE ?? 'https://weather.peterkrieg.com';
const lat = Number(process.argv[2] ?? 40.8);
const lon = Number(process.argv[3] ?? -111.86);
const g = (await (await fetch(`${SITE}/api/ground?lat=${lat}&lon=${lon}`)).json()) as Ground;
const dem = new Dem(async (x, y, z) => {
  const r = await fetch(`${SITE}/api/dem2/${z}/${x}/${y}`);
  if (!r.ok) throw new Error('dem');
  return r.arrayBuffer();
});
const sites = [];
for (const st of g.stations.filter((s) => s.soil2)) {
  const box = { west: st.lon - 0.005, east: st.lon + 0.005, south: st.lat - 0.005, north: st.lat + 0.005 };
  await Promise.all([dem.load(box, FINE_Z, 400), dem.load(box, COARSE_Z, 4200)]);
  const terrain = pointTerrain(dem, st.lat, st.lon, 0);
  if (!terrain) continue;
  // SNOTEL sensors sit in open, level clearings; station coordinates are rounded, so use flat ground.
  terrain.slope = 0;
  const raw = await (await fetch(`${SITE}/api/trailwx?lat=${st.lat}&lon=${st.lon}`)).json();
  const wx = applyStations(raw, { ...g, stations: g.stations.filter((s) => s.id !== st.id) });
  sites.push({ st, terrain, wx, raw });
}

function score() {
  let err = 0;
  let n = 0;
  for (const { st, terrain, wx, raw } of sites) {
    for (let k = 6; k < g.t.length; k += 2) {
      const tt = g.t[k];
      const obs = st.soil2![k];
      if (obs == null || tt < raw.t[0] + 6 * 3600 || tt > Date.now() / 1000) continue;
      const r = simulate({ terrain, soil: null, canopy: 0.1, surface: 'ground' }, wx, tt);
      err += Math.abs(r.why.ground - obs);
      n++;
    }
  }
  return { mae: err / n, n };
}

const base = { ...GROUND };
if (process.env.TRY) {
  for (const combo of process.env.TRY.split(';')) {
    Object.assign(GROUND, base, JSON.parse(combo));
    console.log(combo, 'MAE', score().mae.toFixed(2));
  }
  process.exit(0);
}
console.log(`${sites.length} stations; current constants: MAE ${score().mae.toFixed(2)} °C`);
let best = { mae: Infinity, p: base };
for (const k1 of [0.01, 0.02, 0.04, 0.07, 0.1, 0.15])
  for (const sun of [0.002, 0.004, 0.008, 0.012])
    for (const kSnow of [0.005, 0.015, 0.03])
      for (const couple of [0.01, 0.03, 0.06]) {
        Object.assign(GROUND, base, { k1, sun, kSnow, couple });
        const { mae } = score();
        if (mae < best.mae) best = { mae, p: { ...GROUND } };
      }
Object.assign(GROUND, best.p);
console.log(`best: MAE ${best.mae.toFixed(2)} °C`, best.p);
