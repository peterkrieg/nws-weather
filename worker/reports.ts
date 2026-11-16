// /api/reports — trail condition reports ("How was it?"). Anyone can report, anonymously.
//   POST   add a report (JSON body, see ReportIn). Header X-Device: the browser's random id.
//   GET    ?bbox=w,s,e,n&hours=48   recent reports in view, anonymised, for the map and popups
//   GET    ?all=1                   everything with model inputs (reporter key only; for scripts)
//   DELETE ?id=…                    remove your own (same device, or your key)
//
// Abuse and noise: per-device and per-network daily limits (the network address is only kept as a
// salted hash that changes every day), one report per device per spot per hour (a new one replaces
// it), and sanity checks on time and place. Reports from a valid reporter key are "trusted"; the
// scoring and fitting scripts weigh everything else by how well it agrees with other people.
// Keys live in the REPORT_KEYS secret as "name:key,name:key".

interface D1Stmt {
  bind(...v: unknown[]): D1Stmt;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all(): Promise<{ results: Record<string, unknown>[] }>;
}
interface D1Database {
  prepare(sql: string): D1Stmt;
}

export interface ReportEnv {
  REPORTS?: D1Database;
  REPORT_KEYS?: string;
  IP_SALT?: string;
}

const STATES = ['dry', 'tacky', 'damp', 'muddy', 'frozen', 'icy', 'packed_snow', 'soft_snow'] as const;
const EXTENTS = ['spot', 'stretch', 'trail'] as const;
const SOURCES = { app: 1, relayed: 0.4 } as const;
const PER_DEVICE_DAY = 40;
const PER_NETWORK_DAY = 120; // a shared network (trailhead wifi, office) gets more room
const SAME_SPOT_DEG = 0.0005; // ~50 m
const DEVICE_RE = /^[0-9a-f-]{36}$/;

interface ReportIn {
  observedAt: number;
  lat: number;
  lon: number;
  state: string;
  extent?: string;
  trail?: string;
  source?: keyof typeof SOURCES;
  modelState?: string;
  inputs?: unknown;
  note?: string;
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function keyHolder(req: Request, env: ReportEnv): string | null {
  const key = req.headers.get('X-Reporter-Key');
  if (!key || !env.REPORT_KEYS) return null;
  for (const pair of env.REPORT_KEYS.split(',')) {
    const [name, k] = pair.split(':');
    if (k && k.trim() === key) return name.trim();
  }
  return null;
}

async function networkHash(req: Request, env: ReportEnv) {
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const day = Math.floor(Date.now() / 86400e3);
  const data = new TextEncoder().encode(`${env.IP_SALT ?? 'salt'}|${day}|${ip}`);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...h.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function reports(req: Request, url: URL, env: ReportEnv): Promise<Response> {
  const db = env.REPORTS;
  if (!db) return json({ error: 'reports not configured' }, 503);
  const who = keyHolder(req, env);
  const deviceHeader = req.headers.get('X-Device') ?? '';
  const device = DEVICE_RE.test(deviceHeader) ? deviceHeader : null;
  const now = Math.floor(Date.now() / 1000);

  if (req.method === 'POST') {
    if (!device && !who) return json({ error: 'device id required' }, 400);
    let r: ReportIn;
    try {
      r = (await req.json()) as ReportIn;
    } catch {
      return json({ error: 'bad json' }, 400);
    }
    if (!STATES.includes(r.state as (typeof STATES)[number])) return json({ error: 'bad state' }, 400);
    // Lower 48 (the model only runs where US elevation data exists).
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon) || r.lat < 24 || r.lat > 50 || r.lon < -125 || r.lon > -66) return json({ error: 'bad position' }, 400);
    if (!Number.isFinite(r.observedAt) || r.observedAt > now + 600 || r.observedAt < now - 14 * 86400) return json({ error: 'bad time' }, 400);
    const ipHash = await networkHash(req, env);
    if (!who) {
      const since = now - 86400;
      const d = await db.prepare('SELECT COUNT(*) AS n FROM reports WHERE device = ? AND created_at > ?').bind(device, since).first<{ n: number }>();
      const n = await db.prepare('SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ? AND created_at > ?').bind(ipHash, since).first<{ n: number }>();
      if ((d?.n ?? 0) >= PER_DEVICE_DAY || (n?.n ?? 0) >= PER_NETWORK_DAY) return json({ error: 'Too many reports today. Thanks for all of them!' }, 429);
    }
    const extent = EXTENTS.includes(r.extent as (typeof EXTENTS)[number]) ? r.extent! : 'spot';
    const source = r.source && r.source in SOURCES ? r.source : 'app';
    const inputs = r.inputs == null ? null : JSON.stringify(r.inputs);
    if (inputs && inputs.length > 400_000) return json({ error: 'inputs too large' }, 413);
    // Changing your mind about the same spot within the hour replaces the earlier report.
    if (device) {
      await db
        .prepare('DELETE FROM reports WHERE device = ? AND created_at > ? AND ABS(lat - ?) < ? AND ABS(lon - ?) < ?')
        .bind(device, now - 3600, r.lat, SAME_SPOT_DEG, r.lon, SAME_SPOT_DEG)
        .run();
    }
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO reports (id, created_at, observed_at, lat, lon, state, extent, trail, source, weight, reporter, model_state, inputs, note, device, ip_hash, trusted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, now, Math.round(r.observedAt), r.lat, r.lon, r.state, extent, r.trail?.slice(0, 200) ?? null, source, SOURCES[source], who, r.modelState ?? null, inputs, r.note?.slice(0, 1000) ?? null, device, ipHash, who ? 1 : 0)
      .run();
    return json({ id });
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'id required' }, 400);
    await db.prepare('DELETE FROM reports WHERE id = ? AND ((device IS NOT NULL AND device = ?) OR (reporter IS NOT NULL AND reporter = ?))').bind(id, device ?? '', who ?? '').run();
    return json({ ok: true });
  }

  if (url.searchParams.get('all') === '1') {
    if (!who) return json({ error: 'reporter key required' }, 401);
    const { results } = await db.prepare('SELECT * FROM reports ORDER BY observed_at').all();
    return json(results.map((r) => ({ ...r, ip_hash: undefined, inputs: r.inputs ? JSON.parse(r.inputs as string) : null })));
  }

  const box = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
  if (box.length !== 4 || box.some((v) => !Number.isFinite(v))) return json({ error: 'bbox required' }, 400);
  const hours = Math.min(24 * 14, Math.max(1, Number(url.searchParams.get('hours')) || 48));
  const [w, s, e, n] = box;
  if (e - w > 1 || n - s > 1) return json({ error: 'area too large' }, 400);
  // Anonymised: no names, devices or network hashes. "mine" lets the reporter undo their own.
  const { results } = await db
    .prepare(
      `SELECT id, observed_at, lat, lon, state, extent, trail, source, trusted, model_state, (device IS NOT NULL AND device = ?) AS mine
       FROM reports WHERE lon BETWEEN ? AND ? AND lat BETWEEN ? AND ? AND observed_at > ? ORDER BY observed_at DESC LIMIT 300`,
    )
    .bind(device ?? '', w, e, s, n, now - hours * 3600)
    .all();
  return json(results);
}
