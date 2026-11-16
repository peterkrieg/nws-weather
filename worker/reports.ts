// /api/reports — trail condition reports ("How was it?").
//   POST   add a report (JSON body, see ReportIn)
//   GET    ?bbox=w,s,e,n&hours=48   recent reports in view, for the map
//   GET    ?all=1                   everything, inputs included (for scripts/score-reports.mts)
//   DELETE ?id=…                    remove one (a mis-tap)
// Reports reveal where and when someone runs, so reading needs a key as well as writing.
// Keys live in the REPORT_KEYS secret as "name:key,name:key".

// The slice of Cloudflare's D1 API used here.
interface D1Stmt {
  bind(...v: unknown[]): D1Stmt;
  run(): Promise<unknown>;
  all(): Promise<{ results: Record<string, unknown>[] }>;
}
interface D1Database {
  prepare(sql: string): D1Stmt;
}

export interface ReportEnv {
  REPORTS?: D1Database;
  REPORT_KEYS?: string;
}

const STATES = ['dry', 'tacky', 'damp', 'muddy', 'frozen', 'icy', 'packed_snow', 'soft_snow'] as const;
const EXTENTS = ['spot', 'stretch', 'trail'] as const;
const SOURCES = { app: 1, relayed: 0.4 } as const;

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

function reporter(req: Request, env: ReportEnv): string | null {
  const key = req.headers.get('X-Reporter-Key');
  if (!key || !env.REPORT_KEYS) return null;
  for (const pair of env.REPORT_KEYS.split(',')) {
    const [name, k] = pair.split(':');
    if (k && k.trim() === key) return name.trim();
  }
  return null;
}

export async function reports(req: Request, url: URL, env: ReportEnv): Promise<Response> {
  const db = env.REPORTS;
  if (!db) return json({ error: 'reports not configured' }, 503);
  const who = reporter(req, env);
  if (!who) return json({ error: 'reporter key required' }, 401);

  if (req.method === 'POST') {
    let r: ReportIn;
    try {
      r = (await req.json()) as ReportIn;
    } catch {
      return json({ error: 'bad json' }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    if (!STATES.includes(r.state as (typeof STATES)[number])) return json({ error: 'bad state' }, 400);
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon) || Math.abs(r.lat) > 90) return json({ error: 'bad position' }, 400);
    if (!Number.isFinite(r.observedAt) || r.observedAt > now + 600 || r.observedAt < now - 14 * 86400) return json({ error: 'bad time' }, 400);
    const extent = EXTENTS.includes(r.extent as (typeof EXTENTS)[number]) ? r.extent! : 'spot';
    const source = r.source && r.source in SOURCES ? r.source : 'app';
    const inputs = r.inputs == null ? null : JSON.stringify(r.inputs);
    if (inputs && inputs.length > 400_000) return json({ error: 'inputs too large' }, 413);
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO reports (id, created_at, observed_at, lat, lon, state, extent, trail, source, weight, reporter, model_state, inputs, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, now, Math.round(r.observedAt), r.lat, r.lon, r.state, extent, r.trail?.slice(0, 200) ?? null, source, SOURCES[source], who, r.modelState ?? null, inputs, r.note?.slice(0, 1000) ?? null)
      .run();
    return json({ id });
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'id required' }, 400);
    await db.prepare('DELETE FROM reports WHERE id = ? AND reporter = ?').bind(id, who).run();
    return json({ ok: true });
  }

  if (url.searchParams.get('all') === '1') {
    const { results } = await db.prepare('SELECT * FROM reports ORDER BY observed_at').all();
    return json(results.map((r) => ({ ...r, inputs: r.inputs ? JSON.parse(r.inputs as string) : null })));
  }

  const box = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
  if (box.length !== 4 || box.some((v) => !Number.isFinite(v))) return json({ error: 'bbox required' }, 400);
  const hours = Math.min(24 * 14, Math.max(1, Number(url.searchParams.get('hours')) || 48));
  const [w, s, e, n] = box;
  const { results } = await db
    .prepare(
      `SELECT id, observed_at, lat, lon, state, extent, trail, source, reporter, model_state, note FROM reports
       WHERE lon BETWEEN ? AND ? AND lat BETWEEN ? AND ? AND observed_at > ? ORDER BY observed_at DESC LIMIT 200`,
    )
    .bind(w, e, s, n, Math.floor(Date.now() / 1000) - hours * 3600)
    .all();
  return json(results);
}
