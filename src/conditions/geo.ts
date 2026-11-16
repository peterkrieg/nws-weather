// Small geometry helpers: Web Mercator tiles, distances, and the sun's position.

export const R = 6378137;
export const D2R = Math.PI / 180;

/** Fractional tile coordinates for a lat/lon at zoom z. */
export function tileXY(lat: number, lon: number, z: number) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const s = Math.sin(lat * D2R);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return { x, y };
}

/** Web Mercator metres. */
export function merc(lat: number, lon: number) {
  return { x: R * lon * D2R, y: R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) };
}

/** Bounds of tile (x, y, z) in Web Mercator metres. */
export function tileBoundsMerc(x: number, y: number, z: number) {
  const size = (2 * Math.PI * R) / 2 ** z;
  const minx = -Math.PI * R + x * size;
  const maxy = Math.PI * R - y * size;
  return { minx, miny: maxy - size, maxx: minx + size, maxy };
}

export function tileBoundsLatLon(x: number, y: number, z: number) {
  const n = 2 ** z;
  const lon = (xx: number) => (xx / n) * 360 - 180;
  const lat = (yy: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) / D2R;
  return { west: lon(x), east: lon(x + 1), north: lat(y), south: lat(y + 1) };
}

/** Metres per degree at this latitude. */
export function mPerDeg(lat: number) {
  return { lat: 111320, lon: 111320 * Math.cos(lat * D2R) };
}

export function offset(lat: number, lon: number, dEast: number, dNorth: number) {
  const m = mPerDeg(lat);
  return { lat: lat + dNorth / m.lat, lon: lon + dEast / m.lon };
}

export function distM(a: [number, number], b: [number, number]) {
  // [lon, lat]
  const m = mPerDeg((a[1] + b[1]) / 2);
  return Math.hypot((b[0] - a[0]) * m.lon, (b[1] - a[1]) * m.lat);
}

/** Sun altitude and azimuth (radians; azimuth clockwise from north) — NOAA approximation, good to ~0.5°. */
export function sunPos(tMs: number, lat: number, lon: number) {
  const d = tMs / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * D2R;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const e = (23.439 - 0.00000036 * d) * D2R;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = ((gmst * 15 + lon) * D2R - ra) % (2 * Math.PI);
  const phi = lat * D2R;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) + Math.PI;
  return { alt, az: ((az % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) };
}
