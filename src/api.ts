import { compass, compassToDeg, hourLong } from './format';

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
      short: m?.shortForecast,
      isDay: m?.isDaytime,
      icon: m?.icon,
    });
  }
  return hours;
}

export async function fetchWeather(lat: number, lon: number): Promise<Weather> {
  let point: any;
  try {
    point = (await nws(`${NWS}/points/${coord(lat)},${coord(lon)}`)).properties;
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) {
      throw new Error('The National Weather Service has no forecast for that spot. It only covers the US and its territories.');
    }
    throw new Error('The National Weather Service API did not respond. Try again in a moment.');
  }
  if (!point?.forecastGridData) {
    throw new Error('The National Weather Service has no forecast grid for that spot.');
  }

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
    lat,
    lon,
    place,
    tz: point.timeZone,
    office: point.cwa ?? '',
    periods,
    hours: buildHours(ok(grid), ok(hourly), point.timeZone),
    alerts: (ok(alerts)?.features ?? []).map((f: any) => ({
      id: f.properties.id,
      event: f.properties.event ?? 'Alert',
      headline: f.properties.headline ?? '',
      description: f.properties.description ?? '',
      instruction: f.properties.instruction ?? '',
    })),
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

const NWS_COUNTRIES = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP']);

/** Address / place autocomplete via Photon (OpenStreetMap data), limited to where NWS has forecasts. */
export async function searchPlaces(q: string, bias: { lat: number; lon: number } | null, signal: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({ q, limit: '12', lang: 'en' });
  if (bias) {
    params.set('lat', coord(bias.lat));
    params.set('lon', coord(bias.lon));
  }
  const r = await fetch(`${PHOTON}?${params}`, { signal });
  if (!r.ok) throw new Error('Place search is unavailable right now.');
  const json = await r.json();
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const f of json.features ?? []) {
    const p = f.properties ?? {};
    if (!NWS_COUNTRIES.has(p.countrycode)) continue;
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const town = p.city ?? p.town ?? p.village ?? p.locality ?? p.county;
    const label: string = p.name ?? (street || town || p.state);
    if (!label) continue;
    const sub = [p.name && street ? street : null, town !== label ? town : null, p.state !== label ? p.state : null]
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
