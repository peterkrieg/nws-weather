// Trail surface wetness: an hour-by-hour water budget for the top few centimetres of a trail.
//
//   water in  = rain (less a little caught by trees) + snowmelt, boosted where the ground collects
//               runoff (hollows, flat benches cut into a hillside), reduced where a steep trail sheds it
//   water out = drainage into the soil below (by soil type and rockiness)
//             + evaporation, driven by sun actually reaching that spot (skyline shading, slope angle,
//               tree cover) plus air dryness and wind
//
// The ratio of water held to what the surface can hold maps to dry / tacky / damp / muddy.
// Constants are hand-set and checked against real observations (see conditions/model.test).

import { sunPos } from './geo';
import type { Soil } from './landcover';
import { horizonAt, type PointTerrain } from './terrain';

export interface Weather {
  elev: number;
  t: number[]; // unix seconds, end of each hour
  temp: number[];
  rh: number[];
  wind: number[];
  sw: number[];
  cloud: number[];
  precip: number[];
  snowfall: number[];
  snowDepth: number[];
  soilMoist: number[];
  soilTemp: number[];
  precipScale: number;
}

export type State = 'dry' | 'tacky' | 'damp' | 'muddy' | 'frozen' | 'snow';

export interface Site {
  terrain: PointTerrain;
  soil: Soil | null;
  canopy: number | null;
  /** OpenStreetMap surface tag, if any. */
  surface?: string;
}

export interface Result {
  state: State;
  /** Surface wetness 0 (dry) … 1+ (saturated). */
  wet: number;
  /** Snow water on the ground, mm. */
  swe: number;
  /** Explanation inputs. */
  why: {
    rain72: number; // mm reaching the ground in the last 72 h
    hoursSinceRain: number | null;
    sunToday: number; // hours of direct sun so far today (to the target time)
    sunFull: number; // hours of direct sun over the whole target day
    sunShare: number; // that day's sun energy vs open flat ground, 0–1
    collects: boolean; // hollow or bench
    sheds: boolean;
    soil: string;
    rocky: boolean;
    canopy: number | null;
    surface?: string;
  };
  /** First forecast hour (unix s) when it should be tacky or better, if it isn't now. */
  goodBy: number | null;
}

const LAPSE = 0.0065;

/** Erbs diffuse fraction from clearness index. */
function diffuseFraction(kt: number) {
  if (kt <= 0.22) return 1 - 0.09 * kt;
  if (kt <= 0.8) return 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
  return 0.165;
}

function vpd(tC: number, rh: number) {
  const es = 0.6108 * Math.exp((17.27 * tC) / (tC + 237.3));
  return Math.max(0, es * (1 - rh / 100));
}

const FAST_SURFACES = new Set(['gravel', 'fine_gravel', 'compacted', 'rock', 'pebblestone', 'stone', 'paved', 'asphalt', 'concrete', 'sand']);

/** How much water the surface holds (mm) and how fast it drains (fraction per hour above field capacity). */
function surfaceParams(site: Site) {
  const s = site.surface;
  if (s && FAST_SURFACES.has(s)) {
    if (s === 'paved' || s === 'asphalt' || s === 'concrete') return { cap: 2, drain: 0.6 };
    return { cap: 5, drain: 0.25 };
  }
  const soil = site.soil;
  const clay = soil?.clay ?? 20;
  const rock = Math.min(60, soil?.rock ?? 5);
  const gravel = Math.max(0, 85 - (soil?.fines ?? 85)); // % coarser than 2 mm, roughly
  const cap = (6 + 0.3 * clay) * (1 - rock / 150) * (1 - gravel / 200);
  const base = { A: 0.2, B: 0.1, C: 0.05, D: 0.025 }[soil?.group ?? 'C'] ?? 0.05;
  return { cap, drain: base * (1 + rock / 50 + gravel / 60) };
}

export function simulate(site: Site, wx: Weather, targetSec: number): Result {
  const tr = site.terrain;
  const { cap, drain } = surfaceParams(site);
  const fieldCap = 0.6 * cap;
  const leaf = (ms: number) => {
    const mth = new Date(ms).getUTCMonth();
    return mth >= 4 && mth <= 9 ? 0.85 : 0.5; // deciduous trees still shade a little when bare
  };
  const canopy = site.canopy ?? 0.2;

  // Ground that gathers water: a hollow (the surroundings sit above it) collects runoff and seepage
  // from around it; a rib or nose sheds it. (Trail grade from mapped lines isn't reliable enough on
  // steep ground to spot flat benches, so the hollow measure carries this.)
  const collectsBy = Math.max(0, Math.min(1, 0.6 * (tr.hollow - 0.2)));
  const collects = collectsBy > 0.15;
  const shedsBy = Math.max(0, Math.min(0.5, 0.5 * (-tr.hollow - 0.1)));
  const sheds = shedsBy > 0.1;
  const runon = 1 + collectsBy - shedsBy;

  const i0 = wx.t.findIndex((t) => t > targetSec - 72 * 3600);
  if (i0 < 0) throw new Error('weather does not cover the target time');
  const sm0 = wx.soilMoist[i0];
  let w = cap * Math.max(0, Math.min(1, (sm0 - 0.12) / 0.33));
  // Water seeping in from the slope above: collecting spots get part of their extra water late,
  // released over a day or two after the rain stops (lateral flow through the hillside).
  let seep = 0;
  const SEEP_RATE = 0.04;
  let swe = wx.snowDepth[i0] * 250;

  let rain72 = 0;
  let lastRain: number | null = null;
  const dayStart = Math.floor((targetSec - 7 * 3600) / 86400) * 86400 + 7 * 3600; // local midnight, Mountain time
  let sunToday = 0;
  let sunFull = 0;
  let sunEnergy = 0;
  let flatEnergy = 0;
  let atTarget: Result | null = null;
  let goodBy: number | null = null;

  for (let i = i0; i < wx.t.length; i++) {
    const tEnd = wx.t[i];
    const tMid = (tEnd - 1800) * 1000;
    const temp = wx.temp[i] + (wx.elev - tr.elev) * LAPSE;

    // --- Water in
    const p = wx.precip[i] * wx.precipScale;
    const snowShare = Math.max(0, Math.min(1, (1.5 - temp) / 2));
    const rain = p * (1 - snowShare) * (1 - 0.15 * canopy);
    swe += p * snowShare;

    // --- Sun reaching this spot
    const { alt, az } = sunPos(tMid, tr.lat, tr.lon);
    let rs = 0;
    let direct = false;
    const sw = wx.sw[i];
    if (alt > 0.01 && sw > 0) {
      const kt = Math.min(1, sw / (1361 * Math.sin(alt)));
      const dif = sw * diffuseFraction(kt);
      const dni = Math.min(1000, (sw - dif) / Math.sin(alt));
      const cosInc = Math.sin(alt) * Math.cos(tr.slope) + Math.cos(alt) * Math.sin(tr.slope) * Math.cos(az - tr.aspect);
      const lit = alt > horizonAt(tr.horizon, az) && cosInc > 0;
      direct = lit && dni > 120;
      const tau = 1 - canopy * leaf(tMid);
      rs = ((lit ? dni * cosInc : 0) + dif * tr.skyView) * tau;
      if (tEnd > dayStart && tEnd <= dayStart + 86400) {
        if (direct) sunFull += 1;
        if (direct && tEnd <= targetSec) sunToday += 1;
        sunEnergy += lit ? dni * cosInc * tau : 0;
        flatEnergy += dni * Math.sin(alt);
      }
    }

    // Ground surface temperature, roughly: warmed by sun, chilled on clear nights.
    const tSurf = temp + 0.012 * rs - (rs === 0 ? 2 * (1 - wx.cloud[i] / 100) : 0);
    const frozen = tSurf < -0.5;

    // --- Snowmelt
    let melt = 0;
    if (swe > 0) {
      melt = Math.min(swe, Math.max(0, 0.12 * temp + (temp > -2 ? 0.0025 * rs : 0)));
      swe -= melt;
    }

    const input = rain + melt;
    if (tEnd <= targetSec && tEnd > targetSec - 72 * 3600) {
      rain72 += input;
      if (input > 0.5) lastRain = tEnd;
    }
    const extra = Math.max(0, runon - 1) * input;
    seep += extra * 0.5;
    const release = seep * SEEP_RATE;
    seep -= release;
    w = Math.min(cap * 1.3, w + input * Math.min(runon, 1) + extra * 0.5 + release);

    // --- Water out
    w -= drain * Math.max(0, w - fieldCap);
    const radEvap = (rs * 0.6 * 3600) / 2.45e6; // mm/h if all absorbed sun went into evaporation
    const airEvap = 0.05 * vpd(temp, wx.rh[i]) * (1 + 0.5 * wx.wind[i]) * (1 - 0.4 * canopy);
    const wetness = w / cap;
    const evap = (radEvap + airEvap) * Math.max(0.1, Math.min(1, wetness / 0.6)) * (frozen ? 0.3 : 1) * (swe > 3 ? 0 : 1);
    w = Math.max(0, w - evap);

    const wet = w / cap;
    const state: State = swe > 5 ? 'snow' : frozen && wet > 0.45 ? 'frozen' : wet >= 0.62 ? 'muddy' : wet >= 0.45 ? 'damp' : wet >= 0.28 ? 'tacky' : 'dry';

    if (!atTarget && tEnd >= targetSec) {
      atTarget = {
        state,
        wet,
        swe,
        why: {
          rain72,
          hoursSinceRain: lastRain == null ? null : (targetSec - lastRain) / 3600,
          sunToday,
          sunFull: 0,
          sunShare: 0,
          collects,
          sheds,
          soil: site.soil?.name ?? 'unknown soil',
          rocky: (site.soil?.rock ?? 0) >= 20 || (site.soil?.fines ?? 100) < 70,
          canopy: site.canopy,
          surface: site.surface,
        },
        goodBy: null,
      };
      if (state === 'dry' || state === 'tacky') goodBy = tEnd;
    } else if (atTarget && goodBy == null && (state === 'dry' || state === 'tacky') && tEnd > targetSec) {
      goodBy = tEnd;
    }
  }
  if (!atTarget) throw new Error('weather ends before the target time');
  atTarget.why.sunFull = sunFull;
  atTarget.why.sunShare = flatEnergy > 0 ? sunEnergy / flatEnergy : 0;
  atTarget.goodBy = atTarget.state === 'dry' || atTarget.state === 'tacky' ? null : goodBy;
  return atTarget;
}
