/**
 * `UNSUPPORTED_ON_PLATFORM` 的统一来源（`platform/errors/unsupported-on-platform.ts`）与三处使用方保持一致：
 * 存储层 `StorageError`、`ctx.http` 的 `public-pinned`、插件装载降级原因。
 */
import { describe, expect, it } from 'vitest';
import { PLUGIN_LOAD_CODES, parseDegradedReason } from '../../../kernel/plugin-load-error.ts';
import { PUBLIC_PINNED_CAPABILITY } from '../../http/pinned-policy.ts';
import { HttpError } from '../../http/api.ts';
import { createHttpService } from '../../http/index.ts';
import { UNSUPPORTED_ON_PLATFORM_PREFIX as STORAGE_PREFIX, unsupportedOnPlatform } from '../../storage/errors.ts';
import {
  UNSUPPORTED_ON_PLATFORM,
  UNSUPPORTED_ON_PLATFORM_PREFIX,
  parseUnsupportedOnPlatform,
  unsupportedOnPlatformMessage,
} from '../api.ts';

describe('UNSUPPORTED_ON_PLATFORM', () => {
  it('builds and parses the capability message', () => {
    expect(UNSUPPORTED_ON_PLATFORM_PREFIX).toBe('UNSUPPORTED_ON_PLATFORM: ');
    const plain = unsupportedOnPlatformMessage('storage.vectorIndex', 'ios');
    expect(plain).toBe('UNSUPPORTED_ON_PLATFORM: storage.vectorIndex is not available on ios');
    expect(parseUnsupportedOnPlatform(plain)).toEqual({ capability: 'storage.vectorIndex', platform: 'ios' });
    const detailed = unsupportedOnPlatformMessage('http.destination.publicPinned', 'this platform', 'needs a native transport: see PINNED.md');
    expect(parseUnsupportedOnPlatform(detailed)).toEqual({
      capability: 'http.destination.publicPinned', platform: 'this platform', detail: 'needs a native transport: see PINNED.md',
    });
    expect(parseUnsupportedOnPlatform('UNSUPPORTED_ON_PLATFORM: plugin "example.x" supports desktop, not mobile')).toBeNull();
    expect(parseUnsupportedOnPlatform('some other error')).toBeNull();
  });

  it('the storage layer uses the same prefix and message format', () => {
    expect(STORAGE_PREFIX).toBe(UNSUPPORTED_ON_PLATFORM_PREFIX);
    const error = unsupportedOnPlatform('storage.lance', 'android', 'no native LanceDB');
    expect(error.code).toBe(UNSUPPORTED_ON_PLATFORM);
    expect(error.message).toBe(unsupportedOnPlatformMessage('storage.lance', 'android', 'no native LanceDB'));
    expect(parseUnsupportedOnPlatform(error.message)).toEqual({ capability: 'storage.lance', platform: 'android', detail: 'no native LanceDB' });
  });

  it('ctx.http public-pinned without a pinned transport rejects with the shared format', async () => {
    const http = createHttpService({ transport: async () => new Response('unused'), platform: 'ios' });
    const error = await http.fetch('https://example.com/', { destination: 'public-pinned' }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).kind).toBe('UnsupportedOnPlatform');
    expect(parseUnsupportedOnPlatform((error as HttpError).message)).toMatchObject({ capability: PUBLIC_PINNED_CAPABILITY, platform: 'ios' });
  });

  it('plugin loading uses the same code', () => {
    expect(PLUGIN_LOAD_CODES).toContain(UNSUPPORTED_ON_PLATFORM);
    expect(parseDegradedReason('UNSUPPORTED_ON_PLATFORM: plugin "example.x" supports desktop, not mobile'))
      .toEqual({ code: UNSUPPORTED_ON_PLATFORM, detail: 'plugin "example.x" supports desktop, not mobile' });
  });
});
