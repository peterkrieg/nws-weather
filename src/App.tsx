import { useCallback, useEffect, useState } from 'react';
import { Loader } from '@mantine/core';
import { fetchElevation, fetchWeather, type Loc, type Place, type Weather } from './api';
import SearchBox from './SearchBox';
import MapView from './MapView';
import { Alerts, Daily, Hero } from './Forecast';
import Hourly from './Hourly';

const LAST_KEY = 'wx:last';
const RECENTS_KEY = 'wx:recents';

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '') as T;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the app works without it */
  }
}

/** URL hash is "#lat,lon" or "#lat,lon,Label" so a location can be bookmarked or shared. */
function parseHash(): Loc | null {
  const [la, lo, ...rest] = decodeURIComponent(location.hash.slice(1)).split(',');
  const lat = Number(la);
  const lon = Number(lo);
  if (!la || !lo || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, label: rest.join(',') || undefined, source: 'url' };
}

function initialLoc(): Loc | null {
  const fromHash = parseHash();
  if (fromHash) return fromHash;
  const last = readJson<Loc | null>(LAST_KEY, null);
  return last && Number.isFinite(last.lat) && Number.isFinite(last.lon) ? { ...last, source: 'url' } : null;
}

export default function App() {
  const [loc, setLoc] = useState<Loc | null>(initialLoc);
  const [wx, setWx] = useState<Weather | null>(null);
  const [pointElevFt, setPointElevFt] = useState<number | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<Place[]>(() => readJson<Place[]>(RECENTS_KEY, []));

  useEffect(() => {
    if (!loc) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const hash = [loc.lat.toFixed(4), loc.lon.toFixed(4), ...(loc.label ? [encodeURIComponent(loc.label)] : [])].join(',');
    history.replaceState(null, '', `#${hash}`);
    setPointElevFt(undefined);
    fetchElevation(loc.lat, loc.lon).then((ft) => {
      if (!cancelled) setPointElevFt(ft);
    });
    fetchWeather(loc.lat, loc.lon)
      .then((w) => {
        if (cancelled) return;
        setWx(w);
        writeJson(LAST_KEY, { lat: loc.lat, lon: loc.lon, label: loc.label });
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setWx(null);
        setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loc]);

  const pickPlace = useCallback((p: Place) => {
    setLoc({ ...p, source: 'search' });
    setRecents((prev) => {
      const next = [p, ...prev.filter((r) => r.label !== p.label || r.sub !== p.sub)].slice(0, 6);
      writeJson(RECENTS_KEY, next);
      return next;
    });
  }, []);
  const pickPoint = useCallback((lat: number, lon: number, source: Loc['source']) => setLoc({ lat, lon, source }), []);

  const title = wx ? (loc?.label ?? wx.place) : '';

  return (
    <>
      <header className="top">
        <div className="top-inner">
          <a className="brand" href="./" aria-label="Weather home">
            ⛅ <span>Weather</span>
          </a>
          <SearchBox
            onPickPlace={pickPlace}
            onPickPoint={pickPoint}
            recents={recents}
            bias={loc}
            clearKey={loc?.source === 'map' ? `${loc.lat},${loc.lon}` : ''}
          />
        </div>
      </header>

      <main className={loading && wx ? 'is-loading' : ''}>
        <section className="area-hero">
          {!wx && loading && (
            <div className="card empty center">
              <Loader size="sm" /> <span>Loading forecast…</span>
            </div>
          )}
          {!wx && !loading && error && (
            <div className="card empty">
              <h1>No forecast here</h1>
              <p>{error}</p>
            </div>
          )}
          {!wx && !loading && !error && (
            <div className="card empty">
              <h1>Where to?</h1>
              <p>
                Search for an address or place above, or click anywhere on the map to get the National Weather Service
                forecast for that exact spot.
              </p>
            </div>
          )}
          {wx && <Alerts alerts={wx.alerts} />}
          {wx && <Hero wx={wx} title={title} pointElevFt={loading ? undefined : pointElevFt} />}
        </section>

        <section className="area-map card map-card">
          <MapView loc={loc} onPick={(lat, lon) => pickPoint(lat, lon, 'map')} />
          <p className="map-hint">Click the map for that spot's forecast</p>
        </section>

        {wx && wx.periods.length > 0 && (
          <section className="area-daily">
            <h2>Forecast</h2>
            <Daily wx={wx} />
          </section>
        )}

        {wx && wx.hours.length > 1 && (
          <section className="area-hourly">
            <Hourly hours={wx.hours} lat={wx.lat} lon={wx.lon} />
          </section>
        )}
      </main>

      <footer>
        Forecast data from the{' '}
        <a href="https://www.weather.gov/" target="_blank" rel="noopener">
          National Weather Service
        </a>
        . Place search by{' '}
        <a href="https://photon.komoot.io/" target="_blank" rel="noopener">
          Photon
        </a>{' '}
        on OpenStreetMap data.
      </footer>
    </>
  );
}
