import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { plainCodec } from '../api.ts';
import { createSyncSupport } from '../src/service.ts';
import { SqliteSyncStateStore } from '../src/state.ts';
import { blobDeviceTombstoneLegacyKey } from '../src/tombstones.ts';
import { MemoryStorage } from './memory-storage.ts';
import { openTestDatabase } from './test-db.ts';
import { tempDirLocalFiles } from './local-files.ts';

function setup() {
  const db = openTestDatabase();
  const logger = { warn: vi.fn<(message: string) => void>(), info: vi.fn<(message: string) => void>() };
  const service = createSyncSupport({ state: new SqliteSyncStateStore(db), notes: () => undefined, logger, localFiles: tempDirLocalFiles() });
  return { db, logger, tombstones: service.tombstones };
}

describe('tombstone Rust tracing side effects through syncSupport', () => {
  it.each(['stat', 'delete'] as const)('delete_legacy_device_tombstone logs %s failure after publishing', async operation => {
    const { db, logger, tombstones } = setup();
    const legacy = blobDeviceTombstoneLegacyKey('device/a');
    class FailingLegacyStorage extends MemoryStorage {
      override async stat(key: string) {
        if (key === legacy && operation === 'stat') throw new Error('legacy probe failed');
        return super.stat(key);
      }
      override async delete(key: string) {
        if (key === legacy && operation === 'delete') throw new Error('legacy delete failed');
        return super.delete(key);
      }
    }
    const storage = new FailingLegacyStorage();
    const manifest = { entries: {}, updated_at: '' };
    storage.files.set(legacy, Buffer.from(JSON.stringify(manifest)));
    try {
      await tombstones.uploadBlobTombstones(storage, plainCodec, 'device/a', manifest);
      expect(storage.files.has(tombstones.blobDeviceTombstoneKey('device/a'))).toBe(true);
      expect(storage.files.has(legacy)).toBe(true);
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(operation === 'stat'
        ? `[sync] 迁移 tombstone 时探测旧对象 ${legacy} 失败: legacy probe failed`
        : `[sync] 迁移 tombstone 后删除旧对象 ${legacy} 失败（新清单已发布）: legacy delete failed`);
    } finally {
      db.raw.close();
    }
  });

  it('tombstone_deleted_at_usable warns without advancing the watermark', () => {
    const { db, logger, tombstones } = setup();
    try {
      const [filtered, offset] = tombstones.filterBlobTombstonesAfter({
        entries: { bad: { device_id: 'd', deleted_at: 'bad-clock' } }, updated_at: '',
      }, 0n);
      expect(filtered.entries).toEqual({});
      // Rust filter_blob_tombstones_after 初始化 max_offset = watermark。
      expect(offset).toBe(0n);
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        '[sync] 跳过坏/超前 deleted_at 的 tombstone（该条不推进水位）: blob/bad deleted_at=bad-clock 原因: Database error: blob/bad tombstone 时间戳无效: bad-clock',
      );
    } finally {
      db.raw.close();
    }
  });

  it('download_workspace_tombstones_after preserves the invalid-event warning', async () => {
    const { db, logger, tombstones } = setup();
    const storage = new MemoryStorage();
    const event = {
      format_version: 4, device_id: 'd', seq: 1n, kind: 'workspaces', object_id: 'workspace',
      deleted_at: 'bad-clock', size: null, relative_path: null,
      operation_id: tombstones.eventOperationId('workspaces', 'd', 'workspace', 'bad-clock'),
      payload_hash: '',
    };
    event.payload_hash = tombstones.eventPayloadHash(event);
    storage.files.set(tombstones.eventKey(event), Buffer.from(JSON.stringify({ ...event, seq: 1 })));
    try {
      const [manifest, advances] = await tombstones.downloadWorkspaceTombstonesAfter(storage, plainCodec, () => 0n);
      expect(manifest.entries).toEqual({});
      expect(advances).toEqual([]);
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        '[sync] 跳过坏/超前 deleted_at 的 tombstone（该条不推进水位）: workspaces/workspace deleted_at=bad-clock 原因: Database error: workspaces/workspace tombstone 时间戳无效: bad-clock',
      );
    } finally {
      db.raw.close();
    }
  });

  it('apply_blob_tombstones logs newer local files and missing cloud objects then continues', async () => {
    const { db, logger, tombstones } = setup();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-support-log-'));
    const hash = 'a'.repeat(64);
    const missing = 'b'.repeat(64);
    const relative = `aa/${hash}.bin`;
    fs.mkdirSync(path.join(directory, 'aa'));
    fs.writeFileSync(path.join(directory, relative), 'newer');
    const storage = new MemoryStorage();
    const deletedAt = '2026-08-01T00:00:00Z';
    try {
      const affected = await tombstones.applyBlobTombstones(storage, {
        entries: {
          [hash]: { device_id: 'd', deleted_at: deletedAt, relative_path: relative },
          [missing]: { device_id: 'd', deleted_at: deletedAt },
        }, updated_at: '',
      }, directory, 'blobs', true);
      expect(affected).toEqual([missing]);
      expect(fs.readFileSync(path.join(directory, relative), 'utf8')).toBe('newer');
      expect(logger.info).toHaveBeenCalledExactlyOnceWith(
        `[sync] 跳过过期 blob tombstone，本地文件更新: ${hash} deleted_at=${deletedAt}`,
      );
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        `[sync] tombstone ${missing} 无 relative_path 且云端未找到匹配对象，跳过云端删除`,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
      db.raw.close();
    }
  });
});
