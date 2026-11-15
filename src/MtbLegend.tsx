import { useState } from 'react';
import L from 'leaflet';
import { useMap, useMapEvents } from 'react-leaflet';

// Keep in step with MTB in vectorMap.ts (duplicated so this legend doesn't pull in MapLibre).
const KEYS = [
  { label: 'Easy', color: '#2f9e44' },
  { label: 'Intermediate', color: '#1c6dd0' },
  { label: 'Difficult', color: '#1a1a1a' },
  { label: 'Very difficult', color: '#1a1a1a', double: true },
  { label: 'Pro line', color: '#e8590c' },
  { label: 'Bike trail, unrated', color: '#9c36b5' },
];
const DOWNHILL = '#d6336c'; // MTB_DOWNHILL in vectorMap.ts

/** Mountain bike colour key, shown on the Outdoors map once trails are visible. */
export default function MtbLegend({ ratings }: { ratings: boolean }) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  const [open, setOpen] = useState(() => !window.matchMedia('(max-width: 600px)').matches);
  if (zoom < 14) return null; // trails appear from here
  const arrowColor = ratings ? '#1c6dd0' : DOWNHILL;
  const chipColors = ratings ? KEYS.slice(0, 3).map((k) => k.color) : [DOWNHILL];
  return (
    <div className="mtb-legend leaflet-bottom leaflet-right">
      <div className="leaflet-control" ref={(el) => { if (el) L.DomEvent.disableClickPropagation(el); }}>
        {!open ? (
          <button type="button" className="aq-chip" onClick={() => setOpen(true)} aria-label="Show bike trail legend">
            <span className="aq-chip-scale" aria-hidden="true">
              {chipColors.map((c, i) => (
                <i key={i} style={{ background: c }} />
              ))}
            </span>
            {ratings ? 'MTB' : 'Downhill'}
          </button>
        ) : (
          <>
            <button type="button" className="aq-close" onClick={() => setOpen(false)} aria-label="Hide legend">
              ✕
            </button>
            <div className="mtb-head">{ratings ? 'Bike trails' : 'Trails'}</div>
            <ul className="mtb-keys">
              {(ratings ? KEYS : []).map((k) => (
                <li key={k.label}>
                  <i className={k.double ? 'mtb-swatch is-double' : 'mtb-swatch'} style={{ background: k.color }} />
                  {k.label}
                </li>
              ))}
              <li>
                <i className="mtb-swatch mtb-arrow" style={{ background: arrowColor }}>
                  <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5 7.5 6 4 9.5" /></svg>
                </i>
                {ratings ? 'One-way (usually downhill)' : 'Bike only, downhill / one-way'}
              </li>
              <li>
                <i className="mtb-swatch is-hike" />
                Hiking trail
              </li>
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
