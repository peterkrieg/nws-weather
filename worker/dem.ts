// /api/dem/{z}/{x}/{y} — USGS 3DEP elevation tiles for the trail conditions model, cached at the edge.
// USGS renders each tile on request (often several seconds); terrain never changes, so the first
// viewer of an area waits and everyone after gets it from Cloudflare's cache.

import { COARSE_Z, FINE_Z, demUrl } from '../src/conditions/terrain';

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
