/// <reference lib="webworker" />
// Trail conditions, off the main thread: samples every trail in view every 5 m, works out terrain,
// soil and tree cover for each sample (kept between runs), runs the wetness model, and returns
// stretches of trail grouped by condition.

import { distM } from './geo';
import { CanopyMap, SoilMap } from './landcover';
import { simulate, type Result, type State, type Weather } from './model';
import { COARSE_Z, Dem, FINE_Z, pointTerrain, type PointTerrain } from './terrain';

export interface TrailIn {
  coords: [number, number][]; // [lon, lat]
  surface?: string;
  name?: string;
}

export interface RunRequest {
  id: number;
  trails: TrailIn[];
  wx: Weather;
  target: number; // unix seconds
  box: { west: number; south: number; east: number; north: number };
}

export interface Stretch {
  coords: [number, number][];
  state: State;
  name?: string;
  /** Result for the wettest sample in the stretch, for the details popup. */
  worst: Result;
  lengthM: number;
}

export type RunReply =
  | { id: number; ok: true; stretches: Stretch[]; samples: number; missing: number; ms: number; loadMs: number }
  | { id: number; ok: false; error: string };

const STEP = 5; // metres between samples

const dem = new Dem(async (x, y, z) => {
  const r = await fetch(`/api/dem/${z}/${x}/${y}`);
  if (!r.ok) throw new Error(`dem ${r.status}`);
  return r.arrayBuffer();
});
const soil = new SoilMap();
const canopy = new CanopyMap(async (buf) => {
  const bmp = await createImageBitmap(new Blob([buf]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const img = g.getImageData(0, 0, bmp.width, bmp.height);
  return { data: img.data, width: img.width, height: img.height };
});

interface Sample {
  lon: number;
  lat: number;
  terrain: PointTerrain | null;
}
// Terrain per sample position (rounded to ~1 m), kept across runs: panning back costs nothing.
const terrainCache = new Map<string, PointTerrain | null>();

/** Points every STEP metres along a line, with the bearing there. */
function sampleLine(coords: [number, number][]) {
  const out: { lon: number; lat: number; dir: number }[] = [];
  let carry = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const len = distM(a, b);
    if (len === 0) continue;
    const kx = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
    const dir = Math.atan2((b[0] - a[0]) * kx, b[1] - a[1]);
    for (let d = carry; d < len; d += STEP) {
      const f = d / len;
      out.push({ lon: a[0] + (b[0] - a[0]) * f, lat: a[1] + (b[1] - a[1]) * f, dir });
    }
    carry = (carry - len) % STEP;
    if (carry < 0) carry += STEP;
  }
  const last = coords[coords.length - 1];
  out.push({ lon: last[0], lat: last[1], dir: out.length ? out[out.length - 1].dir : 0 });
  return out;
}

const RANK: Record<State, number> = { dry: 0, tacky: 1, damp: 2, muddy: 3, frozen: 4, snow: 5 };

async function run(req: RunRequest): Promise<RunReply> {
  const t0 = performance.now();
  await Promise.all([dem.load(req.box, FINE_Z, 400), dem.load(req.box, COARSE_Z, 4200), soil.load(req.box), canopy.load(req.box)]);
  const loadMs = Math.round(performance.now() - t0);

  const seen = new Set<string>(); // map tiles repeat lines along their edges: sample each spot once
  const stretches: Stretch[] = [];
  let count = 0;
  let missing = 0; // samples skipped because their elevation tile didn't load
  for (const trail of req.trails) {
    const pts = sampleLine(trail.coords);
    let cur: Stretch | null = null;
    let prev: [number, number] | null = null;
    const flush = () => {
      if (cur && cur.coords.length > 1) stretches.push(cur);
      cur = null;
    };
    for (const p of pts) {
      const key = `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
      const near = `${(p.lat * 30000) | 0},${(p.lon * 23000) | 0}`; // ~3.7 m cells
      if (seen.has(near)) {
        flush();
        prev = null;
        continue;
      }
      seen.add(near);
      let terrain = terrainCache.get(key);
      if (terrain === undefined) {
        terrain = pointTerrain(dem, p.lat, p.lon, p.dir);
        // Only remember "no terrain" when the elevation tile actually loaded; a tile that failed
        // to download should be tried again on the next run.
        if (terrain || dem.hasTile(p.lat, p.lon)) terrainCache.set(key, terrain);
        else missing++;
      }
      if (!terrain) {
        flush();
        prev = null;
        continue;
      }
      count++;
      const res = simulate({ terrain, soil: soil.at(p.lat, p.lon), canopy: canopy.at(p.lat, p.lon), surface: trail.surface }, req.wx, req.target);
      const here: [number, number] = [p.lon, p.lat];
      if (cur && (cur as Stretch).state === res.state) {
        const c = cur as Stretch;
        c.coords.push(here);
        c.lengthM += STEP;
        if (res.wet > c.worst.wet) c.worst = res;
      } else {
        // Start the new stretch where the last one ended so the line has no gaps.
        if (cur) (cur as Stretch).coords.push(here);
        flush();
        cur = { coords: prev ? [prev, here] : [here], state: res.state, name: trail.name, worst: res, lengthM: STEP };
      }
      prev = here;
    }
    flush();
  }
  // Drop sub-5 m flickers of a milder state between two worse stretches? Keep everything: a single
  // muddy 5 m spot is exactly what this is for. Sort so the worst draws on top.
  stretches.sort((a, b) => RANK[a.state] - RANK[b.state]);
  return { id: req.id, ok: true, stretches, samples: count, missing, ms: Math.round(performance.now() - t0), loadMs };
}

self.onmessage = (e: MessageEvent<RunRequest>) => {
  run(e.data).then(
    (r) => self.postMessage(r),
    (err) => self.postMessage({ id: e.data.id, ok: false, error: String(err) } satisfies RunReply),
  );
};
