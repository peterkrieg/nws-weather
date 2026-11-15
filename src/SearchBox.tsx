import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Combobox, Loader, TextInput, useCombobox } from '@mantine/core';
import { searchPlaces, type Loc, type Place } from './api';
import type { Favorite } from './store';

interface Props {
  onPickPlace: (p: Place) => void;
  onPickPoint: (lat: number, lon: number, source: Loc['source']) => void;
  recents: Place[];
  bias: { lat: number; lon: number } | null;
  /** Changes when a location is chosen some other way (map click), which clears the box. */
  clearKey: string;
  favorites: Favorite[];
  onPickFavorite: (f: Favorite) => void;
}

const LATLON = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export default function SearchBox({ onPickPlace, onPickPoint, recents, bias, clearKey, favorites, onPickFavorite }: Props) {
  const combobox = useCombobox({ onDropdownClose: () => combobox.resetSelectedOption() });
  const [value, setValue] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const biasRef = useRef(bias);
  biasRef.current = bias;

  useEffect(() => {
    if (clearKey) setValue('');
  }, [clearKey]);

  const query = value.trim();
  const coords = LATLON.exec(query);

  useEffect(() => {
    abort.current?.abort();
    setNote(null);
    if (query.length < 3 || coords) {
      setResults([]);
      setBusy(false);
      return;
    }
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    const timer = setTimeout(() => {
      searchPlaces(query, biasRef.current, ctl.signal)
        .then((r) => {
          setResults(r);
          setNote(r.length ? null : 'No places found');
          setBusy(false);
        })
        .catch((e) => {
          if (e.name === 'AbortError') return;
          setResults([]);
          setNote('Place search is unavailable right now');
          setBusy(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const showingRecents = query.length < 3 && !coords;
  const list = showingRecents ? recents : results;

  const submit = (key: string) => {
    combobox.closeDropdown();
    if (key.startsWith('fav:')) {
      const f = favorites.find((x) => x.id === key.slice(4));
      if (f) {
        setValue('');
        onPickFavorite(f);
      }
      return;
    }
    if (key === 'coords' && coords) {
      onPickPoint(Number(coords[1]), Number(coords[2]), 'search');
      return;
    }
    const p = list[Number(key)];
    if (!p) return;
    setValue(p.label);
    onPickPlace(p);
  };

  const locate = () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        setValue('');
        onPickPoint(pos.coords.latitude, pos.coords.longitude, 'geo');
      },
      () => setNote('Could not get your location'),
      { timeout: 10000 },
    );
  };

  const q = query.toLowerCase();
  // Favorites lead the list: all of them on an empty box, matching names as you type.
  const favMatches = coords ? [] : favorites.filter((f) => !q || f.label.toLowerCase().includes(q)).slice(0, 8);
  const hasDropdown = Boolean(coords) || list.length > 0 || favMatches.length > 0 || Boolean(note);

  return (
    <div className="search">
      <Combobox store={combobox} onOptionSubmit={submit} shadow="lg" radius="md">
        <Combobox.Target>
          <TextInput
            size="md"
            radius="md"
            type="search"
            aria-label="Search for a place"
            placeholder="Search an address, place, or lat, lon"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.currentTarget.value);
              combobox.openDropdown();
              combobox.updateSelectedOptionIndex();
            }}
            onFocus={() => combobox.openDropdown()}
            onClick={() => combobox.openDropdown()}
            onBlur={() => combobox.closeDropdown()}
            onKeyDown={(e) => {
              // Enter with nothing highlighted picks the top suggestion.
              if (e.key === 'Enter' && combobox.getSelectedOptionIndex() < 0) {
                if (coords) submit('coords');
                else if (!showingRecents && results.length) submit('0');
              }
            }}
            leftSection={
              busy ? (
                <Loader size={16} />
              ) : (
                <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.5-3.5" />
                </svg>
              )
            }
            rightSection={
              <ActionIcon variant="subtle" color="gray" onClick={locate} aria-label="Use my location" title="Use my location">
                <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="3.5" />
                  <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
                </svg>
              </ActionIcon>
            }
          />
        </Combobox.Target>
        <Combobox.Dropdown hidden={!hasDropdown}>
          <Combobox.Options>
            {coords && (
              <Combobox.Option value="coords">
                <div className="s-main">
                  Forecast for {coords[1]}, {coords[2]}
                </div>
              </Combobox.Option>
            )}
            {favMatches.length > 0 && <div className="s-head">Favorites</div>}
            {favMatches.map((f) => (
              <Combobox.Option value={`fav:${f.id}`} key={f.id}>
                <div className="s-main">
                  <span aria-hidden="true">{f.emoji}</span> {f.label}
                </div>
              </Combobox.Option>
            ))}
            {showingRecents && list.length > 0 && <div className="s-head">Recent</div>}
            {list.map((p, i) => (
              <Combobox.Option value={String(i)} key={`${p.label}|${p.sub}|${p.lat}`}>
                <div className="s-main">{p.label}</div>
                {p.sub && <div className="s-sub">{p.sub}</div>}
              </Combobox.Option>
            ))}
            {note && !coords && list.length === 0 && favMatches.length === 0 && <Combobox.Empty>{note}</Combobox.Empty>}
          </Combobox.Options>
        </Combobox.Dropdown>
      </Combobox>
    </div>
  );
}
