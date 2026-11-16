// Score the trail conditions model against every "How was it?" report.
//   REPORTER_KEY=… npx tsx scripts/score-reports.mts            (live site)
//   SITE=http://localhost:8787 REPORTER_KEY=… npx tsx scripts/score-reports.mts
//
// Re-runs the *current* model on each report's saved inputs, so after changing src/conditions/
// model.ts this shows whether agreement improved. Reports are weighted with some skepticism (see
// reports-lib.mts); to search for better settings, use fit-model.mts.

import { sameCall } from '../src/reportForm.ts';
import { agreement, loadReports, rerun, weigh } from './reports-lib.mts';

const rows = await loadReports();
if (!rows.length) {
  console.log('No reports with model inputs yet.');
  process.exit(0);
}
const w = weigh(rows);
const confusion = new Map<string, Map<string, number>>();
let then = 0;
let total = 0;
for (const row of rows) {
  const res = rerun(row);
  const wt = w.get(row.id)!;
  total += wt;
  if (row.model_state && sameCall(row.state, row.model_state)) then += wt;
  const m = confusion.get(row.state) ?? new Map<string, number>();
  m.set(res.state, (m.get(res.state) ?? 0) + 1);
  confusion.set(row.state, m);
  const when = new Date(row.observed_at * 1000).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric' });
  console.log(
    `${sameCall(row.state, res.state) ? '✓' : '✗'} ${when.padEnd(16)} ${(row.trail ?? '').slice(0, 26).padEnd(26)} reported ${row.state.padEnd(11)} model ${res.state.padEnd(11)} wet ${res.wet.toFixed(2)}  weight ${wt.toFixed(2)}${row.trusted ? ' (trusted)' : ''}`,
  );
}
console.log(`\nWeighted agreement now: ${(100 * agreement(rows, w)).toFixed(0)}%   · when reported: ${((100 * then) / total).toFixed(0)}%   (${rows.length} reports)`);
console.log('\nReported → model says:');
for (const [rep, m] of confusion) console.log(`  ${rep.padEnd(12)} ${[...m].map(([k, v]) => `${k} ×${v}`).join(', ')}`);
