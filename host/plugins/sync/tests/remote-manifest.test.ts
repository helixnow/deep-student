import { describe, expect, it } from 'vitest';
import type { BackupCrypto } from '../../../platform/secrets/api.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import {
  LEGACY_MANIFEST_KEY,
  DIVERGED_CHECKSUM_SENTINEL,
  deviceManifestKey,
  downloadManifest,
} from '../src/remote-manifest.ts';
import { createPayloadCodec, type PayloadCodec } from '../src/payload.ts';
import type { DatabaseSyncState, SyncManifest } from '../src/merge.ts';
import type { SyncLogger } from '../src/log.ts';

const encoder = new TextEncoder();

interface FileEntry {
  key: string;
  size: number;
  lastModified: string;
}

class MemoryStorage {
  readonly files = new Map<string, Uint8Array>();
  truncated = false;

  put(key: string, text: string): void {
    this.files.set(key, encoder.encode(text));
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.files.get(key) ?? null;
  }

  async listOutcome(prefix: string) {
    const files: FileEntry[] = [...this.files.keys()]
      .filter(key => key.startsWith(prefix))
      .map(key => ({ key, size: this.files.get(key)!.byteLength, lastModified: '2026-01-01T00:00:00Z' }));
    return { files, truncated: this.truncated };
  }
}

const plainCodec: PayloadCodec = {
  encrypted: false,
  encode: async data => data,
  decode: async data => data,
  dispose: () => undefined,
};

function manifest(
  deviceId: string,
  databases: Record<string, DatabaseSyncState>,
  extra: Partial<SyncManifest> = {},
): SyncManifest {
  return {
    sync_transaction_id: `tx-${deviceId}`,
    databases,
    status: 'Complete',
    created_at: '2026-10-25T00:00:00Z',
    device_id: deviceId,
    format_version: 3,
    published_max_seq: 0,
    cursors: {},
    superseded_by: null,
    snapshot_seen: {},
    ...extra,
  };
}

function captureLogger(): { logger: SyncLogger; warnings: string[]; infos: string[]; debugs: string[] } {
  const warnings: string[] = [];
  const infos: string[] = [];
  const debugs: string[] = [];
  return {
    warnings,
    infos,
    debugs,
    logger: {
      debug: message => debugs.push(message),
      info: message => infos.push(message),
      warn: message => warnings.push(message),
      error: () => undefined,
    },
  };
}

describe('download_manifest', () => {
  it('orders created_at at nanosecond precision and excludes numeric timestamps', async () => {
    const storage = new MemoryStorage();
    for (const [device, createdAt] of [
      ['a', '2026-10-25T00:00:00.000000001Z'],
      ['b', '2026-10-25T00:00:00.000000002Z'],
      ['c', '9999999999'],
    ]) {
      storage.put(deviceManifestKey(device!), JSON.stringify(manifest(device!, {}, { created_at: createdAt! })));
    }
    const merged = await downloadManifest(storage as unknown as CloudStorage, { deviceId: 'reader', codec: plainCodec });
    expect(merged.created_at).toBe('2026-10-25T00:00:00.000000002Z');
  });
  it('cloud_manifest_keeps_highest_schema_despite_newer_old_client_data_version', async () => {
    const storage = new MemoryStorage();
    storage.put(
      deviceManifestKey('new'),
      JSON.stringify(manifest('new', { vfs: { schema_version: 20261023, data_version: 1, checksum: 'new' } })),
    );
    storage.put(
      deviceManifestKey('old'),
      JSON.stringify(manifest('old', { vfs: { schema_version: 20261006, data_version: 1000, checksum: 'old' } })),
    );

    const merged = await downloadManifest(storage as unknown as CloudStorage, {
      deviceId: 'reader',
      codec: plainCodec,
    });
    expect(merged.databases.vfs!.schema_version).toBe(20261023);
    expect(BigInt(merged.databases.vfs!.data_version)).toBe(1n);
    expect(merged.device_id).toBe('merged');
    expect(merged.format_version).toBe(3);
  });

  it('marks_same_version_different_checksum_as_diverged', async () => {
    const storage = new MemoryStorage();
    storage.put(
      deviceManifestKey('a'),
      JSON.stringify(manifest('a', { vfs: { schema_version: 1, data_version: 5, checksum: 'aaa' } })),
    );
    storage.put(
      deviceManifestKey('b'),
      JSON.stringify(manifest('b', { vfs: { schema_version: 1, data_version: 5, checksum: 'bbb' } })),
    );
    const captured = captureLogger();

    const merged = await downloadManifest(storage as unknown as CloudStorage, {
      deviceId: 'reader',
      codec: plainCodec,
      logger: captured.logger,
    });
    expect(merged.databases.vfs!.checksum).toBe(DIVERGED_CHECKSUM_SENTINEL);
    expect(captured.warnings).toContain('[sync] 检测到同版本云端分叉数据库: vfs');
  });

  it('falls_back_to_legacy_single_manifest_when_no_device_manifests', async () => {
    const storage = new MemoryStorage();
    storage.put(
      LEGACY_MANIFEST_KEY,
      JSON.stringify(manifest('legacy-device', { chat_v2: { schema_version: 1, data_version: 7, checksum: 'x' } })),
    );
    const captured = captureLogger();

    const legacy = await downloadManifest(storage as unknown as CloudStorage, {
      deviceId: 'reader',
      codec: plainCodec,
      logger: captured.logger,
    });
    expect(legacy.device_id).toBe('legacy-device');
    expect(legacy.databases.chat_v2!.data_version).toBe(7);
    expect(captured.infos.some(message => message.includes('从旧版单清单迁移读取'))).toBe(true);
  });

  it('ignores_own_manifest_and_returns_empty_merged_manifest', async () => {
    const storage = new MemoryStorage();
    storage.put(
      deviceManifestKey('reader'),
      JSON.stringify(manifest('reader', { vfs: { schema_version: 1, data_version: 1, checksum: 'self' } })),
    );
    const captured = captureLogger();

    const merged = await downloadManifest(storage as unknown as CloudStorage, {
      deviceId: 'reader',
      codec: plainCodec,
      logger: captured.logger,
    });
    expect(merged.device_id).toBe('');
    expect(merged.sync_transaction_id).toBe('');
    expect(merged.format_version).toBe(3);
    expect(merged.databases).toEqual({});
    expect(captured.infos).toContain('[sync] 云端没有其他设备的同步清单');
  });

  it('skips_superseded_manifests', async () => {
    const storage = new MemoryStorage();
    storage.put(
      deviceManifestKey('old-device'),
      JSON.stringify(manifest('old-device', { vfs: { schema_version: 1, data_version: 2, checksum: 'old' } }, {
        superseded_by: 'new-device',
      })),
    );
    const merged = await downloadManifest(storage as unknown as CloudStorage, {
      deviceId: 'reader',
      codec: plainCodec,
    });
    expect(merged.databases).toEqual({});
  });

  it('corrupt_manifest_is_skipped_with_warning_but_others_still_merge', async () => {
    const storage = new MemoryStorage();
    storage.put(deviceManifestKey('broken'), '{not json');
    storage.put(
      deviceManifestKey('good'),
      JSON.stringify(manifest('good', { mistakes: { schema_version: 2, data_version: 3, checksum: 'ok' } })),
    );
    const captured = captureLogger();

    const merged = await downloadManifest(storage as unknown as CloudStorage, {
      deviceId: 'reader',
      codec: plainCodec,
      logger: captured.logger,
    });
    expect(merged.databases.mistakes!.schema_version).toBe(2);
    expect(captured.warnings.some(message => message.startsWith('[sync] 跳过损坏设备清单:'))).toBe(true);
  });

  it('rejects_truncated_manifest_listing', async () => {
    const storage = new MemoryStorage();
    storage.truncated = true;
    await expect(downloadManifest(storage as unknown as CloudStorage, {
      deviceId: 'reader',
      codec: plainCodec,
    })).rejects.toThrow('Network error: 云端清单列表被截断，已停止同步以避免漏读设备状态');
  });

  it('decrypts_encrypted_device_manifests_and_rejects_wrong_password', async () => {
    const realBackup = createBackupCrypto();
    const backup: BackupCrypto = {
      ...realBackup,
      createFileCipherSession: (password, params) =>
        realBackup.createFileCipherSession(password, params ?? { mCost: 8, tCost: 1, pCost: 1 }),
    };
    const storage = new MemoryStorage();
    const sender = await createPayloadCodec(backup, 'pw-123');
    try {
      const encoded = await sender.encode(encoder.encode(JSON.stringify(
        manifest('encrypted', { vfs: { schema_version: 1, data_version: 9, checksum: 'c' } }),
      )));
      storage.files.set(deviceManifestKey('encrypted'), encoded);
    } finally {
      sender.dispose();
    }

    const receiver = await createPayloadCodec(backup, 'pw-123');
    try {
      const merged = await downloadManifest(storage as unknown as CloudStorage, {
        deviceId: 'reader',
        codec: receiver,
      });
      expect(merged.databases.vfs!.data_version).toBe(9);
    } finally {
      receiver.dispose();
    }

    const wrong = await createPayloadCodec(backup, 'pw-456');
    try {
      await expect(downloadManifest(storage as unknown as CloudStorage, {
        deviceId: 'reader',
        codec: wrong,
      })).rejects.toThrow(/设备清单无法解密，已停止同步（请检查加密密码）/);
    } finally {
      wrong.dispose();
    }
  });

  it('preserves_large_u64_versions_losslessly', async () => {
    const storage = new MemoryStorage();
    const raw = JSON.stringify(manifest('peer', {}))
      .replace('"published_max_seq":0', '"published_max_seq":9007199254740993')
      .replace('"format_version":3', '"format_version":3')
      .replace(
        '"databases":{}',
        '"databases":{"vfs":{"schema_version":1,"data_version":9007199254740995,"checksum":"big"}}',
      );
    storage.put(deviceManifestKey('peer'), raw);

    const merged = await downloadManifest(storage as unknown as CloudStorage, {
      deviceId: 'reader',
      codec: plainCodec,
    });
    expect(merged.databases.vfs!.data_version).toBe(9007199254740995n);
  });
});
