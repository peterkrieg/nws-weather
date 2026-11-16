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
