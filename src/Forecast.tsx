import type { ReactNode } from 'react';
import { Accordion } from '@mantine/core';
import type { Alert, Period, Weather } from './api';
import { clock, sunTimes } from './sun';
import { compass, deg, emoji, feet, mph, pct } from './format';

export function Alerts({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) return null;
  return (
    <div className="alerts">
      {alerts.map((a) => (
        <details className="alert" key={a.id}>
          <summary>⚠️ {a.event}</summary>
          {a.headline && <div className="a-head">{a.headline}</div>}
          <pre>{[a.description, a.instruction].filter(Boolean).join('\n\n')}</pre>
        </details>
      ))}
    </div>
  );
}

const ft = (v: number) => `${Math.round(v).toLocaleString('en-US')} ft`;

export function Hero({
  wx,
  title,
  pointElevFt,
  titleAction,
}: {
  wx: Weather;
  title: string;
  pointElevFt: number | null | undefined;
  titleAction?: ReactNode;
}) {
  // undefined = still loading, null = lookup failed
  const now = wx.hours[0];
  const first = wx.periods[0];
  const short = now?.short ?? first?.shortForecast ?? '';
  const icon = now?.icon ?? first?.icon;
  const temp = now?.temp ?? first?.temperature ?? null;
  const showPlace = title !== wx.place;
  const sourceUrl =
    wx.source === 'nws'
      ? `https://forecast.weather.gov/MapClick.php?lat=${wx.lat.toFixed(4)}&lon=${wx.lon.toFixed(4)}`
      : wx.source === 'openmeteo'
        ? 'https://open-meteo.com/'
        : `https://www.yr.no/en/forecast/daily-table/${wx.lat.toFixed(3)},${wx.lon.toFixed(3)}`;

  // Show the first four of these that the forecast source actually provides for this spot.
  const tiles: { label: string; value: string; small?: string }[] = now
    ? [
        { label: 'Wind', value: mph(now.wind), small: now.dir != null ? compass(now.dir) : undefined, has: now.wind },
        { label: 'Gusts', value: mph(now.gust), has: now.gust },
        { label: 'Chance of precip', value: pct(now.pop), has: now.pop },
        { label: 'Freezing level', value: feet(now.frzLvl), has: now.frzLvl },
        { label: 'Humidity', value: pct(now.rh), has: now.rh },
        { label: 'Cloud cover', value: pct(now.sky), has: now.sky },
        { label: 'Dew point', value: deg(now.dew), has: now.dew },
      ].filter((t) => t.has != null)
    : [];

  // After dark, tomorrow's times are the useful ones.
  const nowMs = Date.now();
  let sun = sunTimes(nowMs, wx.lat, wx.lon);
  let sunDay = 'Today';
  if (sun.lastLight != null && nowMs > sun.lastLight) {
    sun = sunTimes(nowMs + 86400e3, wx.lat, wx.lon);
    sunDay = 'Tomorrow';
  }
  const daylightMin = sun.sunrise != null && sun.sunset != null ? Math.round((sun.sunset - sun.sunrise) / 60e3) : null;

  return (
    <div className="card hero">
      <div className="place-row">
        <h1 className="place">{title}</h1>
        {titleAction}
      </div>
      <div className="place-sub">
        {[
          showPlace ? wx.place : null,
          `${wx.lat.toFixed(4)}, ${wx.lon.toFixed(4)}`,
        ]
          .filter(Boolean)
          .join(' · ')}{' '}
        ·{' '}
        <a href={sourceUrl} target="_blank" rel="noopener">
          {wx.source === 'nws' ? 'weather.gov' : wx.source === 'openmeteo' ? 'Open-Meteo forecast' : 'MET Norway forecast'}
        </a>{' '}
        ·{' '}
        <span className="elev">
          Elevation{' '}
          {pointElevFt === undefined ? (
            <span className="elev-skel" role="status" aria-label="Loading elevation" />
          ) : pointElevFt === null ? (
            'unavailable'
          ) : (
            ft(pointElevFt)
          )}
        </span>
      </div>

      <div className="now">
        <div className="now-emoji" aria-hidden="true">
          {emoji(icon, now?.isDay ?? first?.isDaytime)}
        </div>
        <div className="now-temp">{deg(temp)}</div>
        <div>
          <div className="now-short">{short}</div>
          {now?.feels != null && <div className="now-sub">Feels like {deg(now.feels)}</div>}
        </div>
      </div>

      {now && (
        <div className="tiles">
          {tiles.slice(0, 4).map((t) => (
            <div className="tile" key={t.label}>
              <div className="tile-label">{t.label}</div>
              <div className="tile-value">
                {t.small && <small>{t.small} </small>}
                {t.value}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="sun">
        <div className="sun-day">
          {sunDay}
          {daylightMin != null && (
            <span>
              {Math.floor(daylightMin / 60)}h {daylightMin % 60}m of daylight
            </span>
          )}
        </div>
        <div className="sun-times">
          <div title="Civil dawn: light enough to see without a headlamp">
            <span>First light</span>
            <b>{clock(sun.firstLight, wx.tz)}</b>
          </div>
          <div>
            <span>Sunrise</span>
            <b>{clock(sun.sunrise, wx.tz)}</b>
          </div>
          <div>
            <span>Sunset</span>
            <b>{clock(sun.sunset, wx.tz)}</b>
          </div>
          <div title="Civil dusk: after this you need a headlamp">
            <span>Headlamp by</span>
            <b>{clock(sun.lastLight, wx.tz)}</b>
          </div>
        </div>
      </div>

      {first && (
        <p className="now-text">
          <b>{first.name}:</b> {first.detailedForecast}
        </p>
      )}
    </div>
  );
}

interface Day {
  key: string;
  day: Period | null;
  night: Period | null;
}

function groupDays(periods: Period[]): Day[] {
  const days: Day[] = [];
  for (let i = 0; i < periods.length; ) {
    const p = periods[i];
    if (p.isDaytime) {
      const next = periods[i + 1];
      const night = next && !next.isDaytime ? next : null;
      days.push({ key: p.name, day: p, night });
      i += night ? 2 : 1;
    } else {
      days.push({ key: p.name, day: null, night: p });
      i += 1;
    }
  }
  return days;
}

export function Daily({ wx }: { wx: Weather }) {
  const days = groupDays(wx.periods);
  return (
    <Accordion multiple variant="default" className="card daily" chevronPosition="right">
      {days.map(({ key, day, night }) => {
        const main = (day ?? night)!;
        const pop = Math.max(day?.pop ?? 0, night?.pop ?? 0);
        const sun = sunTimes(Date.parse(main.startTime), wx.lat, wx.lon);
        return (
          <Accordion.Item value={key} key={key}>
            <Accordion.Control>
              <div className="day">
                <span className="d-name">{main.name}</span>
                <span className="d-emoji" aria-hidden="true">
                  {emoji(main.icon, main.isDaytime)}
                </span>
                <span className="d-short">{main.shortForecast}</span>
                <span className="d-pop">{pop >= 10 ? `💧${pop}%` : ''}</span>
                <span className="d-temps">
                  <span className="d-hi">{day ? deg(day.temperature) : ''}</span>
                  <span className="d-lo">{night ? deg(night.temperature) : ''}</span>
                </span>
              </div>
            </Accordion.Control>
            <Accordion.Panel>
              <div className="d-body">
                <p className="d-sun">
                  Sunrise <b>{clock(sun.sunrise, wx.tz)}</b> · Sunset <b>{clock(sun.sunset, wx.tz)}</b> · Headlamp by{' '}
                  <b>{clock(sun.lastLight, wx.tz)}</b>
                </p>
                {[day, night].map(
                  (p) =>
                    p && (
                      <p key={p.name}>
                        <b>{p.name}:</b> {p.detailedForecast}
                      </p>
                    ),
                )}
              </div>
            </Accordion.Panel>
          </Accordion.Item>
        );
      })}
    </Accordion>
  );
}
