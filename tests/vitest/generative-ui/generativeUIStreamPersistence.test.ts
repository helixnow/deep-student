import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GENERATIVE_UI_STREAM_PERSIST_PREFIX,
  GENERATIVE_UI_STREAM_PERSIST_RECORD_VERSION,
  clearPersistedLastGoodIntent,
  createMemoryStreamPersistStorage,
  createSessionStorageStreamPersistAdapter,
  readPersistedLastGoodFingerprint,
  readPersistedLastGoodIntent,
  resolveStreamPersistStorageKey,
  writePersistedLastGoodIntent,
} from '@/features/generative-ui/bridge/generativeUIStreamPersistence';
import { fingerprintGenerativeUIIntent } from '@/features/generative-ui/utils/fingerprintGenerativeUIIntent';
import {
  appendGenerativeUIStreamContent,
  clearGenerativeUIStreamRegistry,
  finalizeGenerativeUIStream,
  getGenerativeUIStreamSnapshot,
  getLastGoodGenerativeUIIntent,
  resetGenerativeUIStream,
} from '@/features/generative-ui/bridge/generativeUIStreamRegistry';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

const INTENT: GenerativeUIIntent = {
  version: '1',
  blocks: [{ type: 'text', props: { body: 'held' } }],
};

function persistKeyFor(blockId: string): string {
  return `sess-test:${blockId}`;
}

describe('generativeUIStreamPersistence', () => {
  it('prefixes persistKey and is a no-op without storage', () => {
    expect(resolveStreamPersistStorageKey('abc')).toBe(`${GENERATIVE_UI_STREAM_PERSIST_PREFIX}abc`);
    expect(resolveStreamPersistStorageKey(`  ${GENERATIVE_UI_STREAM_PERSIST_PREFIX}ready  `)).toBe(
      `${GENERATIVE_UI_STREAM_PERSIST_PREFIX}ready`,
    );
    expect(resolveStreamPersistStorageKey('')).toBeNull();
    expect(resolveStreamPersistStorageKey('   ')).toBeNull();
    expect(readPersistedLastGoodIntent('abc')).toBeNull();
    expect(readPersistedLastGoodIntent('abc', null)).toBeNull();
    writePersistedLastGoodIntent('abc', INTENT);
    expect(readPersistedLastGoodIntent('abc')).toBeNull();
  });

  it('round-trips lastGoodIntent through injected memory storage', () => {
    const storage = createMemoryStreamPersistStorage();
    writePersistedLastGoodIntent('blk-a', INTENT, storage);
    const restored = readPersistedLastGoodIntent('blk-a', storage);
    expect(restored?.blocks[0]?.props?.body).toBe('held');
    expect(storage.getItem(resolveStreamPersistStorageKey('blk-a')!)).toContain('"v":1');
    expect(storage.getItem(resolveStreamPersistStorageKey('blk-a')!)).toContain(
      `"v":${GENERATIVE_UI_STREAM_PERSIST_RECORD_VERSION}`,
    );
  });

  it('accepts a raw intent JSON payload without the wrapper record', () => {
    const key = resolveStreamPersistStorageKey('raw-intent')!;
    const storage = createMemoryStreamPersistStorage({
      [key]: JSON.stringify(INTENT),
    });
    expect(readPersistedLastGoodIntent('raw-intent', storage)?.blocks).toHaveLength(1);
  });

  it('drops corrupt or illegal payloads and removes the key', () => {
    const storage = createMemoryStreamPersistStorage();
    const key = resolveStreamPersistStorageKey('bad')!;
    storage.setItem(key, '{not-json');
    expect(readPersistedLastGoodIntent('bad', storage)).toBeNull();
    expect(storage.getItem(key)).toBeNull();

    writePersistedLastGoodIntent('bad', { version: '1', blocks: [] }, storage);
    storage.setItem(key, JSON.stringify({ v: 1, intent: { version: '9', blocks: [] } }));
    expect(readPersistedLastGoodIntent('bad', storage)).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it('write(null) and clear remove the persisted record', () => {
    const storage = createMemoryStreamPersistStorage();
    writePersistedLastGoodIntent('gone', INTENT, storage);
    writePersistedLastGoodIntent('gone', null, storage);
    expect(readPersistedLastGoodIntent('gone', storage)).toBeNull();
    writePersistedLastGoodIntent('gone', INTENT, storage);
    clearPersistedLastGoodIntent('gone', storage);
    expect(readPersistedLastGoodIntent('gone', storage)).toBeNull();
  });

  it('sessionStorage adapter uses the injected Storage, not the real session', () => {
    const fake = createMemoryStreamPersistStorage();
    const adapter = createSessionStorageStreamPersistAdapter(fake);
    expect(adapter).not.toBeNull();
    const spy = vi.spyOn(sessionStorage, 'setItem');
    writePersistedLastGoodIntent('adapter', INTENT, adapter);
    expect(readPersistedLastGoodIntent('adapter', adapter)?.blocks[0]?.type).toBe('text');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('writes then reads fingerprint matching fingerprintGenerativeUIIntent', () => {
    const storage = createMemoryStreamPersistStorage();
    writePersistedLastGoodIntent('fp-new', INTENT, storage);
    expect(readPersistedLastGoodFingerprint('fp-new', storage)).toBe(
      fingerprintGenerativeUIIntent(INTENT),
    );
  });

  it('accepts old records without fingerprint and computes fallback', () => {
    const key = resolveStreamPersistStorageKey('fp-old')!;
    const storage = createMemoryStreamPersistStorage({
      [key]: JSON.stringify({
        v: GENERATIVE_UI_STREAM_PERSIST_RECORD_VERSION,
        persistKey: 'fp-old',
        intent: INTENT,
      }),
    });
    expect(readPersistedLastGoodIntent('fp-old', storage)?.blocks[0]?.props?.body).toBe('held');
    expect(readPersistedLastGoodFingerprint('fp-old', storage)).toBe(
      fingerprintGenerativeUIIntent(INTENT),
    );
  });

  it('swallows storage exceptions', () => {
    const exploding = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readPersistedLastGoodIntent('x', exploding)).toBeNull();
    expect(() => writePersistedLastGoodIntent('x', INTENT, exploding)).not.toThrow();
    expect(() => clearPersistedLastGoodIntent('x', exploding)).not.toThrow();
  });
});

describe('generativeUIStreamRegistry persistKey restore', () => {
  beforeEach(() => {
    clearGenerativeUIStreamRegistry();
  });

  it('does not write sessionStorage when persistKey is omitted', () => {
    const spy = vi.spyOn(sessionStorage, 'setItem');
    appendGenerativeUIStreamContent(
      'blk-default',
      '{"version":"1","blocks":[{"type":"text","props":{"body":"mem"}}',
    );
    expect(getLastGoodGenerativeUIIntent('blk-default')?.blocks[0]?.props?.body).toBe('mem');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not persist when persistKey is set but storage is missing', () => {
    const spy = vi.spyOn(sessionStorage, 'setItem');
    appendGenerativeUIStreamContent(
      'blk-no-storage',
      '{"version":"1","blocks":[{"type":"text","props":{"body":"x"}}',
      { persistKey: persistKeyFor('blk-no-storage') },
    );
    clearGenerativeUIStreamRegistry();
    expect(
      getLastGoodGenerativeUIIntent('blk-no-storage', {
        persistKey: persistKeyFor('blk-no-storage'),
      }),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('restores lastGoodIntent after a registry clear (refresh)', () => {
    const storage = createMemoryStreamPersistStorage();
    const blockId = 'blk-refresh';
    const persistKey = persistKeyFor(blockId);
    const open = '{"version":"1","blocks":[{"type":"text","props":{"body":"stable"}}';
    appendGenerativeUIStreamContent(blockId, open, { persistKey, storage });

    clearGenerativeUIStreamRegistry();
    expect(getLastGoodGenerativeUIIntent(blockId)).toBeNull();

    const restored = getLastGoodGenerativeUIIntent(blockId, { persistKey, storage });
    expect(restored?.blocks[0]?.props?.body).toBe('stable');

    const snap = getGenerativeUIStreamSnapshot(blockId, { persistKey, storage });
    expect(snap?.warnings).toContain('restored-last-good');
    expect(snap?.intent?.blocks[0]?.props?.body).toBe('stable');

    const afterReload = appendGenerativeUIStreamContent(blockId, `${open},{"type":`, {
      persistKey,
      storage,
    });
    expect(afterReload.intent?.blocks[0]?.props?.body).toBe('stable');
  });

  it('hydrates persisted last-good when persistence is bound to an existing entry', () => {
    const storage = createMemoryStreamPersistStorage();
    const blockId = 'blk-late-persist';
    const persistKey = persistKeyFor(blockId);
    writePersistedLastGoodIntent(persistKey, INTENT, storage);

    appendGenerativeUIStreamContent(blockId, '{ bad');
    const restored = appendGenerativeUIStreamContent(blockId, '{ bad', {
      persistKey,
      storage,
    });

    expect(restored.intent?.blocks[0]?.props?.body).toBe('held');
    expect(finalizeGenerativeUIStream(blockId, { persistKey, storage })?.blocks[0]?.props?.body).toBe(
      'held',
    );
    expect(readPersistedLastGoodIntent(persistKey, storage)?.blocks[0]?.props?.body).toBe('held');
  });

  it('hydrates persisted last-good when finalize supplies persistence late', () => {
    const storage = createMemoryStreamPersistStorage();
    const blockId = 'blk-late-finalize';
    const persistKey = persistKeyFor(blockId);
    writePersistedLastGoodIntent(persistKey, INTENT, storage);

    appendGenerativeUIStreamContent(blockId, '{ bad');
    const finalized = finalizeGenerativeUIStream(blockId, { persistKey, storage });

    expect(finalized?.blocks[0]?.props?.body).toBe('held');
    expect(readPersistedLastGoodIntent(persistKey, storage)?.blocks[0]?.props?.body).toBe('held');
  });

  it('keeps finalized lastGood on persist so refresh can recover', () => {
    const storage = createMemoryStreamPersistStorage();
    const blockId = 'blk-finalize-persist';
    const persistKey = persistKeyFor(blockId);
    const open = '{"version":"1","blocks":[{"type":"text","props":{"body":"alpha"}}';
    appendGenerativeUIStreamContent(blockId, open, { persistKey, storage });
    appendGenerativeUIStreamContent(blockId, `${open},{"type":"stat-card","props":{`, {
      persistKey,
      storage,
    });
    const final = finalizeGenerativeUIStream(blockId, { persistKey, storage });
    expect(final?.blocks[0]?.props?.body).toBe('alpha');

    clearGenerativeUIStreamRegistry();
    expect(finalizeGenerativeUIStream(blockId, { persistKey, storage })?.blocks[0]?.props?.body).toBe(
      'alpha',
    );
  });

  it('clears persist on reset and content shrink', () => {
    const storage = createMemoryStreamPersistStorage();
    const blockId = 'blk-reset';
    const persistKey = persistKeyFor(blockId);
    appendGenerativeUIStreamContent(
      blockId,
      '{"version":"1","blocks":[{"type":"text","props":{"body":"long"}}]}',
      { persistKey, storage },
    );
    expect(readPersistedLastGoodIntent(persistKey, storage)?.blocks).toHaveLength(1);

    appendGenerativeUIStreamContent(blockId, '{"version":"1"}', { persistKey, storage });
    expect(readPersistedLastGoodIntent(persistKey, storage)).toBeNull();

    appendGenerativeUIStreamContent(
      blockId,
      '{"version":"1","blocks":[{"type":"text","props":{"body":"again"}}',
      { persistKey, storage },
    );
    resetGenerativeUIStream(blockId, { persistKey, storage });
    expect(readPersistedLastGoodIntent(persistKey, storage)).toBeNull();
    expect(getLastGoodGenerativeUIIntent(blockId, { persistKey, storage })).toBeNull();
  });

  it('isolates persist keys across blocks', () => {
    const storage = createMemoryStreamPersistStorage();
    appendGenerativeUIStreamContent(
      'a',
      '{"version":"1","blocks":[{"type":"text","props":{"body":"A"}}',
      { persistKey: 'key-a', storage },
    );
    appendGenerativeUIStreamContent(
      'b',
      '{"version":"1","blocks":[{"type":"text","props":{"body":"B"}}',
      { persistKey: 'key-b', storage },
    );
    clearGenerativeUIStreamRegistry();
    expect(getLastGoodGenerativeUIIntent('a', { persistKey: 'key-a', storage })?.blocks[0]?.props?.body).toBe(
      'A',
    );
    expect(getLastGoodGenerativeUIIntent('b', { persistKey: 'key-b', storage })?.blocks[0]?.props?.body).toBe(
      'B',
    );
  });
});
