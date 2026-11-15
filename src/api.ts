import { compass, compassToDeg, hourLong } from './format';
import { sunTimes } from './sun';

const NWS = 'https://api.weather.gov';
const PHOTON = 'https://photon.komoot.io/api/';

export interface Loc {
  lat: number;
  lon: number;
  label?: string;
  sub?: string;
  /** Where the location came from; the map only recenters for non-map sources. */
  source: 'search' | 'map' | 'geo' | 'url';
}

export interface Period {
  name: string;
  startTime: string;
  isDaytime: boolean;
  temperature: number;
  shortForecast: string;
  detailedForecast: string;
  icon: string;
  pop: number | null;
  windSpeed: string;
  windDirection: string;
}

export interface Hour {
  /** Start of the hour, epoch ms. */
  t: number;
  /** Local hour of day (0-23) and weekday at the forecast location. */
  hr: number;
  dow: string;
  label: string;
  temp: number | null;
  feels: number | null;
  dew: number | null;
  rh: number | null;
  sky: number | null;
  pop: number | null;
  wind: number | null;
  gust: number | null;
  dir: number | null;
  /** Liquid precip / snowfall totals for the multi-hour bucket this hour falls in. */
  qpf: number | null;
  qpfStart?: number;
  qpfHrs?: number;
  snow: number | null;
  snowStart?: number;
  snowHrs?: number;
  snowLvl: number | null;
  uv: number | null;
  uvClear: number | null;
  /** Freezing level in feet (Open-Meteo only; NWS gives a snow level instead). */
  frzLvl: number | null;
  short?: string;
  isDay?: boolean;
  icon?: string;
}

export interface Alert {
  id: string;
  event: string;
  headline: string;
  description: string;
  instruction: string;
}

export interface Weather {
  /** 'nws' inside US coverage. Elsewhere 'openmeteo', or 'metno' (MET Norway) when Open-Meteo is unreachable. */
  source: 'nws' | 'openmeteo' | 'metno';
  lat: number;
  lon: number;
  place: string;
  tz: string;
  office: string;
  periods: Period[];
  hours: Hour[];
  alerts: Alert[];
}

class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

/** GET with a couple of retries, since api.weather.gov throws intermittent 500s. */
async function nws(url: string, retries = 2): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      throw new HttpError(r.status);
    } catch (e) {
      const clientError = e instanceof HttpError && e.status < 500;
      if (clientError || i >= retries) throw e;
    }
    await new Promise((res) => setTimeout(res, 500 * (i + 1)));
  }
}

const coord = (n: number) => String(Number(n.toFixed(4)));

type Bucket = { v: number; start: number; hrs: number };

function durationHours(d: string | undefined) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?)?/.exec(d ?? '');
  return Math.max(1, Number(m?.[1] ?? 0) * 24 + Number(m?.[2] ?? 0));
}

/** Expand a gridpoint layer ("start/PT6H" intervals) into a per-hour lookup, converted to US units. */
function expand(prop: any): Map<number, Bucket> {
  const out = new Map<number, Bucket>();
  if (!prop?.values) return out;
  const uom: string = prop.uom ?? '';
  const cv = uom.endsWith('degC')
    ? (v: number) => (v * 9) / 5 + 32
    : uom.includes('km_h')
      ? (v: number) => v * 0.621371
      : uom.endsWith(':mm')
        ? (v: number) => v / 25.4
        : uom.endsWith(':m')
          ? (v: number) => v * 3.28084
          : (v: number) => v;
  for (const { validTime, value } of prop.values) {
    if (value == null) continue;
    const [startIso, dur] = String(validTime).split('/');
    const start = Math.round(Date.parse(startIso) / 3600e3);
    const hrs = durationHours(dur);
    const b = { v: cv(value), start, hrs };
    for (let k = 0; k < hrs; k++) out.set(start + k, b);
  }
  return out;
}

function buildHours(grid: any, hourly: any, tz: string): Hour[] {
  const g = grid?.properties ?? {};
  const layers = {
    temp: expand(g.temperature),
    feels: expand(g.apparentTemperature),
    dew: expand(g.dewpoint),
    rh: expand(g.relativeHumidity),
    sky: expand(g.skyCover),
    pop: expand(g.probabilityOfPrecipitation),
    wind: expand(g.windSpeed),
    gust: expand(g.windGust),
    dir: expand(g.windDirection),
    qpf: expand(g.quantitativePrecipitation),
    snow: expand(g.snowfallAmount),
    snowLvl: expand(g.snowLevel),
  };
  const meta = new Map<number, any>();
  for (const p of hourly?.properties?.periods ?? []) {
    meta.set(Math.round(Date.parse(p.startTime) / 3600e3), p);
  }

  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  const now = Math.floor(Date.now() / 3600e3);
  const hours: Hour[] = [];
  for (let i = 0; i < 168; i++) {
    const eh = now + i;
    const val = (k: keyof typeof layers) => layers[k].get(eh)?.v ?? null;
    const m = meta.get(eh);
    // Fall back to the simpler hourly forecast if the raw grid layer is missing.
    const temp = val('temp') ?? m?.temperature ?? null;
    if (temp == null) {
      if (hours.length) break;
      continue;
    }
    const parts = fmt.formatToParts(new Date(eh * 3600e3));
    const hr = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
    const dow = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const dewC = m?.dewpoint?.value;
    const qpf = layers.qpf.get(eh);
    const snow = layers.snow.get(eh);
    hours.push({
      t: eh * 3600e3,
      hr,
      dow,
      label: `${dow} ${hourLong(hr)}`,
      temp,
      feels: val('feels'),
      dew: val('dew') ?? (dewC != null ? (dewC * 9) / 5 + 32 : null),
      rh: val('rh') ?? m?.relativeHumidity?.value ?? null,
      sky: val('sky'),
      pop: val('pop') ?? m?.probabilityOfPrecipitation?.value ?? null,
      wind: val('wind') ?? (m ? parseInt(m.windSpeed, 10) || null : null),
      gust: val('gust'),
      dir: val('dir') ?? (m ? compassToDeg(m.windDirection) : null),
      qpf: qpf?.v ?? null,
      qpfStart: qpf?.start,
      qpfHrs: qpf?.hrs,
      snow: snow?.v ?? null,
      snowStart: snow?.start,
      snowHrs: snow?.hrs,
      snowLvl: val('snowLvl'),
      uv: null,
      uvClear: null,
      frzLvl: null,
      short: m?.shortForecast,
      isDay: m?.isDaytime,
      icon: m?.icon,
    });
  }
  return hours;
}

export async function fetchWeather(lat: number, lon: number): Promise<Weather> {
  const uvPromise = fetchUv(lat, lon);
  let point: any;
  try {
    point = (await nws(`${NWS}/points/${coord(lat)},${coord(lon)}`)).properties;
  } catch (e) {
    // NWS answers 4xx for anywhere outside the US and its territories: use the global forecast there.
    if (e instanceof HttpError && e.status < 500) return fetchIntl(lat, lon, uvPromise);
    throw new Error('The National Weather Service API did not respond. Try again in a moment.');
  }
  if (!point?.forecastGridData) return fetchIntl(lat, lon, uvPromise);

  const [fc, hourly, grid, alerts] = await Promise.allSettled([
    nws(point.forecast),
    nws(point.forecastHourly),
    nws(point.forecastGridData),
    nws(`${NWS}/alerts/active?point=${coord(lat)},${coord(lon)}`, 0),
  ]);
  const ok = <T,>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : null);
  if (!ok(fc) && !ok(hourly) && !ok(grid)) {
    throw new Error('The National Weather Service forecast for this spot is temporarily unavailable. Try again in a moment.');
  }

  const rel = point.relativeLocation?.properties;
  let place = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  if (rel?.city) {
    const miles = (rel.distance?.value ?? 0) / 1609.34;
    const town = `${rel.city}, ${rel.state}`;
    place = miles < 1.5 ? town : `${Math.round(miles)} mi ${compass(rel.bearing?.value ?? 0)} of ${town}`;
  }

  const periods: Period[] = (ok(fc)?.properties?.periods ?? []).map((p: any) => ({
    name: p.name,
    startTime: p.startTime,
    isDaytime: p.isDaytime,
    temperature: p.temperature,
    shortForecast: p.shortForecast,
    detailedForecast: p.detailedForecast,
    icon: p.icon,
    pop: p.probabilityOfPrecipitation?.value ?? null,
    windSpeed: p.windSpeed,
    windDirection: p.windDirection,
  }));

  return {
    source: 'nws',
    lat,
    lon,
    place,
    tz: point.timeZone,
    office: point.cwa ?? '',
    periods,
    hours: applyUv(buildHours(ok(grid), ok(hourly), point.timeZone), await uvPromise),
    alerts: (ok(alerts)?.features ?? []).map((f: any) => ({
      id: f.properties.id,
      event: f.properties.event ?? 'Alert',
      headline: f.properties.headline ?? '',
      description: f.properties.description ?? '',
      instruction: f.properties.instruction ?? '',
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// UV index (worldwide): Open-Meteo air-quality API, which carries the CAMS UV forecast.

interface Uv {
  tz: string | null;
  byHour: Map<number, { uv: number | null; clear: number | null }>;
}

/** Never rejects: UV is an extra, so a failure just means no UV chart. */
async function fetchUv(lat: number, lon: number): Promise<Uv> {
  const byHour: Uv['byHour'] = new Map();
  try {
    const url =
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${coord(lat)}&longitude=${coord(lon)}` +
      '&hourly=uv_index,uv_index_clear_sky&timeformat=unixtime&timezone=auto&forecast_days=7';
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { tz: null, byHour };
    const j = await r.json();
    (j.hourly?.time ?? []).forEach((t: number, i: number) => {
      byHour.set(Math.round(t / 3600), { uv: j.hourly.uv_index?.[i] ?? null, clear: j.hourly.uv_index_clear_sky?.[i] ?? null });
    });
    return { tz: typeof j.timezone === 'string' && j.timezone !== 'GMT' ? j.timezone : null, byHour };
  } catch {
    return { tz: null, byHour };
  }
}

function applyUv(hours: Hour[], uv: Uv): Hour[] {
  for (const h of hours) {
    const u = uv.byHour.get(Math.round(h.t / 3600e3));
    if (u && h.uv == null) {
      h.uv = u.uv;
      h.uvClear = u.clear;
    }
  }
  return hours;
}

// ---------------------------------------------------------------------------------------------
// Outside the US: Open-Meteo. Its default "best match" already picks the best model per region
// (AROME in France, ICON-D2 in central Europe, UKMO in the UK, MET Nordic in Scandinavia, JMA in
// Japan, ...) over a global ECMWF / ICON / GFS base, and adjusts temperature to the point's
// elevation using a 90 m terrain model.

/** WMO weather code -> [label, NWS icon code that format.emoji() understands]. */
function wmo(code: number | null, isDay: boolean): [string, string] {
  switch (code) {
    case 0: return [isDay ? 'Sunny' : 'Clear', 'skc'];
    case 1: return [isDay ? 'Mostly Sunny' : 'Mostly Clear', 'few'];
    case 2: return ['Partly Cloudy', 'sct'];
    case 3: return ['Cloudy', 'ovc'];
    case 45: case 48: return ['Fog', 'fog'];
    case 51: return ['Light Drizzle', 'rain'];
    case 53: case 55: return ['Drizzle', 'rain'];
    case 56: case 57: return ['Freezing Drizzle', 'fzra'];
    case 61: return ['Light Rain', 'rain'];
    case 63: return ['Rain', 'rain'];
    case 65: return ['Heavy Rain', 'rain'];
    case 66: case 67: return ['Freezing Rain', 'fzra'];
    case 71: return ['Light Snow', 'snow'];
    case 73: case 77: return ['Snow', 'snow'];
    case 75: return ['Heavy Snow', 'snow'];
    case 80: return ['Light Rain Showers', 'rain_showers'];
    case 81: return ['Rain Showers', 'rain_showers'];
    case 82: return ['Heavy Rain Showers', 'rain_showers'];
    case 85: return ['Snow Showers', 'snow'];
    case 86: return ['Heavy Snow Showers', 'snow'];
    case 95: return ['Thunderstorms', 'tsra'];
    case 96: case 99: return ['Thunderstorms with Hail', 'tsra'];
    default: return ['', 'sct'];
  }
}

async function fetchOpenMeteo(lat: number, lon: number): Promise<{ tz: string; hours: Hour[] }> {
  const vars = [
    'temperature_2m', 'apparent_temperature', 'dew_point_2m', 'relative_humidity_2m', 'cloud_cover',
    'precipitation_probability', 'precipitation', 'snowfall', 'wind_speed_10m', 'wind_gusts_10m',
    'wind_direction_10m', 'freezing_level_height', 'weather_code', 'is_day', 'uv_index', 'uv_index_clear_sky',
  ];
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${coord(lat)}&longitude=${coord(lon)}&hourly=${vars.join(',')}` +
    '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timeformat=unixtime&timezone=auto&forecast_days=8';
  const r = await fetch(url, { signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new HttpError(r.status);
  const j = await r.json();
  const h = j.hourly ?? {};
  const tz: string = j.timezone ?? 'UTC';
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  const now = Math.floor(Date.now() / 3600e3);
  const at = (k: string, i: number): number | null => h[k]?.[i] ?? null;
  const hours: Hour[] = [];
  (h.time ?? []).forEach((sec: number, i: number) => {
    const eh = Math.round(sec / 3600);
    const temp = at('temperature_2m', i);
    if (eh < now || eh > now + 167 || temp == null) return;
    const t = eh * 3600e3;
    const parts = fmt.formatToParts(new Date(t));
    const hr = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
    const dow = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const isDay = at('is_day', i) !== 0;
    const [short, code] = wmo(at('weather_code', i), isDay);
    const qpf = at('precipitation', i);
    const snow = at('snowfall', i);
    hours.push({
      t,
      hr,
      dow,
      label: `${dow} ${hourLong(hr)}`,
      temp,
      feels: at('apparent_temperature', i),
      dew: at('dew_point_2m', i),
      rh: at('relative_humidity_2m', i),
      sky: at('cloud_cover', i),
      pop: at('precipitation_probability', i),
      wind: at('wind_speed_10m', i),
      gust: at('wind_gusts_10m', i),
      dir: at('wind_direction_10m', i),
      qpf,
      qpfStart: qpf != null ? eh : undefined,
      qpfHrs: qpf != null ? 1 : undefined,
      snow,
      snowStart: snow != null ? eh : undefined,
      snowHrs: snow != null ? 1 : undefined,
      snowLvl: null,
      uv: at('uv_index', i),
      uvClear: at('uv_index_clear_sky', i),
      frzLvl: at('freezing_level_height', i),
      short,
      isDay,
      icon: `/icons/land/${isDay ? 'day' : 'night'}/${code}`,
    });
  });
  if (hours.length < 2) throw new Error('Open-Meteo returned no forecast');
  return { tz, hours };
}

// ---------------------------------------------------------------------------------------------
// Fallback outside the US: MET Norway's global Locationforecast. Hourly for about 2.5 days, then 6-hourly
// out to about 9 days (interpolated to hourly here so the charts stay continuous). It has no
// precipitation probability, snowfall amount or text forecast, and gusts only in the Nordics.

const C_TO_F = (c: number) => (c * 9) / 5 + 32;
const MS_TO_MPH = 2.23694;

/** MET Norway symbol ("lightrainshowers_day") -> the NWS icon code that format.emoji() understands. */
function symbolIcon(symbol: string | undefined, isDay: boolean) {
  const s = (symbol ?? '').split('_')[0];
  const code = !s
    ? 'sct'
    : s.includes('thunder')
      ? 'tsra'
      : s.includes('sleet')
        ? 'sleet'
        : s.includes('snow')
          ? 'snow'
          : s.includes('rainshowers')
            ? 'rain_showers'
            : s.includes('rain')
              ? 'rain'
              : s === 'fog'
                ? 'fog'
                : s === 'clearsky'
                  ? 'skc'
                  : s === 'fair'
                    ? 'few'
                    : s === 'partlycloudy'
                      ? 'sct'
                      : 'ovc';
  return `/icons/land/${isDay ? 'day' : 'night'}/${code}`;
}

function symbolLabel(symbol: string | undefined, isDay: boolean) {
  const s = (symbol ?? '').split('_')[0];
  if (!s) return '';
  if (s === 'clearsky') return isDay ? 'Sunny' : 'Clear';
  if (s === 'fair') return isDay ? 'Mostly Sunny' : 'Mostly Clear';
  if (s === 'partlycloudy') return 'Partly Cloudy';
  return s
    .replace(/^(light|heavy)s?(rain|sleet|snow)/, '$1 $2')
    .replace('showers', ' showers')
    .replace('andthunder', ' and thunder')
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(' And ', ' and ');
}

function intlHours(json: any, tz: string, lat: number, lon: number): Hour[] {
  const ts: { eh: number; d: any }[] = (json?.properties?.timeseries ?? []).map((t: any) => ({
    eh: Math.round(Date.parse(t.time) / 3600e3),
    d: t.data ?? {},
  }));
  if (ts.length < 2) return [];
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  const start = Math.max(Math.floor(Date.now() / 3600e3), ts[0].eh);
  const end = Math.min(ts[ts.length - 1].eh, start + 167);
  const hours: Hour[] = [];
  let i = 0;
  for (let eh = start; eh <= end; eh++) {
    while (i < ts.length - 2 && ts[i + 1].eh <= eh) i++;
    const a = ts[i];
    const b = ts[i + 1];
    const frac = Math.min(1, Math.max(0, (eh - a.eh) / (b.eh - a.eh)));
    const A = a.d.instant?.details ?? {};
    const B = b.d.instant?.details ?? {};
    const lerp = (k: string): number | null =>
      A[k] == null ? (B[k] ?? null) : B[k] == null ? A[k] : A[k] + (B[k] - A[k]) * frac;
    const tempC = lerp('air_temperature');
    if (tempC == null) continue;
    const dewC = lerp('dew_point_temperature');
    const wind = lerp('wind_speed');
    const gust = lerp('wind_speed_of_gust');

    const t = eh * 3600e3;
    const sun = sunTimes(t, lat, lon);
    const isDay = sun.sunrise == null || sun.sunset == null ? true : t >= sun.sunrise && t < sun.sunset;
    const block = a.d.next_1_hours ?? a.d.next_6_hours;
    const mm = block?.details?.precipitation_amount;
    const symbol = (a.d.next_1_hours ?? a.d.next_6_hours ?? a.d.next_12_hours)?.summary?.symbol_code;
    const parts = fmt.formatToParts(new Date(t));
    const hr = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
    const dow = parts.find((p) => p.type === 'weekday')?.value ?? '';
    hours.push({
      t,
      hr,
      dow,
      label: `${dow} ${hourLong(hr)}`,
      temp: C_TO_F(tempC),
      // MET Norway's apparent temperature is experimental and gave implausible values, so it is left out.
      feels: null,
      dew: dewC != null ? C_TO_F(dewC) : null,
      rh: lerp('relative_humidity'),
      sky: lerp('cloud_area_fraction'),
      pop: lerp('probability_of_precipitation'),
      wind: wind != null ? wind * MS_TO_MPH : null,
      gust: gust != null ? gust * MS_TO_MPH : null,
      dir: A.wind_from_direction ?? null,
      qpf: mm != null ? mm / 25.4 : null,
      qpfStart: mm != null ? a.eh : undefined,
      qpfHrs: mm != null ? (a.d.next_1_hours ? 1 : 6) : undefined,
      snow: null,
      snowLvl: null,
      uv: null,
      uvClear: null,
      frzLvl: null,
      short: symbolLabel(symbol, isDay),
      isDay,
      icon: symbolIcon(symbol, isDay),
    });
  }
  return hours;
}

/** Group hourly data into NWS-style day (6am-6pm) and night periods, with a generated summary. */
function intlPeriods(hours: Hour[], tz: string): Period[] {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
  const groups: Hour[][] = [];
  for (const h of hours) {
    if (!groups.length || h.hr === 6 || h.hr === 18) groups.push([]);
    groups[groups.length - 1].push(h);
  }
  const periods: Period[] = [];
  groups.forEach((g, idx) => {
    if (g.length < 3 || periods.length >= 14) return;
    const first = g[0];
    const isDaytime = first.hr >= 6 && first.hr < 18;
    const day = weekday.format(first.t);
    const name = idx === 0 ? (isDaytime ? 'Today' : first.hr < 6 ? 'Overnight' : 'Tonight') : isDaytime ? day : `${day} Night`;
    const temps = g.map((h) => h.temp!);
    const temperature = Math.round(isDaytime ? Math.max(...temps) : Math.min(...temps));

    // Precipitation total: count each multi-hour bucket once.
    const seen = new Set<number>();
    let precip = 0;
    for (const h of g) {
      if (h.qpf != null && h.qpfStart != null && !seen.has(h.qpfStart)) {
        seen.add(h.qpfStart);
        precip += h.qpf;
      }
    }
    // Headline condition: the most common one, looking only at wet hours when it is a wet period.
    const pool = precip >= 0.02 ? g.filter((h) => (h.qpf ?? 0) > 0) : g;
    const counts = new Map<string, { n: number; h: Hour }>();
    for (const h of pool.length ? pool : g) {
      const c = counts.get(h.short ?? '') ?? { n: 0, h };
      c.n++;
      counts.set(h.short ?? '', c);
    }
    const top = [...counts.values()].sort((x, y) => y.n - x.n)[0].h;

    const winds = g.map((h) => h.wind ?? 0);
    const lo = Math.round(Math.min(...winds));
    const hi = Math.round(Math.max(...winds));
    const windSpeed = lo === hi ? `${hi} mph` : `${lo} to ${hi} mph`;
    const strongest = g.reduce((m, h) => ((h.wind ?? 0) > (m.wind ?? 0) ? h : m), first);
    const windDirection = strongest.dir != null ? compass(strongest.dir) : '';
    const gustMax = Math.max(...g.map((h) => h.gust ?? 0));

    const pops = g.map((h) => h.pop).filter((v): v is number => v != null);
    const pop = pops.length ? Math.round(Math.max(...pops)) : null;
    const snowSeen = new Set<number>();
    let snow = 0;
    for (const h of g) {
      if (h.snow != null && h.snowStart != null && !snowSeen.has(h.snowStart)) {
        snowSeen.add(h.snowStart);
        snow += h.snow;
      }
    }

    const detail = [
      `${top.short}.`,
      `${isDaytime ? 'High' : 'Low'} near ${temperature}°F.`,
      `${windDirection} wind ${windSpeed}${gustMax > hi + 5 ? `, with gusts to ${Math.round(gustMax)} mph` : ''}.`.trim(),
      pop != null && pop >= 10 ? `Chance of precipitation ${pop}%.` : '',
      precip >= 0.01 ? `Precipitation around ${precip.toFixed(2)} in (liquid equivalent).` : '',
      snow >= 0.1 ? `Snowfall around ${snow.toFixed(1)} in.` : '',
    ]
      .filter(Boolean)
      .join(' ');

    periods.push({
      name,
      startTime: new Date(first.t).toISOString(),
      isDaytime,
      temperature,
      shortForecast: top.short ?? '',
      detailedForecast: detail,
      icon: symbolIcon(undefined, isDaytime).replace(/[a-z_]+$/, (top.icon ?? '').split('/').pop() ?? 'sct'),
      pop,
      windSpeed,
      windDirection,
    });
  });
  return periods;
}

/** Nearest named place for a point (Photon reverse geocoding), e.g. "Chamonix-Mont-Blanc, France". */
async function reverseName(lat: number, lon: number): Promise<string | null> {
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${coord(lat)}&lon=${coord(lon)}&lang=en`, {
      signal: AbortSignal.timeout(4000),
    });
    const p = (await r.json()).features?.[0]?.properties;
    const town = p?.city ?? p?.town ?? p?.village ?? p?.locality ?? p?.county ?? p?.state ?? p?.name;
    return town ? [town, p.country !== town ? p.country : null].filter(Boolean).join(', ') : null;
  } catch {
    return null;
  }
}

async function fetchIntl(lat: number, lon: number, uvPromise: Promise<Uv>): Promise<Weather> {
  const placePromise = reverseName(lat, lon);
  const fallbackPlace = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  try {
    const { tz, hours } = await fetchOpenMeteo(lat, lon);
    return {
      source: 'openmeteo',
      lat,
      lon,
      place: (await placePromise) ?? fallbackPlace,
      tz,
      office: '',
      periods: intlPeriods(hours, tz),
      hours,
      alerts: [],
    };
  } catch {
    // Open-Meteo unreachable or returned nothing usable: fall back to MET Norway below.
  }

  let json: any;
  try {
    const r = await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${coord(lat)}&lon=${coord(lon)}`);
    if (!r.ok) throw new HttpError(r.status);
    json = await r.json();
  } catch {
    throw new Error('No forecast is available for that spot right now. Try again in a moment.');
  }
  const [uv, place] = await Promise.all([uvPromise, placePromise]);
  // Time zone comes with the UV lookup; if that failed, approximate it from the longitude.
  const offset = Math.round(lon / 15);
  const tz = uv.tz ?? `Etc/GMT${offset <= 0 ? '+' : '-'}${Math.abs(offset)}`;
  const hours = applyUv(intlHours(json, tz, lat, lon), uv);
  if (!hours.length) throw new Error('No forecast is available for that spot right now. Try again in a moment.');
  return {
    source: 'metno',
    lat,
    lon,
    place: place ?? fallbackPlace,
    tz,
    office: '',
    periods: intlPeriods(hours, tz),
    hours,
    alerts: [],
  };
}

const TERRAIN_ZOOM = 14;
let lastTile: { key: string; pixels: Promise<ImageData> } | null = null;

function terrainTile(x: number, y: number): Promise<ImageData> {
  const key = `${x}/${y}`;
  if (lastTile?.key === key) return lastTile.pixels;
  const pixels = new Promise<ImageData>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, img.width, img.height));
    };
    img.onerror = () => reject(new Error('terrain tile failed to load'));
    img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${TERRAIN_ZOOM}/${key}.png`;
  });
  lastTile = { key, pixels };
  return pixels;
}

/**
 * Ground elevation at the exact point, in feet. Reads one pixel from the public "Terrarium" terrain tiles
 * (built from USGS 3DEP data in the US, roughly 10 m resolution at this zoom), which load far faster
 * than the USGS point-query service.
 */
export async function fetchElevation(lat: number, lon: number): Promise<number | null> {
  try {
    const n = 2 ** TERRAIN_ZOOM;
    const x = ((lon + 180) / 360) * n;
    const y = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
    const tile = await terrainTile(Math.floor(x), Math.floor(y));
    const px = Math.min(tile.width - 1, Math.floor((x % 1) * tile.width));
    const py = Math.min(tile.height - 1, Math.floor((y % 1) * tile.height));
    const i = (py * tile.width + px) * 4;
    const [r, g, b] = [tile.data[i], tile.data[i + 1], tile.data[i + 2]];
    const meters = r * 256 + g + b / 256 - 32768;
    return meters * 3.28084;
  } catch {
    lastTile = null;
    return null;
  }
}

export interface Place {
  lat: number;
  lon: number;
  label: string;
  sub: string;
}

/** Address / place autocomplete via Photon (OpenStreetMap data). */
/** How much a kind of OSM feature deserves to be suggested (cities beat villages beat cafés). */
function kindWeight(key: string, value: string, hasHouseNumber: boolean): number {
  if (key === 'place') return ({ city: 6, town: 5, village: 3, suburb: 3, hamlet: 2, locality: 2 } as Record<string, number>)[value] ?? 2;
  if (hasHouseNumber) return 4; // the street address the user is typing
  if (key === 'natural' || key === 'water' || key === 'waterway') return 4; // peaks, lakes, rivers
  if (key === 'highway' && (value === 'trailhead' || value === 'path')) return 4;
  if (key === 'tourism' && /camp|alpine_hut|viewpoint|wilderness_hut/.test(value)) return 4;
  if (key === 'leisure' && /park|nature_reserve|sports_centre/.test(value)) return 3.5;
  if (key === 'boundary' && /national_park|protected_area/.test(value)) return 4.5;
  if (key === 'boundary' && value === 'administrative') return 4.5; // often how a town is tagged (Chamonix)
  if (key === 'highway') return 0.5; // street names without a number
  return 0.5; // shops, offices, companies, buildings
}

function km(aLat: number, aLon: number, bLat: number, bLon: number) {
  const r = Math.PI / 180;
  const x = (bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r);
  const y = (bLat - aLat) * r;
  return Math.hypot(x, y) * 6371;
}

/**
 * Address / place autocomplete via Photon (OpenStreetMap data).
 * Photon's own ranking is either purely global ("Bost", France, before Boston) or, when biased,
 * purely local (every "Boston Court" in town). So ask twice — near the current location and
 * worldwide — and rank the union by what kind of place it is, how close it is, and how
 * prominently each list placed it.
 */
export async function searchPlaces(q: string, bias: { lat: number; lon: number } | null, signal: AbortSignal): Promise<Place[]> {
  const get = async (extra: Record<string, string>) => {
    const params = new URLSearchParams({ q, limit: '10', lang: 'en', ...extra });
    const r = await fetch(`${PHOTON}?${params}`, { signal });
    if (!r.ok) throw new Error('Place search is unavailable right now.');
    return ((await r.json()).features ?? []) as any[];
  };
  const [world, near] = await Promise.all([
    get({}),
    bias ? get({ lat: coord(bias.lat), lon: coord(bias.lon), zoom: '9', location_bias_scale: '0.2' }).catch(() => []) : Promise.resolve([]),
  ]);

  const query = q.trim().toLowerCase();
  const scored = new Map<string, { f: any; score: number }>();
  const add = (list: any[], rankBonus: number) =>
    list.forEach((f, i) => {
      const p = f.properties ?? {};
      const [lon, lat] = f.geometry.coordinates;
      const id = `${p.osm_type}${p.osm_id}`;
      let score = kindWeight(p.osm_key, p.osm_value, Boolean(p.housenumber) && /\d/.test(query)) + rankBonus * (1 - i / list.length);
      if (bias) {
        const d = km(bias.lat, bias.lon, lat, lon);
        score += d < 80 ? 3.5 : d < 300 ? 2.5 : d < 1500 ? 1 : 0;
      } else if (p.countrycode === 'US') score += 1;
      if (String(p.name ?? '').toLowerCase() === query) score += 0.5;
      const prev = scored.get(id);
      if (!prev || prev.score < score) scored.set(id, { f, score });
    });
  add(world, 2);
  add(near, 1);
  const ranked = [...scored.values()].sort((a, b) => b.score - a.score).map((s) => s.f);

  const seen = new Set<string>();
  const out: Place[] = [];
  for (const f of ranked) {
    const p = f.properties ?? {};
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const town = p.city ?? p.town ?? p.village ?? p.locality ?? p.county;
    const label: string = p.name ?? (street || town || p.state);
    if (!label) continue;
    const country = p.countrycode && p.countrycode !== 'US' && p.country !== label ? p.country : null;
    const sub = [p.name && street ? street : null, town !== label ? town : null, p.state !== label ? p.state : null, country]
      .filter(Boolean)
      .join(', ');
    const key = `${label}|${sub}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [lon, lat] = f.geometry.coordinates;
    out.push({ lat, lon, label, sub });
    if (out.length >= 6) break;
  }
  return out;
}
