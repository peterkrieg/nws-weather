// /api/ground?lat=&lon= — measured conditions near a spot, for the trail conditions model:
//   - USDA SNOTEL / SCAN sites: air temperature, soil temperature at 2" and 8", soil moisture at
//     2", snow depth. Mountain sites at many elevations.
//   - NWS stations (airports, mostly valley floors): air temperature.
// Together they give the real temperature change with elevation each hour (inversions included),
// whether the ground is frozen, and where snow is lying. Hourly, past 4 days, cached for an hour.

const AWDB = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1';
const NWS = 'https://api.weather.gov';
const UA = 'nws-weather personal app';
const RADIUS_KM = 40;
const MAX_MOUNTAIN = 6;
const MAX_VALLEY = 3;
const HOURS = 96;

export interface Station {
  id: string;
  name: string;
  net: 'SNTL' | 'SCAN' | 'NWS';
  lat: number;
  lon: number;
  elev: number; // metres
  km: number;
  /** Hourly, aligned to `t` (unix seconds, top of hour). null = no reading. */
  temp: (number | null)[]; // °C air
  soil2?: (number | null)[]; // °C at 2 in
  soil8?: (number | null)[]; // °C at 8 in
  moist2?: (number | null)[]; // % volumetric at 2 in
  snow?: (number | null)[]; // snow depth, cm
}
export interface Ground {
  t: number[];
  stations: Station[];
}

const cache = () => (caches as unknown as { default: Cache }).default;
async function cachedJson<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const req = new Request(`https://ground-cache.internal/v1/${key}`);
  const hit = await cache().match(req);
  if (hit) return hit.json() as Promise<T>;
  const v = await load();
  await cache().put(req, new Response(JSON.stringify(v), { headers: { 'Cache-Control': `max-age=${ttl}` } }));
  return v;
}

const km = (a: [number, number], b: [number, number]) => Math.hypot((a[0] - b[0]) * 111 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 111);
const fToC = (f: number | null | undefined) => (f == null ? null : Math.round(((f - 32) * 5) / 9 * 10) / 10);

type Meta = [triplet: string, name: string, lat: number, lon: number, elevFt: number, tz: number];

/** Every active SNOTEL and SCAN site (~1,100), kept a week. */
const siteList = () =>
  cachedJson<Meta[]>('awdb-sites', 7 * 86400, async () => {
    const r = await fetch(`${AWDB}/stations?stationTriplets=*:*:SNTL,*:*:SCAN&activeOnly=true`);
    if (!r.ok) throw new Error(`awdb stations ${r.status}`);
    const rows = (await r.json()) as { stationTriplet: string; name: string; latitude: number; longitude: number; elevation: number; dataTimeZone: number }[];
    return rows.map((s) => [s.stationTriplet, s.name, s.latitude, s.longitude, s.elevation, s.dataTimeZone ?? -7] as Meta);
  });

function hourIndex(t0: number, unix: number) {
  return Math.round((unix - t0) / 3600);
}

async function mountain(lat: number, lon: number, t0: number): Promise<Station[]> {
  const near = (await siteList())
    .map((m) => ({ m, d: km([lon, lat], [m[3], m[2]]) }))
    .filter((x) => x.d <= RADIUS_KM)
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_MOUNTAIN);
  if (!near.length) return [];
  // AWDB dates are station-local standard time; ask a little wide and place each value by hour.
  const fmt = (u: number) => new Date(u * 1000 - 7 * 3600e3).toISOString().slice(0, 16).replace('T', '%20');
  const url = `${AWDB}/data?stationTriplets=${near.map((x) => x.m[0]).join(',')}&elements=TOBS,STO:-2,STO:-8,SMS:-2,SNWD&duration=HOURLY&beginDate=${fmt(t0 - 6 * 3600)}&endDate=${fmt(t0 + (HOURS + 6) * 3600)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`awdb data ${r.status}`);
  const data = (await r.json()) as {
    stationTriplet: string;
    data: { stationElement: { elementCode: string; heightDepth?: number }; values: { date: string; value?: number }[] }[];
  }[];
  return data.flatMap((st) => {
    const hit = near.find((x) => x.m[0] === st.stationTriplet);
    if (!hit) return [];
    const [id, name, slat, slon, elevFt, tz] = hit.m;
    const series = () => new Array<number | null>(HOURS).fill(null);
    const out: Station = { id, name, net: id.endsWith('SCAN') ? 'SCAN' : 'SNTL', lat: slat, lon: slon, elev: Math.round(elevFt * 0.3048), km: Math.round(hit.d * 10) / 10, temp: series() };
    for (const el of st.data) {
      const code = el.stationElement.elementCode;
      const depth = el.stationElement.heightDepth;
      const key = code === 'TOBS' ? 'temp' : code === 'STO' && depth === -2 ? 'soil2' : code === 'STO' && depth === -8 ? 'soil8' : code === 'SMS' ? 'moist2' : code === 'SNWD' ? 'snow' : null;
      if (!key) continue;
      const arr = (out[key] as (number | null)[] | undefined) ?? series();
      for (const v of el.values) {
        if (v.value == null) continue;
        const unix = Date.parse(`${v.date.replace(' ', 'T')}:00Z`) / 1000 - tz * 3600;
        const i = hourIndex(t0, unix);
        if (i < 0 || i >= HOURS || arr[i] != null) continue; // SCAN has duplicate sensors: keep the first
        arr[i] = key === 'temp' || key === 'soil2' || key === 'soil8' ? fToC(v.value) : key === 'snow' ? Math.round(v.value * 2.54) : v.value;
      }
      (out as unknown as Record<string, unknown>)[key] = arr;
    }
    return [out];
  });
}

async function valley(lat: number, lon: number, t0: number): Promise<Station[]> {
  const pt = await cachedJson<{ url: string }>(`nws-point/${lat.toFixed(2)},${lon.toFixed(2)}`, 30 * 86400, async () => {
    const r = await fetch(`${NWS}/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`nws point ${r.status}`);
    return { url: ((await r.json()) as { properties: { observationStations: string } }).properties.observationStations };
  });
  const list = await cachedJson<{ id: string; name: string; lat: number; lon: number; elev: number }[]>(`nws-stations/${pt.url}`, 7 * 86400, async () => {
    const r = await fetch(`${pt.url}?limit=10`, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`nws stations ${r.status}`);
    const j = (await r.json()) as { features: { geometry: { coordinates: [number, number] }; properties: { stationIdentifier: string; name: string; elevation: { value: number } } }[] };
    return j.features.map((f) => ({ id: f.properties.stationIdentifier, name: f.properties.name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], elev: f.properties.elevation.value }));
  });
  const near = list
    .map((s) => ({ s, d: km([lon, lat], [s.lon, s.lat]) }))
    .filter((x) => x.d <= RADIUS_KM)
    .slice(0, MAX_VALLEY);
  const start = new Date(t0 * 1000).toISOString();
  const got = await Promise.all(
    near.map(async ({ s, d }) => {
      const r = await fetch(`${NWS}/stations/${s.id}/observations?start=${start}`, { headers: { 'User-Agent': UA } }).catch(() => null);
      if (!r?.ok) return null;
      const j = (await r.json()) as { features: { properties: { timestamp: string; temperature: { value: number | null } } }[] };
      const temp = new Array<number | null>(HOURS).fill(null);
      for (const f of j.features) {
        const v = f.properties.temperature.value;
        if (v == null) continue;
        const i = hourIndex(t0, Date.parse(f.properties.timestamp) / 1000);
        if (i >= 0 && i < HOURS && temp[i] == null) temp[i] = Math.round(v * 10) / 10;
      }
      return { id: s.id, name: s.name, net: 'NWS', lat: s.lat, lon: s.lon, elev: Math.round(s.elev), km: Math.round(d * 10) / 10, temp } satisfies Station;
    }),
  );
  return got.filter((x): x is NonNullable<typeof x> => x != null);
}

export async function ground(url: URL): Promise<Response> {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return new Response('lat/lon required', { status: 400 });
  // One answer per ~10 km square per hour: every viewer nearby shares it.
  const cell = `${(Math.round(lat * 10) / 10).toFixed(1)},${(Math.round(lon * 10) / 10).toFixed(1)}`;
  const hour = Math.floor(Date.now() / 3600e3);
  try {
    const body = await cachedJson<Ground>(`ground/${cell}/${hour}`, 3600, async () => {
      const t0 = (hour - HOURS + 1) * 3600;
      const [m, v] = await Promise.all([mountain(lat, lon, t0).catch(() => []), valley(lat, lon, t0).catch(() => [])]);
      return { t: Array.from({ length: HOURS }, (_, i) => t0 + i * 3600), stations: [...v, ...m] };
    });
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
}
