import { afterAll, beforeAll, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import {
  SYNC_TARGET_LEASE_PREFIX,
  acquireSyncTargetLeaseWithTtl,
} from '../../sync-providers/api.ts';
// boundary-allow cross-plugin-impl: L22 集成测试需安装真实 L20 同步插件，验证格式门槛先于租约写入
import syncPlugin from '../../sync/index.ts';
import { createTestHost } from './sync-fixture.ts';
import { createPayloadCodec, type SyncService } from '../../sync/api.ts';
import { MemoryCloud } from './memory-cloud.ts';

/**
 * `sync_r11_lease.rs::remote_format_gate_rejects_future_version_before_lease_write`
 * 的 TS 行为级移植：先走 L20 `validateRemoteFormat` 生产门槛，再进入 L23 真实租约状态机。
 */
let host: TestHost;
let sync: SyncService;
const codec = await createPayloadCodec(undefined, null);
const options = { deviceId: 'device-a', codec };

beforeAll(async () => {
  host = await createTestHost({
    plugins: [syncPlugin],
    provide: {
      notes: {},
      backup: {},
      syncProvider: {},
      secrets: { backup: createBackupCrypto() },
      vfsDatabase: { isInMaintenanceMode: () => false },
      syncSupport: { state: {
        bindInstance: () => undefined,
        nextUploadSeq: () => 43n,
        markPublishedSeq: () => undefined,
      } },
      nativeCompression: compression,
    },
  });
  sync = host.ctx.sync;
});

afterAll(async () => {
  codec.dispose();
  await host?.dispose();
});

function leaseKeys(storage: MemoryCloud): string[] {
  return storage.keys().filter(key => key.startsWith(SYNC_TARGET_LEASE_PREFIX));
}

it('remote_format_gate_rejects_future_version_before_lease_write', async () => {
  const storage = new MemoryCloud();
  storage.insertRaw('data_governance/format.json', JSON.stringify({
    format_version: 5,
    min_client: 5,
    features: [],
  }));

  const error = await sync.validateRemoteFormat(storage, true, options)
    .then(() => { throw new Error('未来 remote format 必须拒绝'); }, (reason: unknown) => String(reason));
  expect(error).toContain('高于当前客户端');
  expect(leaseKeys(storage)).toEqual([]);

  storage.insertRaw('data_governance/format.json', JSON.stringify({
    format_version: 4,
    min_client: 3,
    features: [],
    checkpoint: null,
    compatibility_lease: null,
  }));
  const descriptor = await sync.validateRemoteFormat(storage, false, options);
  expect(descriptor.format_version).toBe(4);

  const guard = await acquireSyncTargetLeaseWithTtl(storage, 'device-a', 60_000);
  await guard.release();
  expect(leaseKeys(storage)).toEqual([]);
});
