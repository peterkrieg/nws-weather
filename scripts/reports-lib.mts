// Shared by score-reports and fit-model: load reports, weigh them with some skepticism, re-run the
// model on their saved inputs, and measure agreement.
//
// Weighing (people can be wrong, or describe only part of a trail):
//   base       trusted (reporter key) 1.0, anonymous 0.6; relayed second-hand reviews × 0.4
//   peers      other devices' reports within 300 m and 3 h: agreeing ones raise confidence; a report
//              contradicted by two or more with none agreeing drops to 0.3×
//   reputation per device: how often its reports agree with *other people's* (never with the model,
//              which would just reward repeating the estimate), Laplace-smoothed: (agree+1)/(peers+2)
//   volume     a device's reports on the same day share their weight (÷ √n), so one enthusiastic
//              person can't outvote everyone

import { simulate, type Result, type Weather } from '../src/conditions/model.ts';
import { sameCall } from '../src/reportForm.ts';

export interface Row {
  id: string;
  observed_at: number;
  lat: number;
  lon: number;
  state: string;
  extent: string;
  trail: string | null;
  source: string;
  weight: number;
  trusted: number;
  device: string | null;
  reporter: string | null;
  model_state: string | null;
  inputs: { v: number; site: Parameters<typeof simulate>[0] & { terrain: { horizon: number[] } }; wx: Weather } | null;
}

export async function loadReports(): Promise<Row[]> {
  const SITE = process.env.SITE ?? 'https://weather.peterkrieg.com';
  const KEY = process.env.REPORTER_KEY;
  if (!KEY) throw new Error('Set REPORTER_KEY (the key from your reporter setup link).');
  const r = await fetch(`${SITE}/api/reports?all=1`, { headers: { 'X-Reporter-Key': KEY } });
  if (!r.ok) throw new Error(`reports ${r.status}`);
  return ((await r.json()) as Row[]).filter((x) => x.inputs);
}

const near = (a: Row, b: Row) => Math.abs(a.lat - b.lat) < 0.0027 && Math.abs(a.lon - b.lon) < 0.0035 && Math.abs(a.observed_at - b.observed_at) < 3 * 3600;
const who = (r: Row) => r.device ?? (r.reporter ? `key:${r.reporter}` : r.id);

export function weigh(rows: Row[]): Map<string, number> {
  const agree = new Map<string, number>();
  const disagree = new Map<string, number>();
  const rep = new Map<string, { a: number; n: number }>();
  for (const r of rows) {
    let a = 0;
    let d = 0;
    for (const o of rows) {
      if (o === r || who(o) === who(r) || !near(r, o)) continue;
      if (sameCall(r.state, o.state)) a++;
      else d++;
    }
    agree.set(r.id, a);
    disagree.set(r.id, d);
    const k = who(r);
    const cur = rep.get(k) ?? { a: 0, n: 0 };
    rep.set(k, { a: cur.a + a, n: cur.n + a + d });
  }
  const perDay = new Map<string, number>();
  for (const r of rows) {
    const k = `${who(r)}|${Math.floor((r.observed_at - 7 * 3600) / 86400)}`;
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = who(r);
    const { a, n } = rep.get(k)!;
    const reputation = (a + 1) / (n + 2);
    const base = (r.trusted ? 1 : 0.6) * (r.source === 'relayed' ? 0.4 : 1);
    const contradicted = (disagree.get(r.id) ?? 0) >= 2 && (agree.get(r.id) ?? 0) === 0 ? 0.3 : 1;
    const volume = 1 / Math.sqrt(perDay.get(`${k}|${Math.floor((r.observed_at - 7 * 3600) / 86400)}`) ?? 1);
    out.set(r.id, base * (0.5 + reputation) * contradicted * volume);
  }
  return out;
}

export function rerun(r: Row): Result {
  const site = { ...r.inputs!.site, terrain: { ...r.inputs!.site.terrain, horizon: Float32Array.from(r.inputs!.site.terrain.horizon) } };
  return simulate(site, r.inputs!.wx, r.observed_at);
}

/** Weighted share of reports the current model agrees with (by what matters for going out). */
export function agreement(rows: Row[], w: Map<string, number>) {
  let total = 0;
  let ok = 0;
  for (const r of rows) {
    const wt = w.get(r.id) ?? 0;
    total += wt;
    if (sameCall(r.state, rerun(r).state)) ok += wt;
  }
  return total ? ok / total : NaN;
}
