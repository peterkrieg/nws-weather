// /api/s2?lat=&lon= — recent Sentinel-2 passes over a spot (Earth Search catalogue, AWS open data).
// Returns, newest first, each scene's scene-classification layer (SCL: 20 m pixels labelled snow,
// cloud, vegetation, bare ground…) with its map grid. The browser reads only the few 512 px tiles
// it needs straight from the public bucket. Cached 3 h (a pass every 2–5 days).

const STAC = 'https://earth-search.aws.element84.com/v1/search';
const DAYS = 20;

export interface Scene {
  at: number; // unix seconds
  cloud: number; // % of the scene
  epsg: number; // UTM zone, e.g. 32612
  transform: number[]; // [res, 0, x0, 0, -res, y0]
  shape: [number, number]; // rows, cols
  href: string;
}

const cache = () => (caches as unknown as { default: Cache }).default;

export async function s2(url: URL): Promise<Response> {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return new Response('lat/lon required', { status: 400 });
  const cell = `${(Math.round(lat * 20) / 20).toFixed(2)},${(Math.round(lon * 20) / 20).toFixed(2)}`;
  const slot = Math.floor(Date.now() / (3 * 3600e3));
  const key = new Request(`https://s2-cache.internal/v1/${cell}/${slot}`);
  const hit = await cache().match(key);
  if (hit) return hit;
  const now = new Date();
  const from = new Date(now.getTime() - DAYS * 86400e3);
  const r = await fetch(STAC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: ['sentinel-2-l2a'],
      intersects: { type: 'Point', coordinates: [lon, lat] },
      datetime: `${from.toISOString()}/${now.toISOString()}`,
      query: { 'eo:cloud_cover': { lt: 80 } },
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
      limit: 12,
    }),
  });
  if (!r.ok) return new Response(JSON.stringify({ error: `stac ${r.status}` }), { status: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const j = (await r.json()) as {
    features: { properties: Record<string, unknown>; assets: Record<string, { href: string; 'proj:transform'?: number[]; 'proj:shape'?: [number, number] }> }[];
  };
  const scenes: Scene[] = j.features.flatMap((f) => {
    const a = f.assets.scl;
    const epsg = Number(f.properties['proj:epsg']);
    if (!a?.href || !a['proj:transform'] || !a['proj:shape'] || !epsg) return [];
    return [{ at: Date.parse(String(f.properties.datetime)) / 1000, cloud: Number(f.properties['eo:cloud_cover']), epsg, transform: a['proj:transform'], shape: a['proj:shape'], href: a.href }];
  });
  const res = new Response(JSON.stringify(scenes), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
  await cache().put(key, res.clone());
  return res;
}
