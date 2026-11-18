/// <reference lib="webworker" />
// Trail conditions, off the main thread: samples every trail in view every 5 m, works out terrain,
// soil and tree cover for each sample (kept between runs), runs the wetness model, and returns
// stretches of trail grouped by condition.

import { distM } from './geo';
import { CanopyMap, SoilMap } from './landcover';
import { simulate, type Result, type State, type Weather } from './model';
import { COARSE_Z, Dem, FINE_Z, pointTerrain, type PointTerrain } from './terrain';
import { SnowSeen } from './snowSeen';

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
  /** Wait for the satellite snow look (the second pass); otherwise reply without it if it's slow. */
  waitSatellite?: boolean;
}

/** Start downloading terrain, soil, cover and satellite data for a view while the weather loads. */
export interface PrefetchRequest {
  kind: 'prefetch';
  trails: TrailIn[];
  box: RunRequest['box'];
}

export interface Stretch {
  coords: [number, number][];
  state: State;
  name?: string;
  surface?: string;
  /** Result for the wettest sample in the stretch, for the details popup. */
  worst: Result;
  lengthM: number;
}

/** Model inputs and result at one trail point and time: saved with each condition report. */
export interface ProbeRequest {
  kind: 'probe';
  id: number;
  lat: number;
  lon: number;
  dir: number;
  surface?: string;
  wx: Weather;
  target: number;
}
export interface ProbeInputs {
  terrain: Omit<PointTerrain, 'horizon'> & { horizon: number[] };
  soil: ReturnType<SoilMap['at']>;
  canopy: number | null;
  surface?: string;
}
export type ProbeReply = { id: number; ok: true; inputs: ProbeInputs; result: Result } | { id: number; ok: false; error: string };

export type RunReply =
  | { id: number; ok: true; stretches: Stretch[]; samples: number; missing: number; ms: number; loadMs: number; parts?: Record<string, number>; partial?: boolean }
  | { id: number; ok: false; error: string };

const STEP = 5; // metres between samples

const dem = new Dem(async (x, y, z) => {
  const r = await fetch(`/api/dem2/${z}/${x}/${y}`);
  if (!r.ok) throw new Error(`dem ${r.status}`);
  return r.arrayBuffer();
});
const soil = new SoilMap();
const snowSeen = new SnowSeen();
const decodePng = async (buf: ArrayBuffer) => {
  const bmp = await createImageBitmap(new Blob([buf]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const img = g.getImageData(0, 0, bmp.width, bmp.height);
  return { data: img.data, width: img.width, height: img.height };
};
const canopy = new CanopyMap(decodePng);
const landCover = new CanopyMap(decodePng, 'nlcd');

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

// Draw order (worst on top): what most changes the decision to go.
const RANK: Record<State, number> = { dry: 0, tacky: 1, frozen: 2, damp: 3, packed_snow: 4, soft_snow: 5, muddy: 6, icy: 7 };

/** Downloads for a view: what the model needs (core) and the satellite look (s2), started once. */
interface Loads {
  key: string;
  t0: number;
  parts: Record<string, number>;
  /** Trail sample points the satellite look was asked for (grows as trail tiles arrive). */
  points: number;
  core: Promise<unknown>;
  s2: Promise<unknown>;
}
let loads: Loads | null = null;
const boxKey = (b: RunRequest['box']) => [b.west, b.south, b.east, b.north].map((v) => v.toFixed(5)).join(',');

function startLoads(box: RunRequest['box'], trails: TrailIn[]): Loads {
  const key = boxKey(box);
  const points = trails.flatMap((t) => sampleLine(t.coords));
  const centre = [(box.north + box.south) / 2, (box.east + box.west) / 2] as const;
  if (loads?.key === key) {
    // Same view, but more trail lines may have arrived since: look those up from the satellite too
    // (points already looked up are skipped).
    if (points.length !== loads.points) {
      loads.points = points.length;
      loads.s2 = Promise.all([loads.s2, snowSeen.load(centre[0], centre[1], points).catch(() => {})]);
    }
    return loads;
  }
  const t0 = performance.now();
  // How long each data source took (ms), for the status line's data-parts attribute.
  const parts: Record<string, number> = {};
  const timed = <T,>(name: string, p: Promise<T>) => p.finally(() => (parts[name] = Math.round(performance.now() - t0)));
  loads = {
    key,
    t0,
    parts,
    points: points.length,
    core: Promise.all([
      timed('dem', dem.load(box, FINE_Z, 400)),
      timed('dem2', dem.load(box, COARSE_Z, 4200)),
      timed('soil', soil.load(box)),
      timed('canopy', canopy.load(box)),
      timed('nlcd', landCover.load(box).catch(() => {})),
    ]),
    // Satellite snow is a refinement: never let it hold up or break a run.
    s2: timed('s2', snowSeen.load(centre[0], centre[1], points).catch(() => {})),
  };
  return loads;
}

async function run(req: RunRequest): Promise<RunReply> {
  const t0 = performance.now();
  const sampled = req.trails.map((t) => sampleLine(t.coords));
  const l = startLoads(req.box, req.trails);
  await l.core;
  // First pass: don't wait on a slow satellite read (the client asks again once it's in).
  let s2Done = true;
  if (req.waitSatellite) await l.s2;
  else s2Done = await Promise.race([l.s2.then(() => true), new Promise<boolean>((ok) => setTimeout(() => ok(false), 50))]);
  const loadMs = Math.round(performance.now() - Math.min(t0, l.t0));
  const parts = l.parts;

  const seen = new Set<string>(); // map tiles repeat lines along their edges: sample each spot once
  const stretches: Stretch[] = [];
  let count = 0;
  let missing = 0; // samples skipped because their elevation tile didn't load
  for (const [ti, trail] of req.trails.entries()) {
    const pts = sampled[ti];
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
      const res = simulate({ terrain, soil: soil.at(p.lat, p.lon), canopy: canopy.at(p.lat, p.lon), surface: trail.surface, cover: landCover.classAt(p.lat, p.lon), seen: snowSeen.at(p.lat, p.lon) }, req.wx, req.target);
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
        cur = { coords: prev ? [prev, here] : [here], state: res.state, name: trail.name, surface: trail.surface, worst: res, lengthM: STEP };
      }
      prev = here;
    }
    flush();
  }
  // Drop sub-5 m flickers of a milder state between two worse stretches? Keep everything: a single
  // muddy 5 m spot is exactly what this is for. Sort so the worst draws on top.
  stretches.sort((a, b) => RANK[a.state] - RANK[b.state]);
  if (missing && loads === l) loads = null; // some tiles failed: the retry downloads them again
  return { id: req.id, ok: true, stretches, samples: count, missing, ms: Math.round(performance.now() - Math.min(t0, l.t0)), loadMs, parts, partial: !s2Done };
}

async function probe(req: ProbeRequest): Promise<ProbeReply> {
  const pad = 0.002;
  const box = { west: req.lon - pad, east: req.lon + pad, south: req.lat - pad, north: req.lat + pad };
  await Promise.all([dem.load(box, FINE_Z, 400), dem.load(box, COARSE_Z, 4200), soil.load(box), canopy.load(box), landCover.load(box), snowSeen.load(req.lat, req.lon, [req])]).catch(() => {});
  const terrain = pointTerrain(dem, req.lat, req.lon, req.dir);
  if (!terrain) return { id: req.id, ok: false, error: 'no elevation data here' };
  const site = { terrain, soil: soil.at(req.lat, req.lon), canopy: canopy.at(req.lat, req.lon), surface: req.surface, cover: landCover.classAt(req.lat, req.lon), seen: snowSeen.at(req.lat, req.lon) };
  const result = simulate(site, req.wx, req.target);
  return { id: req.id, ok: true, result, inputs: { ...site, terrain: { ...terrain, horizon: [...terrain.horizon] } } };
}

self.onmessage = (e: MessageEvent<RunRequest | ProbeRequest | PrefetchRequest>) => {
  if ('kind' in e.data && e.data.kind === 'prefetch') {
    startLoads(e.data.box, e.data.trails);
    return;
  }
  if ('kind' in e.data && e.data.kind === 'probe') {
    const req = e.data;
    probe(req).then(
      (r) => self.postMessage(r),
      (err) => self.postMessage({ id: req.id, ok: false, error: String(err) } satisfies ProbeReply),
    );
    return;
  }
  const req = e.data as RunRequest;
  run(req).then(
    (r) => self.postMessage(r),
    (err) => self.postMessage({ id: req.id, ok: false, error: String(err) } satisfies RunReply),
  );
};
