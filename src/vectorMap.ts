// "Outdoors" map style: OpenStreetMap data from OpenFreeMap (free, no key), drawn in the browser
// with MapLibre so we pick the colours. Starts from OpenFreeMap's Liberty style and changes it to
// quiet grey roads, brown dashed trails and hill shading. Loaded only when the style is chosen.

import L from 'leaflet';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl, type FilterSpecification, type LayerSpecification, type Map as MlMap, type StyleSpecification } from 'maplibre-gl';
// MapLibre finds its worker next to its own file, which breaks once bundled; let Vite bundle it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);

import { COND_SOURCE, TrailConditions, conditionLayers, type Status } from './conditions/client';
export type { Status as ConditionsStatus } from './conditions/client';
export type { Stretch } from './conditions/worker';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const ROAD = '#ffffff';
const CASING_MAJOR = '#bfbab0';
const CASING_MINOR = '#d9d5cc';
const TRAIL = '#9a5b2a';
const SIDEWALK = '#cfcac0';

// ---- Mountain bike trails, in Trailforks' colours ------------------------------------------------
// OpenStreetMap rates MTB difficulty with mtb:scale 0–6; the common mapping to trail-sign colours:
export const MTB = [
  { key: 'easy', label: 'Easy', color: '#2f9e44', scale: ['0', '1'] },
  { key: 'intermediate', label: 'Intermediate', color: '#1c6dd0', scale: ['2'] },
  { key: 'difficult', label: 'Difficult', color: '#1a1a1a', scale: ['3'] },
  { key: 'expert', label: 'Very difficult', color: '#1a1a1a', scale: ['4'], double: true },
  { key: 'pro', label: 'Pro line', color: '#e8590c', scale: ['5', '6'] },
] as const;
export const MTB_UNRATED = '#9c36b5';
/** Downhill-only trails when difficulty colours are off. */
export const MTB_DOWNHILL = '#d6336c';

/** First character of mtb_scale ("2+" → "2"). */
const scale = ['slice', ['to-string', ['get', 'mtb_scale']], 0, 1];
const mtbColor = [
  'match',
  scale,
  ...MTB.flatMap((d) => [[...d.scale], d.color]),
  MTB_UNRATED,
];
// Bike trails: anything with an MTB rating, or a dirt path designated for bikes
// (city bike paths and paved trails stay as they are).
const isMtb = [
  'all',
  ['==', ['get', 'class'], 'path'],
  [
    'any',
    ['has', 'mtb_scale'],
    ['all', ['==', ['get', 'bicycle'], 'designated'], ['!=', ['get', 'subclass'], 'cycleway'], ['!=', ['get', 'surface'], 'paved']],
  ],
];
// One-way bike trails: in practice the downhill-only lines.
const isDownhill = ['all', isMtb, ['!=', ['coalesce', ['get', 'oneway'], 0], 0]];
const width = (k: number) => ['interpolate', ['linear'], ['zoom'], 12, 1.2 * k, 14, 2.2 * k, 16, 3.2 * k, 20, 7 * k];

function mtbLayers(): LayerSpecification[] {
  const base = { source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 12 } as const;
  const round = { 'line-cap': 'round', 'line-join': 'round' } as const;
  return [
    // White halo so the coloured line reads on forest green and hill shade alike.
    { ...base, id: 'mtb-halo', type: 'line', filter: isMtb, layout: round, paint: { 'line-color': '#ffffff', 'line-width': width(2), 'line-opacity': 0.9 } },
    { ...base, id: 'mtb-line', type: 'line', filter: isMtb, layout: round, paint: { 'line-color': mtbColor, 'line-width': width(1) } },
    // Double black: white dashes down the middle.
    {
      ...base,
      id: 'mtb-double',
      type: 'line',
      filter: ['all', isMtb, ['==', scale, '4']],
      paint: { 'line-color': '#ffffff', 'line-width': width(0.35), 'line-dasharray': ['literal', [1.5, 2.5]] },
    },
    // One-way trails (downhill lines): arrows pointing the way you ride.
    {
      ...base,
      id: 'mtb-arrows',
      type: 'symbol',
      minzoom: 13, // MapLibre zoom runs one below Leaflet's: this is Leaflet zoom 14
      filter: isDownhill,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 13, 60, 17, 120],
        'icon-image': 'mtb-arrow',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 17, 1],
        'icon-rotate': ['match', ['get', 'oneway'], -1, 180, 0],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-color': mtbColor, 'icon-halo-color': '#ffffff', 'icon-halo-width': 1.5 },
    },
  ] as LayerSpecification[];
}

/** A chevron pointing along the line (east = direction of travel), drawn as a signed-distance icon so it can take any colour. */
function arrowImage() {
  const size = 32;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.strokeStyle = '#000';
  g.lineWidth = 6;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(10, 6);
  g.lineTo(22, 16);
  g.lineTo(10, 26);
  g.stroke();
  return g.getImageData(0, 0, size, size);
}

/** A small filled triangle for summits, signed-distance so it takes the label colour. */
function peakImage() {
  const size = 24;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.beginPath();
  g.moveTo(12, 4);
  g.lineTo(21, 19);
  g.lineTo(3, 19);
  g.closePath();
  g.fill();
  return g.getImageData(0, 0, size, size);
}

function peakLayer(): LayerSpecification {
  return {
    id: 'peak',
    type: 'symbol',
    source: 'openmaptiles',
    'source-layer': 'mountain_peak',
    minzoom: 9,
    filter: ['all', ['match', ['get', 'class'], ['peak', 'volcano'], true, false], ['has', 'name']],
    layout: {
      'icon-image': 'peak-icon',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.45, 14, 0.6],
      'text-field': ['case', ['has', 'ele_ft'], ['format', ['get', 'name'], {}, '\n', {}, ['concat', ['to-string', ['get', 'ele_ft']], ' ft'], { 'font-scale': 0.85 }], ['get', 'name']],
      'text-font': ['Noto Sans Italic'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10.5, 14, 12],
      'text-anchor': 'top',
      'text-offset': [0, 0.5],
      'text-max-width': 8,
      'text-optional': true, // keep the triangle even when the name can't fit
      // Highest summit wins when labels collide.
      'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'ele'], 0]],
    },
    paint: { 'icon-color': '#5c4630', 'text-color': '#4a3826', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.4 },
  } as LayerSpecification;
}

function restyle(style: StyleSpecification): StyleSpecification {
  const layers: LayerSpecification[] = [];
  for (const layer of style.layers) {
    const id = layer.id;
    if (id === 'building-3d') continue; // flat map
    // Trail-condition glow sits under every trail and road line.
    if (id === 'tunnel_motorway_link_casing') layers.push(...conditionLayers());
    if (layer.type === 'line' && 'source-layer' in layer && layer['source-layer'] === 'transportation') {
      const paint = { ...(layer.paint ?? {}) } as Record<string, unknown>;
      if (id.includes('path_pedestrian')) {
        // Trails brown and dashed; sidewalks and plazas a quiet grey.
        paint['line-color'] = ['match', ['get', 'subclass'], ['footway', 'pedestrian', 'steps', 'sidewalk', 'crossing'], SIDEWALK, TRAIL];
        paint['line-dasharray'] = ['literal', [2.2, 1.2]];
        paint['line-width'] = ['interpolate', ['linear'], ['zoom'], 12, 0.8, 14, 1.4, 16, 2, 20, 5];
        if (id.includes('casing')) continue;
        layers.push({ ...layer, minzoom: 12, paint } as LayerSpecification);
        continue;
      } else if (/rail/.test(id)) {
        // leave railways as they are
      } else if (id.includes('casing')) {
        paint['line-color'] = /motorway|trunk|primary|link/.test(id) ? CASING_MAJOR : CASING_MINOR;
      } else if (/motorway|trunk|primary|secondary|tertiary|link|minor|street|service/.test(id)) {
        paint['line-color'] = ROAD;
      }
      layers.push({ ...layer, paint } as LayerSpecification);
      continue;
    }
    if (id === 'highway-name-path' && layer.type === 'symbol') {
      // Trail names as soon as the tiles carry them (MapLibre 14 = Leaflet 15), easier to read, and
      // for old jeep roads (tracks) too, which the stock style labelled only as grey minor roads.
      layers.push({
        ...layer,
        minzoom: 13.5,
        filter: ['match', ['get', 'class'], ['path', 'track'], true, false],
        // Switchbacks: allow the label to bend more than the 45° default or most trails get none.
        layout: { ...layer.layout, 'symbol-spacing': 200, 'text-padding': 1, 'text-max-angle': 85, 'text-letter-spacing': 0.02, 'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11.5, 16, 13] },
        paint: { ...layer.paint, 'text-color': '#7a4a22', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
      } as LayerSpecification);
      continue;
    }
    // Route-number shields on trails ("1901") take the label slot and hide the trail's name.
    if (/shield/.test(id) && 'filter' in layer) {
      layers.push({ ...layer, filter: ['all', layer.filter, ['!', ['match', ['get', 'class'], ['path', 'track'], true, false]]] } as LayerSpecification);
      continue;
    }
    if (id === 'highway-name-minor' && 'filter' in layer) {
      layers.push({ ...layer, filter: ['all', layer.filter, ['!=', ['get', 'class'], 'track']] } as LayerSpecification);
      continue;
    }
    // Bike trails go over every road and path layer, under buildings and labels.
    if (id === 'building') layers.push(...mtbLayers());
    layers.push(layer);
    // Hill shading goes over the land cover, under water, roads and labels.
    if (id === 'landcover_sand') {
      layers.push({
        id: 'hillshade',
        type: 'hillshade',
        source: 'dem',
        paint: {
          'hillshade-exaggeration': 0.35,
          'hillshade-shadow-color': 'rgba(70, 62, 50, 0.55)',
          'hillshade-highlight-color': 'rgba(255, 255, 255, 0.25)',
        },
      });
    }
  }
  // Peaks: the tiles carry them but the stock style never draws them. Last, so a summit wins over
  // a neighbourhood label when they collide.
  layers.push(peakLayer());
  return {
    ...style,
    sources: {
      ...style.sources,
      [COND_SOURCE]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      dem: { type: 'raster-dem', tiles: [DEM], encoding: 'terrarium', tileSize: 256, maxzoom: 14, attribution: 'Terrain: Mapzen, AWS' },
    },
    layers,
  };
}

let stylePromise: Promise<StyleSpecification> | null = null;
const loadStyle = () =>
  (stylePromise ??= fetch(STYLE_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`style ${r.status}`);
      return r.json() as Promise<StyleSpecification>;
    })
    .then(restyle)
    .catch((e) => {
      stylePromise = null; // try again next time
      throw e;
    }));

/**
 * Difficulty colours on: every bike trail coloured by rating. Off: only downhill-only trails are
 * highlighted (one colour, with arrows) and other bike trails look like any other trail.
 */
export function setMtbRatings(map: MlMap | null | undefined, on: boolean) {
  if (!map) return; // layer already taken off the map
  const apply = () => {
    const filter = (on ? isMtb : isDownhill) as FilterSpecification;
    const color = (on ? mtbColor : MTB_DOWNHILL) as never;
    map.setFilter('mtb-halo', filter);
    map.setFilter('mtb-line', filter);
    map.setPaintProperty('mtb-line', 'line-color', color);
    map.setPaintProperty('mtb-arrows', 'icon-color', color);
    map.setLayoutProperty('mtb-double', 'visibility', on ? 'visible' : 'none');
  };
  if (map.isStyleLoaded()) apply();
  else map.once('load', apply);
}

/** Starts trail-condition assessment on this map; call setEnabled on the result. */
export function attachConditions(map: MlMap, onStatus: (s: Status) => void) {
  return new TrailConditions(map, onStatus);
}

export async function createOutdoorsLayer(): Promise<L.Layer> {
  const style = await loadStyle();
  const layer = L.maplibreGL({ style, attributionControl: false });
  // The MapLibre map only exists once the layer is on the Leaflet map.
  layer.on('add', () => {
    const map = layer.getMaplibreMap();
    if (import.meta.env.DEV) (window as unknown as { __gl: unknown }).__gl = map;
    map.on('styleimagemissing', (e: { id: string }) => {
      if (e.id === 'mtb-arrow' && !map.hasImage('mtb-arrow')) map.addImage('mtb-arrow', arrowImage(), { sdf: true });
      if (e.id === 'peak-icon' && !map.hasImage('peak-icon')) map.addImage('peak-icon', peakImage(), { sdf: true });
    });
  });
  return layer;
}
