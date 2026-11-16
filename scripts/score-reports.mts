// Score the trail conditions model against every "How was it?" report.
//   REPORTER_KEY=… npx tsx scripts/score-reports.mts            (live site)
//   SITE=http://localhost:8787 REPORTER_KEY=… npx tsx scripts/score-reports.mts
//
// Each report carries the model's inputs at that spot and time, so this re-runs the *current*
// model on them: change a constant in src/conditions/model.ts, run this, see if agreement improves.
// Reports are weighted (relayed reviews count less than first-hand ones) and grouped by what
// matters for going out: good / damp / mud / frozen / ice / snow.

import { simulate, type Weather } from '../src/conditions/model.ts';
import { sameCall } from '../src/reportForm.ts';

const SITE = process.env.SITE ?? 'https://weather.peterkrieg.com';
const KEY = process.env.REPORTER_KEY;
if (!KEY) {
  console.error('Set REPORTER_KEY (the key from your reporter setup link).');
  process.exit(1);
}

interface Row {
  id: string;
  observed_at: number;
  lat: number;
  lon: number;
  state: string;
  extent: string;
  trail: string | null;
  source: string;
  weight: number;
  model_state: string | null;
  inputs: { v: number; site: Parameters<typeof simulate>[0] & { terrain: { horizon: number[] } }; wx: Weather } | null;
}

const r = await fetch(`${SITE}/api/reports?all=1`, { headers: { 'X-Reporter-Key': KEY } });
if (!r.ok) throw new Error(`reports ${r.status}`);
const rows = (await r.json()) as Row[];

let total = 0;
let agree = 0;
let agreeThen = 0;
const confusion = new Map<string, Map<string, number>>();
for (const row of rows) {
  if (!row.inputs) continue;
  const site = { ...row.inputs.site, terrain: { ...row.inputs.site.terrain, horizon: Float32Array.from(row.inputs.site.terrain.horizon) } };
  const res = simulate(site, row.inputs.wx, row.observed_at);
  const ok = sameCall(row.state, res.state);
  total += row.weight;
  if (ok) agree += row.weight;
  if (row.model_state && sameCall(row.state, row.model_state)) agreeThen += row.weight;
  const m = confusion.get(row.state) ?? new Map<string, number>();
  m.set(res.state, (m.get(res.state) ?? 0) + 1);
  confusion.set(row.state, m);
  const when = new Date(row.observed_at * 1000).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric' });
  console.log(
    `${ok ? '✓' : '✗'} ${when.padEnd(16)} ${(row.trail ?? '').slice(0, 28).padEnd(28)} reported ${row.state.padEnd(11)} model ${res.state.padEnd(7)} wet ${res.wet.toFixed(2)} snow ${res.swe.toFixed(0)}mm` +
      `${row.source !== 'app' ? `  (${row.source}, ×${row.weight})` : ''}`,
  );
}
if (!total) {
  console.log('No reports with model inputs yet.');
  process.exit(0);
}
console.log(`\nAgreement now: ${((100 * agree) / total).toFixed(0)}% (weighted, ${rows.length} reports)` + `   · when reported: ${((100 * agreeThen) / total).toFixed(0)}%`);
console.log('\nReported → model said:');
for (const [rep, m] of confusion) console.log(`  ${rep.padEnd(12)} ${[...m].map(([k, v]) => `${k} ×${v}`).join(', ')}`);
