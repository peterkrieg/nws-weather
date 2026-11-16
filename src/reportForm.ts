// "How was it?" inside the trail-condition popup. One tap on a condition files the report; the
// model's inputs at that spot and time go with it (see conditions/worker probe), so the model can
// be re-run and scored against every report after any change (scripts/score-reports.mts).

import type { Stretch } from './conditions/worker';
import type { TrailConditions } from './conditions/client';
import { REPORTS_CHANGED, recentReports, reportsApi } from './reporter';

export const REPORT_STATES = [
  ['dry', 'Dry', '#adb5bd'],
  ['tacky', 'Tacky', '#2f9e44'],
  ['damp', 'Damp', '#d9a21b'],
  ['muddy', 'Muddy', '#8a4b14'],
  ['frozen', 'Frozen firm', '#1c7ed6'],
  ['icy', 'Icy', '#15aabf'],
  ['packed_snow', 'Packed snow', '#9775fa'],
  ['soft_snow', 'Soft snow', '#a5d8ff'],
] as const;
export const REPORT_LABEL: Record<string, string> = Object.fromEntries(REPORT_STATES.map(([id, label]) => [id, label]));
export const REPORT_COLOR: Record<string, string> = Object.fromEntries(REPORT_STATES.map(([id, , c]) => [id, c]));

const WHEN = [
  ['0', 'Just now'],
  ['1', '1 h ago'],
  ['3', '3 h ago'],
  ['morning', 'This morning'],
] as const;

export function reportHtml() {
  return `
    <div class="rep">
      <div class="rep-q">How was it?</div>
      <div class="rep-when" role="radiogroup" aria-label="When">
        ${WHEN.map(([v, l], i) => `<button type="button" data-when="${v}" class="${i === 0 ? 'on' : ''}" aria-pressed="${i === 0}">${l}</button>`).join('')}
      </div>
      <div class="rep-states">
        ${REPORT_STATES.map(([id, label, c]) => `<button type="button" data-state="${id}"><i style="background:${c}"></i>${label}</button>`).join('')}
      </div>
      <label class="rep-extent"><input type="checkbox" data-extent> The whole stretch, not just here</label>
      <div class="rep-msg" aria-live="polite"></div>
    </div>`;
}

function observedAt(when: string) {
  const now = Date.now() / 1000;
  if (when === 'morning') {
    const d = new Date();
    d.setHours(9, 0, 0, 0);
    return Math.min(now, d.getTime() / 1000);
  }
  return now - Number(when) * 3600;
}

/** Wire up the form in a just-opened popup. */
export function wireReport(root: HTMLElement, tap: { lat: number; lon: number }, stretch: Stretch, cond: Pick<TrailConditions, 'probe'>) {
  const box = root.querySelector<HTMLElement>('.rep');
  if (!box) return;
  const msg = box.querySelector<HTMLElement>('.rep-msg')!;
  let when = '0';
  box.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    if (btn.dataset.when) {
      when = btn.dataset.when;
      box.querySelectorAll<HTMLButtonElement>('[data-when]').forEach((b) => {
        b.classList.toggle('on', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      return;
    }
    if (btn.dataset.undo) {
      await reportsApi(`?id=${encodeURIComponent(btn.dataset.undo)}`, { method: 'DELETE' }).catch(() => {});
      msg.textContent = 'Removed.';
      window.dispatchEvent(new Event(REPORTS_CHANGED));
      return;
    }
    const state = btn.dataset.state;
    if (!state) return;
    const states = box.querySelector<HTMLElement>('.rep-states')!;
    states.classList.add('busy');
    msg.textContent = 'Saving…';
    try {
      const at = observedAt(when);
      const p = await cond.probe(tap.lat, tap.lon, stretch, Math.floor(at));
      const extent = box.querySelector<HTMLInputElement>('[data-extent]')!.checked ? 'stretch' : 'spot';
      const { id } = (await reportsApi('', {
        method: 'POST',
        body: JSON.stringify({
          observedAt: Math.floor(at),
          lat: p.lat,
          lon: p.lon,
          state,
          extent,
          trail: stretch.name,
          modelState: p.result.state,
          // v1: what model.simulate takes, plus the stretch shape for "whole stretch" reports.
          inputs: { v: 1, site: p.inputs, wx: p.wx, stretch: extent === 'stretch' ? stretch.coords : undefined },
        }),
      })) as { id: string };
      const agreed = sameCall(state, p.result.state);
      msg.innerHTML = `Saved: <b>${REPORT_LABEL[state]}</b>. ${agreed ? 'The estimate agreed.' : `The estimate said ${p.result.state}.`} <button type="button" class="rep-undo" data-undo="${id}">Undo</button>`;
      window.dispatchEvent(new Event(REPORTS_CHANGED));
    } catch (err) {
      msg.textContent = `Couldn't save: ${String(err).replace(/^Error: /, '')}`;
    } finally {
      states.classList.remove('busy');
    }
  });
}

/** Whether a report and the model's state mean the same thing for someone deciding to go. */
export function sameCall(reported: string, model: string) {
  const group = (s: string) =>
    ({ dry: 'good', tacky: 'good', damp: 'damp', muddy: 'mud', frozen: 'frozen', icy: 'ice', packed_snow: 'snow', soft_snow: 'snow', snow: 'snow' })[s] ?? s;
  return group(reported) === group(model);
}

/**
 * Recent reports along this stretch (within ~40 m, last 24 h), summarised: "Muddy ×2 · Damp ×1".
 * Newer and trusted reports count for more; one report is shown as one report, not a verdict.
 */
export function nearbyReportsHtml(stretch: Stretch): string {
  const now = Date.now() / 1000;
  const near = recentReports().filter((r) => {
    if (now - r.observed_at > 24 * 3600) return false;
    return stretch.coords.some(([x, y]) => Math.abs(y - r.lat) < 0.00036 && Math.abs(x - r.lon) < 0.00047);
  });
  if (!near.length) return '';
  const tally = new Map<string, { n: number; w: number; newest: number }>();
  for (const r of near) {
    const t = tally.get(r.state) ?? { n: 0, w: 0, newest: 0 };
    t.n++;
    t.w += (r.trusted ? 1.5 : 1) * Math.exp(-(now - r.observed_at) / (12 * 3600));
    t.newest = Math.max(t.newest, r.observed_at);
    tally.set(r.state, t);
  }
  const parts = [...tally].sort((a, b) => b[1].w - a[1].w).map(([st, t]) => `<i style="background:${REPORT_COLOR[st] ?? '#888'}"></i>${REPORT_LABEL[st] ?? st}${t.n > 1 ? ` ×${t.n}` : ''}`);
  const newest = Math.max(...near.map((r) => r.observed_at));
  const h = Math.max(1, Math.round((now - newest) / 3600));
  return `<div class="cond-reports"><b>Reported here:</b> ${parts.join(" · ")} <span class="muted">(latest ${now - newest < 2700 ? "just now" : `${h} h ago`})</span></div>`;
}
