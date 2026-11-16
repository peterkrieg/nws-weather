// /api/dem/{z}/{x}/{y} — USGS 3DEP elevation tiles for the trail conditions model, cached at the edge.
// USGS renders each tile on request (often several seconds); terrain never changes, so the first
// viewer of an area waits and everyone after gets it from Cloudflare's cache.

import { COARSE_Z, FINE_Z, demUrl } from '../src/conditions/terrain';
import { encodeDem, readFloatTiff } from '../src/conditions/tiff';

const TTL = 30 * 86400;

export async function dem(url: URL): Promise<Response> {
  const m = url.pathname.match(/^\/api\/dem\/(\d+)\/(\d+)\/(\d+)$/);
  if (!m) return new Response('bad tile', { status: 400 });
  const [z, x, y] = m.slice(1).map(Number);
  if (z !== FINE_Z && z !== COARSE_Z) return new Response('unsupported zoom', { status: 400 });
  const key = new Request(`https://dem-cache.internal/v1/${z}/${x}/${y}`);
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(key);
  if (hit) return hit;
  const r = await fetch(demUrl(x, y, z));
  const type = r.headers.get('content-type') ?? '';
  if (!r.ok || !type.includes('tiff')) return new Response('elevation unavailable', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  const res = new Response(r.body, { headers: { 'Content-Type': 'image/tiff', 'Cache-Control': `public, max-age=${TTL}, immutable` } });
  await cache.put(key, res.clone());
  return res;
}

// /api/dem2/{z}/{x}/{y} — the same tile in the compact format (src/conditions/tiff.ts encodeDem),
// gzipped once and cached: ~60 KB instead of 256 KB. The app unzips it (readDem).
export async function dem2(url: URL): Promise<Response> {
  const m = url.pathname.match(/^\/api\/dem2\/(\d+)\/(\d+)\/(\d+)$/);
  if (!m) return new Response('bad tile', { status: 400 });
  const [z, x, y] = m.slice(1).map(Number);
  if (z !== FINE_Z && z !== COARSE_Z) return new Response('unsupported zoom', { status: 400 });
  const key = new Request(`https://dem-cache.internal/v3/${z}/${x}/${y}`);
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(key);
  if (hit) return hit;
  const tiff = await dem(new URL(`/api/dem/${z}/${x}/${y}`, url));
  if (!tiff.ok) return tiff;
  const raster = await readFloatTiff(await tiff.arrayBuffer());
  const gz = await new Response(new Blob([encodeDem(raster) as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  // Plain bytes (no Content-Encoding): the app unzips them itself, so no proxy or cache can
  // double-compress or strip them along the way.
  const res = new Response(gz, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': `public, max-age=${TTL}, immutable` } });
  await cache.put(key, res.clone());
  return res;
}
