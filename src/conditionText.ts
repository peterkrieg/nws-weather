// Words for the trail-condition popup. Kept out of the MapLibre chunk so it loads with the map.

import type { Stretch } from './conditions/worker';

export const COND_LABEL: Record<string, string> = {
  muddy: 'Muddy',
  damp: 'Damp, soft spots',
  tacky: 'Tacky',
  dry: 'Dry',
  frozen: 'Frozen firm',
  icy: 'Icy',
  packed_snow: 'Packed snow',
  soft_snow: 'Soft snow',
};
const COND_DOT: Record<string, string> = {
  muddy: '#8a4b14',
  damp: '#d9a21b',
  tacky: '#2f9e44',
  dry: '#adb5bd',
  frozen: '#1c7ed6',
  icy: '#15aabf',
  packed_snow: '#9775fa',
  soft_snow: '#a5d8ff',
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const inches = (mm: number) => (mm / 25.4 < 0.05 ? 'a trace' : `${(mm / 25.4).toFixed(mm / 25.4 < 1 ? 2 : 1)} in`);
/** "Mon afternoon": the model isn't precise enough for an hour. */
function when(sec: number) {
  const d = new Date(sec * 1000);
  const h = d.getHours();
  const part = h < 5 ? 'early morning' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400e3);
  const day = d.toDateString() === today.toDateString() ? 'this' : d.toDateString() === tomorrow.toDateString() ? 'tomorrow' : d.toLocaleDateString('en-US', { weekday: 'long' });
  if (day === 'this') return part === 'night' ? 'tonight' : `this ${part}`;
  return `${day} ${part}`;
}

export function conditionHtml(s: Stretch): string {
  const r = s.worst;
  const w = r.why;
  const lines: string[] = [];
  lines.push(
    w.rain72 < 0.5
      ? 'No rain or melt in the last 3 days.'
      : `${inches(w.rain72)} of rain/melt in the last 3 days${w.hoursSinceRain != null ? `, most recently ${Math.round(w.hoursSinceRain)} h ago` : ''}.`,
  );
  if (r.swe > 5) {
    const inch = Math.max(1, Math.round((r.swe * 4) / 25.4));
    const age = w.hoursSinceSnow == null ? '' : w.hoursSinceSnow < 18 ? ', fresh' : w.hoursSinceSnow < 48 ? `, fell ${Math.round(w.hoursSinceSnow / 24) || 1} day ago` : '';
    const under = w.under === 'frozen' ? ' Frozen ground underneath.' : w.under === 'mud' ? ' Wet, thawed ground underneath: slushy and muddy as it melts.' : '';
    lines.push(`About ${inch} in of snow${age}.${w.refrozen ? (r.state === 'icy' ? ' A thin layer that melted and refroze: icy.' : ' It has melted and refrozen: a firm, crusty surface, slick in places.') : r.state === 'packed_snow' ? ' Likely packed down where people walk.' : ''}${under}`);
  } else if (r.state === 'icy') {
    lines.push('Water has frozen on the surface (meltwater, rain or seepage onto frozen ground).');
  } else if (r.state === 'frozen') {
    lines.push(w.ground > 0 ? 'The top crust froze overnight; the ground below hasn’t.' : `The ground is frozen (about ${Math.round((w.ground * 9) / 5 + 32)}°F an inch or two down).`);
  } else if (w.frost > 0.3) {
    lines.push('Partly frozen: firm in places, soft on top.');
  } else if (w.deepFrozen && r.wet >= 0.45) {
    lines.push('Thawed on top but frozen below, so water can’t soak away.');
  }
  lines.push(
    w.sunFull === 0
      ? 'No direct sun today: the terrain blocks it.'
      : `${w.sunToday} h of direct sun so far today (${w.sunFull} h all day, ${Math.round(w.sunShare * 100)}% of open flat ground).`,
  );
  if (w.collects) lines.push('Sits in a hollow that collects runoff and seepage.');
  else if (w.sheds) lines.push('On a rib or nose that sheds water.');
  if (w.seen) {
    const d = new Date(w.seen.at * 1000);
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400e3);
    const day = days === 0 ? 'today' : days === 1 ? 'yesterday' : `on ${d.toLocaleDateString('en-US', { weekday: 'long' })}`;
    lines.push(`Satellite saw ${w.seen.snow ? 'snow' : 'bare ground'} here ${day}.`);
  }
  const ground = w.surface && !['ground', 'dirt', 'unpaved', 'earth'].includes(w.surface) ? `${w.surface.replace('_', ' ')} surface` : `${w.soil} soil${w.rocky ? ', rocky' : ''}`;
  lines.push(`${ground[0].toUpperCase()}${ground.slice(1)}${w.canopy != null ? `, ${Math.round(w.canopy * 100)}% tree cover` : ''}.`);
  const outlook =
    r.state === 'frozen'
      ? r.thawBy
        ? `Firm now; should soften by <b>${when(r.thawBy)}</b>.`
        : 'Should stay frozen for the next couple of days.'
      : r.state === 'dry' || r.state === 'tacky'
      ? ''
      : r.state === 'icy' || r.state === 'packed_snow' || r.state === 'soft_snow'
        ? r.goodBy
          ? `Should clear by <b>${when(r.goodBy)}</b>.`
          : 'Not expected to clear in the next 2 days.'
      : r.goodBy
        ? `Should firm up by <b>${when(r.goodBy)}</b>.`
        : 'Not expected to dry out in the next 2 days.';
  const len = s.lengthM >= 1000 ? `${(s.lengthM / 1609).toFixed(1)} mi` : `${Math.round(s.lengthM / 5) * 5 * 3.28 < 30 ? 'a few feet' : `about ${Math.round((s.lengthM * 3.28) / 10) * 10} ft`}`;
  return `
    <div class="cond-head"><i style="background:${COND_DOT[r.state]}"></i><b>${COND_LABEL[r.state]}</b></div>
    <div class="cond-sub">${s.name ? `${esc(s.name)} · ` : ''}${len} of trail</div>
    <ul class="cond-why">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
    ${outlook ? `<div class="cond-out">${outlook}</div>` : ''}
    <div class="cond-note">Estimate from terrain, soil and weather data${w.measured?.length ? `, corrected with ${w.measured.length} nearby weather station${w.measured.length > 1 ? 's' : ''}` : ''}.</div>`;
}
