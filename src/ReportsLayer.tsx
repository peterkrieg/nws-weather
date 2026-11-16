// Recent trail condition reports on the map: a coloured dot per report that fades over two days.
// Reports are anonymous; your own (same browser) can be removed from the dot's popup.

import { useEffect } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import { REPORT_COLOR, REPORT_LABEL } from './reportForm';
import { REPORTS_CHANGED, reportsApi, setRecentReports, type ReportRow } from './reporter';

const HOURS = 48;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function ago(sec: number) {
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
      if (map.getZoom() < 11) {
        group.clearLayers();
        setRecentReports([]);
        return;
      }
      const b = map.getBounds().pad(0.2);
      const n = ++seq;
      const rows = (await reportsApi(`?bbox=${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}&hours=${HOURS}`).catch(() => null)) as ReportRow[] | null;
      if (!rows || n !== seq) return;
      setRecentReports(rows);
      group.clearLayers();
      for (const r of rows) {
        const age = (Date.now() / 1000 - r.observed_at) / 3600;
        const fade = Math.max(0.35, 1 - age / HOURS);
        const marker = L.circleMarker([r.lat, r.lon], {
          radius: r.extent === 'spot' ? 6 : 8,
          color: r.mine ? '#222' : '#fff',
          weight: 2,
          fillColor: REPORT_COLOR[r.state] ?? '#888',
          fillOpacity: fade,
          opacity: fade,
        })
          .bindTooltip(`${REPORT_LABEL[r.state] ?? r.state} · ${ago(r.observed_at)}`, { direction: 'top', offset: [0, -6] })
          .bindPopup(
            `<div class="rep-pop"><b>${REPORT_LABEL[r.state] ?? r.state}</b> · ${ago(r.observed_at)}<br>` +
              `${r.trail ? `${esc(r.trail)} · ` : ''}${r.extent === 'spot' ? 'this spot' : 'whole stretch'}` +
              `${r.mine ? ' · your report' : ''}` +
              `${r.model_state ? `<br><span class="muted">Estimate then: ${REPORT_LABEL[r.model_state] ?? r.model_state}</span>` : ''}` +
              `${r.mine ? `<br><button type="button" class="rep-del" data-id="${r.id}">Remove my report</button>` : ''}</div>`,
          )
          .addTo(group);
        marker.on('popupopen', (e) => {
          const btn = (e.popup.getElement() as HTMLElement | undefined)?.querySelector<HTMLButtonElement>('.rep-del');
          btn?.addEventListener('click', async () => {
            await reportsApi(`?id=${encodeURIComponent(r.id)}`, { method: 'DELETE' }).catch(() => {});
            map.closePopup();
            window.dispatchEvent(new Event(REPORTS_CHANGED));
          });
        });
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
      setRecentReports([]);
    };
  }, [map]);
  return null;
}
