// Folds measured station data (/api/ground: SNOTEL / SCAN mountain sites, NWS valley stations)
// into the forecast model's weather for the trail conditions model:
//   - tempFix: each hour, how far off the model's temperature is, as a straight line in elevation.
//     With stations from the valley floor to the ridges this captures inversions (valley colder
//     than the slopes above), which the coarse model misses. Fades out over ~12 h of forecast.
//   - start: measured soil temperature (2" and 8") and snow depth by elevation when the model run
//     begins, so ground frost and snow start from what's really there.

import type { Weather } from './model';

export interface GroundStation {
  id: string;
  name: string;
  net: string;
  lat: number;
  lon: number;
  elev: number;
  km: number;
  temp: (number | null)[];
  soil2?: (number | null)[];
  soil8?: (number | null)[];
  moist2?: (number | null)[];
  snow?: (number | null)[];
}
export interface Ground {
  t: number[];
  stations: GroundStation[];
}

const LAPSE = 0.0065;
const FADE_H = 12;

interface Pt {
  e: number;
  v: number;
  w: number;
}

/** Weighted straight-line fit v = a + b·(e − e0); flat when the stations don't span enough height. */
function fit(pts: Pt[], maxSlope: number) {
  const sw = pts.reduce((s, p) => s + p.w, 0);
  const e0 = pts.reduce((s, p) => s + p.w * p.e, 0) / sw;
  const v0 = pts.reduce((s, p) => s + p.w * p.v, 0) / sw;
  const lo = Math.min(...pts.map((p) => p.e));
  const hi = Math.max(...pts.map((p) => p.e));
  let b = 0;
  if (pts.length >= 3 && hi - lo >= 300) {
    const sxx = pts.reduce((s, p) => s + p.w * (p.e - e0) ** 2, 0);
    const sxy = pts.reduce((s, p) => s + p.w * (p.e - e0) * (p.v - v0), 0);
    b = Math.max(-maxSlope, Math.min(maxSlope, sxy / sxx));
  }
  return { a: v0, b, e0, lo, hi };
}

export interface ByElevation {
  a: number;
  b: number;
  e0: number;
  lo: number;
  hi: number;
}
/**
 * Stations' values at a height: a weighted average favouring stations near that height (within a
 * few hundred metres) and nearby; far-off heights still count a little, so a trail above or below
 * every station takes the closest ones. Null when no station has a value.
 */
export function byHeight(e: number[], w: number[], v: (number | null)[], elev: number): number | null {
  let sw = 0;
  let sv = 0;
  for (let j = 0; j < e.length; j++) {
    const x = v[j];
    if (x == null) continue;
    const k = w[j] * (Math.exp(-(((e[j] - elev) / 200) ** 2)) + 0.01);
    sw += k;
    sv += k * x;
  }
  return sw ? sv / sw : null;
}

/** Value of a fit at an elevation, flat beyond the stations' range. */
export const atElev = (f: ByElevation, e: number) => f.a + f.b * (Math.max(f.lo, Math.min(f.hi, e)) - f.e0);

export function applyStations(wx: Weather, g: Ground | null): Weather {
  if (!g || !g.stations.length) return wx;
  const weight = (s: GroundStation) => 1 / (1 + s.km / 10);
  const gi = (t: number) => Math.round((t - g.t[0]) / 3600);

  // Temperature correction per forecast hour: each station's error (measured − model moved to
  // its height). The trail takes the stations nearest its own height (see byHeight), so a profile
  // that bends — a storm holding near 0 °C through mid-slopes, an inversion — comes through as
  // measured rather than as one straight line through every station from valley to ridge.
  const stations = g.stations.filter((s) => s.temp.some((v) => v != null));
  if (!stations.length) return wx;
  const used = new Set<string>();
  const r: (number | null)[][] = [];
  let last: { r: (number | null)[]; t: number } | null = null;
  for (let i = 0; i < wx.t.length; i++) {
    const t = wx.t[i];
    const k = gi(t);
    const row = stations.map((s) => {
      const obs = k >= 0 && k < g.t.length ? s.temp[k] : null;
      return obs == null ? null : obs - (wx.temp[i] + (wx.elev - s.elev) * LAPSE);
    });
    if (row.some((v) => v != null)) {
      for (const s of stations) if (s.temp[k] != null) used.add(s.name);
      last = { r: row, t };
      r.push(row);
    } else if (last) {
      // Past the last reading: the error fades over ~12 h of forecast.
      const f = Math.exp(-(t - last.t) / 3600 / FADE_H);
      r.push(last.r.map((v) => (v == null ? null : v * f)));
    } else r.push(row);
  }
  const elevs = stations.map((s) => s.elev);
  const weights = stations.map(weight);

  // Measured ground and snow at the start of the model run (3 days back).
  const k0 = gi(wx.t[0]);
  const startFit = (key: 'soil2' | 'soil8' | 'snow', maxSlope: number): ByElevation | null => {
    const pts: Pt[] = [];
    for (const s of g.stations) {
      const arr = s[key];
      if (!arr) continue;
      // First reading within 6 h of the start.
      let v: number | null = null;
      for (let k = Math.max(0, k0); k < Math.min(arr.length, k0 + 6); k++) if (arr[k] != null) { v = arr[k]; break; }
      if (v != null) pts.push({ e: s.elev, v, w: weight(s) });
    }
    return pts.length ? fit(pts, maxSlope) : null;
  };

  // Latest snow depth at each snow station (within the last 6 h).
  const snowSt = g.stations.filter((s) => s.snow);
  let snowNow: Weather['snowNow'];
  for (let k = g.t.length - 1; k >= Math.max(0, g.t.length - 6) && !snowNow; k--) {
    const v = snowSt.map((s) => s.snow![k] ?? null);
    if (v.filter((x) => x != null).length >= 2) snowNow = { at: g.t[k] + 3600, e: snowSt.map((s) => s.elev), w: snowSt.map(weight), v };
  }

  return {
    ...wx,
    snowNow,
    tempFix: { e: elevs, w: weights, r },
    start: { soil2: startFit('soil2', 0.02), soil8: startFit('soil8', 0.02), snowCm: startFit('snow', 1) },
    measured: [...used],
  };
}
