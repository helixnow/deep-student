import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { PruneGapResponse } from '../../../../contracts/ipc/generated/L20-sync.ts';
import { createTestHost } from './host-fixture.ts';
import sync from '../index.ts';
import { deviceManifestKey } from '../src/remote-manifest.ts';
import { createManifest } from '../src/merge.ts';

it('detect_prune_gap uses instance cursors, not local publication timestamps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-prune-gap-'));
  const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  for (const [name, version] of [['vfs', 200], ['chat_v2', 100]] as const) {
    const db = storage.openFile(storage.pathOf(name), { profile: 'plain' });
    db.exec(`CREATE TABLE refinery_schema_history(version INTEGER);
      CREATE TABLE __change_log(sync_version INTEGER, changed_at TEXT);`);
    db.run('INSERT INTO __change_log VALUES (?1, ?2)', [version, '2026-01-01T00:00:00Z']);
    storage.close(db);
  }
  const objects = new Map<string, Uint8Array>([
    ['data_governance/instance.json', Buffer.from('{"instance_id":"instance-a"}')],
    [deviceManifestKey('peer'), Buffer.from(JSON.stringify({ ...createManifest('peer', {}), published_max_seq: 2 }))],
    ['data_governance/changes/peer/000000000002-1792755307-op.json.zst', new Uint8Array()],
  ]);
  const order: string[] = [];
  const bindings: unknown[][] = [];
  let cursor = 0n;
  const host = await createTestHost({ plugins: [sync], provide: {
    storage,
    paths: { deviceId: async () => { order.push('device'); return 'reader'; } },
    backup: { hydrateCloudConfig: async () => { order.push('hydrate'); } },
    syncProvider: { createStorage: async () => {
      order.push('transport');
      return {
        providerName: () => 'memory', instanceBindingHint: () => 'root',
        get: async (key: string) => objects.get(key) ?? null,
        listOutcome: async (prefix: string) => ({
          files: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false,
        }),
        put: () => { throw new Error('preflight must not write'); },
      };
    } },
    syncSupport: { state: {
      bindInstance: (...args: unknown[]) => { bindings.push(args); },
      cursors: (id: string) => { expect(id).toBe('instance-a'); return new Map([['peer', cursor]]); },
      setCursor: () => { throw new Error('preflight must not acknowledge'); },
    } },
  } });
  try {
    const report = await host.invoke<PruneGapResponse>('data_governance_detect_prune_gap', { cloudConfig: {} });
    expect(order).toEqual(['hydrate', 'device', 'transport']);
    expect(bindings).toEqual([['instance-a', 'memory', 'root']]);
    expect(report).toEqual({
      since_version: 100, has_gap: true, min_available_version: 1792755307,
      remote_format_version: 3, uses_device_cursors: true, instance_id: 'instance-a',
      gap_details: '设备 peer 缺少序号 1（下一可用序号 2，已发布到 2）；已停止同步，请从数据完整的备份恢复。不会跳过缺失分片或清空本地消息。',
    });
    cursor = 1n;
    expect((await host.invoke<PruneGapResponse>('data_governance_detect_prune_gap', { cloudConfig: {} })).has_gap).toBe(false);
    objects.set('data_governance/format.json', Buffer.from('{"format_version":5}'));
    await expect(host.invoke('data_governance_detect_prune_gap', { cloudConfig: {} }))
      .rejects.toMatch(/^检查云端变更断层失败: Database error: 远端同步格式 v5/);
  } finally {
    await host.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
