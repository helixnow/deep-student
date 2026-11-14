import './local-runtime-fixture.ts';
import { describe, expect, it } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import type { RepoCheckReport } from '../../../../contracts/ipc/generated/L20-sync.ts';
import sync from '../index.ts';

function emptyStorage(): CloudStorage {
  return {
    providerName: () => 'memory',
    instanceBindingHint: () => 'memory:test',
    checkConnection: async () => undefined,
    put: async () => undefined,
    get: async () => null,
    getBounded: async () => null,
    getRange: async () => new Uint8Array(0),
    list: async () => [],
    listOutcome: async () => ({ files: [], truncated: false }),
    delete: async () => undefined,
    stat: async () => null,
    exists: async () => false,
    putFile: async () => '',
    verifyRemoteObjectSize: async () => undefined,
    supportsConditionalPut: () => false,
    putIfAbsent: async () => true,
    supportsResumableDownload: () => false,
    getFileResumable: async () => 0,
    supportsPrefixRead: () => false,
    getPrefix: async () => null,
    getFile: async () => '',
  };
}

async function makeHost(provider: unknown, maintenance = false) {
  return createTestHost({
    plugins: [sync],
    provide: {
      storage: {},
      paths: { deviceId: async () => 'test-device' },
      backup: { hydrateCloudConfig: async () => undefined },
      syncProvider: provider,
      vfsDatabase: { isInMaintenanceMode: () => maintenance },
    },
  });
}

describe('cloud commands', () => {
  it('repo_check_runs_read_only_check_and_maps_errors', async () => {
    const host = await makeHost({ createStorage: async () => emptyStorage() });
    try {
      const report = await host.invoke<RepoCheckReport>('data_governance_repo_check', { cloudConfig: {} });
      expect(report.status).toBe('ok');
      expect(report.objectsChecked).toBe(0);
      expect(report.problems).toEqual([]);
      expect(report.listingTruncated).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  it('repo_check_rejects_when_transport_service_is_missing', async () => {
    await expect(makeHost(undefined)).rejects.toThrow('required services not available: "syncProvider"');
  });

  it('repo_check_respects_maintenance_mode', async () => {
    const host = await makeHost({ createStorage: async () => emptyStorage() }, true);
    try {
      await expect(host.invoke('data_governance_repo_check', { cloudConfig: {} }))
        .rejects.toBe('数据治理操作正在进行（维护模式），请稍后再试。');
    } finally {
      await host.dispose();
    }
  });
});
