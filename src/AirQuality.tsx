import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { CircleMarker, LayerGroup, Marker, Tooltip, useMap, useMapEvents } from 'react-leaflet';

// Mirrors the Worker's /api/aq response (worker/index.ts).
interface Monitor {
  lat: number;
  lon: number;
  name: string;
  agency: string;
  aqi: number;
  param: string;
  readings: { param: string; aqi: number }[];
  time: string;
}
interface Sensor {
  id: number;
  lat: number;
  lon: number;
  aqi: number;
  pm: number;
  seen: number;
}
interface CellData {
  monitors: Monitor[];
  sensors: Sensor[];
  errors: string[];
  /** Sources whose API key isn't set up on the server. */
  unconfigured?: string[];
}

export const AQ_LAYER = 'Air quality';
const CELL = 0.5;
const MIN_ZOOM = 9;
const MAX_CELLS = 12;
const REFRESH_MS = 10 * 60e3;

/** EPA's standard AQI colours and names. */
const LEVELS = [
  { max: 50, color: '#00e400', ink: '#111', name: 'Good' },
  { max: 100, color: '#ffff00', ink: '#111', name: 'Moderate' },
  { max: 150, color: '#ff7e00', ink: '#111', name: 'Unhealthy for sensitive groups' },
  { max: 200, color: '#ff0000', ink: '#fff', name: 'Unhealthy' },
  { max: 300, color: '#8f3f97', ink: '#fff', name: 'Very unhealthy' },
  { max: Infinity, color: '#7e0023', ink: '#fff', name: 'Hazardous' },
];
export const aqiLevel = (aqi: number) => LEVELS.find((l) => aqi <= l.max)!;

const PARAM: Record<string, string> = { 'PM2.5': 'PM2.5', OZONE: 'Ozone', PM25: 'PM2.5' };

function ago(ms: number) {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60e3));
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
}

function monitorIcon(m: Monitor) {
  const lvl = aqiLevel(m.aqi);
  return L.divIcon({
    className: '',
    html: `<div class="aq-monitor" style="background:${lvl.color};color:${lvl.ink}">${m.aqi}</div>`,
    iconSize: [28, 22],
    iconAnchor: [14, 11],
  });
}

function cellsInView(map: L.Map): string[] {
  const b = map.getBounds();
  const cells: string[] = [];
  for (let s = Math.floor(b.getSouth() / CELL) * CELL; s < b.getNorth(); s += CELL) {
    for (let w = Math.floor(b.getWest() / CELL) * CELL; w < b.getEast(); w += CELL) {
      const lon = ((((w + 180) % 360) + 360) % 360) - 180; // wrap for worldCopyJump
      cells.push(`${s},${lon}`);
    }
  }
  return cells;
}

function Legend({ note, sensors }: { note: string | null; sensors: boolean }) {
  return (
    <div className="aq-legend leaflet-bottom leaflet-left">
      <div className="leaflet-control">
        {note ? (
          <div className="aq-note">{note}</div>
        ) : (
          <>
            <div className="aq-scale">
              {LEVELS.map((l) => (
                <span key={l.name} title={l.name} style={{ background: l.color }} />
              ))}
            </div>
            <div className="aq-scale-labels">
              <span>Good</span>
              <span>Hazardous</span>
            </div>
            <div className="aq-keys">
              <span>
                <i className="aq-key-monitor" /> Official monitor
              </span>
              {sensors && (
                <span>
                  <i className="aq-key-sensor" /> PurpleAir
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Air quality markers. Render inside a LayersControl.Overlay named AQ_LAYER; fetches only while that overlay is on. */
export function AirQualityLayer({ initialOn }: { initialOn: boolean }) {
  const map = useMap();
  const [on, setOn] = useState(initialOn);
  const [zoom, setZoom] = useState(map.getZoom());
  const [cells, setCells] = useState<Record<string, CellData & { at: number }>>({});
  const inflight = useRef(new Set<string>());

  const load = () => {
    if (!on || map.getZoom() < MIN_ZOOM) return;
    const now = Date.now();
    for (const cell of cellsInView(map).slice(0, MAX_CELLS)) {
      const have = cells[cell];
      const maxAge = have?.errors.length ? 60e3 : REFRESH_MS; // retry failures sooner
      if ((have && now - have.at < maxAge) || inflight.current.has(cell)) continue;
      inflight.current.add(cell);
      fetch(`/api/aq?cell=${cell}`)
        .then((r) => r.json())
        .then((d: CellData) => setCells((c) => ({ ...c, [cell]: { ...d, at: Date.now() } })))
        .catch(() => {})
        .finally(() => inflight.current.delete(cell));
    }
  };

  useMapEvents({
    overlayadd: (e) => e.name === AQ_LAYER && setOn(true),
    overlayremove: (e) => e.name === AQ_LAYER && setOn(false),
    moveend: () => {
      setZoom(map.getZoom());
      load();
    },
  });

  useEffect(load, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!on) return;
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }); // re-armed each render so it sees current state

  const data = Object.values(cells);
  const monitors = data.flatMap((d) => d.monitors);
  const sensors = data.flatMap((d) => d.sensors);
  const errors = [...new Set(data.flatMap((d) => d.errors))];
  const note = !on
    ? null
    : zoom < MIN_ZOOM
      ? 'Zoom in to see air quality'
      : monitors.length || sensors.length
        ? null
        : errors.length
          ? `Air quality unavailable: ${errors.join('; ')}`
          : data.length && data.every((d) => d.unconfigured?.length === 2)
            ? 'Air quality needs an API key on the server'
            : null;

  return (
    <>
      <LayerGroup>
        {zoom >= MIN_ZOOM &&
          sensors.map((s) => {
            const lvl = aqiLevel(s.aqi);
            return (
              <CircleMarker
                key={`pa${s.id}`}
                center={[s.lat, s.lon]}
                radius={6}
                pathOptions={{ color: '#fff', weight: 1.5, fillColor: lvl.color, fillOpacity: 0.95 }}
                bubblingMouseEvents={false}
              >
                <Tooltip direction="top" offset={[0, -6]}>
                  <div className="aq-tip">
                    <b>AQI {s.aqi}</b> · {lvl.name}
                    <div>
                      PM2.5 {s.pm} µg/m³ · PurpleAir sensor, EPA-corrected
                    </div>
                    <div className="aq-dim">{ago(s.seen * 1000)}</div>
                  </div>
                </Tooltip>
              </CircleMarker>
            );
          })}
        {zoom >= MIN_ZOOM &&
          monitors.map((m) => {
            const lvl = aqiLevel(m.aqi);
            return (
              <Marker key={`an${m.name}${m.lat}`} position={[m.lat, m.lon]} icon={monitorIcon(m)} zIndexOffset={500} bubblingMouseEvents={false}>
                <Tooltip direction="top" offset={[0, -10]}>
                  <div className="aq-tip">
                    <b>AQI {m.aqi}</b> · {lvl.name}
                    <div>
                      {m.name} · {m.agency}
                    </div>
                    <div>
                      {m.readings
                        .sort((a, b) => b.aqi - a.aqi)
                        .map((r) => `${PARAM[r.param] ?? r.param} ${r.aqi}`)
                        .join(' · ')}
                    </div>
                    <div className="aq-dim">Official monitor · {ago(Date.parse(`${m.time}:00Z`))}</div>
                  </div>
                </Tooltip>
              </Marker>
            );
          })}
      </LayerGroup>
      {on && <Legend note={note} sensors={sensors.length > 0} />}
    </>
  );
}
