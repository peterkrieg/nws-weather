// App-like behaviour: forecast age, pull-to-refresh, and the "new version" prompt.

import { useEffect, useRef, useState } from 'react';
import { Button, Loader } from '@mantine/core';
import { useRegisterSW } from 'virtual:pwa-register/react';

function useNow(everyMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function age(ms: number) {
  const min = Math.floor(ms / 60e3);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/** "Updated 5 min ago ↻", or a warning when showing a saved forecast offline. */
export function Updated({ at, offline, loading, onRefresh }: { at: number; offline: boolean; loading: boolean; onRefresh: () => void }) {
  const now = useNow(30e3);
  if (!at) return null;
  return (
    <span className={offline ? 'updated is-offline' : 'updated'}>
      {offline ? `Offline · forecast from ${age(now - at)}` : `Updated ${age(now - at)}`}
      <button type="button" className="refresh-btn" onClick={onRefresh} disabled={loading} aria-label="Refresh forecast" title="Refresh">
        {loading ? (
          <Loader size={12} />
        ) : (
          <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4.5h-4.5" />
          </svg>
        )}
      </button>
    </span>
  );
}

const PULL = 70; // px of downward drag at the top of the page that triggers a refresh

/** Pull down at the top of the page to refresh, like a native app. */
export function usePullToRefresh(onRefresh: () => void) {
  const cb = useRef(onRefresh);
  cb.current = onRefresh;
  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    const el = document.createElement('div');
    el.className = 'ptr';
    el.innerHTML = '<svg class="ico" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4.5h-4.5"/></svg>';
    document.body.appendChild(el);
    let startY: number | null = null;
    let dist = 0;
    const set = (d: number, animate = false) => {
      el.style.transition = animate ? 'transform 0.2s, opacity 0.2s' : 'none';
      el.style.transform = `translate(-50%, ${Math.min(d, PULL * 1.4) - 44}px) rotate(${d * 3}deg)`;
      el.style.opacity = String(Math.min(1, d / PULL));
      el.classList.toggle('is-ready', d >= PULL);
    };
    const start = (e: TouchEvent) => {
      // Not when the touch starts on the map or inside a scrollable chart/table/dialog.
      const t = e.target as Element;
      startY = scrollY <= 0 && !t.closest('.leaflet-container, .mantine-Modal-content, .table-scroll') ? e.touches[0].clientY : null;
      dist = 0;
    };
    const move = (e: TouchEvent) => {
      if (startY == null) return;
      dist = Math.max(0, (e.touches[0].clientY - startY) * 0.5);
      if (scrollY > 0) dist = 0;
      set(dist);
    };
    const end = () => {
      if (startY != null && dist >= PULL) cb.current();
      startY = null;
      set(0, true);
    };
    addEventListener('touchstart', start, { passive: true });
    addEventListener('touchmove', move, { passive: true });
    addEventListener('touchend', end);
    addEventListener('touchcancel', end);
    return () => {
      removeEventListener('touchstart', start);
      removeEventListener('touchmove', move);
      removeEventListener('touchend', end);
      removeEventListener('touchcancel', end);
      el.remove();
    };
  }, []);
}

/** After a deploy, the installed app offers to reload into the new version instead of switching mid-use. */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      // Home-screen apps stay open for days, and iOS only checks for a new version on a cold
      // launch. So also check hourly, and whenever the app comes back to the foreground.
      // The check is one small file, so a 10 s gap is only there to absorb rapid app switching.
      let last = 0;
      const check = () => {
        if (Date.now() - last < 10e3 || !navigator.onLine) return;
        last = Date.now();
        reg.update().catch(() => {});
      };
      setInterval(check, 3600e3);
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
    },
  });
  if (!needRefresh) return null;
  return (
    <div className="update-toast" role="status">
      <span>A new version is available.</span>
      <Button size="xs" onClick={() => updateServiceWorker(true)}>
        Reload
      </Button>
      <button type="button" className="update-x" onClick={() => setNeedRefresh(false)} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
