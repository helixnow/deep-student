/**
 * 流式 registry 的可选 lastGoodIntent 持久化。
 *
 * 默认关闭：不绑定真实 sessionStorage，避免刷新/测试互相污染。
 * 调用方传入 persistKey + 注入 storage（测试用内存实现，生产可选用 sessionStorage 适配器）。
 */

import { generativeUIIntentSchema } from '../schema';
import type { GenerativeUIIntent } from '../types';
import { fingerprintGenerativeUIIntent } from '../utils/fingerprintGenerativeUIIntent';

export const GENERATIVE_UI_STREAM_PERSIST_PREFIX = 'dstu.generative-ui.stream.lastGood.';
export const GENERATIVE_UI_STREAM_PERSIST_RECORD_VERSION = 1 as const;

/** Web Storage 子集，便于测试注入 Map / 假 Storage */
export interface GenerativeUIStreamPersistStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface GenerativeUIStreamPersistRecord {
  v: typeof GENERATIVE_UI_STREAM_PERSIST_RECORD_VERSION;
  persistKey: string;
  intent: GenerativeUIIntent;
  fingerprint?: string;
}

export function createMemoryStreamPersistStorage(
  initial?: Record<string, string>,
): GenerativeUIStreamPersistStorage {
  const store = new Map<string, string>(initial ? Object.entries(initial) : undefined);
  return {
    getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

/**
 * 可选 sessionStorage 适配器。registry 默认不会调用本函数。
 * 传入假 Storage 即可在测试中覆盖，而不碰真实 sessionStorage。
 */
export function createSessionStorageStreamPersistAdapter(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
): GenerativeUIStreamPersistStorage | null {
  const target = storage ?? (typeof sessionStorage === 'undefined' ? null : sessionStorage);
  if (!target) return null;
  return {
    getItem(key) {
      try {
        return target.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        target.setItem(key, value);
      } catch {
        // 配额 / 隐私模式：持久化仅增强能力
      }
    },
    removeItem(key) {
      try {
        target.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}

export function resolveStreamPersistStorageKey(persistKey: string | null | undefined): string | null {
  if (typeof persistKey !== 'string') return null;
  const trimmed = persistKey.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(GENERATIVE_UI_STREAM_PERSIST_PREFIX)) return trimmed;
  return `${GENERATIVE_UI_STREAM_PERSIST_PREFIX}${trimmed}`;
}

function parsePersistedIntent(raw: string): GenerativeUIIntent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  const wrapped = rec.intent;
  const candidate =
    wrapped && typeof wrapped === 'object'
      ? wrapped
      : Array.isArray(rec.blocks)
        ? rec
        : null;
  if (!candidate) return null;
  const result = generativeUIIntentSchema.safeParse(candidate);
  return result.success ? (result.data as GenerativeUIIntent) : null;
}

export function readPersistedLastGoodIntent(
  persistKey: string | null | undefined,
  storage?: GenerativeUIStreamPersistStorage | null,
): GenerativeUIIntent | null {
  if (!storage) return null;
  const key = resolveStreamPersistStorageKey(persistKey);
  if (!key) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  const intent = parsePersistedIntent(raw);
  if (!intent) {
    try {
      storage.removeItem(key);
    } catch {
      // ignore
    }
    return null;
  }
  return intent;
}

export function readPersistedLastGoodFingerprint(
  persistKey: string | null | undefined,
  storage?: GenerativeUIStreamPersistStorage | null,
): string | null {
  if (!storage) return null;
  const key = resolveStreamPersistStorageKey(persistKey);
  if (!key) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed && typeof parsed === 'object') {
    const stored = (parsed as Record<string, unknown>).fingerprint;
    if (typeof stored === 'string' && stored) return stored;
  }

  const intent = parsePersistedIntent(raw);
  return intent ? fingerprintGenerativeUIIntent(intent) : null;
}

export function writePersistedLastGoodIntent(
  persistKey: string | null | undefined,
  intent: GenerativeUIIntent | null,
  storage?: GenerativeUIStreamPersistStorage | null,
): void {
  if (!storage) return;
  if (!intent) {
    clearPersistedLastGoodIntent(persistKey, storage);
    return;
  }
  const key = resolveStreamPersistStorageKey(persistKey);
  if (!key) return;
  const validated = generativeUIIntentSchema.safeParse(intent);
  if (!validated.success) return;
  const record: GenerativeUIStreamPersistRecord = {
    v: GENERATIVE_UI_STREAM_PERSIST_RECORD_VERSION,
    persistKey: String(persistKey).trim(),
    intent: validated.data as GenerativeUIIntent,
    fingerprint: fingerprintGenerativeUIIntent(validated.data),
  };
  try {
    storage.setItem(key, JSON.stringify(record));
  } catch {
    // ignore
  }
}

export function clearPersistedLastGoodIntent(
  persistKey: string | null | undefined,
  storage?: GenerativeUIStreamPersistStorage | null,
): void {
  if (!storage) return;
  const key = resolveStreamPersistStorageKey(persistKey);
  if (!key) return;
  try {
    storage.removeItem(key);
  } catch {
    // ignore
  }
}
