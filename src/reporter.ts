// Trail condition reports from this browser. Anyone can report; each browser gets a random,
// anonymous device id (for undoing your own reports and for weighing repeat reporters). A reporter
// key (set once from a setup link, …/?reporter=KEY, or pasted in Layout settings) marks reports as
// trusted. The address bar sync drops ?reporter= from the URL, so it isn't passed along when shared.

const KEY = 'wx:reporter';
const DEVICE = 'wx:device';

try {
  const k = new URLSearchParams(location.search).get('reporter');
  if (k) localStorage.setItem(KEY, k);
} catch {
  /* storage unavailable */
}

export function reporterKey(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setReporterKey(k: string) {
  try {
    if (k.trim()) localStorage.setItem(KEY, k.trim());
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

let memoryDevice: string | null = null;
export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE, id);
    }
    return id;
  } catch {
    return (memoryDevice ??= crypto.randomUUID());
  }
}

export const REPORTS_CHANGED = 'wx:reports-changed';

export async function reportsApi(query: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Device': deviceId() };
  const key = reporterKey();
  if (key) headers['X-Reporter-Key'] = key;
  const r = await fetch(`/api/reports${query}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  if (!r.ok) {
    const msg = await r.json().then((j: { error?: string }) => j.error).catch(() => null);
    throw new Error(msg ?? `reports ${r.status}`);
  }
  return r.json();
}

// ---- Recent reports in view (filled by ReportsLayer, read by the trail popup) ----------------

export interface ReportRow {
  id: string;
  observed_at: number;
  lat: number;
  lon: number;
  state: string;
  extent: string;
  trail: string | null;
  source: string;
  trusted: number;
  model_state: string | null;
  mine: number;
}
let recent: ReportRow[] = [];
export const setRecentReports = (rows: ReportRow[]) => void (recent = rows);
export const recentReports = () => recent;
