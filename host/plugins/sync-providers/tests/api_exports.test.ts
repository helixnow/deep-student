import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import plugin from '../index.ts';
import {
  CloudSyncManager,
  syncProviderService,
  type CloudManifest,
  type CloudSyncManagerOptions,
  type SyncProviderService,
} from '../api.ts';

describe('api.ts public surface for L20/L22', () => {
  it('publishes CloudSyncManager and its option/manifest types', () => {
    expect(typeof CloudSyncManager).toBe('function');
    expectTypeOf<CloudSyncManagerOptions>().toHaveProperty('backup');
    expectTypeOf<CloudManifest>().toHaveProperty('versions');
  });

  it('declares the syncProvider service and required cross-lane injections', () => {
    expect(syncProviderService).toEqual({ name: 'syncProvider', version: '1.0.0' });
    expect(plugin.meta.provides).toEqual(['syncProvider']);
    expect(plugin.inject).toEqual(['secrets', 'backup', 'paths']);
    expectTypeOf<Context['syncProvider']>().toMatchTypeOf<SyncProviderService>();
  });
});
