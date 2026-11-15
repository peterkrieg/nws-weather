// Sun position maths (the standard low-precision formulas, same approach as the SunCalc library).
// Accurate to about a minute, which is finer than terrain and weather make meaningful anyway.

const RAD = Math.PI / 180;
const DAY_MS = 86400e3;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;
const J0 = 0.0009;

/** Sun altitude at sunrise/sunset: centre 0.833° below the horizon (refraction plus the sun's radius). */
const HORIZON = -0.833;
/** Civil twilight: sun 6° below the horizon. Past this you need a headlamp. */
const CIVIL = -6;

export interface SunTimes {
  /** Civil dawn: enough light to see without a headlamp. */
  firstLight: number | null;
  sunrise: number | null;
  sunset: number | null;
  /** Civil dusk: after this it is too dark to see the trail without a headlamp. */
  lastLight: number | null;
}

/**
 * Sun times (epoch ms) for the solar day nearest to `when` at the given point.
 * Values are null where the event does not happen that day (polar summer or winter).
 */
export function sunTimes(when: number, lat: number, lon: number): SunTimes {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = when / DAY_MS - 0.5 + J1970 - J2000;
  const n = Math.round(d - J0 - lw / (2 * Math.PI));

  const transit = (hourAngle: number) => {
    const ds = J0 + (hourAngle + lw) / (2 * Math.PI) + n;
    const M = RAD * (357.5291 + 0.98560028 * ds);
    const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + RAD * 102.9372 + Math.PI;
    return { j: J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L), dec: Math.asin(Math.sin(L) * Math.sin(OBLIQUITY)) };
  };
  const toMs = (j: number) => (j + 0.5 - J1970) * DAY_MS;

  const noon = transit(0);
  const pair = (altitude: number): [number | null, number | null] => {
    const cosW = (Math.sin(RAD * altitude) - Math.sin(phi) * Math.sin(noon.dec)) / (Math.cos(phi) * Math.cos(noon.dec));
    if (cosW < -1 || cosW > 1) return [null, null];
    const set = transit(Math.acos(cosW)).j;
    return [toMs(noon.j - (set - noon.j)), toMs(set)];
  };

  const [sunrise, sunset] = pair(HORIZON);
  const [firstLight, lastLight] = pair(CIVIL);
  return { firstLight, sunrise, sunset, lastLight };
}

/** Dark intervals (last light to next first light) overlapping [from, to], for shading charts. */
export function darkSpans(from: number, to: number, lat: number, lon: number): [number, number][] {
  const spans: [number, number][] = [];
  for (let t = from - DAY_MS; t <= to + DAY_MS; t += DAY_MS) {
    const dusk = sunTimes(t, lat, lon).lastLight;
    const dawn = sunTimes(t + DAY_MS, lat, lon).firstLight;
    if (dusk == null || dawn == null) continue;
    const a = Math.max(dusk, from);
    const b = Math.min(dawn, to);
    if (b > a) spans.push([a, b]);
  }
  return spans;
}

export function clock(ms: number | null, tz: string) {
  if (ms == null) return '–';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(ms);
}
