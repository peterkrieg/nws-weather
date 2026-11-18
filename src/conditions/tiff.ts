// Minimal reader for the single-band float32 GeoTIFFs USGS's 3DEP elevation service returns
// (tiled or stripped, uncompressed or deflate). Not a general TIFF reader.

export interface Raster {
  width: number;
  height: number;
  data: Float32Array;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readFloatTiff(buf: ArrayBuffer): Promise<Raster> {
  const dv = new DataView(buf);
  const le = dv.getUint16(0) === 0x4949;
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  if (u16(2) !== 42) throw new Error('not a TIFF');
  const ifd = u32(4);
  const n = u16(ifd);
  const tags = new Map<number, { type: number; count: number; at: number }>();
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    tags.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
  }
  const scalar = (tag: number) => {
    const t = tags.get(tag);
    if (!t) return undefined;
    return t.type === 3 ? u16(t.at) : u32(t.at);
  };
  const array = (tag: number): number[] => {
    const t = tags.get(tag);
    if (!t) return [];
    const size = t.type === 3 ? 2 : 4;
    const base = t.count * size > 4 ? u32(t.at) : t.at;
    return Array.from({ length: t.count }, (_, i) => (size === 2 ? u16(base + i * 2) : u32(base + i * 4)));
  };
  const width = scalar(256)!;
  const height = scalar(257)!;
  const compression = scalar(259) ?? 1;
  const bits = scalar(258) ?? 32;
  const format = scalar(339) ?? 3;
  if (bits !== 32 || format !== 3) throw new Error(`expected float32, got ${bits}-bit format ${format}`);
  const predictor = scalar(317) ?? 1;

  const tiled = tags.has(322);
  const tw = tiled ? scalar(322)! : width;
  const th = tiled ? scalar(323)! : scalar(278) ?? height;
  const offsets = array(tiled ? 324 : 273);
  const counts = array(tiled ? 325 : 279);
  const across = Math.ceil(width / tw);
  const data = new Float32Array(width * height);

  for (let k = 0; k < offsets.length; k++) {
    let chunk: Uint8Array<ArrayBuffer> = new Uint8Array(buf, offsets[k], counts[k]);
    if (compression === 8 || compression === 32946) chunk = await inflate(chunk);
    else if (compression !== 1) throw new Error(`unsupported TIFF compression ${compression}`);
    if (predictor === 3) chunk = unpredictFloat(chunk, tw, th);
    const cdv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const x0 = (k % across) * tw;
    const y0 = Math.floor(k / across) * th;
    for (let y = 0; y < th && y0 + y < height; y++) {
      for (let x = 0; x < tw && x0 + x < width; x++) {
        const o = (y * tw + x) * 4;
        if (o + 4 > chunk.byteLength) break;
        data[(y0 + y) * width + x0 + x] = cdv.getFloat32(o, le);
      }
    }
  }
  return { width, height, data };
}

/** TIFF floating point predictor (3): byte-planar, horizontally differenced. */
function unpredictFloat(bytes: Uint8Array, w: number, h: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    const r = bytes.subarray(y * row, (y + 1) * row);
    const acc = new Uint8Array(row);
    acc[0] = r[0];
    for (let i = 1; i < row; i++) acc[i] = (acc[i - 1] + r[i]) & 255;
    for (let x = 0; x < w; x++) for (let b = 0; b < 4; b++) out[y * row + x * 4 + (3 - b)] = acc[b * w + x];
  }
  return out;
}

// ---- Compact elevation tiles ----------------------------------------------------------------------
// USGS tiles are 256 KB of raw float32. /api/dem2 re-encodes them once at the edge: elevations to
// the nearest 10 cm, each row as its first value then neighbour-to-neighbour differences (small
// numbers, so gzip squeezes a tile to ~60 KB). Layout, little-endian:
//   "DM" 1 0 | width u16 | height u16 | per row: first i32, then (width−1) × i16 differences;
//   a difference of −32768 is followed by the value itself as an i32 (big jumps, no-data).
const NODATA_DM = -2147483648;
const NODATA = -3.4028234663852886e38;

// Version 2 (what /api/dem2 sends now, ~⅓ smaller): each value is predicted from its left, upper
// and upper-left neighbours (left + up − upper-left, a tilted plane, which terrain mostly is), and
// only the error is stored, zigzagged to u16 and split into a low-byte block then a high-byte block
// (gzip finds the mostly-zero high bytes easy). Layout, little-endian:
//   "DM" 2 0 | width u16 | height u16 | exceptions u32 | no-data u32 | low bytes | high bytes |
//   exceptions × (index u32, value i32) | no-data × index u32
// An error too big for u16 is stored as 0xFFFF plus an exception holding the value itself. No-data
// points are stored as their prediction and listed at the end.
const ESC = 0xffff;
const zig = (v: number) => (v << 1) ^ (v >> 31);
const unzig = (z: number) => (z >>> 1) ^ -(z & 1);
const predict = (q: Int32Array, i: number, x: number, y: number, w: number) =>
  x && y ? q[i - 1] + q[i - w] - q[i - w - 1] : x ? q[i - 1] : y ? q[i - w] : 0;

export function encodeDem(r: Raster): Uint8Array {
  const { width: w, height: h, data } = r;
  const n = w * h;
  const q = new Int32Array(n);
  const z = new Uint16Array(n);
  const exc: number[] = [];
  const nodata: number[] = [];
  for (let y = 0, i = 0; y < h; y++)
    for (let x = 0; x < w; x++, i++) {
      const p = predict(q, i, x, y, w);
      const v = data[i];
      if (!(Number.isFinite(v) && v > -10000)) {
        q[i] = p;
        nodata.push(i);
        continue;
      }
      q[i] = Math.round(v * 10);
      const e = zig(q[i] - p) >>> 0;
      if (e < ESC) z[i] = e;
      else {
        z[i] = ESC;
        exc.push(i, q[i]);
      }
    }
  const out = new DataView(new ArrayBuffer(16 + n * 2 + exc.length * 4 + nodata.length * 4));
  out.setUint8(0, 0x44);
  out.setUint8(1, 0x4d);
  out.setUint8(2, 2);
  out.setUint16(4, w, true);
  out.setUint16(6, h, true);
  out.setUint32(8, exc.length / 2, true);
  out.setUint32(12, nodata.length, true);
  const bytes = new Uint8Array(out.buffer);
  for (let i = 0; i < n; i++) {
    bytes[16 + i] = z[i] & 255;
    bytes[16 + n + i] = z[i] >> 8;
  }
  let o = 16 + n * 2;
  for (let k = 0; k < exc.length; k += 2) {
    out.setUint32(o, exc[k], true);
    out.setInt32(o + 4, exc[k + 1], true);
    o += 8;
  }
  for (const i of nodata) {
    out.setUint32(o, i, true);
    o += 4;
  }
  return bytes;
}

function decodeDem2(buf: ArrayBuffer): Raster {
  const dv = new DataView(buf);
  const b = new Uint8Array(buf);
  const w = dv.getUint16(4, true);
  const h = dv.getUint16(6, true);
  const nExc = dv.getUint32(8, true);
  const nNo = dv.getUint32(12, true);
  const n = w * h;
  const q = new Int32Array(n);
  let eo = 16 + n * 2;
  for (let y = 0, i = 0; y < h; y++)
    for (let x = 0; x < w; x++, i++) {
      const z = b[16 + i] | (b[16 + n + i] << 8);
      if (z === ESC) {
        q[i] = dv.getInt32(eo + 4, true);
        eo += 8;
      } else q[i] = predict(q, i, x, y, w) + unzig(z);
    }
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = q[i] / 10;
  let no = 16 + n * 2 + nExc * 8;
  for (let k = 0; k < nNo; k++, no += 4) data[dv.getUint32(no, true)] = NODATA;
  return { width: w, height: h, data };
}

/** Version 1 (row differences); kept so tiles already cached on a phone still read. */
export function encodeDemV1(r: Raster): Uint8Array {
  const { width: w, height: h, data } = r;
  const out = new DataView(new ArrayBuffer(8 + h * (4 + (w - 1) * 6)));
  out.setUint8(0, 0x44);
  out.setUint8(1, 0x4d);
  out.setUint8(2, 1);
  out.setUint16(4, w, true);
  out.setUint16(6, h, true);
  let o = 8;
  const dm = (v: number) => (Number.isFinite(v) && v > -10000 ? Math.round(v * 10) : NODATA_DM);
  for (let y = 0; y < h; y++) {
    let prev = dm(data[y * w]);
    out.setInt32(o, prev, true);
    o += 4;
    for (let x = 1; x < w; x++) {
      const v = dm(data[y * w + x]);
      const d = v - prev;
      if (prev !== NODATA_DM && v !== NODATA_DM && d > -32768 && d <= 32767) {
        out.setInt16(o, d, true);
        o += 2;
      } else {
        out.setInt16(o, -32768, true);
        out.setInt32(o + 2, v, true);
        o += 6;
      }
      prev = v;
    }
  }
  return new Uint8Array(out.buffer, 0, o);
}

export function decodeDem(buf: ArrayBuffer): Raster {
  const dv = new DataView(buf);
  if (dv.getUint8(2) === 2) return decodeDem2(buf);
  const w = dv.getUint16(4, true);
  const h = dv.getUint16(6, true);
  const data = new Float32Array(w * h);
  let o = 8;
  const val = (q: number) => (q === NODATA_DM ? NODATA : q / 10);
  for (let y = 0; y < h; y++) {
    let prev = dv.getInt32(o, true);
    o += 4;
    data[y * w] = val(prev);
    for (let x = 1; x < w; x++) {
      const d = dv.getInt16(o, true);
      o += 2;
      if (d === -32768) {
        prev = dv.getInt32(o, true);
        o += 4;
      } else prev += d;
      data[y * w + x] = val(prev);
    }
  }
  return { width: w, height: h, data };
}

/** An elevation tile in either format: compact (/api/dem2) or the original GeoTIFF. */
export async function readDem(buf: ArrayBuffer): Promise<Raster> {
  let b = new Uint8Array(buf, 0, 2);
  if (b[0] === 0x1f && b[1] === 0x8b) {
    // gzipped compact tile (as /api/dem2 sends it)
    buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    b = new Uint8Array(buf, 0, 2);
  }
  return b[0] === 0x44 && b[1] === 0x4d ? decodeDem(buf) : readFloatTiff(buf);
}
