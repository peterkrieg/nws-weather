// /api/snow?lat=&lon= — NOAA's daily national snow analysis (SNODAS, 1 km) around a spot:
// snow water equivalent (mm) and depth (m) for a 5 × 5 block of 1 km cells, plus the analysis time.
// NOAA serves it as a map, so each cell is one "identify" lookup; the analysis is updated once a
// day (06 UTC), so the block is cached until the next one.

const SERVICE = 'https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer';
const CELL = 1 / 120; // SNODAS grid: 30 arc-seconds
const HALF = 2; // 5 × 5 cells

export interface SnowCell {
  lat: number;
  lon: number;
  swe: number | null; // mm
  depth: number | null; // m
}
export interface Snow {
  /** Unix seconds of the analysis (06 UTC on its day). */
  at: number;
  cells: SnowCell[];
}

const cache = () => (caches as unknown as { default: Cache }).default;

async function identify(lat: number, lon: number): Promise<{ swe: number | null; depth: number | null }> {
  const q = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    sr: '4326',
    layers: 'all:3,7',
    tolerance: '0',
    mapExtent: `${lon - 0.1},${lat - 0.1},${lon + 0.1},${lat + 0.1}`,
    imageDisplay: '200,200,96',
    returnGeometry: 'false',
    f: 'json',
  });
  const r = await fetch(`${SERVICE}/identify?${q}`);
  if (!r.ok) throw new Error(`snodas ${r.status}`);
  const j = (await r.json()) as { results?: { attributes: Record<string, string> }[] };
  let swe: number | null = null;
  let depth: number | null = null;
  for (const res of j.results ?? []) {
    const v = Number(res.attributes['Service Pixel Value']);
    if (!Number.isFinite(v)) continue;
    // Product codes in the file name: 1034 = snow water equivalent (mm), 1036 = snow depth (m).
    if (res.attributes.name?.includes('1034')) swe = v;
    else if (res.attributes.name?.includes('1036')) depth = v;
  }
  return { swe, depth };
}

export async function snow(url: URL): Promise<Response> {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return new Response('lat/lon required', { status: 400 });
  // Snap to the grid so nearby views share cells; the analysis lands around 06–08 UTC.
  const ci = Math.round(lat / CELL);
  const cj = Math.round(lon / CELL);
  const now = Date.now() / 1000;
  const day = Math.floor((now - 9 * 3600) / 86400); // before 09 UTC, yesterday's analysis is current
  const key = new Request(`https://snow-cache.internal/v1/${day}/${ci}/${cj}`);
  const hit = await cache().match(key);
  if (hit) return hit;
  try {
    const jobs: Promise<SnowCell>[] = [];
    for (let di = -HALF; di <= HALF; di++)
      for (let dj = -HALF; dj <= HALF; dj++) {
        const clat = (ci + di) * CELL;
        const clon = (cj + dj) * CELL;
        jobs.push(identify(clat, clon).then((v) => ({ lat: clat, lon: clon, ...v })));
      }
    const body: Snow = { at: day * 86400 + 6 * 3600, cells: await Promise.all(jobs) };
    const res = new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${Math.max(600, (day + 1) * 86400 + 9 * 3600 - Math.floor(now))}` },
    });
    await cache().put(key, res.clone());
    return res;
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
}
