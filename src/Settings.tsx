import { ActionIcon, Button, Modal, Switch } from '@mantine/core';
import { CHARTS, SECTIONS, defaultPrefs, type Item, type Prefs } from './store';

function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}

function OrderList<Id extends string>({
  items,
  labels,
  onChange,
}: {
  items: Item<Id>[];
  labels: Record<Id, string>;
  onChange: (items: Item<Id>[]) => void;
}) {
  return (
    <ul className="order-list">
      {items.map((it, i) => (
        <li key={it.id} className={it.on ? '' : 'is-off'}>
          <Switch
            size="sm"
            checked={it.on}
            onChange={(e) => onChange(items.map((x) => (x.id === it.id ? { ...x, on: e.currentTarget.checked } : x)))}
            label={labels[it.id]}
          />
          <span className="order-btns">
            <ActionIcon variant="subtle" color="gray" size="sm" disabled={i === 0} onClick={() => onChange(move(items, i, i - 1))} aria-label={`Move ${labels[it.id]} up`}>
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
            </ActionIcon>
            <ActionIcon variant="subtle" color="gray" size="sm" disabled={i === items.length - 1} onClick={() => onChange(move(items, i, i + 1))} aria-label={`Move ${labels[it.id]} down`}>
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </ActionIcon>
          </span>
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
      <p className="set-note">On wide screens the map sits beside the section before or after it.</p>
      <OrderList items={prefs.sections} labels={SECTIONS} onChange={(sections) => setPrefs({ ...prefs, sections })} />
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
