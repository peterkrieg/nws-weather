// What Sentinel-2 last saw at each trail point: snow or bare ground, and when.
// Reads the scene classification layer (SCL, 20 m) straight from the public AWS bucket: one small
// header request per scene, then only the 512 px tiles under the trails in view. Pixels labelled
// cloud, cloud shadow, dark/shaded, saturated or no-data say nothing, so each point uses the most
// recent scene that saw the ground clearly (low winter sun leaves steep north slopes "dark" often).

export interface Scene {
  at: number;
  cloud: number;
  epsg: number;
  transform: number[];
  shape: [number, number];
  href: string;
}
export interface Seen {
  snow: boolean;
  at: number;
}

// SCL classes: 4 vegetation, 5 bare soil, 6 water, 7 unclassified, 11 snow/ice. Everything else
// (0 no data, 1 saturated, 2 dark/shaded, 3 cloud shadow, 8–10 cloud and cirrus) is no information.
const CLEAR = new Set([4, 5, 6, 7, 11]);
const SNOW = 11;

/** WGS84 lat/lon → UTM easting/northing (northern hemisphere) in the given zone. */
export function toUtm(lat: number, lon: number, zone: number): [number, number] {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const phi = (lat * Math.PI) / 180;
  const lam = (lon * Math.PI) / 180;
  const lam0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const N = a / Math.sqrt(1 - e2 * sin * sin);
  const T = Math.tan(phi) ** 2;
  const C = ep2 * cos * cos;
  const A = cos * (lam - lam0);
  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const x = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  const y = k0 * (M + N * Math.tan(phi) * (A ** 2 / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  return [x, y];
}

interface Header {
  tileW: number;
  tileH: number;
  across: number;
  offsets: number[];
  counts: number[];
  predictor: number;
}

async function range(url: string, start: number, end: number) {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!r.ok) throw new Error(`s2 ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** First image (full resolution) of a tiled TIFF: tile layout only. */
async function readHeader(url: string): Promise<Header> {
  const b = await range(url, 0, 65535);
  const dv = new DataView(b.buffer);
  const le = b[0] === 0x49;
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const ifd = u32(4);
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
  return { tileW, tileH: one(323), across: Math.ceil(width / tileW), offsets: arr(324), counts: arr(325), predictor: tags.has(317) ? one(317) : 1 };
}

async function inflate(data: Uint8Array) {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

class SceneReader {
  private header: Promise<Header> | null = null;
  private tiles = new Map<number, Promise<Uint8Array | null>>();
  constructor(readonly s: Scene) {}

  private head() {
    return (this.header ??= readHeader(this.s.href).catch((e) => {
      this.header = null;
      throw e;
    }));
  }

  /** Pixel row/col of a point, or null when outside the scene. */
  pixel(lat: number, lon: number): [number, number] | null {
    const [x, y] = toUtm(lat, lon, this.s.epsg % 100);
    const [res, , x0, , resY, y0] = this.s.transform;
    const col = Math.floor((x - x0) / res);
    const row = Math.floor((y - y0) / resY);
    return row >= 0 && col >= 0 && row < this.s.shape[0] && col < this.s.shape[1] ? [row, col] : null;
  }

  async tileFor(row: number, col: number) {
    const h = await this.head();
    const idx = Math.floor(row / h.tileH) * h.across + Math.floor(col / h.tileW);
    let t = this.tiles.get(idx);
    if (!t) {
      t = (async () => {
        const off = h.offsets[idx];
        const len = h.counts[idx];
        if (!len) return null;
        const px = await inflate(await range(this.s.href, off, off + len - 1));
        if (h.predictor === 2)
          for (let r = 0; r < h.tileH; r++) for (let c = 1; c < h.tileW; c++) px[r * h.tileW + c] = (px[r * h.tileW + c] + px[r * h.tileW + c - 1]) & 255;
        return px;
      })().catch(() => {
        this.tiles.delete(idx);
        return null;
      });
      this.tiles.set(idx, t);
    }
    return t;
  }

  async classAt(lat: number, lon: number): Promise<number | null> {
    const p = this.pixel(lat, lon);
    if (!p) return null;
    const h = await this.head();
    const tile = await this.tileFor(p[0], p[1]);
    if (!tile) return null;
    return tile[(p[0] % h.tileH) * h.tileW + (p[1] % h.tileW)];
  }
}

export class SnowSeen {
  private readers = new Map<string, SceneReader>();
  private scenes: Scene[] = [];
  private loadedFor = '';
  private seen = new Map<string, Seen | null>();

  /** Fetch the scene list for the area and the tiles under these points. */
  async load(lat: number, lon: number, points: { lat: number; lon: number }[]) {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (key !== this.loadedFor) {
      const r = await fetch(`/api/s2?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`);
      this.scenes = r.ok ? ((await r.json()) as Scene[]) : [];
      this.loadedFor = key;
    }
    const todo = points.filter((p) => !this.seen.has(this.key(p.lat, p.lon)));
    for (const p of todo) this.seen.set(this.key(p.lat, p.lon), null);
    // Newest scene first; each point stops at the first clear look.
    let left = todo;
    for (const s of this.scenes) {
      if (!left.length) break;
      const reader = this.readers.get(s.href) ?? new SceneReader(s);
      this.readers.set(s.href, reader);
      const next: typeof left = [];
      // Pull the tiles these points need in parallel first, then classify.
      await Promise.all(
        [...new Set(left.map((p) => reader.pixel(p.lat, p.lon)).filter((px): px is [number, number] => !!px).map(([r, c]) => `${(r / 512) | 0},${(c / 512) | 0}`))].map((k) => {
          const [tr, tc] = k.split(',').map(Number);
          return reader.tileFor(tr * 512, tc * 512).catch(() => null);
        }),
      ).catch(() => {});
      for (const p of left) {
        const cls = await reader.classAt(p.lat, p.lon).catch(() => null);
        if (cls != null && CLEAR.has(cls)) this.seen.set(this.key(p.lat, p.lon), { snow: cls === SNOW, at: s.at });
        else next.push(p);
      }
      left = next;
    }
  }

  private key(lat: number, lon: number) {
    // 20 m pixels: points closer than ~10 m share an answer.
    return `${Math.round(lat * 11000)},${Math.round(lon * 8500)}`; // ~10 m cells at 40°N
  }

  at(lat: number, lon: number): Seen | null {
    return this.seen.get(this.key(lat, lon)) ?? null;
  }
}
