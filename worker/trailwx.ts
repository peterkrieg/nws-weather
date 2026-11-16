// /api/trailwx?lat=&lon= — hourly weather for the trail conditions model.
//
// Past 3 days + next 2 days, hour by hour, for a 0.1° cell (about 11 × 8 km), cached for an hour.
// Rain comes from the weather model (Open-Meteo, HRRR in the US) for timing; its 3-day total is
// checked against NOAA's radar + gauge estimate (MRMS, via Iowa State's mesonet) and the ratio is
// passed on so the client can scale the model's amounts toward what was actually measured.

const CELL = 0.1;
const TTL = 3600;

export interface TrailWx {
  lat: number;
  lon: number;
  /** Weather model ground elevation for this cell (m), to adjust temperature for the trail's elevation. */
  elev: number;
  /** Hourly, unix seconds. */
  t: number[];
  temp: number[]; // °C
  rh: number[]; // %
  wind: number[]; // m/s at 10 m
  sw: number[]; // W/m² global horizontal, mean of the preceding hour
  cloud: number[]; // %
  precip: number[]; // mm in the preceding hour
  snowfall: number[]; // cm in the preceding hour
  snowDepth: number[]; // m
  soilMoist: number[]; // m³/m³, top 1 cm
  soilTemp: number[]; // °C at the surface
  /** Measured ÷ modelled precipitation over the last 3 days (1 when unknown or too little to tell). */
  precipScale: number;
  /** For display: 3-day totals in mm. */
  modelPast3d: number;
  measuredPast3d: number | null;
  /** Time the past ends and the forecast starts (unix seconds). */
  now: number;
}

const HOURLY =
  'temperature_2m,relative_humidity_2m,wind_speed_10m,shortwave_radiation,cloud_cover,precipitation,snowfall,snow_depth,soil_moisture_0_to_1cm,soil_temperature_0cm';

export async function loadTrailWx(lat: number, lon: number): Promise<TrailWx> {
  const om = new URL('https://api.open-meteo.com/v1/forecast');
  om.search = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: HOURLY,
    past_days: '3',
    forecast_days: '2',
    timeformat: 'unixtime',
    wind_speed_unit: 'ms',
  }).toString();
  const r = await fetch(om, { headers: { 'User-Agent': 'weather.peterkrieg.com trail conditions' } });
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  const d = (await r.json()) as { elevation: number; hourly: Record<string, (number | null)[]> };
  const h = d.hourly;
  const num = (k: string) => h[k].map((v) => (v == null ? 0 : v));
  const t = h.time as number[];
  const now = Math.floor(Date.now() / 1000);

  // Measured 3-day precipitation (local calendar days, today included) vs the model over the same span.
  const days: string[] = [];
  for (let i = 2; i >= 0; i--) days.push(new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10));
  let measured: number | null = null;
  try {
    const m = await fetch(`https://mesonet.agron.iastate.edu/iemre/multiday/${days[0]}/${days[2]}/${lat}/${lon}/json`);
    if (m.ok) {
      const j = (await m.json()) as { data: { mrms_precip_in: number | null }[] };
      const vals = j.data.map((x) => x.mrms_precip_in).filter((v): v is number => v != null);
      if (vals.length) measured = vals.reduce((a, b) => a + b, 0) * 25.4;
    }
  } catch {
    /* measured totals are a refinement; the model alone still works */
  }
  const start = Date.parse(`${days[0]}T00:00:00Z`) / 1000 - 6 * 3600; // roughly local midnight (Mountain)
  const precip = num('precipitation');
  let model = 0;
  t.forEach((ts, i) => {
    if (ts > start && ts <= now) model += precip[i];
  });
  // Only trust the ratio when there was enough rain to compare; keep it within reason.
  const precipScale = measured != null && model > 2 ? Math.min(2.5, Math.max(0.4, measured / model)) : 1;

  return {
    lat,
    lon,
    elev: d.elevation,
    t,
    temp: num('temperature_2m'),
    rh: num('relative_humidity_2m'),
    wind: num('wind_speed_10m'),
    sw: num('shortwave_radiation'),
    cloud: num('cloud_cover'),
    precip,
    snowfall: num('snowfall'),
    snowDepth: num('snow_depth'),
    soilMoist: num('soil_moisture_0_to_1cm'),
    soilTemp: num('soil_temperature_0cm'),
    precipScale,
    modelPast3d: Math.round(model * 10) / 10,
    measuredPast3d: measured == null ? null : Math.round(measured * 10) / 10,
    now,
  };
}

export async function trailWx(url: URL): Promise<Response> {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return new Response('bad lat/lon', { status: 400 });
  const clat = Math.round(lat / CELL) * CELL;
  const clon = Math.round(lon / CELL) * CELL;
  const key = new Request(`https://trailwx-cache.internal/v1/${clat.toFixed(1)},${clon.toFixed(1)}`);
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(key);
  if (hit) return forBrowser(hit);
  try {
    const body = JSON.stringify(await loadTrailWx(Number(clat.toFixed(1)), Number(clon.toFixed(1))));
    const res = new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${TTL}` } });
    await cache.put(key, res.clone());
    return forBrowser(res);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
}

function forBrowser(r: Response) {
  const res = new Response(r.body, r);
  res.headers.set('Cache-Control', 'max-age=600');
  return res;
}
