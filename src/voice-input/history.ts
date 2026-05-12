import { deleteSetting, getSetting, saveSetting } from '@/utils/settingsApi';

import type { VoiceInputHistoryEntry } from './types';

export const VOICE_INPUT_HISTORY_SETTING_KEY = 'voice_input.history';
export const VOICE_INPUT_HISTORY_CHANGED_EVENT = 'voice-input-history-changed';
const MAX_VOICE_INPUT_HISTORY_ITEMS = 12;

function emitVoiceInputHistoryChanged(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(VOICE_INPUT_HISTORY_CHANGED_EVENT));
  }
}

export function normalizeVoiceInputHistory(
  input: unknown
): VoiceInputHistoryEntry[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item, index): VoiceInputHistoryEntry | null => {
      if (typeof item !== 'object' || !item) {
        return null;
      }

      const row = item as Record<string, unknown>;

      const text = typeof row.text === 'string' ? row.text.trim() : '';
      if (!text) {
        return null;
      }

      const createdAt =
        typeof row.createdAt === 'string' && row.createdAt.trim()
          ? row.createdAt
          : new Date().toISOString();

      return {
        id:
          typeof row.id === 'string' && row.id.trim()
            ? row.id
            : `voice-history-${createdAt}-${index}`,
        text,
        createdAt,
        providerId: typeof row.providerId === 'string' ? row.providerId : undefined,
        model: typeof row.model === 'string' ? row.model : undefined,
        language: typeof row.language === 'string' ? row.language : undefined,
        durationMs:
          typeof row.durationMs === 'number' && Number.isFinite(row.durationMs)
            ? row.durationMs
            : undefined,
      };
    })
    .filter((item): item is VoiceInputHistoryEntry => item !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_VOICE_INPUT_HISTORY_ITEMS);
}

export async function loadVoiceInputHistory(): Promise<VoiceInputHistoryEntry[]> {
  try {
    const raw = await getSetting(VOICE_INPUT_HISTORY_SETTING_KEY);
    if (!raw) {
      return [];
    }
    return normalizeVoiceInputHistory(JSON.parse(raw));
  } catch {
    return [];
  }
}

export async function saveVoiceInputHistory(entries: VoiceInputHistoryEntry[]): Promise<void> {
  const normalized = normalizeVoiceInputHistory(entries);
  if (normalized.length === 0) {
    await deleteSetting(VOICE_INPUT_HISTORY_SETTING_KEY);
    emitVoiceInputHistoryChanged();
    return;
  }

  await saveSetting(VOICE_INPUT_HISTORY_SETTING_KEY, JSON.stringify(normalized));
  emitVoiceInputHistoryChanged();
}

export async function appendVoiceInputHistoryEntry(
  entry: Omit<VoiceInputHistoryEntry, 'id' | 'createdAt'> & Partial<Pick<VoiceInputHistoryEntry, 'id' | 'createdAt'>>
): Promise<void> {
  const text = entry.text.trim();
  if (!text) {
    return;
  }

  const existing = await loadVoiceInputHistory();
  const createdAt = entry.createdAt ?? new Date().toISOString();
  const nextEntry: VoiceInputHistoryEntry = {
    id: entry.id ?? `voice-history-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    createdAt,
    providerId: entry.providerId,
    model: entry.model,
    language: entry.language,
    durationMs: entry.durationMs,
  };

  const deduped = existing.filter(
    (item) => !(item.text === nextEntry.text && item.createdAt === nextEntry.createdAt)
  );
  await saveVoiceInputHistory([nextEntry, ...deduped].slice(0, MAX_VOICE_INPUT_HISTORY_ITEMS));
}

export async function clearVoiceInputHistory(): Promise<void> {
  await saveVoiceInputHistory([]);
}
