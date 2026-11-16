// Terrain for points along trails, from USGS 3DEP elevation (lidar where available; US only).
//
// Two tile sets, both fetched once per area and kept:
//   fine   z15 tiles at 256 px  (~3.6 m at 40°N) — slope, hollows, nearby skyline
//   coarse z12 tiles at 256 px  (~30 m)          — the distant skyline for sun/shade

import { D2R, merc, mPerDeg, offset, tileBoundsMerc, tileXY } from './geo';
import { readDem, type Raster } from './tiff';

export const FINE_Z = 15;
export const COARSE_Z = 12;
const PX = 256;

/** Horizon directions: every 15°, clockwise from north. */
export const AZ_STEPS = 24;
const NEAR = [8, 12, 18, 26, 36, 50, 70, 95, 130, 175, 240, 320];
const FAR = [450, 650, 900, 1250, 1700, 2300, 3100, 4000];

/** Loads one elevation tile (a float32 GeoTIFF, as demUrl returns). */
export type Fetcher = (x: number, y: number, z: number) => Promise<ArrayBuffer>;

interface Tile {
  r: Raster;
  minx: number;
  maxy: number;
  size: number;
}

export function demUrl(x: number, y: number, z: number) {
  const b = tileBoundsMerc(x, y, z);
  const q = new URLSearchParams({
    bbox: `${b.minx},${b.miny},${b.maxx},${b.maxy}`,
    bboxSR: '3857',
    imageSR: '3857',
    size: `${PX},${PX}`,
    format: 'tiff',
    pixelType: 'F32',
    noDataInterpretation: 'esriNoDataMatchAny',
    interpolation: 'RSP_BilinearInterpolation',
    f: 'image',
  });
  return `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?${q}`;
}

export class Dem {
  private tiles = new Map<string, Tile | null>();
  private pending = new Map<string, Promise<void>>();
  constructor(private fetcher: Fetcher) {}

  private key(x: number, y: number, z: number) {
    return `${z}/${x}/${y}`;
  }

  /** Load every tile at zoom z covering the box (degrees), padded by `padM` metres. */
  async load(box: { west: number; south: number; east: number; north: number }, z: number, padM: number) {
    const sw = offset(box.south, box.west, -padM, -padM);
    const ne = offset(box.north, box.east, padM, padM);
    const a = tileXY(ne.lat, sw.lon, z);
    const b = tileXY(sw.lat, ne.lon, z);
    const jobs: Promise<void>[] = [];
    for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++) {
      for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) {
        const k = this.key(x, y, z);
        if (this.tiles.has(k)) {
          // Still downloading for an earlier call: wait for it rather than skip it.
          const inFlight = this.pending.get(k);
          if (inFlight) jobs.push(inFlight);
          continue;
        }
        this.tiles.set(k, null);
        // USGS renders tiles on demand and the first request for an area can fail: one retry.
        const job = this.fetcher(x, y, z)
          .catch(() => new Promise((ok) => setTimeout(ok, 1500)).then(() => this.fetcher(x, y, z)))
          .then(readDem)
          .then((r) => {
            const bounds = tileBoundsMerc(x, y, z);
            this.tiles.set(k, { r, minx: bounds.minx, maxy: bounds.maxy, size: bounds.maxx - bounds.minx });
          })
          .catch(() => void this.tiles.delete(k)) // try again next time
          .finally(() => this.pending.delete(k));
        this.pending.set(k, job);
        jobs.push(job);
      }
    }
    await Promise.all(jobs);
  }

  /** Whether the tile under this point has loaded (so a NaN there means genuinely no data). */
  hasTile(lat: number, lon: number, z = FINE_Z) {
    const t = tileXY(lat, lon, z);
    return !!this.tiles.get(this.key(Math.floor(t.x), Math.floor(t.y), z));
  }

  /** Bilinear elevation in metres, or NaN where there's no data. */
  elev(lat: number, lon: number, z = FINE_Z): number {
    const t = tileXY(lat, lon, z);
    const tile = this.tiles.get(this.key(Math.floor(t.x), Math.floor(t.y), z));
    if (!tile) return z === FINE_Z ? this.elev(lat, lon, COARSE_Z) : NaN;
    const m = merc(lat, lon);
    const px = ((m.x - tile.minx) / tile.size) * PX - 0.5;
    const py = ((tile.maxy - m.y) / tile.size) * PX - 0.5;
    const x0 = Math.max(0, Math.min(PX - 2, Math.floor(px)));
    const y0 = Math.max(0, Math.min(PX - 2, Math.floor(py)));
    const fx = Math.max(0, Math.min(1, px - x0));
    const fy = Math.max(0, Math.min(1, py - y0));
    const d = tile.r.data;
    const v00 = d[y0 * PX + x0];
    const v10 = d[y0 * PX + x0 + 1];
    const v01 = d[(y0 + 1) * PX + x0];
    const v11 = d[(y0 + 1) * PX + x0 + 1];
    const v = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
    return v > -500 && v < 9000 ? v : z === FINE_Z ? this.elev(lat, lon, COARSE_Z) : NaN;
  }
}

export interface PointTerrain {
  lat: number;
  lon: number;
  elev: number;
  /** Hillside slope (radians) and the direction it faces (radians clockwise from north). */
  slope: number;
  aspect: number;
  /** Rise/run along the trail (absolute). */
  grade: number;
  /** Metres the surroundings sit above this point on average (positive = hollow that collects water). */
  hollow: number;
  /** Skyline angle (radians above horizontal) in each of AZ_STEPS directions. */
  horizon: Float32Array;
  /** Fraction of the sky visible (0–1). */
  skyView: number;
}

/**
 * Terrain at a point. `dir` is the trail's bearing here (radians), used for the trail grade.
 */
export function pointTerrain(dem: Dem, lat: number, lon: number, dir: number): PointTerrain | null {
  const e = dem.elev(lat, lon);
  if (!Number.isFinite(e)) return null;
  const at = (dx: number, dy: number) => {
    const p = offset(lat, lon, dx, dy);
    return dem.elev(p.lat, p.lon);
  };
  // Horn's method over a 5 m stencil (bilinear lookups smooth the ~3.6 m pixels a little).
  const s = 5;
  const z = (i: number, j: number) => at(i * s, j * s);
  const dzdx = (z(1, 1) + 2 * z(1, 0) + z(1, -1) - (z(-1, 1) + 2 * z(-1, 0) + z(-1, -1))) / (8 * s);
  const dzdy = (z(-1, 1) + 2 * z(0, 1) + z(1, 1) - (z(-1, -1) + 2 * z(0, -1) + z(1, -1))) / (8 * s);
  const slope = Math.atan(Math.hypot(dzdx, dzdy));
  const aspect = (Math.atan2(-dzdx, -dzdy) + 2 * Math.PI) % (2 * Math.PI);

  const ahead = at(Math.sin(dir) * 5, Math.cos(dir) * 5);
  const behind = at(-Math.sin(dir) * 5, -Math.cos(dir) * 5);
  const grade = Math.abs(ahead - behind) / 10;

  // Hollow: compare with a ring 10 m out, ignoring the hillside's overall tilt.
  let ring = 0;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const dx = Math.sin(a) * 10;
    const dy = Math.cos(a) * 10;
    ring += at(dx, dy) - (e + dzdx * dx + dzdy * dy);
  }
  const hollow = ring / 8;

  const horizon = new Float32Array(AZ_STEPS);
  const m = mPerDeg(lat);
  let sky = 0;
  for (let k = 0; k < AZ_STEPS; k++) {
    const az = (k * 2 * Math.PI) / AZ_STEPS;
    const sx = Math.sin(az);
    const sy = Math.cos(az);
    let best = -Math.PI / 2;
    for (const d of NEAR) {
      const h = dem.elev(lat + (sy * d) / m.lat, lon + (sx * d) / m.lon);
      if (Number.isFinite(h)) best = Math.max(best, Math.atan2(h - e - 1.5, d)); // eye-height offset ignores the tread itself
    }
    for (const d of FAR) {
      const h = dem.elev(lat + (sy * d) / m.lat, lon + (sx * d) / m.lon, COARSE_Z);
      if (Number.isFinite(h)) best = Math.max(best, Math.atan2(h - e, d));
    }
    horizon[k] = best;
    sky += 1 - Math.sin(Math.max(0, best));
  }
  return { lat, lon, elev: e, slope, aspect, grade, hollow, horizon, skyView: sky / AZ_STEPS };
}

/** Skyline angle toward an azimuth (radians), interpolated between the stored directions. */
export function horizonAt(h: Float32Array, az: number) {
  const f = ((az / (2 * Math.PI)) * AZ_STEPS + AZ_STEPS) % AZ_STEPS;
  const i = Math.floor(f);
  const t = f - i;
  return h[i] * (1 - t) + h[(i + 1) % AZ_STEPS] * t;
}

export const deg = (r: number) => r / D2R;
