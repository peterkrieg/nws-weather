// "Outdoors" map style: OpenStreetMap data from OpenFreeMap (free, no key), drawn in the browser
// with MapLibre so we pick the colours. Starts from OpenFreeMap's Liberty style and changes it to
// quiet grey roads, brown dashed trails and hill shading. Loaded only when the style is chosen.

import L from 'leaflet';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl, type StyleSpecification, type LayerSpecification } from 'maplibre-gl';
// MapLibre finds its worker next to its own file, which breaks once bundled; let Vite bundle it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const ROAD = '#ffffff';
const CASING_MAJOR = '#bfbab0';
const CASING_MINOR = '#d9d5cc';
const TRAIL = '#9a5b2a';
const SIDEWALK = '#cfcac0';

function restyle(style: StyleSpecification): StyleSpecification {
  const layers: LayerSpecification[] = [];
  for (const layer of style.layers) {
    const id = layer.id;
    if (id === 'building-3d') continue; // flat map
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
      // Trail names a little sooner and easier to read.
      layers.push({ ...layer, minzoom: 14, paint: { ...layer.paint, 'text-color': '#7a4a22', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 } });
      continue;
    }
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
  return {
    ...style,
    sources: {
      ...style.sources,
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

export async function createOutdoorsLayer(): Promise<L.Layer> {
  const style = await loadStyle();
  return L.maplibreGL({ style, attributionControl: false });
}
