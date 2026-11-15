import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { LayersControl, MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { createElementObject, createLayerComponent } from '@react-leaflet/core';
import type { Loc } from './api';
import { AQ_LAYER, AirQualityLayer } from './AirQuality';
import MtbLegend from './MtbLegend';

const AQ_KEY = 'wx:aq';
/** Phones and tablets: one finger scrolls the page, two fingers move the map. */
const TOUCH = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

const pending = L.divIcon({ className: '', html: '<div class="pin pin-pending"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
const pin = L.divIcon({ className: '', html: '<div class="pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ESRI_ATTR = 'Tiles &copy; <a href="https://www.esri.com">Esri</a>';
/** Map styles. All are free to use without a key, with attribution. */
export const BASES: {
  name: string;
  note: string;
  url: string;
  attribution: string;
  maxNativeZoom: number;
  vector?: boolean;
}[] = [
  {
    name: 'Outdoors',
    note: 'OpenStreetMap with quiet grey roads, brown trails and hill shading.',
    url: '',
    attribution: `${OSM_ATTR} | <a href="https://openfreemap.org">OpenFreeMap</a> | <a href="https://openmaptiles.org">OpenMapTiles</a>`,
    maxNativeZoom: 19,
    vector: true,
  },
  {
    name: 'Street',
    note: 'OpenStreetMap standard. Detailed, bold road colors.',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: OSM_ATTR,
    maxNativeZoom: 19,
  },
  {
    name: 'Trails',
    note: 'CyclOSM. Muted roads, trails stand out.',
    url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    attribution: `${OSM_ATTR} | <a href="https://www.cyclosm.org">CyclOSM</a>`,
    maxNativeZoom: 19,
  },
  {
    name: 'Light',
    note: 'Esri World Topo. Clean and quiet, like Google Maps terrain. No trails.',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: `${ESRI_ATTR}, HERE, Garmin, USGS, NGA, EPA, NPS`,
    maxNativeZoom: 19,
  },
  {
    name: 'Topo',
    note: 'OpenTopoMap. Contours and hill shading, trails shown.',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: `${OSM_ATTR}, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
    maxNativeZoom: 17,
  },
  {
    name: 'USGS Topo',
    note: 'US only. Classic USGS quad style with trails.',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    attribution: 'USGS The National Map',
    maxNativeZoom: 16,
  },
  {
    name: 'Satellite',
    note: 'Esri World Imagery.',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: `${ESRI_ATTR}, Maxar, Earthstar Geographics`,
    maxNativeZoom: 19,
  },
];

const validBase = (name: string) => (BASES.some((b) => b.name === name) ? name : 'Street');

/**
 * The Outdoors style is drawn by MapLibre (about 250 KB), so it's fetched only when that style is
 * on screen. This stand-in layer is what the layer switch adds and removes.
 */
const LazyVector = L.Layer.extend({
  initialize(this: L.Layer & { opts: { attribution: string } }, attribution: string) {
    this.opts = { attribution };
    (this as unknown as { options: L.LayerOptions }).options = { attribution };
  },
  onAdd(this: L.Layer & { gl?: L.Layer; on_?: boolean }, map: L.Map) {
    this.on_ = true;
    import('./vectorMap')
      .then((m) => m.createOutdoorsLayer())
      .then((gl) => {
        if (!this.on_) return;
        this.gl = gl;
        gl.addTo(map);
      })
      .catch(() => {
        /* offline or blocked: the map stays blank until another style is chosen */
      });
    return this;
  },
  onRemove(this: L.Layer & { gl?: L.Layer; on_?: boolean }) {
    this.on_ = false;
    this.gl?.remove();
    this.gl = undefined;
    return this;
  },
}) as unknown as new (attribution: string) => L.Layer;

const VectorLayer = createLayerComponent<L.Layer, { attribution: string }>(
  (props, ctx) => createElementObject(new LazyVector(props.attribution), ctx),
);

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function aqSaved() {
  try {
    return localStorage.getItem(AQ_KEY) === '1';
  } catch {
    return false;
  }
}

function Controller({
  loc,
  onPick,
  onTap,
  onBase,
}: {
  loc: Loc | null;
  onPick: (lat: number, lon: number) => void;
  onTap: (lat: number, lon: number) => void;
  onBase: (name: string) => void;
}) {
  const map = useMap();
  useMapEvents({
    click: (e) => {
      const { lat, lng } = e.latlng.wrap();
      // On touch screens a stray tap while scrolling shouldn't switch the forecast, so ask first.
      if (TOUCH) onTap(lat, lng);
      else onPick(lat, lng);
    },
    overlayadd: (e) => e.name === AQ_LAYER && save(AQ_KEY, '1'),
    overlayremove: (e) => e.name === AQ_LAYER && save(AQ_KEY, '0'),
    baselayerchange: (e) => onBase(e.name),
  });

  // Recenter for searches / saved locations, but leave the view alone when the user clicked the map.
  useEffect(() => {
    if (loc && loc.source !== 'map') map.setView([loc.lat, loc.lon], Math.max(map.getZoom(), 12));
  }, [loc, map]);

  // The card grows and shrinks with the forecast column next to it.
  useEffect(() => {
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);

  return null;
}

/**
 * Full-screen toggle. While full screen, one finger moves the map (there's no page to scroll),
 * and the phone's back gesture or Esc closes it.
 */
function FullScreen({ full, setFull }: { full: boolean; setFull: (v: boolean) => void }) {
  const map = useMap();
  useEffect(() => {
    document.body.classList.toggle('map-full', full);
    if (TOUCH) {
      if (full) map.dragging.enable();
      else map.dragging.disable();
    }
    setTimeout(() => map.invalidateSize(), 0);
    if (!full) return;
    history.pushState({ mapFull: true }, '');
    const onPop = () => setFull(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    addEventListener('popstate', onPop);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('popstate', onPop);
      removeEventListener('keydown', onKey);
      // Closed by the button rather than by Back: drop the history entry we added.
      if (history.state?.mapFull) history.back();
    };
  }, [full, map, setFull]);
  return (
    <button
      type="button"
      className={full ? 'map-full-btn is-full' : 'map-full-btn'}
      onClick={() => setFull(!full)}
      ref={(el) => {
        if (el) L.DomEvent.disableClickPropagation(el);
      }}
      aria-label={full ? 'Exit full screen' : 'Full screen map'}
      title={full ? 'Exit full screen' : 'Full screen map'}
    >
      {full ? (
        'Done'
      ) : (
        <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </svg>
      )}
    </button>
  );
}

/** Shows "Use two fingers to move the map" when someone drags the map with one finger. */
function TwoFingerHint({ disabled }: { disabled: boolean }) {
  const map = useMap();
  const [show, setShow] = useState(false);
  const timer = useRef<number>(0);
  useEffect(() => {
    if (!TOUCH || disabled) return;
    const el = map.getContainer();
    let start: { x: number; y: number } | null = null;
    const down = (e: TouchEvent) => {
      start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
      if (e.touches.length > 1) setShow(false);
    };
    const move = (e: TouchEvent) => {
      if (!start || e.touches.length !== 1) return;
      if (Math.hypot(e.touches[0].clientX - start.x, e.touches[0].clientY - start.y) < 12) return;
      setShow(true);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setShow(false), 1200);
    };
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    return () => {
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchmove', move);
    };
  }, [map, disabled]);
  return show && !disabled ? <div className="map-two-finger">Use two fingers to move the map</div> : null;
}

export default function MapView({
  loc,
  onPick,
  basemap,
  onBasemap,
}: {
  loc: Loc | null;
  onPick: (lat: number, lon: number) => void;
  basemap: string;
  onBasemap: (name: string) => void;
}) {
  const base = validBase(basemap);
  // The layer switch only reads `checked` when it mounts. A change made in the map's own switch is
  // already showing, but one made in Layout settings needs the switch rebuilt.
  const shownBase = useRef(base);
  const [ctlKey, setCtlKey] = useState(0);
  useEffect(() => {
    if (base !== shownBase.current) {
      shownBase.current = base;
      setCtlKey((k) => k + 1);
    }
  }, [base]);
  const pickBase = (name: string) => {
    shownBase.current = name;
    onBasemap(name);
  };
  const aqOn = aqSaved();
  const [tapped, setTapped] = useState<{ lat: number; lon: number } | null>(null);
  const [full, setFull] = useState(false);
  useEffect(() => setTapped(null), [loc]);
  return (
    <MapContainer
      className="map"
      center={loc ? [loc.lat, loc.lon] : [39.5, -98.35]}
      zoom={loc ? 12 : 4}
      maxZoom={18}
      worldCopyJump
      dragging={!TOUCH}
    >
      <LayersControl position="topright" key={ctlKey}>
        {BASES.map((b) => (
          <LayersControl.BaseLayer key={b.name} name={b.name} checked={b.name === base}>
            {/* CORS mode so the service worker can keep viewed tiles for offline use. */}
            {b.vector ? (
              <VectorLayer attribution={b.attribution} />
            ) : (
              <TileLayer url={b.url} attribution={b.attribution} maxNativeZoom={b.maxNativeZoom} maxZoom={18} crossOrigin="anonymous" />
            )}
          </LayersControl.BaseLayer>
        ))}
        <LayersControl.Overlay name={AQ_LAYER} checked={aqOn}>
          <AirQualityLayer initialOn={aqOn} />
        </LayersControl.Overlay>
      </LayersControl>
      {base === 'Outdoors' && <MtbLegend />}
      {loc && <Marker position={[loc.lat, loc.lon]} icon={pin} interactive={false} />}
      {tapped && <Marker position={[tapped.lat, tapped.lon]} icon={pending} interactive={false} />}
      {tapped && (
        <div className="map-confirm" ref={(el) => { if (el) L.DomEvent.disableClickPropagation(el); }}>
          <button
            type="button"
            className="map-confirm-go"
            onClick={() => {
              onPick(tapped.lat, tapped.lon);
              setFull(false); // back to the forecast for the spot just picked
            }}
          >
            Show forecast here
          </button>
          <button type="button" className="map-confirm-x" onClick={() => setTapped(null)} aria-label="Cancel">
            ✕
          </button>
        </div>
      )}
      <TwoFingerHint disabled={full} />
      <FullScreen full={full} setFull={setFull} />
      <Controller loc={loc} onPick={onPick} onTap={(lat, lon) => setTapped({ lat, lon })} onBase={pickBase} />
    </MapContainer>
  );
}
