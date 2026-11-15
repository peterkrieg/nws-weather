import type { Weather } from './api';
import { emoji, hourShort } from './format';
import { clock, sunTimes } from './sun';

type Cell =
  | { kind: 'hour'; t: number; label: string; icon: string; temp: string; pop: number | null; day?: string }
  | { kind: 'sun'; t: number; label: string; icon: string; what: string };

/** Swipeable row of the next 36 hours, with sunrise/sunset and dusk slotted in where they fall. */
export default function HourStrip({ wx }: { wx: Weather }) {
  const hours = wx.hours.slice(0, 36);
  if (hours.length < 2) return null;
  const end = hours[hours.length - 1].t + 3600e3;

  const cells: Cell[] = hours.map((h, i) => ({
    kind: 'hour',
    t: h.t,
    label: i === 0 ? 'Now' : hourShort(h.hr),
    icon: emoji(h.icon, h.isDay),
    temp: h.temp == null ? '–' : `${Math.round(h.temp)}°`,
    pop: h.pop,
    day: i > 0 && h.hr === 0 ? h.dow : undefined,
  }));

  // Sun events in the window (today's and tomorrow's).
  const seen = new Set<number>();
  for (const base of [hours[0].t, hours[0].t + 86400e3]) {
    const s = sunTimes(base, wx.lat, wx.lon);
    const events: [number | null, string, string][] = [
      [s.sunrise, '🌅', 'Sunrise'],
      [s.sunset, '🌇', 'Sunset'],
      [s.lastLight, '🔦', 'Headlamp'],
    ];
    for (const [t, icon, what] of events) {
      if (t == null || t <= hours[0].t || t >= end || seen.has(Math.round(t / 60e3))) continue;
      seen.add(Math.round(t / 60e3));
      cells.push({ kind: 'sun', t, label: clock(t, wx.tz).replace(/\s?([AP])M/, (_, a: string) => a.toLowerCase()), icon, what });
    }
  }
  cells.sort((a, b) => a.t - b.t);
  // Only reserve a row for precip chance when some hour has one worth showing.
  const anyPop = hours.some((h) => (h.pop ?? 0) >= 10);

  return (
    <div className="strip" role="list" aria-label="Next 36 hours">
      {cells.map((c) =>
        c.kind === 'hour' ? (
          <div role="listitem" className={c.day ? 'strip-cell strip-newday' : 'strip-cell'} key={`h${c.t}`}>
            {c.day && <div className="strip-day">{c.day}</div>}
            <div className="strip-time">{c.label}</div>
            <div className="strip-icon" aria-hidden="true">
              {c.icon}
            </div>
            <div className="strip-temp">{c.temp}</div>
            {anyPop && <div className="strip-pop">{c.pop != null && c.pop >= 10 ? `💧${Math.round(c.pop)}%` : ''}</div>}
          </div>
        ) : (
          <div role="listitem" className="strip-cell strip-sun" key={`s${c.t}`}>
            <div className="strip-time">{c.label}</div>
            <div className="strip-icon" aria-hidden="true">
              {c.icon}
            </div>
            <div className="strip-temp">{c.what}</div>
            {anyPop && <div className="strip-pop" />}
          </div>
        ),
      )}
    </div>
  );
}
