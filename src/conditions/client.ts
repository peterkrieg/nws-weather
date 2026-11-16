// Main-thread side of trail conditions: collects the trails drawn on the Outdoors map, asks the
// worker to assess them, and draws the result as a soft glow along muddy / snowy stretches.

import type { GeoJSONSource, LayerSpecification, Map as MlMap } from 'maplibre-gl';
import type { Weather } from './model';
import type { RunReply, RunRequest, Stretch, TrailIn } from './worker';

export const COND_SOURCE = 'trail-cond';

export const COND_COLORS = {
  muddy: '#8a4b14',
  damp: '#d9a21b',
  frozen: '#4dabf7',
  snow: '#a5d8ff',
} as const;

/** Map layers for the glow, drawn under the trail lines themselves. */
export function conditionLayers(): LayerSpecification[] {
  const color = ['match', ['get', 'state'], ...Object.entries(COND_COLORS).flat(), '#000'];
  const width = ['interpolate', ['linear'], ['zoom'], 12, 6, 14, 10, 16, 16, 19, 26];
  return [
    {
      id: 'cond-glow',
      type: 'line',
      source: COND_SOURCE,
      minzoom: 12,
      filter: ['in', ['get', 'state'], ['literal', ['muddy', 'damp', 'frozen', 'snow']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': color,
        'line-width': width,
        'line-opacity': ['match', ['get', 'state'], 'damp', 0.35, 0.55],
        'line-blur': 2,
      },
    },
    // Invisible and wide, every assessed stretch: tapping any trail shows its condition.
    {
      id: 'cond-hit',
      type: 'line',
      source: COND_SOURCE,
      minzoom: 12,
      paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 },
    },
  ] as LayerSpecification[];
}

export interface Status {
  state: 'off' | 'zoom' | 'loading' | 'ready' | 'error' | 'unsupported';
  at?: number; // unix seconds the assessment is for
  muddyM?: number;
  message?: string;
  /** Diagnostics: trail samples assessed and worker time (ms), split into data loading and maths. */
  samples?: number;
  ms?: number;
  loadMs?: number;
}

const MIN_ZOOM = 12.9; // MapLibre zoom (Leaflet's is one higher): trails show from Leaflet 14
const MAX_TRAIL_KM = 80; // beyond this, ask to zoom in

type Box = { west: number; south: number; east: number; north: number };

/** The parts of a line inside the box, as separate runs. */
function clip(coords: [number, number][], b: Box): [number, number][][] {
  const inBox = (c: [number, number]) => c[0] >= b.west && c[0] <= b.east && c[1] >= b.south && c[1] <= b.north;
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  coords.forEach((c, i) => {
    // Keep a point if it, or a neighbour, is inside, so lines cross the edge rather than stop short.
    if (inBox(c) || (i > 0 && inBox(coords[i - 1])) || (i < coords.length - 1 && inBox(coords[i + 1]))) run.push(c);
    else if (run.length) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  });
  if (run.length > 1) runs.push(run);
  return runs;
}

/** One TrailIn per drawn trail line in view (paths and tracks, not sidewalks or paved paths). */
function collectTrails(map: MlMap, box: Box): TrailIn[] {
  const feats = map.querySourceFeatures('openmaptiles', {
    sourceLayer: 'transportation',
    filter: [
      'all',
      ['match', ['get', 'class'], ['path', 'track'], true, false],
      ['!', ['match', ['get', 'subclass'], ['footway', 'pedestrian', 'steps', 'sidewalk', 'crossing', 'platform'], true, false]],
      ['!=', ['get', 'surface'], 'paved'],
    ] as never,
  });
  const out: TrailIn[] = [];
  for (const f of feats) {
    const g = f.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    const props = f.properties as Record<string, unknown>;
    for (const c of lines)
      for (const run of clip(c as [number, number][], box))
        out.push({ coords: run, surface: props.surface as string | undefined, name: props.name as string | undefined });
  }
  return out;
}

function lengthKm(trails: TrailIn[]) {
  let m = 0;
  for (const t of trails)
    for (let i = 1; i < t.coords.length; i++) {
      const [a, b] = [t.coords[i - 1], t.coords[i]];
      m += Math.hypot((b[0] - a[0]) * 84000, (b[1] - a[1]) * 111000);
    }
  return m / 1000;
}

export class TrailConditions {
  private worker: Worker | null = null;
  private enabled = false;
  private runId = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stretches: Stretch[] = [];
  private wxCache = new Map<string, { at: number; wx: Weather & { now: number } }>();

  constructor(
    private map: MlMap,
    private onStatus: (s: Status) => void,
  ) {
    map.on('moveend', this.schedule);
    map.on('sourcedata', this.onSourceData);
  }

  private onSourceData = (e: { sourceId?: string; isSourceLoaded?: boolean }) => {
    // New trail tiles arrived: re-run once they've settled.
    if (e.sourceId === 'openmaptiles' && e.isSourceLoaded && this.enabled) this.schedule();
  };

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) {
      this.clear();
      this.onStatus({ state: 'off' });
    } else this.schedule();
  }

  destroy() {
    this.map.off('moveend', this.schedule);
    this.map.off('sourcedata', this.onSourceData);
    this.worker?.terminate();
    this.worker = null;
  }

  private clear() {
    this.stretches = [];
    (this.map.getSource(COND_SOURCE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
  }

  private schedule = () => {
    if (!this.enabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), 500);
  };

  private async weather(lat: number, lon: number) {
    const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
    const hit = this.wxCache.get(key);
    if (hit && Date.now() - hit.at < 20 * 60e3) return hit.wx;
    const r = await fetch(`/api/trailwx?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`);
    if (!r.ok) throw new Error(`weather ${r.status}`);
    const wx = (await r.json()) as Weather & { now: number };
    this.wxCache.set(key, { at: Date.now(), wx });
    return wx;
  }

  private async run() {
    const map = this.map;
    if (!this.enabled || !map.isStyleLoaded()) return;
    if (map.getZoom() < MIN_ZOOM) {
      this.clear();
      this.onStatus({ state: 'zoom' });
      return;
    }
    const b = map.getBounds();
    // A little beyond the screen so trails don't change colour right at the edge while panning.
    const padX = (b.getEast() - b.getWest()) * 0.1;
    const padY = (b.getNorth() - b.getSouth()) * 0.1;
    const box = { west: b.getWest() - padX, south: b.getSouth() - padY, east: b.getEast() + padX, north: b.getNorth() + padY };
    const trails = collectTrails(map, box);
    if (!trails.length) {
      this.clear();
      this.onStatus({ state: 'ready', muddyM: 0, at: Math.floor(Date.now() / 1000) });
      return;
    }
    const km = lengthKm(trails);
    if (import.meta.env.DEV) console.log(`[conditions] ${trails.length} trail pieces, ${km.toFixed(1)} km`);
    if (km > MAX_TRAIL_KM) {
      this.onStatus({ state: 'zoom', message: 'Zoom in to see trail conditions' });
      return;
    }
    const id = ++this.runId;
    this.onStatus({ state: 'loading' });
    const c = b.getCenter();
    try {
      const wx = await this.weather(c.lat, c.lng);
      const target = Math.floor(Date.now() / 1000);
      if (target > wx.t[wx.t.length - 1]) throw new Error('weather too old');
      this.worker ??= new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const req: RunRequest = { id, trails, wx, target, box };
      const reply = await new Promise<RunReply>((resolve) => {
        const w = this.worker!;
        const onMsg = (e: MessageEvent<RunReply>) => {
          if (e.data.id !== id) return;
          w.removeEventListener('message', onMsg);
          resolve(e.data);
        };
        w.addEventListener('message', onMsg);
        w.postMessage(req);
      });
      if (id !== this.runId || !this.enabled) return; // superseded
      if (!reply.ok) throw new Error(reply.error);
      if (!reply.samples) {
        this.clear();
        this.onStatus({ state: 'unsupported', message: 'Trail conditions need US elevation data' });
        return;
      }
      this.stretches = reply.stretches;
      (map.getSource(COND_SOURCE) as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: reply.stretches.map((s, i) => ({ type: 'Feature', id: i, properties: { state: s.state, i }, geometry: { type: 'LineString', coordinates: s.coords } })),
      });
      const muddyM = reply.stretches.filter((s) => s.state === 'muddy').reduce((a, s) => a + s.lengthM, 0);
      this.onStatus({ state: 'ready', at: target, muddyM, samples: reply.samples, ms: reply.ms, loadMs: reply.loadMs });
      if (import.meta.env.DEV) console.log(`[conditions] ${reply.samples} samples, ${reply.stretches.length} stretches in ${reply.ms} ms`);
    } catch (err) {
      if (id !== this.runId) return;
      this.onStatus({ state: 'error', message: String(err) });
    }
  }

  /** The assessed stretch nearest a screen point (within a few pixels), for the details popup. */
  stretchAt(lng: number, lat: number): Stretch | null {
    if (!this.enabled || !this.stretches.length) return null;
    const p = this.map.project([lng, lat]);
    const hits = this.map.queryRenderedFeatures(
      [
        [p.x - 10, p.y - 10],
        [p.x + 10, p.y + 10],
      ],
      { layers: ['cond-glow', 'cond-hit'] },
    );
    const i = hits.length ? (hits[0].properties as { i: number }).i : -1;
    return i >= 0 ? (this.stretches[i] ?? null) : null;
  }
}
