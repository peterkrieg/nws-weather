import L from 'leaflet';
import type { SatStatus } from './sentinel';

const fmt = (day: number) =>
  new Date(Math.floor(day / 10000), (Math.floor(day / 100) % 100) - 1, day % 100).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/**
 * Date chip for the "Recent satellite" style: which pass is showing, older passes used to fill cloud
 * gaps, and arrows to step back through earlier passes (e.g. before and after a storm).
 */
export default function SatelliteDate({ status, onUntil }: { status: SatStatus; onUntil: (day: number | null) => void }) {
  const { days, until, used, loading, tooFar } = status;
  let line: string;
  if (tooFar) line = 'Zoom in to see recent satellite pictures';
  else if (!days.length) line = loading ? 'Finding recent passes…' : 'No passes in the last 30 days';
  else if (!used.length) line = loading ? 'Loading…' : 'Clouded over in every recent pass';
  else {
    const older = used.slice(1, 4).map(fmt);
    line = older.length ? `Cloudy spots filled from ${older.join(', ')}${used.length > 4 ? '…' : ''}` : 'Clear in view';
    if (loading) line = 'Loading…';
  }
  const shown = until ?? days[0] ?? null;
  const i = shown == null ? -1 : days.indexOf(shown);
  const older = i >= 0 && i < days.length - 1 ? days[i + 1] : null;
  const newer = i > 0 ? days[i - 1] : null;
  const label = used[0] ?? shown;
  return (
    <div className="sat-date leaflet-bottom leaflet-left">
      <div className="leaflet-control" ref={(el) => { if (el) { L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); } }}>
        {!tooFar && days.length > 0 && (
          <div className="sat-date-row">
            <button type="button" disabled={older == null} onClick={() => onUntil(older)} aria-label="Older pass">
              ‹
            </button>
            <span className="sat-date-day">
              {label != null ? fmt(label) : '—'}
              {until == null && <span className="sat-date-tag">latest</span>}
            </span>
            <button type="button" disabled={newer == null} onClick={() => onUntil(newer === days[0] ? null : newer)} aria-label="Newer pass">
              ›
            </button>
          </div>
        )}
        <div className="sat-date-note">{line}</div>
      </div>
    </div>
  );
}
