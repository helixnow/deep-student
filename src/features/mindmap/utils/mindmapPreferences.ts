import { useSyncExternalStore } from 'react';

export type MindMapKeymap = 'deep-student' | 'classic';
export type MindMapCanvasNavigation = 'document' | 'spatial';
export type MindMapDescriptionPreview = 'full' | 'first-line';

export interface MindMapPreferences {
  keymap: MindMapKeymap;
  canvasNavigation: MindMapCanvasNavigation;
  descriptionPreview: MindMapDescriptionPreview;
}

const STORAGE_KEY = 'deep-student:mindmap-preferences:v1';
const CHANGE_EVENT = 'mindmap:preferences-changed';
const DEFAULTS: MindMapPreferences = {
  keymap: 'deep-student',
  canvasNavigation: 'document',
  descriptionPreview: 'full',
};

type StoredMindMapPreferences = Omit<Partial<MindMapPreferences>, 'keymap'> & {
  keymap?: MindMapKeymap | 'mubu';
};

let cachedRaw: string | null | undefined;
let cachedPreferences: MindMapPreferences | null = null;

function invalidatePreferencesCache(): void {
  cachedRaw = undefined;
  cachedPreferences = null;
}

if (typeof globalThis.window !== 'undefined' && typeof globalThis.window.addEventListener === 'function') {
  globalThis.window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      invalidatePreferencesCache();
    }
  });
}

function parseStored(raw: string | null): StoredMindMapPreferences {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as StoredMindMapPreferences;
  } catch {
    return {};
  }
}

export function getMindMapPreferences(): MindMapPreferences {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (cachedPreferences !== null && cachedRaw === raw) {
    return cachedPreferences;
  }
  const stored = parseStored(raw);
  const migratedLegacyKeymap = stored.keymap === 'mubu';
  const keymap = stored.keymap === 'classic' || stored.keymap === 'mubu' ? 'classic' : DEFAULTS.keymap;
  const normalized: MindMapPreferences = {
    keymap,
    canvasNavigation: stored.canvasNavigation === 'spatial' ? 'spatial' : DEFAULTS.canvasNavigation,
    descriptionPreview: stored.descriptionPreview === 'first-line' ? 'first-line' : DEFAULTS.descriptionPreview,
  };
  let finalRaw = raw;
  if (migratedLegacyKeymap) {
    const migratedJson = JSON.stringify({ ...stored, keymap });
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, migratedJson);
      finalRaw = migratedJson;
    } catch {
      // The in-memory migration remains usable if storage is unavailable.
    }
  }
  cachedRaw = finalRaw;
  cachedPreferences = normalized;
  return normalized;
}

export function setMindMapPreferences(patch: Partial<MindMapPreferences>): void {
  const next = { ...getMindMapPreferences(), ...patch };
  const serialized = JSON.stringify(next);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, serialized);
    cachedRaw = serialized;
    cachedPreferences = next;
  } catch {
    // Preferences remain usable for the current event even if storage is unavailable.
    invalidatePreferencesCache();
  }
  globalThis.window?.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  globalThis.window?.addEventListener(CHANGE_EVENT, listener);
  globalThis.window?.addEventListener('storage', onStorage);
  return () => {
    globalThis.window?.removeEventListener(CHANGE_EVENT, listener);
    globalThis.window?.removeEventListener('storage', onStorage);
  };
}

const snapshots = new Map<string, MindMapPreferences>();
function getSnapshot(): MindMapPreferences {
  const next = getMindMapPreferences();
  const key = `${next.keymap}:${next.canvasNavigation}:${next.descriptionPreview}`;
  const cached = snapshots.get(key);
  if (cached) return cached;
  snapshots.set(key, next);
  return next;
}

export function useMindMapPreferences(): MindMapPreferences {
  return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULTS);
}

export function findSpatialMindMapNeighbor(
  current: DOMRect,
  candidates: Array<{ id: string; rect: DOMRect }>,
  direction: 'up' | 'down' | 'left' | 'right',
): string | null {
  const cx = current.left + current.width / 2;
  const cy = current.top + current.height / 2;
  let best: { id: string; score: number } | null = null;
  for (const candidate of candidates) {
    const x = candidate.rect.left + candidate.rect.width / 2;
    const y = candidate.rect.top + candidate.rect.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const primary = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
    if (primary <= 1) continue;
    const cross = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    const score = primary + cross * 2.5;
    if (!best || score < best.score) best = { id: candidate.id, score };
  }
  return best?.id ?? null;
}
