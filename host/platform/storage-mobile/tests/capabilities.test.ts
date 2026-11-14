/** 移动端能力清单与“平台不支持”错误：结构化字段、消息前缀、清单 id 一致。 */
import { describe, expect, it } from 'vitest';
import { StorageError as ApiStorageError } from '../../storage/api.ts';
import { StorageError, UNSUPPORTED_ON_PLATFORM_PREFIX, unsupportedOnPlatform } from '../../storage/errors.ts';
import { MOBILE_STORAGE_CAPABILITIES, STORAGE_BROWSER_DATABASE } from '../capabilities.ts';
import { MobileStorageService } from '../service.ts';
import type { SqliteRuntime } from '../sqlite-wasm.ts';

/** `database('browser')` 在触达 SQLite 之前就拒绝；其余成员不会被调用。 */
const runtime = new Proxy({} as SqliteRuntime, {
  get(_target, key) {
    throw new Error(`runtime.${String(key)} must not be touched`);
  },
});

describe('mobile storage capabilities', () => {
  it('api.ts re-exports the portable error classes (same identity)', () => {
    expect(ApiStorageError).toBe(StorageError);
  });

  it('unsupportedOnPlatform carries a structured code and a recognizable message prefix', () => {
    const error = unsupportedOnPlatform('storage.x', 'mobile', 'why');
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ name: 'StorageError', code: 'UNSUPPORTED_ON_PLATFORM', capability: 'storage.x', platform: 'mobile' });
    expect(error.message).toBe(`${UNSUPPORTED_ON_PLATFORM_PREFIX}storage.x is not available on mobile: why`);
  });

  it('database("browser") throws UNSUPPORTED_ON_PLATFORM with the capability id registered as unsupported', () => {
    const storage = new MobileStorageService({ runtime, baseDir: '/deep-student' });
    let thrown: unknown;
    try {
      storage.database('browser');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'UNSUPPORTED_ON_PLATFORM', capability: STORAGE_BROWSER_DATABASE, platform: 'mobile' });
    expect((thrown as Error).message.startsWith(`${UNSUPPORTED_ON_PLATFORM_PREFIX}${STORAGE_BROWSER_DATABASE} `)).toBe(true);
    expect(MOBILE_STORAGE_CAPABILITIES.find(entry => entry.id === STORAGE_BROWSER_DATABASE)?.status).toBe('unsupported');
  });

  it('capability ids are unique and batch operations are registered as supported', () => {
    const ids = MOBILE_STORAGE_CAPABILITIES.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['storage.batchArchiveOldMistakes', 'storage.batchCleanupOrphanedMessages']) {
      expect(MOBILE_STORAGE_CAPABILITIES.find(entry => entry.id === id)?.status, id).toBe('supported');
    }
  });
});
