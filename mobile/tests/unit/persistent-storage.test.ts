/**
 * V06-L3：启动时申请持久存储（OPFS 默认 best-effort）。已持久时不再申请；被拒、不支持、调用失败都记录原因且不抛错。
 */
import { describe, expect, it, vi } from 'vitest';
import { requestPersistentStorage } from '../../src/shell/persistent-storage.ts';

describe('requestPersistentStorage', () => {
  it('asks for persistence when not yet persisted and reports a refusal', async () => {
    const logs: string[] = [];
    const persist = vi.fn(async () => false);
    await expect(requestPersistentStorage({ persisted: async () => false, persist }, m => logs.push(m))).resolves.toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(['[storage] persistent storage was not granted; OPFS data may be evicted under storage pressure']);
  });

  it('does not ask again when the origin is already persisted', async () => {
    const persist = vi.fn(async () => true);
    await expect(requestPersistentStorage({ persisted: async () => true, persist }, () => undefined)).resolves.toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('grants silently', async () => {
    const logs: string[] = [];
    await expect(requestPersistentStorage({ persisted: async () => false, persist: async () => true }, m => logs.push(m))).resolves.toBe(true);
    expect(logs).toEqual([]);
  });

  it('missing API or a failing call is logged, never thrown', async () => {
    const logs: string[] = [];
    await expect(requestPersistentStorage(undefined, m => logs.push(m))).resolves.toBeNull();
    await expect(requestPersistentStorage({ persist: async () => { throw new Error('SecurityError'); } }, m => logs.push(m))).resolves.toBeNull();
    expect(logs).toEqual([
      '[storage] navigator.storage.persist() is unavailable; OPFS data may be evicted under storage pressure',
      '[storage] persistent storage request failed: SecurityError',
    ]);
  });
});
