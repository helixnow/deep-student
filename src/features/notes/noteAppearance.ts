import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { NotesAPI } from '@/utils/notesApi';

export const NOTE_APPEARANCE_PRESETS = ['standard', 'compact', 'wide'] as const;
export type NoteAppearancePreset = typeof NOTE_APPEARANCE_PRESETS[number];
export const NOTE_APPEARANCE_ICONS = ['', '📄', '📚', '💡', '🧪', '📝'] as const;

export interface NoteAppearance {
  preset: NoteAppearancePreset;
  icon: typeof NOTE_APPEARANCE_ICONS[number];
}

const DEFAULT_APPEARANCE: NoteAppearance = { preset: 'standard', icon: '' };

/** Display preferences, shared by every host of this note; not document metadata. */
export function noteAppearanceKey(noteId: string): string {
  return `note_appearance:${noteId}`;
}

export function parseNoteAppearance(value: string | null): NoteAppearance {
  if (!value) return DEFAULT_APPEARANCE;
  try {
    const parsed = JSON.parse(value);
    return {
      preset: NOTE_APPEARANCE_PRESETS.includes(parsed?.preset) ? parsed.preset : 'standard',
      icon: NOTE_APPEARANCE_ICONS.includes(parsed?.icon) ? parsed.icon : '',
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

interface AppearanceSnapshot {
  value: NoteAppearance;
  loading: boolean;
  saving: boolean;
  error: 'load' | 'save' | null;
}

interface AppearanceEntry {
  snapshot: AppearanceSnapshot;
  listeners: Set<() => void>;
  loaded: boolean;
  pendingLoad?: Promise<void>;
}

const entries = new Map<string, AppearanceEntry>();
const EMPTY_SNAPSHOT: AppearanceSnapshot = {
  value: DEFAULT_APPEARANCE, loading: false, saving: false, error: null,
};

function entryFor(noteId: string): AppearanceEntry {
  let entry = entries.get(noteId);
  if (!entry) {
    entry = {
      snapshot: { ...EMPTY_SNAPSHOT, loading: true },
      listeners: new Set(),
      loaded: false,
    };
    entries.set(noteId, entry);
  }
  return entry;
}

function publish(entry: AppearanceEntry, patch: Partial<AppearanceSnapshot>) {
  entry.snapshot = { ...entry.snapshot, ...patch };
  entry.listeners.forEach((listener) => listener());
}

async function loadAppearance(noteId: string): Promise<void> {
  const entry = entryFor(noteId);
  if (entry.loaded) return;
  if (entry.pendingLoad) return entry.pendingLoad;
  publish(entry, { loading: true, error: null });
  entry.pendingLoad = (async () => {
    try {
      const value = await NotesAPI.getPref(noteAppearanceKey(noteId));
      entry.loaded = true;
      publish(entry, { value: parseNoteAppearance(value), loading: false });
    } catch {
      publish(entry, { loading: false, error: 'load' });
    } finally {
      entry.pendingLoad = undefined;
    }
  })();
  return entry.pendingLoad;
}

async function saveAppearance(noteId: string, patch: Partial<NoteAppearance>): Promise<void> {
  const entry = entryFor(noteId);
  // All mounted views share this gate: no stale read or out-of-order writes.
  if (!entry.loaded || entry.snapshot.saving) return;
  const value = { ...entry.snapshot.value, ...patch };
  publish(entry, { saving: true, error: null });
  try {
    const saved = await NotesAPI.setPref(noteAppearanceKey(noteId), JSON.stringify(value));
    if (!saved) throw new Error('Appearance preference was not saved');
    publish(entry, { value, saving: false });
  } catch {
    publish(entry, { saving: false, error: 'save' });
  }
}

export function useNoteAppearance(noteId: string | undefined) {
  const subscribe = useCallback((listener: () => void) => {
    if (!noteId) return () => {};
    const entry = entryFor(noteId);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [noteId]);
  const getSnapshot = useCallback(
    () => noteId ? entryFor(noteId).snapshot : EMPTY_SNAPSHOT,
    [noteId],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT);
  useEffect(() => {
    if (noteId) void loadAppearance(noteId);
  }, [noteId]);
  return {
    ...snapshot,
    update: (patch: Partial<NoteAppearance>) => noteId ? saveAppearance(noteId, patch) : Promise.resolve(),
    reload: () => noteId ? loadAppearance(noteId) : Promise.resolve(),
  };
}
