import { useRef, useState } from 'react';
import { Button, Modal, Switch } from '@mantine/core';
import { BASES } from './MapView';
import { CHARTS, SECTIONS, defaultPrefs, type Item, type Prefs } from './store';

function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}

/**
 * Switches you reorder by dragging the grip (mouse or finger). The row moves as you drag past
 * its neighbours. Keyboard: focus the grip and use the arrow keys.
 */
function OrderList<Id extends string>({
  items,
  labels,
  onChange,
}: {
  items: Item<Id>[];
  labels: Record<Id, string>;
  onChange: (items: Item<Id>[]) => void;
}) {
  const [dragging, setDragging] = useState<Id | null>(null);
  const rows = useRef(new Map<Id, HTMLLIElement>());
  // Window listeners outlive this render, so they read the latest list through a ref.
  const latest = useRef({ items, onChange });
  latest.current = { items, onChange };

  const startDrag = (id: Id) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragging(id);
    const onMove = (ev: PointerEvent) => {
      const { items, onChange } = latest.current;
      const from = items.findIndex((x) => x.id === id);
      // Target: the row whose vertical middle the pointer has passed.
      let to = from;
      items.forEach((x, i) => {
        const r = rows.current.get(x.id)?.getBoundingClientRect();
        if (!r) return;
        if (i < from && ev.clientY < r.top + r.height / 2) to = Math.min(to, i);
        if (i > from && ev.clientY > r.top + r.height / 2) to = Math.max(to, i);
      });
      if (to !== from) onChange(move(items, from, to));
    };
    const onUp = () => {
      setDragging(null);
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onUp);
  };

  const onKey = (i: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const to = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : null;
    if (to == null || to < 0 || to >= items.length) return;
    e.preventDefault();
    const btn = e.currentTarget;
    onChange(move(items, i, to));
    requestAnimationFrame(() => btn.focus());
  };

  return (
    <ul className={dragging ? 'order-list is-sorting' : 'order-list'}>
      {items.map((it, i) => (
        <li
          key={it.id}
          ref={(el) => {
            if (el) rows.current.set(it.id, el);
            else rows.current.delete(it.id);
          }}
          className={[it.on ? '' : 'is-off', dragging === it.id ? 'is-dragging' : ''].join(' ').trim() || undefined}
        >
          <button
            type="button"
            className="drag-handle"
            onPointerDown={startDrag(it.id)}
            onKeyDown={onKey(i)}
            aria-label={`Reorder ${labels[it.id]}. Use the up and down arrow keys.`}
            title="Drag to reorder"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {[6, 12, 18].map((y) => [9, 15].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.6" />))}
            </svg>
          </button>
          <Switch
            size="sm"
            className="order-switch"
            checked={it.on}
            onChange={(e) => onChange(items.map((x) => (x.id === it.id ? { ...x, on: e.currentTarget.checked } : x)))}
            label={labels[it.id]}
            labelPosition="left"
          />
        </li>
      ))}
    </ul>
  );
}

export default function Settings({
  opened,
  onClose,
  prefs,
  setPrefs,
}: {
  opened: boolean;
  onClose: () => void;
  prefs: Prefs;
  setPrefs: (p: Prefs) => void;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title="Layout" radius="md" size="md" zIndex={2000}>
      <h3 className="set-head">Sections</h3>
      <p className="set-note">Drag ⋮⋮ to reorder. On wide screens the map sits beside the section before or after it.</p>
      <OrderList items={prefs.sections} labels={SECTIONS} onChange={(sections) => setPrefs({ ...prefs, sections })} />
      <h3 className="set-head">Current conditions</h3>
      <ul className="order-list">
        <li className={prefs.strip ? '' : 'is-off'}>
          <Switch
            size="sm"
            className="order-switch"
            checked={prefs.strip}
            onChange={(e) => setPrefs({ ...prefs, strip: e.currentTarget.checked })}
            label="Hour-by-hour strip"
            labelPosition="left"
          />
        </li>
      </ul>
      <h3 className="set-head">Map style</h3>
      <div className="base-list" role="radiogroup" aria-label="Map style">
        {BASES.map((b) => (
          <label key={b.name} className={prefs.basemap === b.name ? 'base-opt is-on' : 'base-opt'}>
            <input
              type="radio"
              name="basemap"
              checked={prefs.basemap === b.name}
              onChange={() => setPrefs({ ...prefs, basemap: b.name })}
            />
            <span>
              <b>{b.name}</b>
              <small>{b.note}</small>
            </span>
          </label>
        ))}
      </div>
      <h3 className="set-head">Hourly charts</h3>
      <OrderList items={prefs.charts} labels={CHARTS} onChange={(charts) => setPrefs({ ...prefs, charts })} />
      <div className="set-foot">
        <Button variant="subtle" color="gray" size="xs" onClick={() => setPrefs(defaultPrefs())}>
          Reset to default
        </Button>
        <span className="set-note">Saved in this browser.</span>
      </div>
    </Modal>
  );
}
