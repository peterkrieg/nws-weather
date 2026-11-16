// Propose model settings (TUNE in src/conditions/model.ts) from weighted trail reports.
//   REPORTER_KEY=… npx tsx scripts/fit-model.mts
//
// Searches the main settings for the best weighted agreement, but judges it honestly: settings are
// picked on all days but one and scored on the day left out, for every day in turn ("leave one day
// out"). A change is only suggested when that held-out score clearly beats the current settings and
// there's enough weighted evidence. It never edits the model: a person reviews and applies it.

import { TUNE } from '../src/conditions/model.ts';
import { agreement, loadReports, weigh, type Row } from './reports-lib.mts';

const MIN_EVIDENCE = 15; // weighted reports
const MIN_GAIN = 0.05; // held-out agreement, 5 points

const rows = await loadReports();
const w = weigh(rows);
const evidence = [...w.values()].reduce((a, b) => a + b, 0);
console.log(`${rows.length} reports, weighted evidence ${evidence.toFixed(1)}`);

const current = { ...TUNE };
const grid: Partial<typeof TUNE>[] = [];
for (const muddy of [0.56, 0.6, 0.62, 0.66, 0.7])
  for (const damp of [0.4, 0.45, 0.5])
    for (const drain of [0.6, 1, 1.5])
      for (const seep of [0.02, 0.04, 0.08])
        for (const icyMm of [1, 2, 4]) if (damp < muddy) grid.push({ muddy, damp, drain, seep, icyMm });

const score = (subset: Row[], p: Partial<typeof TUNE>) => {
  Object.assign(TUNE, current, p);
  const s = agreement(subset, w);
  Object.assign(TUNE, current);
  return s;
};
const best = (subset: Row[]) => {
  let top = { s: -1, p: {} as Partial<typeof TUNE> };
  for (const p of grid) {
    const s = score(subset, p);
    if (s > top.s) top = { s, p };
  }
  return top;
};

const day = (r: Row) => Math.floor((r.observed_at - 7 * 3600) / 86400);
const days = [...new Set(rows.map(day))];
let heldOld = 0;
let heldNew = 0;
let heldW = 0;
if (days.length >= 2) {
  for (const d of days) {
    const train = rows.filter((r) => day(r) !== d);
    const test = rows.filter((r) => day(r) === d);
    const tw = test.reduce((a, r) => a + (w.get(r.id) ?? 0), 0);
    const { p } = best(train);
    heldOld += score(test, {}) * tw;
    heldNew += score(test, p) * tw;
    heldW += tw;
  }
}
const all = best(rows);
const now = score(rows, {});
console.log(`agreement with current settings: ${(100 * now).toFixed(0)}%   best fit (in-sample): ${(100 * all.s).toFixed(0)}%`, all.p);
if (heldW) console.log(`held-out days: current ${((100 * heldOld) / heldW).toFixed(0)}%  vs fitted ${((100 * heldNew) / heldW).toFixed(0)}%`);
const gain = heldW ? (heldNew - heldOld) / heldW : 0;
if (evidence < MIN_EVIDENCE) console.log(`\nNot enough evidence yet (need ${MIN_EVIDENCE} weighted reports). Keep the current settings.`);
else if (days.length < 2) console.log('\nAll reports are from one day: can’t test on held-out days yet. Keep the current settings.');
else if (gain < MIN_GAIN) console.log(`\nFitted settings don’t clearly beat the current ones on held-out days (+${(100 * gain).toFixed(1)} pts). Keep the current settings.`);
else console.log(`\nSuggest: update TUNE in src/conditions/model.ts to`, { ...current, ...all.p }, `(+${(100 * gain).toFixed(0)} pts on held-out days). Re-run scripts/check-conditions.mts after.`);
