// /api/soil/{x}/{y} (z13), /api/canopy|nlcd/{x}/{y} (z14) and …/legend — soil survey and tree
// cover for the trail conditions model, fetched from USDA / MRLC once and cached at the edge.

import { canopyUrl, legendUrl, soilRequest } from '../src/conditions/landcover';

const TTL = 30 * 86400;
const cache = () => (caches as unknown as { default: Cache }).default;

async function cachedFetch(key: string, load: () => Promise<Response>, type: string): Promise<Response> {
  const req = new Request(`https://landcover-cache.internal/v1/${key}`);
  const hit = await cache().match(req);
  if (hit) return hit;
  const r = await load();
  if (!r.ok) return new Response('upstream unavailable', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  const res = new Response(await r.arrayBuffer(), { headers: { 'Content-Type': type, 'Cache-Control': `public, max-age=${TTL}` } });
  await cache().put(req, res.clone());
  return res;
}

export async function landcover(url: URL): Promise<Response> {
  const leg = url.pathname.match(/^\/api\/(canopy|nlcd)\/legend$/);
  if (leg) return cachedFetch(`${leg[1]}-legend`, () => fetch(legendUrl(leg[1] as 'canopy' | 'nlcd')), 'application/json');
  const m = url.pathname.match(/^\/api\/(soil|canopy|nlcd)\/(\d+)\/(\d+)$/);
  if (!m) return new Response('bad request', { status: 400 });
  const [, kind, xs, ys] = m;
  const x = Number(xs);
  const y = Number(ys);
  if (kind === 'soil') {
    const { url: u, body } = soilRequest(x, y);
    return cachedFetch(`soil/${x}/${y}`, () => fetch(u, { method: 'POST', body }), 'application/json');
  }
  const k = kind as 'canopy' | 'nlcd';
  return cachedFetch(`${k}/${x}/${y}`, () => fetch(canopyUrl(x, y, k)), 'image/png');
}
