import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActionIcon, Loader } from '@mantine/core';
import { fetchElevation, fetchWeather, type Loc, type Place, type Weather } from './api';
import SearchBox from './SearchBox';
import MapView from './MapView';
import { Alerts, Daily, Hero } from './Forecast';
import Hourly from './Hourly';
import Settings from './Settings';
import { FavoriteEditor, FavoritesBar, FavoriteStar } from './Favorites';
import { readJson, samePlace, useFavorites, usePrefs, writeJson, type Favorite, type SectionId } from './store';

const LAST_KEY = 'wx:last';
const TOUCH = window.matchMedia('(pointer: coarse)').matches;
const RECENTS_KEY = 'wx:recents';

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
  const [prefs, setPrefs] = usePrefs();
  const [favorites, setFavorites] = useFavorites();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<Favorite | null>(null);

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

  // Follow hash changes made outside the app (pasting a link into the address bar, back/forward).
  useEffect(() => {
    const onHash = () => {
      const next = parseHash();
      if (next) setLoc(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

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
  const currentFav = loc ? favorites.find((f) => samePlace(f, loc)) : undefined;

  const addFavorite = () => {
    if (!loc || !wx) return;
    const fav: Favorite = { id: crypto.randomUUID(), lat: loc.lat, lon: loc.lon, label: title, emoji: '📍' };
    setFavorites((prev) => [...prev, fav]);
    setEditing(fav); // straight into naming it and picking an icon
  };
  const saveFavorite = (f: Favorite) => {
    setFavorites((prev) => prev.map((x) => (x.id === f.id ? f : x)));
    if (currentFav?.id === f.id && loc) setLoc({ ...loc, label: f.label, source: 'url' });
  };
  const pickFavorite = (f: Favorite) => setLoc({ lat: f.lat, lon: f.lon, label: f.label, source: 'search' });
  const moveFavorite = (from: number, to: number) =>
    setFavorites((prev) => {
      const next = [...prev];
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it);
      return next;
    });

  const anyChart = prefs.charts.some((c) => c.on);
  const available: Record<SectionId, boolean> = {
    favorites: favorites.length > 0, // the ☆ by the place name is how the first one gets added
    summary: true,
    map: true,
    daily: Boolean(wx && wx.periods.length > 0),
    hourly: Boolean(wx && wx.hours.length > 1 && anyChart),
  };
  const shown = prefs.sections.filter((s) => s.on && available[s.id]).map((s) => s.id);
  // Wide screens: the map takes one column beside the summary/forecast section just before and/or
  // after it (spanning two rows when it has both). Everything else is full width.
  const mapAt = shown.indexOf('map');
  const isHalf = (id: SectionId | undefined) => id === 'summary' || id === 'daily';
  const besideMap: SectionId[] = mapAt < 0 ? [] : [shown[mapAt - 1], shown[mapAt + 1]].filter(isHalf);
  const cls = (id: SectionId, extra = '') =>
    ['sec', id === 'map' ? `sec-map map-rows-${besideMap.length}` : besideMap.includes(id) ? 'sec-half' : 'sec-wide', extra].join(' ').trim();

  const sectionEls: Record<SectionId, ReactNode> = {
    favorites: (
      <section key="favorites" className={cls('favorites')}>
        <FavoritesBar favorites={favorites} current={currentFav} onPick={pickFavorite} onEdit={setEditing} onMove={moveFavorite} />
      </section>
    ),
    summary: (
      <section key="summary" className={cls('summary', 'sec-hero')}>
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
        {wx && (
          <Hero
            wx={wx}
            title={title}
            pointElevFt={loading ? undefined : pointElevFt}
            titleAction={<FavoriteStar fav={currentFav} onAdd={addFavorite} onEdit={() => currentFav && setEditing(currentFav)} />}
          />
        )}
      </section>
    ),
    map: (
      <section key="map" className={cls('map', 'card map-card')}>
        <MapView loc={loc} onPick={(lat, lon) => pickPoint(lat, lon, 'map')} />
        <p className="map-hint">{TOUCH ? 'Tap the map to check a spot' : "Click the map for that spot's forecast"}</p>
      </section>
    ),
    daily:
      wx && wx.periods.length > 0 ? (
        <section key="daily" className={cls('daily')}>
          <h2>Forecast</h2>
          <Daily wx={wx} />
        </section>
      ) : null,
    hourly:
      wx && wx.hours.length > 1 && anyChart ? (
        <section key="hourly" className={cls('hourly')}>
          <Hourly hours={wx.hours} lat={wx.lat} lon={wx.lon} source={wx.source} charts={prefs.charts} />
        </section>
      ) : null,
  };

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
            favorites={favorites}
            onPickFavorite={pickFavorite}
          />
          <ActionIcon variant="subtle" color="gray" size="lg" onClick={() => setSettingsOpen(true)} aria-label="Layout settings" title="Layout settings">
            <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
              <circle cx="16" cy="7" r="2" />
              <circle cx="10" cy="17" r="2" />
            </svg>
          </ActionIcon>
        </div>
      </header>

      <main className={loading && wx ? 'is-loading' : ''}>
        {shown.map((id) => sectionEls[id])}
      </main>

      <Settings opened={settingsOpen} onClose={() => setSettingsOpen(false)} prefs={prefs} setPrefs={setPrefs} />
      <FavoriteEditor
        fav={editing}
        onSave={saveFavorite}
        onDelete={(f) => setFavorites((prev) => prev.filter((x) => x.id !== f.id))}
        onClose={() => setEditing(null)}
      />

      <footer>
        US forecasts and alerts: <a href="https://www.weather.gov/" target="_blank" rel="noopener">National Weather Service</a>.
        Elsewhere: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0), with{' '}
        <a href="https://api.met.no/" target="_blank" rel="noopener">MET Norway</a> as backup. UV index: Open-Meteo (CAMS). Place search:{' '}
        <a href="https://photon.komoot.io/" target="_blank" rel="noopener">Photon</a> on OpenStreetMap data.
      </footer>
    </>
  );
}
