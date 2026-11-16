// "Recent satellite" map style: the newest cloud-free Sentinel-2 picture of each spot.
//
// Each map tile is drawn in the browser from the raw Sentinel-2 red, green and blue bands (10 m,
// plus their 20–160 m overviews) read straight from the public AWS bucket. The ready-made
// true-colour file (TCI) clips everything brighter than bare ground, so snow comes out flat white;
// the raw bands go through Sentinel Hub's "optimized L2A" tone curve instead, which rolls off the
// highlights and keeps snow texture.
// The newest pass is drawn first; pixels its scene classification (SCL) calls cloud, cloud
// shadow or no-data are filled from the next-newest pass, and so on. The scene list comes from
// /api/s2?cell= (cached 3 h per 0.5° square).

import L from 'leaflet';
import { toUtm, type Scene as BaseScene } from './conditions/snowSeen';

type Scene = BaseScene & { tci: NonNullable<BaseScene['tci']>; bands: NonNullable<BaseScene['bands']>; bbox: number[] };

// SCL classes that say nothing about the ground: 0 no data, 3 cloud shadow, 8–9 cloud, 10 cirrus.
const HIDDEN = new Set([0, 3, 8, 9, 10]);
const CELL = 0.5;
/** Passes tried per map tile before giving up on clouded pixels. */
const MAX_SCENES = 10;
export const MIN_ZOOM = 8;

// ---- Cloud-optimised GeoTIFF reading ------------------------------------------------------------

interface Ifd {
  width: number;
  tileW: number;
  tileH: number;
  across: number;
  offsets: number[];
  counts: number[];
  spp: number;
  bits: number;
  predictor: number;
}

async function range(url: string, start: number, end: number) {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!r.ok) throw new Error(`s2 ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Every image in the file (full size first, then the overviews). */
async function readIfds(url: string): Promise<Ifd[]> {
  let b = await range(url, 0, 65535);
  const out: Ifd[] = [];
  let dv = new DataView(b.buffer);
  const le = b[0] === 0x49;
  let ifd = dv.getUint32(4, le);
  while (ifd && out.length < 8) {
    if (ifd + 4096 > b.length) {
      // Headers normally sit in the first 64 KB; read further if not.
      b = await range(url, 0, ifd + 65535);
      dv = new DataView(b.buffer);
    }
    const u16 = (o: number) => dv.getUint16(o, le);
    const u32 = (o: number) => dv.getUint32(o, le);
    const n = u16(ifd);
    const tags = new Map<number, { type: number; count: number; at: number }>();
    for (let i = 0; i < n; i++) {
      const o = ifd + 2 + i * 12;
      tags.set(u16(o), { type: u16(o + 2), count: u32(o + 4), at: o + 8 });
    }
    const one = (tag: number) => {
      const t = tags.get(tag)!;
      return t.type === 3 ? u16(t.at) : u32(t.at);
    };
    const arr = (tag: number) => {
      const t = tags.get(tag)!;
      const size = t.type === 3 ? 2 : 4;
      const base = t.count * size <= 4 ? t.at : u32(t.at);
      return Array.from({ length: t.count }, (_, i) => (size === 2 ? u16(base + i * 2) : u32(base + i * 4)));
    };
    const width = one(256);
    const tileW = one(322);
    out.push({
      width,
      tileW,
      tileH: one(323),
      across: Math.ceil(width / tileW),
      offsets: arr(324),
      counts: arr(325),
      spp: tags.has(277) ? one(277) : 1,
      bits: tags.has(258) ? (tags.get(258)!.count === 1 ? one(258) : arr(258)[0]) : 8,
      predictor: tags.has(317) ? one(317) : 1,
    });
    ifd = u32(ifd + 2 + n * 12);
  }
  return out;
}

async function inflate(data: Uint8Array) {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Decoded tiles, newest use last; kept under a memory budget (full-size colour tiles are 3 MB). */
type Px = Uint8Array | Uint16Array;
const decoded = new Map<string, Promise<Px | null>>();
const sizes = new Map<string, number>();
let held = 0;
const BUDGET = 120e6;
function remember(key: string, size: number) {
  sizes.set(key, size);
  held += size;
  for (const k of decoded.keys()) {
    if (held <= BUDGET) break;
    if (k === key) continue;
    decoded.delete(k);
    held -= sizes.get(k) ?? 0;
    sizes.delete(k);
  }
}

const headers = new Map<string, Promise<Ifd[]>>();
function ifds(url: string) {
  let h = headers.get(url);
  if (!h) {
    h = readIfds(url).catch((e) => {
      headers.delete(url);
      throw e;
    });
    headers.set(url, h);
  }
  return h;
}

function tile(url: string, level: Ifd, lv: number, idx: number): Promise<Px | null> {
  const key = `${url}|${lv}|${idx}`;
  const hit = decoded.get(key);
  if (hit) {
    decoded.delete(key); // move to the newest end
    decoded.set(key, hit);
    return hit;
  }
  const p = (async () => {
    const off = level.offsets[idx];
    const len = level.counts[idx];
    if (!len) return null;
    const raw = await inflate(await range(url, off, off + len - 1));
    // 16-bit samples are little-endian in these files, like every browser's memory.
    const px: Px = level.bits === 16 ? new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1) : raw;
    if (level.predictor === 2) {
      const { tileW, tileH, spp } = level;
      const row = tileW * spp;
      const mask = level.bits === 16 ? 0xffff : 0xff;
      for (let r = 0; r < tileH; r++) for (let i = r * row + spp, end = (r + 1) * row; i < end; i++) px[i] = (px[i] + px[i - spp]) & mask;
    }
    remember(key, px.byteLength);
    return px;
  })().catch(() => {
    decoded.delete(key);
    return null;
  });
  decoded.set(key, p);
  return p;
}

/** One image level of a scene file, ready to sample by UTM coordinate. */
class Raster {
  constructor(
    readonly url: string,
    readonly lv: number,
    readonly ifd: Ifd,
    readonly x0: number,
    readonly y0: number,
    readonly res: number,
  ) {}

  static async open(url: string, transform: number[], fullWidth: number, lv: number) {
    const all = await ifds(url);
    const i = Math.min(lv, all.length - 1);
    const ifd = all[i];
    return new Raster(url, i, ifd, transform[2], transform[5], transform[0] * (fullWidth / ifd.width));
  }

  index(x: number, y: number): [number, number] | null {
    const col = Math.floor((x - this.x0) / this.res);
    const row = Math.floor((this.y0 - y) / this.res);
    const h = Math.ceil((this.ifd.offsets.length / this.ifd.across) * this.ifd.tileH);
    return col >= 0 && row >= 0 && col < this.ifd.width && row < h ? [row, col] : null;
  }

  tileIndex(row: number, col: number) {
    return Math.floor(row / this.ifd.tileH) * this.ifd.across + Math.floor(col / this.ifd.tileW);
  }

  load(idx: number) {
    return tile(this.url, this.ifd, this.lv, idx);
  }
}

// ---- Scene list -----------------------------------------------------------------------------------

const lists = new Map<string, Promise<Scene[]>>();
function cellScenes(lat: number, lon: number): Promise<Scene[]> {
  const key = `${lat},${lon}|${Math.floor(Date.now() / 3 / 3600e3)}`;
  let p = lists.get(key);
  if (!p) {
    p = fetch(`/api/s2?cell=${lat},${lon}`)
      .then((r) => (r.ok ? (r.json() as Promise<BaseScene[]>) : []))
      .then((all) => all.filter((s): s is Scene => !!s.tci && !!s.bands && !!s.bbox))
      .catch(() => {
        lists.delete(key);
        return [];
      });
    lists.set(key, p);
  }
  return p;
}

/** Scenes over a lon/lat box, newest first (scenes from several 0.5° squares, without repeats). */
export async function scenesIn(south: number, west: number, north: number, east: number): Promise<Scene[]> {
  const cells: Promise<Scene[]>[] = [];
  for (let la = Math.floor(south / CELL) * CELL; la < north; la += CELL)
    for (let lo = Math.floor(west / CELL) * CELL; lo < east; lo += CELL) cells.push(cellScenes(+la.toFixed(2), +lo.toFixed(2)));
  const seen = new Set<string>();
  return (await Promise.all(cells))
    .flat()
    .filter((s) => !seen.has(s.tci.href) && seen.add(s.tci.href) && s.bbox[0] < east && s.bbox[2] > west && s.bbox[1] < north && s.bbox[3] > south)
    .sort((a, b) => b.at - a.at);
}

/** Local calendar day of a pass, as a sortable key. */
export const dayKey = (at: number) => {
  const d = new Date(at * 1000);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};

// ---- The map layer ------------------------------------------------------------------------------

export interface SatStatus {
  loading: boolean;
  /** Pass days over the view, newest first. */
  days: number[];
  /** Shown day: newest passes up to and including this one are used. */
  until: number | null;
  /** Days actually drawn in view (the newest first), when cloud gaps were filled from older passes. */
  used: number[];
  tooFar: boolean;
}

type TileKey = string;
export type SatLayer = L.GridLayer & {
  setUntil(day: number | null): void;
  onStatus: (s: SatStatus) => void;
};

export const SentinelLayer = L.GridLayer.extend({
  initialize(this: SatLayer & { _until: number | null; _used: Map<TileKey, number[]>; _pending: number; _days: number[] }, attribution: string, onStatus: (s: SatStatus) => void) {
    L.setOptions(this, { attribution, tileSize: 256, minZoom: 0, maxZoom: 18, updateWhenIdle: true, keepBuffer: 1 });
    this.onStatus = onStatus;
    this._until = null;
    this._used = new Map();
    this._pending = 0;
    this._days = [];
  },

  onAdd(this: L.GridLayer & { _refresh(): void }, map: L.Map) {
    (L.GridLayer.prototype as unknown as { onAdd(m: L.Map): void }).onAdd.call(this, map);
    map.on('moveend', this._refresh, this);
    this._refresh();
    return this;
  },

  onRemove(this: L.GridLayer & { _refresh(): void }, map: L.Map) {
    map.off('moveend', this._refresh, this);
    (L.GridLayer.prototype as unknown as { onRemove(m: L.Map): void }).onRemove.call(this, map);
    return this;
  },

  setUntil(this: SatLayer & { _until: number | null; _used: Map<TileKey, number[]>; _emit(): void }, day: number | null) {
    if (day === this._until) return;
    this._until = day;
    this._used.clear();
    this.redraw();
    this._emit();
  },

  /** Pass days over the view, for the date chip. */
  _refresh(this: SatLayer & { _days: number[]; _emit(): void; _map: L.Map }) {
    const map = this._map;
    if (!map) return;
    if (map.getZoom() < MIN_ZOOM) {
      this._days = [];
      this._emit();
      return;
    }
    const b = map.getBounds();
    void scenesIn(b.getSouth(), b.getWest(), b.getNorth(), b.getEast()).then((list) => {
      if (this._map !== map) return;
      this._days = [...new Set(list.map((s) => dayKey(s.at)))];
      this._emit();
    });
  },

  _emit(this: SatLayer & { _until: number | null; _used: Map<TileKey, number[]>; _pending: number; _days: number[]; _map: L.Map; _tiles: Record<string, { coords: L.Coords }> }) {
    if (!this._map) return;
    const z = this._map.getZoom();
    const inView = new Map<number, number>();
    for (const [k, days] of this._used) {
      if (!this._tiles[k]) continue;
      for (const d of days) inView.set(d, (inView.get(d) ?? 0) + 1);
    }
    this.onStatus({
      loading: this._pending > 0,
      days: this._days,
      until: this._until,
      used: [...inView.keys()].sort((a, b) => b - a),
      tooFar: z < MIN_ZOOM,
    });
  },

  createTile(this: SatLayer & { _until: number | null; _used: Map<TileKey, number[]>; _pending: number; _emit(): void; _tileCoordsToKey(c: L.Coords): string; _map: L.Map }, coords: L.Coords, done: L.DoneCallback) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256; // drawTile sizes it for the screen
    if (coords.z < MIN_ZOOM) {
      queueMicrotask(() => done(undefined, canvas));
      return canvas;
    }
    const key = this._tileCoordsToKey(coords);
    const until = this._until;
    this._pending++;
    this._emit();
    drawTile(canvas, coords, until)
      .then((days) => {
        if (this._until === until) this._used.set(key, days);
        done(undefined, canvas);
      })
      .catch((e) => done(e as Error, canvas))
      .finally(() => {
        this._pending--;
        this._emit();
      });
    return canvas;
  },
}) as unknown as new (attribution: string, onStatus: (s: SatStatus) => void) => SatLayer;

const tile2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tile2lat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};

// ---- Tone curve (after Sentinel Hub's "optimized L2A" true colour) ---------------------------------
// Reflectance → display: a highlight roll-off (0.18 at mid-grey, 1.5 at white), a 2.2 gamma, a
// small black point, 1.2× saturation, then sRGB. Their defaults (0.13 / 3.0 / 1.8) wash out trees
// and shaded snow; these keep conifers near-black and shadows blue-grey (closer to CalTopo), with
// sunlit snow around 235–248 and its texture intact instead of clipping as the TCI file does.
// Roughly: tree 0.04 → 35, bare ground 0.08–0.12 → 75–105, shaded snow 0.25 → 165, snow 0.9 → 247.
const MAX_R = 1.5;
const MID_R = 0.18;
const BLACK = 0.01;
const SAT = 1.2;
const GAMMA = 2.2;
const G_OFF = 0.01;
const G_OFF_POW = G_OFF ** GAMMA;
const G_OFF_RANGE = (1 + G_OFF) ** GAMMA - G_OFF_POW;
function sAdj(a: number) {
  const ar = Math.min(1, Math.max(0, a / MAX_R));
  const tx = MID_R / MAX_R;
  const v = ar === 0 ? 0 : (ar * (ar * tx - 1)) / (ar * (2 * tx - 1) - tx); // ty = 1
  return ((v + G_OFF) ** GAMMA - G_OFF_POW) / G_OFF_RANGE;
}
const toneLuts = new Map<string, Float32Array>();
/** Raw band value (0–20000) → tone-curved 0–1, for one scale/offset. */
function toneLut(scale: number, offset: number) {
  const k = `${scale}|${offset}`;
  let lut = toneLuts.get(k);
  if (!lut) {
    lut = new Float32Array(20001);
    for (let dn = 0; dn <= 20000; dn++) lut[dn] = sAdj(Math.max(0, dn * scale + offset - BLACK));
    toneLuts.set(k, lut);
  }
  return lut;
}
const SRGB = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) {
  const c = i / 4096;
  SRGB[i] = Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
}
const srgb = (v: number) => SRGB[Math.min(4096, Math.max(0, Math.round(v * 4096)))];

const G = 16; // UTM is worked out exactly on a 17×17 grid and interpolated in between
/** Canvas pixels per CSS pixel: sharp on phone screens without 9× the work at 3×. */
const DPR = typeof window === 'undefined' ? 1 : Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));

/** Draws one map tile; returns the pass days it used. */
async function drawTile(canvas: HTMLCanvasElement, c: L.Coords, until: number | null): Promise<number[]> {
  const S = 256 * DPR;
  canvas.width = canvas.height = S;
  const west = tile2lon(c.x, c.z);
  const east = tile2lon(c.x + 1, c.z);
  const north = tile2lat(c.y, c.z);
  const south = tile2lat(c.y + 1, c.z);
  const all = await scenesIn(south, west, north, east);
  const scenes = all.filter((s) => until == null || dayKey(s.at) <= until);
  const N = S * S;
  const out = new Uint8ClampedArray(N * 4);
  const left = new Uint8Array(N).fill(1); // 1 = still needs a clear pixel
  let remaining = N;
  const fallback = new Uint8Array(N); // 1 = a cloudy pixel was drawn as a stand-in
  const used = new Set<number>();
  // Picture level for this zoom: the coarsest whose pixels are no bigger than the device's pixels.
  const metres = (40075016.686 * Math.cos((((north + south) / 2) * Math.PI) / 180)) / (S * 2 ** c.z);
  const lv = Math.max(0, Math.min(4, Math.floor(Math.log2(metres / 10))));
  // Zoomed in past 10 m pixels: blend neighbours instead of drawing blocks.
  const smooth = metres < 7;
  const grids = new Map<number, Float64Array>();
  const utmGrid = (zone: number) => {
    let g = grids.get(zone);
    if (!g) {
      g = new Float64Array((G + 1) * (G + 1) * 2);
      for (let j = 0; j <= G; j++)
        for (let i = 0; i <= G; i++) {
          const [x, y] = toUtm(tile2lat(c.y + j / G, c.z), tile2lon(c.x + i / G, c.z), zone);
          g[(j * (G + 1) + i) * 2] = x;
          g[(j * (G + 1) + i) * 2 + 1] = y;
        }
      grids.set(zone, g);
    }
    return g;
  };

  // Per pixel: colour tile index, fractional row/col inside it (for blending), classification index.
  const rTile = new Int32Array(N);
  const rRow = new Float32Array(N);
  const rCol = new Float32Array(N);
  const cIdx = new Int32Array(N);
  let tried = 0;
  for (const s of scenes) {
    if (!remaining || tried >= MAX_SCENES) break;
    if (s.bbox[0] > east || s.bbox[2] < west || s.bbox[1] > north || s.bbox[3] < south) continue;
    tried++;
    const g = utmGrid(s.epsg % 100);
    const { tci, bands } = s;
    const [rgb, gBand, bBand, cls] = await Promise.all([
      Raster.open(bands.r, tci.transform, tci.shape[1], lv),
      Raster.open(bands.g, tci.transform, tci.shape[1], lv),
      Raster.open(bands.b, tci.transform, tci.shape[1], lv),
      Raster.open(s.href, s.transform, s.shape[1], Math.max(0, lv - 1)),
    ]);
    const lut = toneLut(bands.scale, bands.offset);
    const { tileW, tileH } = rgb.ifd;
    rTile.fill(-1);
    const need = new Set<number>();
    const needCls = new Set<number>();
    for (let py = 0; py < S; py++) {
      const fy = (py + 0.5) / (S / G);
      const j = Math.min(G - 1, Math.floor(fy));
      const ty = fy - j;
      for (let px = 0; px < S; px++) {
        const p = py * S + px;
        if (!left[p]) continue;
        const fx = (px + 0.5) / (S / G);
        const i = Math.min(G - 1, Math.floor(fx));
        const tx = fx - i;
        const a = (j * (G + 1) + i) * 2;
        const b = a + 2;
        const d = a + (G + 1) * 2;
        const e = d + 2;
        const x = (g[a] * (1 - tx) + g[b] * tx) * (1 - ty) + (g[d] * (1 - tx) + g[e] * tx) * ty;
        const y = (g[a + 1] * (1 - tx) + g[b + 1] * tx) * (1 - ty) + (g[d + 1] * (1 - tx) + g[e + 1] * tx) * ty;
        const rc = rgb.index(x, y);
        const cc = cls.index(x, y);
        if (!rc || !cc) continue;
        const t = rgb.tileIndex(rc[0], rc[1]);
        rTile[p] = t;
        // Pixel centres sit at +0.5; blending reads the four around the exact position.
        rRow[p] = smooth ? (rgb.y0 - y) / rgb.res - 0.5 - Math.floor(rc[0] / tileH) * tileH : rc[0] % tileH;
        rCol[p] = smooth ? (x - rgb.x0) / rgb.res - 0.5 - Math.floor(rc[1] / tileW) * tileW : rc[1] % tileW;
        const ct = cls.tileIndex(cc[0], cc[1]);
        cIdx[p] = ct * 1048576 + (cc[0] % cls.ifd.tileH) * cls.ifd.tileW + (cc[1] % cls.ifd.tileW);
        need.add(t);
        needCls.add(ct);
      }
    }
    if (!need.size) continue;
    // Classification first (tiny); colour tiles only where that pass saw the ground.
    const clsTiles = new Map<number, Px | null>();
    await Promise.all([...needCls].map(async (t) => clsTiles.set(t, await cls.load(t))));
    const clear = new Uint8Array(N);
    const wanted = new Set<number>();
    for (let p = 0; p < N; p++) {
      if (rTile[p] < 0) continue;
      const ct = clsTiles.get(Math.floor(cIdx[p] / 1048576));
      const k = ct ? ct[cIdx[p] % 1048576] : 0;
      if (ct && !HIDDEN.has(k)) clear[p] = 1;
      // Cloudy pixels still get a colour tile when nothing has been drawn there yet (stand-in).
      if (clear[p] || (ct && k !== 0 && !fallback[p])) wanted.add(rTile[p]);
    }
    // The three bands share one grid, so one tile index serves all of them.
    const rgbTiles = new Map<number, [Px, Px, Px] | null>();
    await Promise.all(
      [...wanted].map(async (t) => {
        const [r, g2, b] = await Promise.all([rgb.load(t), gBand.load(t), bBand.load(t)]);
        rgbTiles.set(t, r && g2 && b ? [r, g2, b] : null);
      }),
    );
    let drew = false;
    for (let p = 0; p < N; p++) {
      if (rTile[p] < 0) continue;
      const tl = rgbTiles.get(rTile[p]);
      if (!tl) continue;
      const [tr, tg, tb] = tl;
      let dr: number;
      let dg: number;
      let db: number;
      if (smooth) {
        // Bilinear within the tile (clamped at its edges; seams every 10 km are invisible).
        const fr = Math.min(tileH - 1, Math.max(0, rRow[p]));
        const fc = Math.min(tileW - 1, Math.max(0, rCol[p]));
        const r0 = Math.floor(fr);
        const c0 = Math.floor(fc);
        const r1 = Math.min(tileH - 1, r0 + 1);
        const c1 = Math.min(tileW - 1, c0 + 1);
        const wy = fr - r0;
        const wx = fc - c0;
        const o00 = r0 * tileW + c0;
        const o01 = r0 * tileW + c1;
        const o10 = r1 * tileW + c0;
        const o11 = r1 * tileW + c1;
        // A no-data neighbour (0 at the swath edge) would darken the blend: use the nearest.
        if (!tr[o00] || !tr[o01] || !tr[o10] || !tr[o11]) {
          const o = Math.round(fr) * tileW + Math.round(fc);
          dr = tr[o];
          dg = tg[o];
          db = tb[o];
        } else {
          const mix = (t: Px) => (t[o00] * (1 - wx) + t[o01] * wx) * (1 - wy) + (t[o10] * (1 - wx) + t[o11] * wx) * wy;
          dr = mix(tr);
          dg = mix(tg);
          db = mix(tb);
        }
      } else {
        const o = rRow[p] * tileW + rCol[p];
        dr = tr[o];
        dg = tg[o];
        db = tb[o];
      }
      if (!dr || !dg || !db) continue; // outside the swath
      const vr = lut[Math.min(20000, dr | 0)];
      const vg = lut[Math.min(20000, dg | 0)];
      const vb = lut[Math.min(20000, db | 0)];
      const avg = ((vr + vg + vb) / 3) * (1 - SAT);
      const r = srgb(avg + vr * SAT);
      const gg = srgb(avg + vg * SAT);
      const bb = srgb(avg + vb * SAT);
      if (clear[p] || !fallback[p]) {
        out[p * 4] = r;
        out[p * 4 + 1] = gg;
        out[p * 4 + 2] = bb;
        out[p * 4 + 3] = 255;
        if (clear[p]) {
          left[p] = 0;
          remaining--;
          drew = true;
        } else fallback[p] = 1;
      }
    }
    if (drew) used.add(dayKey(s.at));
  }
  canvas.getContext('2d')!.putImageData(new ImageData(out, S, S), 0, 0);
  return [...used].sort((a, b) => b - a);
}
