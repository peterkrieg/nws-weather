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
/** Value of a fit at an elevation, flat beyond the stations' range. */
export const atElev = (f: ByElevation, e: number) => f.a + f.b * (Math.max(f.lo, Math.min(f.hi, e)) - f.e0);

export function applyStations(wx: Weather, g: Ground | null): Weather {
  if (!g || !g.stations.length) return wx;
  const weight = (s: GroundStation) => 1 / (1 + s.km / 10);
  const gi = (t: number) => Math.round((t - g.t[0]) / 3600);

  // Temperature correction per forecast hour.
  const a: number[] = [];
  const b: number[] = [];
  let e0 = 0;
  let lo = Infinity;
  let hi = -Infinity;
  let last: { a: number; b: number; t: number } | null = null;
  const used = new Set<string>();
  const fits: (ByElevation | null)[] = wx.t.map((t, i) => {
    const k = gi(t);
    if (k < 0 || k >= g.t.length) return null;
    const pts: Pt[] = [];
    for (const s of g.stations) {
      const obs = s.temp[k];
      if (obs == null) continue;
      const modelThere = wx.temp[i] + (wx.elev - s.elev) * LAPSE;
      pts.push({ e: s.elev, v: obs - modelThere, w: weight(s) });
      used.add(s.name);
    }
    return pts.length ? fit(pts, 0.02) : null;
  });
  const firstFit = fits.find((f) => f) ?? null;
  if (!firstFit) return wx;
  wx.t.forEach((t, i) => {
    const f = fits[i];
    if (f) {
      // Express every hour around one reference elevation so a[i], b[i] share e0.
      if (!e0) e0 = f.e0;
      a.push(f.a + f.b * (e0 - f.e0));
      b.push(f.b);
      lo = Math.min(lo, f.lo);
      hi = Math.max(hi, f.hi);
      last = { a: a[i], b: f.b, t };
    } else if (last) {
      const k = Math.exp(-(t - (last as { t: number }).t) / 3600 / FADE_H);
      a.push((last as { a: number }).a * k);
      b.push((last as { b: number }).b * k);
    } else {
      a.push(firstFit.a + firstFit.b * ((e0 || firstFit.e0) - firstFit.e0));
      b.push(firstFit.b);
    }
  });
  if (!e0) e0 = firstFit.e0;

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

  return {
    ...wx,
    tempFix: { a, b, e0, lo, hi },
    start: { soil2: startFit('soil2', 0.02), soil8: startFit('soil8', 0.02), snowCm: startFit('snow', 1) },
    measured: [...used],
  };
}
