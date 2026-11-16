// Trail surface conditions: an hour-by-hour budget of water, frost, ice and snow for the top few
// centimetres of a trail.
//
//   water in  = rain (less a little caught by trees) + snowmelt, boosted where the ground collects
//               runoff (hollows, flat benches cut into a hillside), reduced where a steep trail sheds it
//   water out = drainage into the soil below (by soil type and rockiness)
//             + evaporation, driven by sun actually reaching that spot (skyline shading, slope angle,
//               tree cover) plus air dryness and wind
//
// The ratio of water held to what the surface can hold maps to dry / tacky / damp / muddy.
//
// Cold weather:
//   ground    two layers (~2" and ~8") that warm and cool towards the surface temperature, with
//             wet ground held near 0 °C while it freezes or thaws (the water has to change state
//             first). Starts from measured soil temperatures when SNOTEL sites are near.
//   frozen    the top crust (~1 cm) or the top layer mostly frozen: firm ("frozen firm").
//   ice       water arriving on a frozen surface (melt from snow above, rain, seepage) or standing
//             water freezing; thin snow that has melted and refrozen also counts as icy.
//   snow      soft when fresh or deep, packed once a day old and shallow (assumes the trail is used).
// Constants are hand-set and checked against real observations (see conditions/model.test).

import { sunPos } from './geo';
import type { Soil } from './landcover';
import { horizonAt, type PointTerrain } from './terrain';
import { atElev, type ByElevation } from './stations';

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
  /** Measured-station correction to temperature (conditions/stations.ts): add a[i] + b[i]·(elev − e0). */
  tempFix?: { a: number[]; b: number[]; e0: number; lo: number; hi: number };
  /** Measured soil temperature (°C) and snow depth (cm) by elevation at the first hour. */
  start?: { soil2: ByElevation | null; soil8: ByElevation | null; snowCm: ByElevation | null };
  /** Stations used, for the explanation. */
  measured?: string[];
  /** NOAA's daily snow analysis (SNODAS, 1 km cells): snow water (mm) at `at`. */
  snodas?: { at: number; cells: { lat: number; lon: number; swe: number | null }[] };
}

export type State = 'dry' | 'tacky' | 'damp' | 'muddy' | 'frozen' | 'icy' | 'packed_snow' | 'soft_snow';
export const SNOWY: State[] = ['packed_snow', 'soft_snow'];

export interface Site {
  terrain: PointTerrain;
  soil: Soil | null;
  canopy: number | null;
  /** OpenStreetMap surface tag, if any. */
  surface?: string;
  /** National land cover class: 41 deciduous, 42 evergreen, 43 mixed forest, 52 shrub… */
  cover?: number | null;
  /** What Sentinel-2 last saw here (20 m pixel), if it had a clear look. */
  seen?: { snow: boolean; at: number } | null;
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
    cover: number | null;
    surface?: string;
    ground: number; // °C, top layer
    frost: number; // 0–1, top layer frozen
    deepFrozen: boolean; // ~8" down frozen: water can't soak away
    ice: number; // mm of ice on the surface
    refrozen: boolean; // snow that melted and refroze
    hoursSinceSnow: number | null;
    under: 'frozen' | 'mud' | 'firm' | null; // what's under the snow
    measured?: string[];
    seen?: { snow: boolean; at: number } | null; // satellite look used
  };
  /** First forecast hour (unix s) when it should be tacky, dry or frozen firm, if it isn't now. */
  goodBy: number | null;
  /** Frozen firm now: first forecast hour it softens. */
  thawBy: number | null;
}

const LAPSE = 0.0065;
/** Ice on the surface (mm of water) that counts as icy: more than a skim on a puddle. */
const ICY_MM = 2;

/**
 * Ground heat constants, fitted to SNOTEL 2" soil temperatures (scripts/fit-ground.mts).
 * k1: how fast the top layer follows the surface per hour; kSnow: the same under snow; couple and
 * k2: exchange with the deeper layer; sun: °C of surface warming per W/m² of sun on it.
 */
export const GROUND = { k1: 0.04, kSnow: 0.03, couple: 0.03, k2: 0.025, sun: 0.004 };
/** The top ~1 cm crust, which freezes on a clear night before the ground 2" down does. Not fitted
 * (no sensors that shallow): to be checked against "frozen firm" reports. */
export const SKIN = { k: 0.3, kSnow: 0.05, couple: 0.05, latent: 4 };

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
  // Mapped as bare rock (the soil survey's "Rock outcrop" parts): drains like gravel.
  if (soil && /rock outcrop|rubble land/i.test(soil.name) ) return { cap: 4, drain: 0.3 };
  const clay = soil?.clay ?? 20;
  const rock = Math.min(60, soil?.rock ?? 5);
  const gravel = Math.max(0, 85 - (soil?.fines ?? 85)); // % coarser than 2 mm, roughly
  const cap = (6 + 0.3 * clay) * (1 - rock / 150) * (1 - gravel / 200);
  const base = { A: 0.2, B: 0.1, C: 0.05, D: 0.025 }[soil?.group ?? 'C'] ?? 0.05;
  return { cap, drain: base * (1 + rock / 50 + gravel / 60) };
}

/** A station-fitted value at an elevation; beyond the stations' range, carried on with the usual lapse rate. */
function startTemp(f: ByElevation | null | undefined, elev: number): number | null {
  if (!f) return null;
  const clamped = Math.max(f.lo, Math.min(f.hi, elev));
  return atElev(f, elev) - (elev - clamped) * LAPSE;
}

/** Ground layer state from its heat content H (°C·units): above 0 thawed, 0…−L freezing, below fully frozen. */
function fromHeat(H: number, L: number) {
  if (H >= 0) return { t: H, frost: 0 };
  if (H > -L) return { t: 0, frost: -H / L };
  return { t: H + L, frost: 1 };
}
const toHeat = (t: number, frost: number, L: number) => (t > 0 ? t : t < 0 ? t - L : -frost * L);

export function simulate(site: Site, wx: Weather, targetSec: number): Result {
  const tr = site.terrain;
  const { cap, drain } = surfaceParams(site);
  const fieldCap = 0.6 * cap;
  // How much of the tree cover's shade is there: conifers all year; deciduous trees and shrubs
  // (Gambel oak in the foothills) keep only their branches' shade November to April.
  const bare = site.cover === 42 ? 0.85 : site.cover === 41 ? 0.25 : site.cover === 43 ? 0.55 : site.cover === 52 ? 0.3 : 0.5;
  const leaf = (ms: number) => {
    const mth = new Date(ms).getUTCMonth();
    return mth >= 4 && mth <= 9 ? 0.85 : bare;
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

  // Temperature here: the model's, moved to this elevation, corrected by measured stations.
  const fix = wx.tempFix;
  const airTemp = (i: number) => {
    let t = wx.temp[i] + (wx.elev - tr.elev) * LAPSE;
    if (fix) t += fix.a[i] + fix.b[i] * (Math.max(fix.lo, Math.min(fix.hi, tr.elev)) - fix.e0);
    return t;
  };

  // Snow at the start: measured depth by elevation where stations cover this height (tapering to
  // the model's below the lowest station), else the model's. SWE ≈ depth × 0.25.
  const modelSwe = wx.snowDepth[i0] * 250;
  let swe = modelSwe;
  const sf = wx.start?.snowCm;
  if (sf) {
    const measuredSwe = Math.max(0, atElev(sf, tr.elev)) * 2.5;
    const below = Math.max(0, sf.lo - tr.elev);
    const k = Math.max(0, 1 - below / 300); // trust the stations fully within their range, none 300 m below
    swe = k * measuredSwe + (1 - k) * modelSwe;
  }

  // Ground temperature at the start: measured where possible, else the model's surface soil temperature.
  const modelSoil = wx.soilTemp[i0] + (wx.elev - tr.elev) * LAPSE;
  const g1Start = startTemp(wx.start?.soil2, tr.elev) ?? modelSoil;
  const g2Start = startTemp(wx.start?.soil8, tr.elev) ?? (g1Start + modelSoil) / 2 + 0.5;
  const latent = (wet: number) => 1 + 12 * Math.max(0, Math.min(1.2, wet)); // wet ground resists freeze/thaw
  const L2 = 8;
  let H1 = toHeat(g1Start, g1Start < 0 ? 1 : 0, latent(w / cap));
  let Hs = toHeat(g1Start, g1Start < 0 ? 1 : 0, SKIN.latent * latent(w / cap) / 13);
  let H2 = toHeat(g2Start, g2Start < 0 ? 1 : 0, L2);
  let ice = 0;
  let refrozen = false;
  let meltedToday = false;
  let lastSnow: number | null = swe > 5 ? wx.t[i0] - 48 * 3600 : null;

  // NOAA's snow analysis for the 1 km cell here, applied when the run reaches its time: bare cells
  // clear the model's snow (less so in shade, where pockets outlast the cell), snowy cells pull the
  // depth halfway to theirs, and shaded spots the model had melted out get some back.
  let snodasSwe: number | null = null;
  if (wx.snodas) {
    let best = Infinity;
    for (const c of wx.snodas.cells) {
      const d = (c.lat - tr.lat) ** 2 + ((c.lon - tr.lon) * 0.77) ** 2;
      if (c.swe != null && d < best) [best, snodasSwe] = [d, c.swe];
    }
    if (best > 0.0002) snodasSwe = null; // more than ~1.5 km away: not this cell
  }
  let snodasDone = false;
  let litHours = 0;
  let dayHours = 0;

  let rain72 = 0;
  let lastRain: number | null = null;
  const dayStart = Math.floor((targetSec - 7 * 3600) / 86400) * 86400 + 7 * 3600; // local midnight, Mountain time
  let sunToday = 0;
  let sunFull = 0;
  let sunEnergy = 0;
  let flatEnergy = 0;
  let atTarget: Result | null = null;
  let goodBy: number | null = null;
  let thawBy: number | null = null;
  const good = (s: State) => s === 'dry' || s === 'tacky' || s === 'frozen';

  for (let i = i0; i < wx.t.length; i++) {
    const tEnd = wx.t[i];
    const tMid = (tEnd - 1800) * 1000;
    const temp = airTemp(i);

    // --- Water in
    const p = wx.precip[i] * wx.precipScale;
    const snowShare = Math.max(0, Math.min(1, (1.5 - temp) / 2));
    let rain = p * (1 - snowShare) * (1 - 0.15 * canopy);
    const newSnow = p * snowShare;
    swe += newSnow;
    if (newSnow > 1) {
      lastSnow = tEnd;
      refrozen = false; // fresh snow on top
    }

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

    if (alt > 0.05) {
      dayHours++;
      if (direct) litHours++;
    }
    if (!snodasDone && snodasSwe != null && wx.snodas && tEnd >= wx.snodas.at) {
      snodasDone = true;
      const shaded = dayHours > 0 && litHours / dayHours < 0.35;
      if (snodasSwe < 2) swe = shaded ? swe * 0.7 : Math.min(swe, 1);
      else if (swe > 0) swe = 0.5 * swe + 0.5 * snodasSwe;
      else if (shaded) swe = 0.5 * snodasSwe;
    }

    // The satellite's look, when the run reaches its time: snow there or not, at 20 m. Under dense
    // trees it can't see the ground, so "bare" only counts in the open.
    const seen = site.seen;
    if (seen && seen.at >= wx.t[i0] - 3600 && tEnd >= seen.at && tEnd - 3600 < seen.at) {
      if (seen.snow) swe = Math.max(swe, snodasSwe != null && snodasSwe >= 2 ? snodasSwe : 15);
      else if (canopy < 0.5) {
        swe = 0;
        refrozen = false;
      }
    }

    // Surface temperature, roughly: warmed by sun, chilled on clear nights; snow-covered ≤ 0 °C.
    const snowCover = swe > 5;
    let tSurf = temp + GROUND.sun * rs - (rs === 0 ? 2 * (1 - wx.cloud[i] / 100) : 0);
    if (snowCover) tSurf = Math.min(0, tSurf);

    // --- Ground: the top layer follows the surface (insulated under snow), the deeper one follows it.
    const wetNow = w / cap;
    const L1 = latent(wetNow);
    const Ls = (SKIN.latent * L1) / 13;
    const gs = fromHeat(Hs, Ls);
    const g1 = fromHeat(H1, L1);
    const g2 = fromHeat(H2, L2);
    const drive = snowCover ? Math.min(0, temp) * (swe > 25 ? 0.05 : 0.3) : tSurf;
    Hs += (snowCover ? SKIN.kSnow : SKIN.k) * (drive - gs.t) + SKIN.couple * (g1.t - gs.t);
    H1 += (snowCover ? GROUND.kSnow : GROUND.k1) * (drive - g1.t) + GROUND.couple * (g2.t - g1.t);
    H2 += GROUND.k2 * (g1.t - g2.t);
    const skin = fromHeat(Hs, Ls);
    const ground = fromHeat(H1, L1);
    const deep = fromHeat(H2, L2);
    const frozenTop = skin.frost > 0.6 || ground.frost > 0.5;
    const deepFrozen = deep.frost > 0.5;

    // --- Snowmelt
    let melt = 0;
    if (swe > 0) {
      melt = Math.min(swe, Math.max(0, 0.12 * temp + (temp > -2 ? 0.0025 * rs : 0)));
      swe -= melt;
      if (melt > 0.2) meltedToday = true;
      // Melted, then frozen again: the snow turns to a crust or ice.
      if (meltedToday && tSurf < -1) {
        refrozen = true;
        meltedToday = false;
      }
    }

    // --- Ice: liquid water meeting a frozen surface freezes onto it.
    let input = rain + melt;
    if (input > 0 && (tSurf < -0.5 || (frozenTop && temp < 0.5))) {
      const f = input * 0.6;
      ice += f * runon;
      input -= f;
      rain = Math.max(0, rain - f);
    }
    const standing = Math.max(0, w - fieldCap);
    if (standing > 0 && tSurf < -1 && !snowCover) {
      const f = Math.min(standing * 0.3, 0.15); // puddles skin over slowly
      ice += f;
      w -= f;
    }
    if (ice > 0 && tSurf > 0.5) {
      const m = Math.min(ice, 0.08 * temp + 0.002 * rs);
      ice -= m;
      w += m;
    }

    if (tEnd <= targetSec && tEnd > targetSec - 72 * 3600) {
      rain72 += rain + melt;
      if (rain + melt > 0.5) lastRain = tEnd;
    }
    const extra = Math.max(0, runon - 1) * input;
    seep += extra * 0.5;
    const release = seep * SEEP_RATE;
    seep -= release;
    w = Math.min(cap * 1.3, w + input * Math.min(runon, 1) + extra * 0.5 + release);

    // --- Water out: frozen ground below stops water soaking away (thawed mud over frost is the worst).
    const drainNow = frozenTop ? 0 : deepFrozen ? drain * 0.15 : drain;
    w -= drainNow * Math.max(0, w - fieldCap);
    const radEvap = (rs * 0.6 * 3600) / 2.45e6; // mm/h if all absorbed sun went into evaporation
    const airEvap = 0.05 * vpd(temp, wx.rh[i]) * (1 + 0.5 * wx.wind[i]) * (1 - 0.4 * canopy);
    const wetness = w / cap;
    const evap = (radEvap + airEvap) * Math.max(0.1, Math.min(1, wetness / 0.6)) * (frozenTop ? 0.3 : 1) * (swe > 3 ? 0 : 1);
    w = Math.max(0, w - evap);

    const wet = w / cap;
    const sinceSnow = lastSnow == null ? Infinity : (tEnd - lastSnow) / 3600;
    let state: State;
    // Refrozen snow: a thin layer (≲2") is basically ice; thicker, it's a crust over snow.
    if (snowCover) state = refrozen && swe < 12 ? 'icy' : !refrozen && (sinceSnow < 18 || swe > 40) ? 'soft_snow' : 'packed_snow';
    else if (ice > ICY_MM) state = 'icy';
    else if (frozenTop) state = wet > 0.28 ? 'frozen' : 'dry';
    else state = wet >= 0.62 ? 'muddy' : wet >= 0.45 ? 'damp' : wet >= 0.28 ? 'tacky' : 'dry';

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
          cover: site.cover ?? null,
          surface: site.surface,
          ground: ground.t,
          frost: Math.max(skin.frost, ground.frost),
          deepFrozen,
          ice,
          refrozen,
          hoursSinceSnow: Number.isFinite(sinceSnow) ? sinceSnow : null,
          under: snowCover ? (frozenTop ? 'frozen' : wet >= 0.62 ? 'mud' : 'firm') : null,
          measured: wx.measured,
          seen: seen && seen.at >= wx.t[i0] - 3600 && seen.at <= targetSec ? seen : null,
        },
        goodBy: null,
        thawBy: null,
      };
      if (good(state)) goodBy = tEnd;
    } else if (atTarget && tEnd > targetSec) {
      if (goodBy == null && good(state)) goodBy = tEnd;
      if (atTarget.state === 'frozen' && thawBy == null && !frozenTop) thawBy = tEnd;
    }
  }
  if (!atTarget) throw new Error('weather ends before the target time');
  atTarget.why.sunFull = sunFull;
  atTarget.why.sunShare = flatEnergy > 0 ? sunEnergy / flatEnergy : 0;
  atTarget.goodBy = good(atTarget.state) ? null : goodBy;
  atTarget.thawBy = atTarget.state === 'frozen' ? thawBy : null;
  return atTarget;
}
