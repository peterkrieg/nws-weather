// /api/s2?lat=&lon= — recent Sentinel-2 passes over a spot (Earth Search catalogue, AWS open data).
// /api/s2?cell=lat,lon — the same for a 0.5° square (south-west corner), for the satellite map.
// Returns, newest first, each scene's scene-classification layer (SCL: 20 m pixels labelled snow,
// cloud, vegetation, bare ground…) and true-colour picture (TCI, 10 m) with their map grids. The
// browser reads only the tiles it needs straight from the public bucket. Cached 3 h (a pass every
// 2–5 days).

const STAC = 'https://earth-search.aws.element84.com/v1/search';
const DAYS = 20;
const CELL = 0.5;
const CELL_DAYS = 30;

export interface Scene {
  at: number; // unix seconds
  cloud: number; // % of the scene
  epsg: number; // UTM zone, e.g. 32612
  transform: number[]; // [res, 0, x0, 0, -res, y0]
  shape: [number, number]; // rows, cols
  href: string;
  /** True colour, 10 m (the SCL grid is 20 m). */
  tci?: { href: string; transform: number[]; shape: [number, number] };
  /** Raw 10 m red/green/blue (uint16; reflectance = value × scale + offset), same grid as tci. */
  bands?: { r: string; g: string; b: string; scale: number; offset: number };
  /** lon/lat footprint box. */
  bbox?: number[];
}

const cache = () => (caches as unknown as { default: Cache }).default;

export async function s2(url: URL): Promise<Response> {
  const sq = url.searchParams.get('cell')?.split(',').map(Number);
  const area = sq?.length === 2 && sq.every(Number.isFinite) ? sq.map((v) => Math.floor(v / CELL + 1e-9) * CELL) : null;
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!area && (!Number.isFinite(lat) || !Number.isFinite(lon))) return new Response('lat/lon or cell required', { status: 400 });
  const cell = area ? `sq/${area[0]},${area[1]}` : `${(Math.round(lat * 20) / 20).toFixed(2)},${(Math.round(lon * 20) / 20).toFixed(2)}`;
  const slot = Math.floor(Date.now() / (3 * 3600e3));
  const key = new Request(`https://s2-cache.internal/v4/${cell}/${slot}`);
  const hit = await cache().match(key);
  if (hit) return hit;
  const now = new Date();
  const from = new Date(now.getTime() - (area ? CELL_DAYS : DAYS) * 86400e3);
  const intersects = area
    ? { type: 'Polygon', coordinates: [[[area[1], area[0]], [area[1] + CELL, area[0]], [area[1] + CELL, area[0] + CELL], [area[1], area[0] + CELL], [area[1], area[0]]]] }
    : { type: 'Point', coordinates: [lon, lat] };
  const r = await fetch(STAC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: ['sentinel-2-l2a'],
      intersects,
      datetime: `${from.toISOString()}/${now.toISOString()}`,
      // A mostly cloudy scene can still be clear over the spot that matters.
      query: { 'eo:cloud_cover': { lt: area ? 95 : 80 } },
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
      limit: area ? 100 : 12,
    }),
  });
  if (!r.ok) return new Response(JSON.stringify({ error: `stac ${r.status}` }), { status: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const j = (await r.json()) as {
    features: {
      bbox?: number[];
      properties: Record<string, unknown>;
      assets: Record<string, { href: string; 'proj:transform'?: number[]; 'proj:shape'?: [number, number]; 'raster:bands'?: { scale?: number; offset?: number }[] }>;
    }[];
  };
  const scenes: Scene[] = j.features.flatMap((f) => {
    const a = f.assets.scl;
    const v = f.assets.visual;
    const epsg = Number(f.properties['proj:epsg']);
    if (!a?.href || !a['proj:transform'] || !a['proj:shape'] || !epsg) return [];
    const tci = v?.href && v['proj:transform'] && v['proj:shape'] ? { href: v.href, transform: v['proj:transform'], shape: v['proj:shape'] } : undefined;
    const { red, green, blue } = f.assets;
    const rb = red?.['raster:bands']?.[0];
    // Earth Search already removed the -0.1 offset from newer scenes (despite listing it): applying it
    // again turns bare ground black.
    const bands = red?.href && green?.href && blue?.href ? { r: red.href, g: green.href, b: blue.href, scale: rb?.scale ?? 0.0001, offset: f.properties['earthsearch:boa_offset_applied'] ? 0 : (rb?.offset ?? 0) } : undefined;
    return [{ at: Date.parse(String(f.properties.datetime)) / 1000, cloud: Number(f.properties['eo:cloud_cover']), epsg, transform: a['proj:transform'], shape: a['proj:shape'], href: a.href, tci, bands, bbox: f.bbox }];
  });
  const res = new Response(JSON.stringify(scenes), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
  await cache().put(key, res.clone());
  return res;
}
