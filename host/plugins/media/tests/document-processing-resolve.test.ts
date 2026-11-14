import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import { resolveFile } from '../src/document-processing.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let database: VfsDatabase;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-resolve-file-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const report = await storage.migrations.runAll();
  expect(report.success, report.error ?? '').toBe(true);
  const conn: DatabaseHandle = storage.database('vfs');
  const now = '2026-01-01T00:00:00.000Z';
  conn.run(
    `INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
     VALUES ('res_upload', 'hash-upload', 'file', 'inline', '{"refs":[]}', 1, ?1, ?1)`,
    [now],
  );
  conn.run(
    `INSERT INTO files (id, resource_id, sha256, file_name, mime_type, size, created_at, updated_at)
     VALUES ('att_file1', 'res_upload', 'hash-upload', 'doc.pdf', 'application/pdf', 10, ?1, ?1)`,
    [now],
  );
  conn.run(
    `INSERT INTO resources (id, hash, type, storage_mode, data, source_id, ref_count, created_at, updated_at)
     VALUES ('res_ref', 'hash-ref', 'file', 'inline', '{"refs":[]}', 'att_file1', 1, ?1, ?1)`,
    [now],
  );
  conn.run(
    `INSERT INTO resources (id, hash, type, storage_mode, data, source_id, ref_count, created_at, updated_at)
     VALUES ('res_ref_indirect', 'hash-ref2', 'file', 'inline', '{"refs":[]}', 'res_upload', 1, ?1, ?1)`,
    [now],
  );
  database = {
    getConnSafe: () => conn,
    blobsDir: () => path.join(root, 'vfs_blobs'),
  } as unknown as VfsDatabase;
}, 120_000);

afterAll(() => {
  storage?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}, 120_000);

it('resolve_file_supports_att_prefix_and_upload_resource', () => {
  const direct = resolveFile(database, 'att_file1');
  expect(direct.id).toBe('att_file1');
  expect(direct.fileName).toBe('doc.pdf');
  expect(direct.mimeType).toBe('application/pdf');

  const upload = resolveFile(database, 'res_upload');
  expect(upload.id).toBe('att_file1');
});

it('resolve_file_resolves_reference_resource_via_source_id', () => {
  expect(resolveFile(database, 'res_ref').id).toBe('att_file1');
  expect(resolveFile(database, 'res_ref_indirect').id).toBe('att_file1');
});

it('resolve_file_rejects_unresolvable_resource', () => {
  expect(() => resolveFile(database, 'res_missing')).toThrowError(/未关联到可解析的文件/);
  expect(() => resolveFile(database, 'att_missing'))
    .toThrowError('文件不存在: att_missing（请用 resource_list/resource_search 获取有效 ID）');
  expect(() => resolveFile(database, '../etc/passwd'))
    .toThrowError('资源 ID 格式无效: ../etc/passwd');
});
