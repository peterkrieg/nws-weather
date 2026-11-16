// Who may file and see trail condition reports: a key kept in this browser. It's set once by
// opening a setup link (…/?reporter=KEY); the address bar sync then drops it from the URL, so it
// isn't passed along when a view is shared.

const KEY = 'wx:reporter';

try {
  const k = new URLSearchParams(location.search).get('reporter');
  if (k) localStorage.setItem(KEY, k);
} catch {
  /* storage unavailable: reporting stays off */
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

export const REPORTS_CHANGED = 'wx:reports-changed';

export async function reportsApi(query: string, init: RequestInit = {}) {
  const key = reporterKey();
  if (!key) throw new Error('no reporter key');
  const r = await fetch(`/api/reports${query}`, { ...init, headers: { ...init.headers, 'X-Reporter-Key': key, 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`reports ${r.status}`);
  return r.json();
}
