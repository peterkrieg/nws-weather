const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
export const compassToDeg = (c: string) => {
  const i = COMPASS.indexOf(c);
  return i < 0 ? null : i * 22.5;
};

export const hourLong = (hr: number) => `${hr % 12 || 12} ${hr < 12 ? 'AM' : 'PM'}`;
export const hourShort = (hr: number) => `${hr % 12 || 12}${hr < 12 ? 'a' : 'p'}`;

export const deg = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v)}°`);
export const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v)}%`);
export const mph = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v)} mph`);
export const inches = (v: number | null | undefined, digits = 2) =>
  v == null ? '–' : v < 0.5 / 10 ** digits ? '0"' : `${v.toFixed(digits)}"`;
export const feet = (v: number | null | undefined) =>
  v == null ? '–' : `${(Math.round(v / 100) * 100).toLocaleString('en-US')} ft`;

/** Map an NWS icon URL (…/icons/land/day/rain_showers,40?size=medium) to an emoji. */
export function emoji(iconUrl: string | undefined, isDay = true): string {
  const m = /\/icons\/\w+\/(day|night)\/([a-z_]+)/.exec(iconUrl ?? '');
  if (!m) return isDay ? '🌤️' : '🌙';
  const day = m[1] === 'day';
  const code = m[2];
  if (code.startsWith('tsra')) return '⛈️';
  if (code === 'tornado') return '🌪️';
  if (code === 'hurricane' || code === 'tropical_storm') return '🌀';
  if (code === 'snow' || code === 'blizzard') return '❄️';
  if (/snow|sleet|fzra/.test(code)) return '🌨️';
  if (code.startsWith('rain_showers')) return day ? '🌦️' : '🌧️';
  if (code.startsWith('rain')) return '🌧️';
  if (/fog|haze|smoke|dust/.test(code)) return '🌫️';
  if (code.startsWith('wind')) return '💨';
  if (code === 'cold') return '🥶';
  if (code === 'hot') return '🥵';
  if (code === 'skc') return day ? '☀️' : '🌙';
  if (code === 'few') return day ? '🌤️' : '🌙';
  if (code === 'sct') return day ? '⛅' : '☁️';
  if (code === 'bkn') return day ? '🌥️' : '☁️';
  return '☁️';
}

export const uvValue = (v: number | null | undefined) => (v == null ? '–' : v < 10 ? v.toFixed(1) : String(Math.round(v)));
/** WHO exposure categories for the UV index. */
export const uvCategory = (v: number | null | undefined) =>
  v == null ? '' : v < 3 ? 'low' : v < 6 ? 'moderate' : v < 8 ? 'high' : v < 11 ? 'very high' : 'extreme';
