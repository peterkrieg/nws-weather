import { useState, type CSSProperties } from 'react';
import { Button, Modal, PasswordInput, Switch } from '@mantine/core';
import { reporterKey, setReporterKey } from './reporter';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { BASES } from './MapView';
import { CHARTS, SECTIONS, defaultPrefs, type Item, type Prefs } from './store';

function Row<Id extends string>({ item, label, onToggle }: { item: Item<Id>; label: string; onToggle: (on: boolean) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  return (
    <li ref={setNodeRef} style={style} className={[item.on ? '' : 'is-off', isDragging ? 'is-dragging' : ''].join(' ').trim() || undefined}>
      <button
        type="button"
        className="drag-handle"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${label}`}
        title="Drag to reorder"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {[6, 12, 18].map((y) => [9, 15].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.6" />))}
        </svg>
      </button>
      <Switch
        size="sm"
        className="order-switch"
        checked={item.on}
        onChange={(e) => onToggle(e.currentTarget.checked)}
        label={label}
        labelPosition="left"
      />
    </li>
  );
}

/**
 * Switches you reorder by dragging the grip (mouse or finger): the row lifts, its neighbours slide
 * out of the way, and it settles into place on drop. Keyboard: focus the grip, Space, arrows, Space.
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
  const sensors = useSensors(
    // A few px of movement before a drag starts, so a tap on the grip isn't a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const name = (id: unknown) => labels[id as Id] ?? String(id);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((i) => i.id === active.id);
    const to = items.findIndex((i) => i.id === over.id);
    onChange(arrayMove(items, from, to));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Picked up ${name(active.id)}.`,
          onDragOver: ({ active, over }) => (over ? `${name(active.id)} is now at ${name(over.id)}.` : undefined),
          onDragEnd: ({ active, over }) => (over ? `Dropped ${name(active.id)} at ${name(over.id)}.` : `Dropped ${name(active.id)}.`),
          onDragCancel: ({ active }) => `Cancelled. ${name(active.id)} is back where it was.`,
        },
      }}
    >
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        <ul className="order-list">
          {items.map((it) => (
            <Row
              key={it.id}
              item={it}
              label={labels[it.id]}
              onToggle={(on) => onChange(items.map((x) => (x.id === it.id ? { ...x, on } : x)))}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
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
      {prefs.basemap === 'Outdoors' && (
        <ul className="order-list">
          <li className={prefs.trailConditions ? '' : 'is-off'}>
            <Switch
              size="sm"
              className="order-switch"
              checked={prefs.trailConditions}
              onChange={(e) => setPrefs({ ...prefs, trailConditions: e.currentTarget.checked })}
              label="Trail conditions"
              description="Highlight trail stretches likely to be muddy, frozen or snowy (estimate)."
              labelPosition="left"
            />
          </li>
          <li className={prefs.mtbRatings ? '' : 'is-off'}>
            <Switch
              size="sm"
              className="order-switch"
              checked={prefs.mtbRatings}
              onChange={(e) => setPrefs({ ...prefs, mtbRatings: e.currentTarget.checked })}
              label="Colour bike trails by difficulty"
              description="Off: only downhill-only trails are highlighted."
              labelPosition="left"
            />
          </li>
        </ul>
      )}
      <h3 className="set-head">Hourly charts</h3>
      <OrderList items={prefs.charts} labels={CHARTS} onChange={(charts) => setPrefs({ ...prefs, charts })} />
      <ReporterKey />
      <div className="set-foot">
        <Button variant="subtle" color="gray" size="xs" onClick={() => setPrefs(defaultPrefs())}>
          Reset to default
        </Button>
        <span className="set-note">Saved in this browser.</span>
      </div>
    </Modal>
  );
}

/** Paste the reporter key here: an app installed to the home screen doesn't share Safari's storage,
 * so the setup link opened in the browser doesn't reach it. */
function ReporterKey() {
  const [value, setValue] = useState(() => reporterKey() ?? '');
  const [saved, setSaved] = useState(false);
  return (
    <div className="set-reporter">
      <h3 className="set-head">Trail reports</h3>
      <PasswordInput
        size="xs"
        label="Trusted reporter key"
        description="Optional. Marks your reports as trusted (they count for more). Reload after saving."
        value={value}
        onChange={(e) => {
          setValue(e.currentTarget.value);
          setSaved(false);
        }}
      />
      <Button
        size="xs"
        variant="light"
        mt={6}
        onClick={() => {
          setReporterKey(value);
          setSaved(true);
        }}
      >
        {saved ? 'Saved' : 'Save key'}
      </Button>
    </div>
  );
}
