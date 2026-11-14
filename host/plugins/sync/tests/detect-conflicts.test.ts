import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import type { ConflictDetectionResponse } from '../../../../contracts/ipc/generated/L20-sync.ts';
import sync from '../index.ts';
import { deviceManifestKey } from '../src/remote-manifest.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeStorage() {
  const dir = mkdtempSync(join(tmpdir(), 'sync-detect-conflicts-'));
  dirs.push(dir);
  return createStorageService({ baseDir: dir, dataLocalDir: dir });
}

function cloudManifest(deviceId: string, overrides: Record<string, unknown> = {}) {
  return {
    sync_transaction_id: `tx-${deviceId}`,
    databases: {
      vfs: { schema_version: 5, data_version: 10, checksum: 'cloud-checksum' },
    },
    status: 'Complete',
    created_at: '2026-10-25T00:00:00Z',
    device_id: deviceId,
    format_version: 3,
    published_max_seq: 0,
    cursors: {},
    snapshot_seen: {},
    ...overrides,
  };
}

class MemoryCloudStorage {
  readonly files = new Map<string, Uint8Array>();
  truncated = false;

  async listOutcome(prefix: string) {
    return {
      files: [...this.files.keys()]
        .filter(key => key.startsWith(prefix))
        .map(key => ({ key, size: this.files.get(key)!.byteLength, lastModified: '2026-01-01T00:00:00Z' })),
      truncated: this.truncated,
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.files.get(key) ?? null;
  }
}

async function makeHost(cloud?: MemoryCloudStorage) {
  const storage = makeStorage();
  const host = await createTestHost({
    plugins: [sync],
    provide: {
      storage,
      paths: { deviceId: async () => 'local-device' },
      backup: { hydrateCloudConfig: async () => undefined },
      syncProvider: { createStorage: async () => {
        if (cloud === undefined) throw new Error('cloud transport not supplied in test');
        return cloud as unknown as CloudStorage;
      } },
    },
  });
  return host;
}

describe('detect_conflicts command', () => {
  it('returns LocalOnly/CloudOnly differences from an explicit cloud manifest', async () => {
    const host = await makeHost();
    try {
      const response = await host.invoke<ConflictDetectionResponse>('data_governance_detect_conflicts', {
        cloudManifestJson: JSON.stringify(cloudManifest('cloud-device')),
      });
      expect(response.has_conflicts).toBe(true);
      expect(response.needs_migration).toBe(false);
      expect(response.database_conflicts).toEqual([{
        database_name: 'vfs',
        conflict_type: 'CloudOnly',
        local_version: null,
        cloud_version: 10,
        local_schema_version: null,
        cloud_schema_version: 5,
      }]);
      expect(response.record_conflict_count).toBe(0);
      const local = JSON.parse(response.local_manifest_json!) as { device_id: string; databases: object };
      expect(local.device_id).toBe('local-device');
      expect(local.databases).toEqual({});
      expect(JSON.parse(response.cloud_manifest_json!).device_id).toBe('cloud-device');
    } finally {
      await host.dispose();
    }
  });

  it('reports schema mismatch from an explicit cloud manifest', async () => {
    const storage = makeStorage();
    // 直接向本地 vfs 库写入版本表，模拟已有本地 schema 状态。
    const db = storage.openFile(storage.pathOf('vfs'), { profile: 'plain' });
    try {
      db.exec(`
        CREATE TABLE refinery_schema_history (version INTEGER);
        INSERT INTO refinery_schema_history(version) VALUES (4);
        CREATE TABLE __change_log (sync_version INTEGER, changed_at TEXT);
      `);
    } finally {
      storage.close(db);
    }
    const host = await createTestHost({
      plugins: [sync],
      provide: { storage, paths: { deviceId: async () => 'local-device' } },
    });
    try {
      const response = await host.invoke<ConflictDetectionResponse>('data_governance_detect_conflicts', {
        cloudManifestJson: JSON.stringify(cloudManifest('cloud-device')),
      });
      expect(response.database_conflicts).toHaveLength(1);
      expect(response.database_conflicts[0]).toMatchObject({
        conflict_type: 'SchemaMismatch',
        local_schema_version: 4,
        cloud_schema_version: 5,
      });
      expect(response.needs_migration).toBe(true);
    } finally {
      await host.dispose();
    }
  });

  it('downloads and merges manifests when only cloudConfig is provided', async () => {
    const cloud = new MemoryCloudStorage();
    cloud.files.set(
      deviceManifestKey('cloud-device'),
      new TextEncoder().encode(JSON.stringify(cloudManifest('cloud-device'))),
    );
    const host = await makeHost(cloud);
    try {
      const response = await host.invoke<ConflictDetectionResponse>('data_governance_detect_conflicts', {
        cloudConfig: {},
      });
      expect(response.has_conflicts).toBe(true);
      expect(response.database_conflicts[0]).toMatchObject({
        conflict_type: 'CloudOnly',
        cloud_version: 10,
      });
      const downloaded = JSON.parse(response.cloud_manifest_json!) as { device_id: string };
      expect(downloaded.device_id).toBe('merged');
    } finally {
      await host.dispose();
    }
  });

  it('returns local state only when no cloud manifest or config is given', async () => {
    const host = await makeHost();
    try {
      const response = await host.invoke<ConflictDetectionResponse>('data_governance_detect_conflicts', {});
      expect(response.has_conflicts).toBe(false);
      expect(response.database_conflicts).toEqual([]);
      expect(response.cloud_manifest_json).toBeNull();
      expect(response.local_manifest_json).not.toBeNull();
    } finally {
      await host.dispose();
    }
  });

  it('rejects malformed cloud manifest json with parser context', async () => {
    const host = await makeHost();
    try {
      await expect(host.invoke('data_governance_detect_conflicts', {
        cloudManifestJson: '{not json',
      })).rejects.toMatch(/^解析云端清单失败: /);
    } finally {
      await host.dispose();
    }
  });

  it('maps download failures to 从云端下载清单失败', async () => {
    const cloud = new MemoryCloudStorage();
    cloud.truncated = true;
    const host = await makeHost(cloud);
    try {
      await expect(host.invoke('data_governance_detect_conflicts', {
        cloudConfig: {},
      })).rejects.toBe(
        '从云端下载清单失败: Network error: 云端清单列表被截断，已停止同步以避免漏读设备状态',
      );
    } finally {
      await host.dispose();
    }
  });
});
