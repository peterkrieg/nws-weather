// User data kept in this browser: layout preferences and favorite places.
// Everything goes through usePersisted, so moving to server-side sync later only touches this file.

import { useCallback, useEffect, useState } from 'react';

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the app works without it */
  }
}

/** useState that persists to localStorage and stays in step across tabs. */
export function usePersisted<T>(key: string, initial: () => T, normalize: (v: T) => T = (v) => v) {
  const [value, setValue] = useState<T>(() => normalize(readJson(key, initial())));
  const set = useCallback(
    (next: T | ((prev: T) => T)) =>
      setValue((prev) => {
        const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        writeJson(key, v);
        return v;
      }),
    [key],
  );
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setValue(normalize(readJson(key, initial())));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, set] as const;
}

// ---- Layout preferences -------------------------------------------------------------------------

export interface Item<Id extends string> {
  id: Id;
  on: boolean;
}

export const SECTIONS = {
  favorites: 'Favorites bar',
  summary: 'Current conditions',
  map: 'Map',
  daily: '7-day forecast',
  hourly: 'Hourly charts',
} as const;
export type SectionId = keyof typeof SECTIONS;

export const CHARTS = {
  temp: 'Temperature',
  humidity: 'Precip chance, cloud cover, humidity',
  rain: 'Rain',
  snow: 'Snowfall',
  wind: 'Wind',
  uv: 'UV index',
  table: 'Hourly table',
} as const;
export type ChartId = keyof typeof CHARTS;

export interface Prefs {
  sections: Item<SectionId>[];
  charts: Item<ChartId>[];
}

const defaults = <Id extends string>(labels: Record<Id, string>): Item<Id>[] =>
  (Object.keys(labels) as Id[]).map((id) => ({ id, on: true }));

export const defaultPrefs = (): Prefs => ({ sections: defaults(SECTIONS), charts: defaults(CHARTS) });

/** Keep saved order, drop ids that no longer exist, append ones added since. */
function reconcile<Id extends string>(saved: Item<Id>[] | undefined, labels: Record<Id, string>): Item<Id>[] {
  const valid = (saved ?? []).filter((i) => i && i.id in labels);
  const seen = new Set(valid.map((i) => i.id));
  return [...valid, ...defaults(labels).filter((i) => !seen.has(i.id))];
}

export const normalizePrefs = (p: Partial<Prefs> | null): Prefs => ({
  sections: reconcile(p?.sections, SECTIONS),
  charts: reconcile(p?.charts, CHARTS),
});

export const usePrefs = () => usePersisted<Prefs>('wx:prefs', defaultPrefs, normalizePrefs);

// ---- Favorites ------------------------------------------------------------------------------------

export interface Favorite {
  id: string;
  lat: number;
  lon: number;
  label: string;
  emoji: string;
}

/** Two points within ~10 m count as the same place. */
export const samePlace = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;

export const useFavorites = () =>
  usePersisted<Favorite[]>('wx:favorites', () => [], (v) => (Array.isArray(v) ? v.filter((f) => f && Number.isFinite(f.lat)) : []));

// ---- Saved forecasts ----------------------------------------------------------------------------
// The last few forecasts, so the app opens instantly and still shows something with no signal.

import type { Weather } from './api';

interface SavedForecast {
  lat: number;
  lon: number;
  at: number;
  wx: Weather;
}
const FORECASTS_KEY = 'wx:forecasts';
const KEEP = 10;

export function savedForecast(p: { lat: number; lon: number }): SavedForecast | undefined {
  return readJson<SavedForecast[]>(FORECASTS_KEY, []).find((f) => samePlace(f, p));
}

export function saveForecast(p: { lat: number; lon: number }, wx: Weather, at = Date.now()) {
  const rest = readJson<SavedForecast[]>(FORECASTS_KEY, []).filter((f) => !samePlace(f, p));
  const next = [{ lat: p.lat, lon: p.lon, at, wx }, ...rest].slice(0, KEEP);
  // Forecasts are ~50–100 KB each; if storage is full, keep fewer rather than none.
  for (let n = next.length; n > 0; n--) {
    try {
      localStorage.setItem(FORECASTS_KEY, JSON.stringify(next.slice(0, n)));
      return;
    } catch {
      /* try with fewer */
    }
  }
}
