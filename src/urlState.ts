// The address bar mirrors what's on screen, so a copied link opens the same view for someone else:
//   ?loc=40.79650,-111.83300&name=Grandeur%20Peak    forecast spot (and its label)
//   &map=15/40.79650/-111.83300                       map zoom / centre
//   &style=outdoors&bikes=1&mud=1&aq=0                map style and overlays
//
// The app's own state stays the source of truth and the URL is written from it (read once at
// launch). Reading it back live would break the full-screen map: closing it with Back restores the
// URL from before full screen, which would undo any style or overlay changed while there.

import { createLoader, createParser, createSerializer, parseAsString } from 'nuqs';
import { BASES } from './MapView';

export interface MapPos {
  z: number;
  lat: number;
  lon: number;
}

const slug = (name: string) => name.toLowerCase().replace(/\s+/g, '-');
const num = (s: string | undefined) => (s != null && s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : null);

const parseAsPoint = createParser({
  parse: (v) => {
    const [lat, lon] = v.split(',').map(num);
    return lat != null && lon != null && Math.abs(lat) <= 90 ? { lat, lon } : null;
  },
  serialize: (p: { lat: number; lon: number }) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`,
  eq: (a, b) => a.lat === b.lat && a.lon === b.lon,
});

const parseAsView = createParser({
  parse: (v) => {
    const [z, lat, lon] = v.split(/[/,]/).map(num); // "15/40.8/-111.8" (or with commas)
    return z != null && lat != null && lon != null && z >= 0 && z <= 20 && Math.abs(lat) <= 90 ? { z, lat, lon } : null;
  },
  serialize: (m: MapPos) => `${Math.round(m.z * 10) / 10}/${m.lat.toFixed(5)}/${m.lon.toFixed(5)}`,
  eq: (a, b) => a.z === b.z && a.lat === b.lat && a.lon === b.lon,
});

const parseAsStyle = createParser({
  parse: (v) => BASES.find((b) => slug(b.name) === v.toLowerCase())?.name ?? null,
  serialize: slug,
});

const parseAsFlag = createParser({
  parse: (v) => (v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : null),
  serialize: (b: boolean) => (b ? '1' : '0'),
});

const parsers = {
  loc: parseAsPoint,
  name: parseAsString,
  map: parseAsView,
  style: parseAsStyle,
  bikes: parseAsFlag,
  mud: parseAsFlag,
  aq: parseAsFlag,
};

export type UrlState = { [K in keyof typeof parsers]: ReturnType<(typeof parsers)[K]['parse']> | null };

const load = createLoader(parsers);
const serialize = createSerializer(parsers);

/** Older links: "#lat,lon" or "#lat,lon,Label". */
export function legacyHash(): { lat: number; lon: number; label?: string } | null {
  const [la, lo, ...rest] = decodeURIComponent(location.hash.slice(1)).split(',');
  const lat = num(la);
  const lon = num(lo);
  return lat != null && lon != null ? { lat, lon, label: rest.join(',') || undefined } : null;
}

/** What the link asked for, read once at launch. */
export function readUrl(): UrlState {
  const s = load(location.search) as UrlState;
  const old = !s.loc ? legacyHash() : null;
  return old ? { ...s, loc: { lat: old.lat, lon: old.lon }, name: old.label ?? null } : s;
}

let timer = 0;
/** Write the current view into the address bar (no history entry; batched while the map moves). */
export function writeUrl(state: UrlState) {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    const url = serialize(location.pathname, state);
    // Keep history.state: the full-screen map marks its history entry there.
    if (url !== location.pathname + location.search || location.hash) history.replaceState(history.state, '', url);
  }, 250);
}
