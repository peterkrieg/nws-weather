// Cloudflare Worker: serves the static app, plus /api/aq, which proxies air quality data so the
// API keys stay server-side and responses are cached (PurpleAir charges per sensor per field).
//
// The map asks for 0.5° grid cells. For each cell:
//   - AirNow: every official monitor (Utah DEQ etc.), cached 15 min.
//   - PurpleAir: a thinned sample, at most one sensor per SAMPLE square. The sample (ids and
//     positions) is chosen once a week; refreshes then ask only for PM2.5 and humidity of those
//     ids, cached 30 min. PurpleAir bills per sensor per field, so both halves are kept lean.

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  PURPLEAIR_KEY?: string;
  AIRNOW_KEY?: string;
}

const CELL = 0.5; // degrees per requested grid cell
const SAMPLE = 0.04; // degrees: keep one PurpleAir sensor per square this size (~2.8 × 2 miles at 40°N)
const READ_TTL = 15 * 60; // AirNow (free; it only updates hourly anyway)
const PA_TTL = 30 * 60; // PurpleAir readings: each refresh costs points
const SAMPLE_TTL = 7 * 24 * 3600;

const cache = () => (caches as unknown as { default: Cache }).default;

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const req = new Request(`https://aq-cache.internal/${key}`);
  const hit = await cache().match(req);
  if (hit) return hit.json() as Promise<T>;
  const value = await load();
  await cache().put(req, new Response(JSON.stringify(value), { headers: { 'Cache-Control': `max-age=${ttl}` } }));
  return value;
}

// ---- AQI maths ------------------------------------------------------------------------------

/** EPA PM2.5 AQI breakpoints (2024 revision). */
const PM_BREAKS: [number, number, number, number][] = [
  [0, 9.0, 0, 50],
  [9.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 125.4, 151, 200],
  [125.5, 225.4, 201, 300],
  [225.5, 325.4, 301, 500],
];

function pmToAqi(pm: number): number {
  const c = Math.floor(Math.max(0, pm) * 10) / 10;
  for (const [cl, ch, il, ih] of PM_BREAKS) {
    if (c <= ch) return Math.round(((ih - il) / (ch - cl)) * (Math.max(c, cl) - cl) + il);
  }
  return 500;
}

/**
 * EPA's US-wide correction for PurpleAir (Barkjohn et al. 2021, extended for smoke in 2023).
 * Raw PurpleAir readings run high, especially in humid air, which inversions often are.
 * `pa` is the cf_1 PM2.5 averaged across both laser channels, `rh` the sensor's own humidity.
 */
function correctPurpleAir(pa: number, rh: number): number {
  let pm: number;
  if (pa < 30) pm = 0.524 * pa - 0.0862 * rh + 5.75;
  else if (pa < 50) {
    const w = pa / 20 - 1.5;
    pm = (0.786 * w + 0.524 * (1 - w)) * pa - 0.0862 * rh + 5.75;
  } else if (pa < 210) pm = 0.786 * pa - 0.0862 * rh + 5.75;
  else if (pa < 260) {
    const w = pa / 50 - 4.2;
    pm = (0.69 * w + 0.786 * (1 - w)) * pa - 0.0862 * rh * (1 - w) + 2.966 * w + 5.75 * (1 - w) + 8.84e-4 * pa * pa * w;
  } else pm = 2.966 + 0.69 * pa + 8.84e-4 * pa * pa;
  return Math.max(0, pm);
}

// ---- AirNow ---------------------------------------------------------------------------------

interface Monitor {
  lat: number;
  lon: number;
  name: string;
  agency: string;
  aqi: number;
  /** Pollutant driving the AQI, e.g. PM2.5 or OZONE. */
  param: string;
  readings: { param: string; aqi: number }[];
  time: string;
}

const hourStamp = (d: Date) => d.toISOString().slice(0, 13);

async function airNow(env: Env, s: number, w: number): Promise<Monitor[]> {
  const now = Date.now();
  const params = new URLSearchParams({
    startDate: hourStamp(new Date(now - 3 * 3600e3)),
    endDate: hourStamp(new Date(now)),
    parameters: 'PM25,OZONE',
    BBOX: [w, s, w + CELL, s + CELL].join(','),
    dataType: 'A',
    format: 'application/json',
    verbose: '1',
    monitorType: '0',
    includerawconcentrations: '0',
    API_KEY: env.AIRNOW_KEY!,
  });
  const r = await fetch(`https://www.airnowapi.org/aq/data/?${params}`);
  if (!r.ok) throw new Error(`AirNow ${r.status}`);
  const rows = (await r.json()) as {
    Latitude: number;
    Longitude: number;
    UTC: string;
    Parameter: string;
    AQI: number;
    SiteName: string;
    AgencyName: string;
    FullAQSCode: string;
  }[];

  // Latest hour per site and pollutant.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.AQI == null || row.AQI < 0) continue;
    const k = `${row.FullAQSCode}|${row.Parameter}`;
    const prev = latest.get(k);
    if (!prev || prev.UTC < row.UTC) latest.set(k, row);
  }
  const sites = new Map<string, Monitor>();
  for (const row of latest.values()) {
    const site = sites.get(row.FullAQSCode) ?? {
      lat: row.Latitude,
      lon: row.Longitude,
      name: row.SiteName,
      agency: row.AgencyName,
      aqi: -1,
      param: '',
      readings: [],
      time: row.UTC,
    };
    site.readings.push({ param: row.Parameter, aqi: row.AQI });
    if (row.AQI > site.aqi) Object.assign(site, { aqi: row.AQI, param: row.Parameter });
    if (row.UTC > site.time) site.time = row.UTC;
    sites.set(row.FullAQSCode, site);
  }
  return [...sites.values()];
}

// ---- PurpleAir ------------------------------------------------------------------------------

interface Sensor {
  id: number;
  lat: number;
  lon: number;
  aqi: number;
  pm: number;
  /** Unix seconds of the reading. */
  seen: number;
}

async function purpleAir(env: Env, fields: string[], extra: Record<string, string>) {
  const params = new URLSearchParams({ fields: fields.join(','), location_type: '0', max_age: '3600', ...extra });
  const r = await fetch(`https://api.purpleair.com/v1/sensors?${params}`, { headers: { 'X-API-Key': env.PURPLEAIR_KEY! } });
  if (!r.ok) throw new Error(`PurpleAir ${r.status}`);
  const json = (await r.json()) as { fields: string[]; data: (number | null)[][]; data_time_stamp: number };
  return {
    time: json.data_time_stamp,
    rows: json.data.map((row) => Object.fromEntries(json.fields.map((f, i) => [f, row[i]])) as Record<string, number | null>),
  };
}

interface Sampled {
  id: number;
  lat: number;
  lon: number;
}

async function purpleAirSample(env: Env, s: number, w: number): Promise<Sampled[]> {
  // Quality fields cost points too, but only on this weekly lookup.
  const { rows } = await purpleAir(env, ['latitude', 'longitude', 'confidence', 'channel_flags'], {
    nwlat: String(s + CELL),
    nwlng: String(w),
    selat: String(s),
    selng: String(w + CELL),
  });
  // Each sensor has two laser counters. `channel_flags` is non-zero when PurpleAir has marked one
  // as faulty; `confidence` (0–100) is how well the two agree. Skip flagged or disagreeing sensors,
  // and in each square keep the most trustworthy one.
  const picked = new Map<string, Sampled & { confidence: number }>();
  for (const row of rows) {
    if (row.latitude == null || row.longitude == null) continue;
    if (row.channel_flags) continue;
    const confidence = row.confidence ?? 0;
    if (confidence < 90) continue;
    const k = `${Math.floor(row.latitude / SAMPLE)},${Math.floor(row.longitude / SAMPLE)}`;
    const prev = picked.get(k);
    if (!prev || confidence > prev.confidence) picked.set(k, { id: row.sensor_index!, lat: row.latitude, lon: row.longitude, confidence });
  }
  return [...picked.values()].map(({ id, lat, lon }) => ({ id, lat, lon }));
}

async function purpleAirReadings(env: Env, sample: Sampled[]): Promise<Sensor[]> {
  if (!sample.length) return [];
  const where = new Map(sample.map((p) => [p.id, p]));
  // max_age keeps out sensors that haven't reported in the last hour, so the batch time stands in for each reading's age.
  const { time, rows } = await purpleAir(env, ['pm2.5_cf_1', 'humidity'], { show_only: [...where.keys()].join(',') });
  const out: Sensor[] = [];
  for (const row of rows) {
    const raw = row['pm2.5_cf_1'];
    const p = where.get(row.sensor_index!);
    if (raw == null || !p) continue;
    const pm = correctPurpleAir(raw, row.humidity ?? 40);
    out.push({ id: p.id, lat: p.lat, lon: p.lon, pm: Math.round(pm * 10) / 10, aqi: pmToAqi(pm), seen: time });
  }
  return out;
}

// ---- Routing --------------------------------------------------------------------------------

const json = (body: unknown, status = 200, maxAge = 0) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store' },
  });

async function airQuality(url: URL, env: Env) {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(url.searchParams.get('cell') ?? '');
  const s = m ? Number(m[1]) : NaN;
  const w = m ? Number(m[2]) : NaN;
  if (!m || s % CELL !== 0 || w % CELL !== 0 || Math.abs(s) > 90 || Math.abs(w) > 180) {
    return json({ error: 'cell must be the south-west corner of a 0.5° grid square, e.g. 40.5,-112' }, 400);
  }
  const cell = `${s},${w}`;
  const [monitors, sensors] = await Promise.all([
    env.AIRNOW_KEY
      ? cached(`airnow/${cell}`, READ_TTL, () => airNow(env, s, w)).catch((e: Error) => e.message)
      : null,
    env.PURPLEAIR_KEY
      ? cached(`pa-sample-v3/${cell}`, SAMPLE_TTL, () => purpleAirSample(env, s, w))
          .then((sample) => cached(`pa-v3/${cell}`, PA_TTL, () => purpleAirReadings(env, sample)))
          .catch((e: Error) => e.message)
      : null,
  ]);
  const errors = [monitors, sensors].filter((x): x is string => typeof x === 'string');
  const unconfigured = [!env.AIRNOW_KEY && 'AirNow', !env.PURPLEAIR_KEY && 'PurpleAir'].filter(Boolean);
  return json(
    { monitors: Array.isArray(monitors) ? monitors : [], sensors: Array.isArray(sensors) ? sensors : [], errors, unconfigured },
    200,
    errors.length ? 0 : 300, // never let a browser hold on to a failure
  );
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/aq') return airQuality(url, env);
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(req);
  },
};
