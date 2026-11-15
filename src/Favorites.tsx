import { useEffect, useState } from 'react';
import { ActionIcon, Button, Modal, TextInput } from '@mantine/core';
import type { Favorite } from './store';

const EMOJIS = ['📍', '⭐', '🏠', '🏢', '🏔️', '⛰️', '🥾', '🏕️', '🌲', '🏞️', '⛷️', '🏂', '🚵', '🚴', '🧗', '🎣', '🛶', '🌊', '🏜️', '🏖️', '❄️', '☀️', '🌋', '🗻'];

/** First grapheme of whatever was typed or pasted, so one emoji (including flags and ZWJ sequences) is kept. */
function firstGrapheme(s: string) {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const { segment } of seg.segment(s.trim())) return segment;
  return '';
}

export function FavoriteEditor({
  fav,
  onSave,
  onDelete,
  onClose,
}: {
  fav: Favorite | null;
  onSave: (f: Favorite) => void;
  onDelete: (f: Favorite) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState('');
  const [emoji, setEmoji] = useState('📍');
  useEffect(() => {
    if (fav) {
      setLabel(fav.label);
      setEmoji(fav.emoji);
    }
  }, [fav]);

  const save = () => {
    if (!fav) return;
    onSave({ ...fav, label: label.trim() || fav.label, emoji: emoji || '📍' });
    onClose();
  };

  return (
    <Modal opened={fav != null} onClose={onClose} title="Favorite" radius="md" size="sm" zIndex={2000}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="fav-form"
      >
        <TextInput label="Name" value={label} onChange={(e) => setLabel(e.currentTarget.value)} data-autofocus />
        <div>
          <TextInput
            label="Icon"
            description="Pick one below, or type or paste any emoji"
            value={emoji}
            classNames={{ input: 'fav-emoji-input' }}
            onChange={(e) => {
              // Whatever was just typed or pasted replaces the current icon.
              const v = e.currentTarget.value;
              const g = firstGrapheme(v.startsWith(emoji) ? v.slice(emoji.length) : v.replace(emoji, ''));
              if (g) setEmoji(g);
            }}
          />
          <div className="emoji-grid">
            {EMOJIS.map((em) => (
              <button type="button" key={em} className={em === emoji ? 'is-on' : ''} onClick={() => setEmoji(em)} aria-label={`Use ${em}`}>
                {em}
              </button>
            ))}
          </div>
        </div>
        <div className="fav-actions">
          <Button
            variant="subtle"
            color="red"
            onClick={() => {
              if (fav) onDelete(fav);
              onClose();
            }}
          >
            Remove favorite
          </Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Star toggle shown next to the location title. */
export function FavoriteStar({ fav, onAdd, onEdit }: { fav: Favorite | undefined; onAdd: () => void; onEdit: () => void }) {
  return (
    <ActionIcon
      variant="subtle"
      color={fav ? 'yellow' : 'gray'}
      size="lg"
      onClick={fav ? onEdit : onAdd}
      aria-label={fav ? 'Edit favorite' : 'Save as favorite'}
      title={fav ? 'Edit favorite' : 'Save as favorite'}
    >
      <svg className="ico" viewBox="0 0 24 24" aria-hidden="true" style={fav ? { fill: 'currentColor' } : undefined}>
        <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
      </svg>
    </ActionIcon>
  );
}

/** Horizontal row of favorite chips. */
export function FavoritesBar({
  favorites,
  current,
  onPick,
  onEdit,
  onMove,
}: {
  favorites: Favorite[];
  current: Favorite | undefined;
  onPick: (f: Favorite) => void;
  onEdit: (f: Favorite) => void;
  onMove: (from: number, to: number) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  if (!favorites.length) {
    return <p className="fav-empty">Tap ☆ next to a place's name to save it here.</p>;
  }
  return (
    <div className="fav-bar" role="list">
      {favorites.map((f, i) => (
        <button
          key={f.id}
          role="listitem"
          className={`fav-chip${current?.id === f.id ? ' is-current' : ''}`}
          onClick={() => onPick(f)}
          onContextMenu={(e) => {
            e.preventDefault();
            onEdit(f);
          }}
          draggable
          onDragStart={() => setDragging(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragging != null && dragging !== i) onMove(dragging, i);
            setDragging(null);
          }}
          title="Drag to reorder. To rename or change the icon, open it and tap the star."
        >
          <span aria-hidden="true">{f.emoji}</span> {f.label}
        </button>
      ))}
    </div>
  );
}
