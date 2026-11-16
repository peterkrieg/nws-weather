// Recent trail condition reports on the map: a coloured dot per report that fades over two days.
// Only for browsers holding a reporter key (reports show where and when people run).

import { useEffect } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import { REPORT_COLOR, REPORT_LABEL } from './reportForm';
import { REPORTS_CHANGED, reportsApi } from './reporter';

interface Row {
  id: string;
  observed_at: number;
  lat: number;
  lon: number;
  state: string;
  extent: string;
  trail: string | null;
  source: string;
  reporter: string | null;
  model_state: string | null;
}

const HOURS = 48;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function ago(sec: number) {
  const h = (Date.now() / 1000 - sec) / 3600;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 24) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export default function ReportsLayer() {
  const map = useMap();
  useEffect(() => {
    const group = L.layerGroup().addTo(map);
    let timer = 0;
    let seq = 0;
    const load = async () => {
      if (map.getZoom() < 11) return void group.clearLayers();
      const b = map.getBounds().pad(0.2);
      const n = ++seq;
      const rows = (await reportsApi(`?bbox=${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}&hours=${HOURS}`).catch(() => null)) as Row[] | null;
      if (!rows || n !== seq) return;
      group.clearLayers();
      for (const r of rows) {
        const age = (Date.now() / 1000 - r.observed_at) / 3600;
        const fade = Math.max(0.35, 1 - age / HOURS);
        L.circleMarker([r.lat, r.lon], {
          radius: r.extent === 'spot' ? 6 : 8,
          color: '#fff',
          weight: 2,
          fillColor: REPORT_COLOR[r.state] ?? '#888',
          fillOpacity: fade,
          opacity: fade,
        })
          .bindTooltip(`${REPORT_LABEL[r.state] ?? r.state} · ${ago(r.observed_at)}`, { direction: 'top', offset: [0, -6] })
          .bindPopup(
            `<div class="rep-pop"><b>${REPORT_LABEL[r.state] ?? r.state}</b> · ${ago(r.observed_at)}<br>` +
              `${r.trail ? `${esc(r.trail)} · ` : ''}${r.extent === 'spot' ? 'this spot' : 'whole stretch'}` +
              `${r.reporter ? ` · ${esc(r.reporter)}` : ''}${r.model_state ? `<br><span class="muted">Estimate then: ${r.model_state}</span>` : ''}</div>`,
          )
          .addTo(group);
      }
    };
    const soon = () => {
      clearTimeout(timer);
      timer = window.setTimeout(load, 400);
    };
    map.on('moveend', soon);
    window.addEventListener(REPORTS_CHANGED, soon);
    load();
    return () => {
      map.off('moveend', soon);
      window.removeEventListener(REPORTS_CHANGED, soon);
      clearTimeout(timer);
      group.remove();
    };
  }, [map]);
  return null;
}
