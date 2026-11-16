// Replay the trail model at a point with live weather and print what it carried hour by hour.
//   npx tsx scripts/debug-point.mts 40.6284 -111.7260 [canopy] [cover]
import { COARSE_Z, Dem, FINE_Z, pointTerrain } from '../src/conditions/terrain.ts';
import { SoilMap } from '../src/conditions/landcover.ts';
import { simulate, type Weather } from '../src/conditions/model.ts';
import { applyStations, byHeight } from '../src/conditions/stations.ts';
import { SnowSeen } from '../src/conditions/snowSeen.ts';

const SITE = process.env.SITE ?? 'https://weather.peterkrieg.com';
const [lat, lon] = [Number(process.argv[2]), Number(process.argv[3])];
const canopy = Number(process.argv[4] ?? 0.5);
const cover = Number(process.argv[5] ?? 42);
const q = `lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`;
const get = async (p: string) => {
  const r = await fetch(`${SITE}${p}`);
  return r.ok ? r.json() : null;
};
const [raw, ground, snodas] = await Promise.all([get(`/api/trailwx?${q}`), get(`/api/ground?${q}`), get(`/api/snow?${q}`)]);
const wx = { ...applyStations(raw as Weather, ground), snodas } as Weather & { now: number };
const dem = new Dem(async (x, y, z) => (await fetch(`${SITE}/api/dem/${z}/${x}/${y}`)).arrayBuffer());
const soil = new SoilMap(SITE);
const box = { west: lon - 0.002, south: lat - 0.002, east: lon + 0.002, north: lat + 0.002 };
await Promise.all([dem.load(box, FINE_Z, 400), dem.load(box, COARSE_Z, 4200), soil.load(box)]);
const terrain = pointTerrain(dem, lat, lon, 0)!;
const g0 = globalThis.fetch;
globalThis.fetch = ((u: RequestInfo | URL, o?: RequestInit) => g0(typeof u === 'string' && u.startsWith('/') ? SITE + u : u, o)) as typeof fetch;
const snowSeen = new SnowSeen();
await snowSeen.load(lat, lon, [{ lat, lon }]);
const seen = snowSeen.at(lat, lon);
console.log('satellite:', seen ? `${seen.snow ? 'snow' : 'bare'} at ${new Date(seen.at * 1000).toISOString()}` : 'no clear look');
const site = { terrain, soil: soil.at(lat, lon), canopy, cover, surface: 'ground' as const, seen };
console.log(`elev ${Math.round(terrain.elev)} m (${Math.round(terrain.elev * 3.281)} ft); model grid elev ${Math.round(wx.elev)} m; soil ${site.soil?.name}`);
console.log('measured:', wx.measured, ' start snow cm @elev:', wx.start?.snowCm ? 'yes' : 'none');
const near = snodas?.cells?.map((c: { lat: number; lon: number; swe: number | null }) => ({ d: Math.hypot(c.lat - lat, c.lon - lon), swe: c.swe })).sort((a: { d: number }, b: { d: number }) => a.d - b.d)[0];
console.log('SNODAS nearest cell swe mm:', near?.swe, ' at', snodas?.at && new Date(snodas.at * 1000).toISOString());
const now = wx.now ?? Date.now() / 1000;
const LAPSE = 0.0065;
console.log('\nlocal time        tempModel  tempHere  precip(mm)  modelSnowDepth  -> state  swe  wet');
for (let i = 0; i < wx.t.length; i++) {
  const t = wx.t[i];
  if (t < now - 4 * 86400 || t > now + 3600) continue;
  const fix = wx.tempFix;
  let th = wx.temp[i] + (wx.elev - terrain.elev) * LAPSE;
  if (fix) th += byHeight(fix.e, fix.w, fix.r[i], terrain.elev) ?? 0;
  const p = (wx as unknown as { precip: number[] }).precip?.[i] ?? 0;
  if (i % 3 && p < 0.2) continue;
  const r = simulate(site, wx, t + 3600);
  const when = new Date(t * 1000).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric' });
  console.log(`${when.padEnd(16)}  ${wx.temp[i].toFixed(1).padStart(6)}  ${th.toFixed(1).padStart(8)}  ${p.toFixed(1).padStart(9)}  ${(wx.snowDepth[i] * 100).toFixed(0).padStart(10)} cm  -> ${r.state.padEnd(11)} ${r.swe.toFixed(0).padStart(3)}  ${r.wet.toFixed(2)}`);
}
