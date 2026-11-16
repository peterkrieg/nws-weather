// Soil (USDA soil survey, SSURGO) and tree cover (US national tree canopy map, NLCD) for trail points.
// Both are fetched per map tile and kept; neither changes on any timescale that matters here.

import { tileBoundsLatLon, tileXY } from './geo';

export interface Soil {
  name: string;
  /** % clay in the surface layer. */
  clay: number;
  /** % rock fragments over 3 inches (cobbles, stones) by volume. */
  rock: number;
  /** % passing a #10 sieve (2 mm) — lower means more gravel. */
  fines: number;
  /** Hydrologic group A (drains fast) … D (slow). */
  group: string;
  /** Saturated hydraulic conductivity, µm/s. */
  ksat: number;
}

export const SOIL_Z = 13;

interface SoilPoly {
  soil: Soil;
  rings: [number, number][][]; // [lon, lat]
  box: [number, number, number, number]; // west, south, east, north
}

function parseWkt(wkt: string): [number, number][][] {
  // POLYGON ((x y, …), (…)) or MULTIPOLYGON (((…)), ((…))): every ring, holes included.
  // Point-in-polygon below uses even-odd, which handles holes and multiple parts alike.
  const rings: [number, number][][] = [];
  for (const m of wkt.matchAll(/\(([^()]+)\)/g)) {
    rings.push(
      m[1].split(',').map((p) => {
        const [x, y] = p.trim().split(/\s+/).map(Number);
        return [x, y] as [number, number];
      }),
    );
  }
  return rings;
}

function inside(rings: [number, number][][], x: number, y: number) {
  let c = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

export class SoilMap {
  private tiles = new Map<string, SoilPoly[] | null>();
  /** `base`: origin serving /api/soil (empty in the app; the live site in scripts). */
  constructor(private base = '') {}

  async load(box: { west: number; south: number; east: number; north: number }) {
    const a = tileXY(box.north, box.west, SOIL_Z);
    const b = tileXY(box.south, box.east, SOIL_Z);
    const jobs: Promise<void>[] = [];
    for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++)
      for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) {
        const k = `${x}/${y}`;
        if (this.tiles.has(k)) continue;
        this.tiles.set(k, null);
        jobs.push(
          this.fetchTile(x, y)
            .then((p) => void this.tiles.set(k, p))
            .catch(() => void this.tiles.delete(k)),
        );
      }
    await Promise.all(jobs);
  }

  private async fetchTile(x: number, y: number): Promise<SoilPoly[]> {
    const r = await fetch(`${this.base}/api/soil/${x}/${y}`);
    if (!r.ok) throw new Error(`soil ${r.status}`);
    return parseSoilRows(((await r.json()) as { Table?: (string | null)[][] }).Table ?? []);
  }

  at(lat: number, lon: number): Soil | null {
    const t = tileXY(lat, lon, SOIL_Z);
    const polys = this.tiles.get(`${Math.floor(t.x)}/${Math.floor(t.y)}`);
    if (!polys) return null;
    for (const p of polys) {
      if (lon < p.box[0] || lon > p.box[2] || lat < p.box[1] || lat > p.box[3]) continue;
      if (inside(p.rings, lon, lat)) return p.soil;
    }
    return null;
  }
}

/** USDA Soil Data Access request for one z13 tile (run server-side, cached). */
export function soilRequest(x: number, y: number): { url: string; body: URLSearchParams } {
    const b = tileBoundsLatLon(x, y, SOIL_Z);
    const poly = `POLYGON((${b.west} ${b.south},${b.east} ${b.south},${b.east} ${b.north},${b.west} ${b.north},${b.west} ${b.south}))`;
    // Each soil area's shape, plus its main component's surface layer.
    const query = `
      SELECT p.mukey, p.mupolygongeo.STIntersection(geometry::STGeomFromText('${poly}',4326)).STAsText() AS wkt,
             c.compname, ch.claytotal_r, ISNULL(ch.frag3to10_r,0) + ISNULL(ch.fraggt10_r,0) AS rock, ch.sieveno10_r, c.hydgrp, ch.ksat_r
      FROM mupolygon p
      CROSS APPLY (SELECT TOP 1 cokey, compname, hydgrp FROM component WHERE mukey = p.mukey ORDER BY comppct_r DESC) c
      LEFT JOIN chorizon ch ON ch.cokey = c.cokey AND ch.hzdept_r = 0
      WHERE p.mupolygongeo.STIntersects(geometry::STGeomFromText('${poly}',4326)) = 1`;
    return { url: 'https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest', body: new URLSearchParams({ format: 'JSON', query }) };
}

function parseSoilRows(rows: (string | null)[][]): SoilPoly[] {
    return rows.flatMap((row) => {
      const [, wkt, name, clay, rock, fines, group, ksat] = row;
      if (!wkt) return [];
      const rings = parseWkt(wkt);
      if (!rings.length) return [];
      let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
      for (const ring of rings) for (const [px, py] of ring) {
        w = Math.min(w, px); e = Math.max(e, px); s = Math.min(s, py); n = Math.max(n, py);
      }
      const soil: Soil = {
        name: name ?? 'Unknown',
        clay: clay == null ? 20 : Number(clay),
        rock: rock == null ? 0 : Number(rock),
        fines: fines == null ? 80 : Number(fines),
        group: (group ?? 'C').slice(0, 1),
        ksat: ksat == null ? 9 : Number(ksat),
      };
      return [{ soil, rings, box: [w, s, e, n] as [number, number, number, number] }];
    });
}

// ---- Tree cover -------------------------------------------------------------------------------
// MRLC's map server only offers tree canopy as a coloured picture, but it colours each percentage
// 0–100 with its own exact colour, so the picture decodes back to values with the legend.

const CANOPY_Z = 14;
const CANOPY_PX = 128; // ~9 m pixels at 40°N for 30 m data
const WMS = 'https://www.mrlc.gov/geoserver/ows';
// Tree canopy (% cover) and land cover class (deciduous / evergreen / shrub…), same tiling.
const LAYERS = { canopy: 'NLCD_Canopy', nlcd: 'mrlc_display:NLCD_2021_Land_Cover_L48' } as const;
export type CoverKind = keyof typeof LAYERS;
export const legendUrl = (kind: CoverKind) => `${WMS}?service=WMS&version=1.1.1&request=GetLegendGraphic&layer=${LAYERS[kind]}&format=application/json`;
export const CANOPY_LEGEND_URL = legendUrl('canopy');

/** MRLC map request for one z14 tile's picture (run server-side, cached). */
export function canopyUrl(x: number, y: number, kind: CoverKind = 'canopy') {
  const b = tileBoundsLatLon(x, y, CANOPY_Z);
  const q = new URLSearchParams({
    service: 'WMS', version: '1.1.1', request: 'GetMap', layers: LAYERS[kind], styles: '', srs: 'EPSG:4326',
    bbox: `${b.west},${b.south},${b.east},${b.north}`, width: String(CANOPY_PX), height: String(CANOPY_PX),
    format: 'image/png', transparent: 'true',
  });
  return `${WMS}?${q}`;
}

export type ImageDecoder = (buf: ArrayBuffer) => Promise<{ data: Uint8ClampedArray; width: number; height: number }>;

export class CanopyMap {
  private tiles = new Map<string, Uint8Array | null>();
  private legend: Map<number, number> | null = null;
  /** kind 'nlcd': land cover class codes (41 deciduous, 42 evergreen, 43 mixed, 52 shrub…) instead of %. */
  constructor(private decode: ImageDecoder | null, private kind: CoverKind = 'canopy') {}

  private async loadLegend() {
    if (this.legend) return this.legend;
    const r = await fetch(`/api/${this.kind}/legend`);
    const j = (await r.json()) as { Legend: { rules: { symbolizers: { Raster: { colormap: { entries: { quantity: string; color: string }[] } } }[] }[] }[] };
    const m = new Map<number, number>();
    for (const e of j.Legend[0].rules[0].symbolizers[0].Raster.colormap.entries) {
      const q = Number(e.quantity);
      if (q <= 100 && (this.kind === 'canopy' || q > 0)) m.set(parseInt(e.color.slice(1), 16), q);
    }
    return (this.legend = m);
  }

  async load(box: { west: number; south: number; east: number; north: number }) {
    if (!this.decode) return;
    const legend = await this.loadLegend().catch(() => null);
    if (!legend) return;
    const a = tileXY(box.north, box.west, CANOPY_Z);
    const b = tileXY(box.south, box.east, CANOPY_Z);
    const jobs: Promise<void>[] = [];
    for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++)
      for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) {
        const k = `${x}/${y}`;
        if (this.tiles.has(k)) continue;
        this.tiles.set(k, null);
        jobs.push(
          this.fetchTile(x, y, legend)
            .then((v) => void this.tiles.set(k, v))
            .catch(() => void this.tiles.delete(k)),
        );
      }
    await Promise.all(jobs);
  }

  private async fetchTile(x: number, y: number, legend: Map<number, number>) {
    const r = await fetch(`/api/${this.kind}/${x}/${y}`);
    if (!r.ok) throw new Error(`canopy ${r.status}`);
    const img = await this.decode!(await r.arrayBuffer());
    const out = new Uint8Array(CANOPY_PX * CANOPY_PX);
    const entries = [...legend.entries()];
    for (let i = 0; i < out.length; i++) {
      const o = i * 4;
      if (img.data[o + 3] < 128) continue; // transparent = 0 % (or no data)
      const rgb = (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2];
      let v = legend.get(rgb);
      if (v == null) {
        // Not an exact colour (resampling or colour management): nearest legend colour.
        let best = Infinity;
        for (const [c, q] of entries) {
          const d = Math.abs((c >> 16) - img.data[o]) + Math.abs(((c >> 8) & 255) - img.data[o + 1]) + Math.abs((c & 255) - img.data[o + 2]);
          if (d < best) { best = d; v = q; }
        }
      }
      out[i] = v ?? 0;
    }
    return out;
  }

  /** Land cover class code at a point (kind 'nlcd'), or null. */
  classAt(lat: number, lon: number): number | null {
    const v = this.raw(lat, lon);
    return v == null || v === 0 ? null : v;
  }

  /** Tree cover 0–1, or null if unknown. */
  at(lat: number, lon: number): number | null {
    const v = this.raw(lat, lon);
    return v == null ? null : v / 100;
  }

  private raw(lat: number, lon: number): number | null {
    const t = tileXY(lat, lon, CANOPY_Z);
    const tile = this.tiles.get(`${Math.floor(t.x)}/${Math.floor(t.y)}`);
    if (!tile) return null;
    // The WMS image is in plain lat/lon, so the pixel row is linear in latitude within the tile.
    const b = tileBoundsLatLon(Math.floor(t.x), Math.floor(t.y), CANOPY_Z);
    const px = Math.min(CANOPY_PX - 1, Math.floor(((lon - b.west) / (b.east - b.west)) * CANOPY_PX));
    const py = Math.min(CANOPY_PX - 1, Math.floor(((b.north - lat) / (b.north - b.south)) * CANOPY_PX));
    return tile[py * CANOPY_PX + px];
  }
}
