import { create } from 'zustand';
import { TauriAPI } from '../utils/tauriApi';
import type { AnkiCard, AnkiGenerationOptions } from '../types';
import { showGlobalNotification } from '../components/UnifiedNotification';
import { debugLog } from '../debug-panel/debugMasterSwitch';
import i18n from '@/i18n';

export type AnkiMaterialSourceType = 'mistake' | 'chat';

export interface ChatQueueSnapshotMetadata {
  trimmed?: boolean;
  originMessageStableId?: string | null;
  focusCardId?: string | null;
}

export interface ChatQueueSnapshot {
  type: 'chat';
  templateId: string;
  cards: AnkiCard[];
  options: AnkiGenerationOptions;
  metadata?: ChatQueueSnapshotMetadata;
}

export type AnkiMaterialSnapshot = Record<string, unknown> | ChatQueueSnapshot | null;

export interface QueuedAnkiMaterial {
  queueId: string;
  sourceId: string;
  sourceType: AnkiMaterialSourceType;
  title: string;
  tags?: string[];
  createdAt: string;
  sourceCreatedAt?: string | null;
  summary?: string | null;
  content: string;
  contentLength: number;
  snapshot?: AnkiMaterialSnapshot;
}

interface AnkiQueueState {
  materials: QueuedAnkiMaterial[];
  addMaterial: (material: QueuedAnkiMaterial, options?: { replaceExisting?: boolean }) => void;
  removeMaterial: (queueId: string) => void;
  clearMaterials: () => void;
}

const isSameSource = (a: QueuedAnkiMaterial, b: QueuedAnkiMaterial) =>
  a.sourceType === b.sourceType && a.sourceId === b.sourceId;

const STORAGE_KEY = 'anki.material.queue';

const hasLocalStorage = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const persistMaterials = async (materials: QueuedAnkiMaterial[]) => {
  const serialized = JSON.stringify(materials);
  try {
    await TauriAPI.saveSetting(STORAGE_KEY, serialized);
  } catch (error: unknown) {
    console.error('[AnkiQueue] Failed to persist material queue:', error);
    if (hasLocalStorage()) {
      try {
        window.localStorage.setItem(STORAGE_KEY, serialized);
      } catch (storageError: unknown) {
        console.error('[AnkiQueue] Failed to backup material queue to localStorage:', storageError);
      }
    }
  }
};

const parseTimestamp = (value?: string | null): number => {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const mergeMaterials = (
  current: QueuedAnkiMaterial[],
  incoming: unknown,
): QueuedAnkiMaterial[] => {
  if (!Array.isArray(incoming) || incoming.length === 0) {
    return current;
  }

  const dedupeMap = new Map<string, QueuedAnkiMaterial>();
  const upsert = (item: QueuedAnkiMaterial | null | undefined) => {
    if (!item) return;
    if (typeof item.sourceId !== 'string' || typeof item.sourceType !== 'string') return;
    const key = `${item.sourceType}:${item.sourceId}`;
    const existing = dedupeMap.get(key);
    if (!existing) {
      dedupeMap.set(key, item);
      return;
    }
    const currentTs = parseTimestamp(existing.createdAt);
    const nextTs = parseTimestamp(item.createdAt);
    if (nextTs > currentTs) {
      dedupeMap.set(key, item);
    }
  };

  current.forEach((item) => upsert(item));
  (incoming as QueuedAnkiMaterial[]).forEach((item) => upsert(item));

  const merged = Array.from(dedupeMap.values());
  merged.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return merged;
};

export const useAnkiQueueStore = create<AnkiQueueState>((set, get) => {
  const loadMaterials = async () => {
    try {
      const stored = await TauriAPI.getSetting(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as unknown;
        set((state) => {
          const merged = mergeMaterials(state.materials, parsed);
          const hasChanges =
            merged.length !== state.materials.length ||
            merged.some((item, index) => item !== state.materials[index]);
          return hasChanges ? { materials: merged } : state;
        });
        return;
      }
    } catch (error: unknown) {
      console.error('[AnkiQueue] Failed to load material queue:', error);
    }

    if (hasLocalStorage()) {
      try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as unknown;
          set((state) => {
            const merged = mergeMaterials(state.materials, parsed);
            const hasChanges =
              merged.length !== state.materials.length ||
              merged.some((item, index) => item !== state.materials[index]);
            return hasChanges ? { materials: merged } : state;
          });
        }
      } catch (storageError: unknown) {
        console.error('[AnkiQueue] Failed to load material queue from localStorage:', storageError);
      }
    }
  };

  if (typeof window !== 'undefined') {
    void loadMaterials();
  }

  return {
    materials: [],
    addMaterial: (material, options) => {
      set((state) => {
        const existing = state.materials.find((item) => isSameSource(item, material));
        const others = state.materials.filter((item) => !isSameSource(item, material));
        let nextList: QueuedAnkiMaterial[];
        if (existing) {
          nextList = options?.replaceExisting ? [material, ...others] : [existing, ...others];
        } else {
          nextList = [material, ...others];
        }
        const sorted = nextList.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        persistMaterials(sorted).catch((err) => {
          debugLog.error('[AnkiQueue] Failed to persist materials:', err);
          showGlobalNotification('warning', i18n.t('common:persistFailed', 'Failed to save changes'));
        });
        return { materials: sorted };
      });
    },
    removeMaterial: (queueId) => {
      set((state) => {
        const updated = state.materials.filter((item) => item.queueId !== queueId);
        persistMaterials(updated).catch((err) => {
          debugLog.error('[AnkiQueue] Failed to persist materials:', err);
          showGlobalNotification('warning', i18n.t('common:persistFailed', 'Failed to save changes'));
        });
        return { materials: updated };
      });
    },
    clearMaterials: () => {
      set(() => {
        persistMaterials([]).catch((err) => {
          debugLog.error('[AnkiQueue] Failed to persist materials:', err);
          showGlobalNotification('warning', i18n.t('common:persistFailed', 'Failed to save changes'));
        });
        if (hasLocalStorage()) {
          try { window.localStorage.removeItem(STORAGE_KEY); } catch (error: unknown) { console.error('[AnkiQueue] Failed to clear localStorage backup:', error); }
        }
        return { materials: [] };
      });
    },
  };
});

export const createQueueId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `anki-queue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};
