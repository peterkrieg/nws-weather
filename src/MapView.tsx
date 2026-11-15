import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { LayersControl, MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import type { Loc } from './api';
import { AQ_LAYER, AirQualityLayer } from './AirQuality';

const BASE_KEY = 'wx:basemap';
const AQ_KEY = 'wx:aq';
/** Phones and tablets: one finger scrolls the page, two fingers move the map. */
const TOUCH = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

const pending = L.divIcon({ className: '', html: '<div class="pin pin-pending"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
const pin = L.divIcon({ className: '', html: '<div class="pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const BASES = [
  {
    name: 'Street',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: OSM_ATTR,
    maxNativeZoom: 19,
  },
  {
    name: 'Topo',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: `${OSM_ATTR}, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
    maxNativeZoom: 17,
  },
  {
    name: 'USGS Topo',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    attribution: 'USGS The National Map',
    maxNativeZoom: 16,
  },
];

function savedBase() {
  try {
    const name = localStorage.getItem(BASE_KEY);
    return BASES.some((b) => b.name === name) ? name : 'Street';
  } catch {
    return 'Street';
  }
}

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
}: {
  loc: Loc | null;
  onPick: (lat: number, lon: number) => void;
  onTap: (lat: number, lon: number) => void;
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
    baselayerchange: (e) => {
      try {
        localStorage.setItem(BASE_KEY, e.name);
      } catch {
        /* ignore */
      }
    },
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

/** Shows "Use two fingers to move the map" when someone drags the map with one finger. */
function TwoFingerHint() {
  const map = useMap();
  const [show, setShow] = useState(false);
  const timer = useRef<number>(0);
  useEffect(() => {
    if (!TOUCH) return;
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
  }, [map]);
  return show ? <div className="map-two-finger">Use two fingers to move the map</div> : null;
}

export default function MapView({ loc, onPick }: { loc: Loc | null; onPick: (lat: number, lon: number) => void }) {
  const base = savedBase();
  const aqOn = aqSaved();
  const [tapped, setTapped] = useState<{ lat: number; lon: number } | null>(null);
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
      <LayersControl position="topright">
        {BASES.map((b) => (
          <LayersControl.BaseLayer key={b.name} name={b.name} checked={b.name === base}>
            <TileLayer url={b.url} attribution={b.attribution} maxNativeZoom={b.maxNativeZoom} maxZoom={18} />
          </LayersControl.BaseLayer>
        ))}
        <LayersControl.Overlay name={AQ_LAYER} checked={aqOn}>
          <AirQualityLayer initialOn={aqOn} />
        </LayersControl.Overlay>
      </LayersControl>
      {loc && <Marker position={[loc.lat, loc.lon]} icon={pin} interactive={false} />}
      {tapped && <Marker position={[tapped.lat, tapped.lon]} icon={pending} interactive={false} />}
      {tapped && (
        <div className="map-confirm" ref={(el) => { if (el) L.DomEvent.disableClickPropagation(el); }}>
          <button type="button" className="map-confirm-go" onClick={() => onPick(tapped.lat, tapped.lon)}>
            Show forecast here
          </button>
          <button type="button" className="map-confirm-x" onClick={() => setTapped(null)} aria-label="Cancel">
            ✕
          </button>
        </div>
      )}
      <TwoFingerHint />
      <Controller loc={loc} onPick={onPick} onTap={(lat, lon) => setTapped({ lat, lon })} />
    </MapContainer>
  );
}
