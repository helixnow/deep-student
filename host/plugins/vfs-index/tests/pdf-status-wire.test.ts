import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
// boundary-allow cross-plugin-impl: exercise the registered L13 status command with its real owners
import handlersPlugin from '../../vfs-handlers/index.ts';
// boundary-allow cross-plugin-impl: real L13 database provider
import vfsPlugin from '../../vfs/index.ts';
// boundary-allow cross-plugin-impl: real L11 repository/maintenance providers
import reposPlugin from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: required notes owner, never substituted
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: real docs provider required by the handler plugin
import mediaPlugin from '../../media/index.ts';
import plugin from '../index.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

let root: string;
let host: TestHost;
let storage: ReturnType<typeof createStorageService>;

beforeAll(async () => {
  root = fs.mkdtempSync('/tmp/opencode/vfs-status-wire-');
  storage = createStorageService({ baseDir: root, dataLocalDir: path.join(root, 'local') });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error(report.error ?? 'migration failed');
  host = await createTestHost({
    plugins: [reposPlugin, notesPlugin, vfsPlugin, plugin, mediaPlugin, handlersPlugin],
    provide: { storage, paths: { ...pathsServiceDouble(), appDataDir: root }, settings: { get: () => null } },
  });
  storage.database('vfs').run(`INSERT INTO files
    (id, sha256, file_name, size, created_at, updated_at, mime_type, processing_status)
    VALUES ('file_progress_wire', 'sha_progress_wire', 'book.pdf', 1, 'now', 'now', 'application/pdf', 'ocr_processing')`);
}, 180_000);

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function setProgress(raw: string): void {
  storage.database('vfs').run(`UPDATE files SET processing_progress = ?1,
    processing_started_at = NULL, processing_completed_at = NULL WHERE id = 'file_progress_wire'`, [raw]);
}

it('R12-08 wire: normal progress passes the registered command result schema', async () => {
  setProgress('{"stage":"ocr_processing","percent":25,"readyModes":["text"]}');
  await expect(host.invoke('vfs_get_pdf_processing_status', { fileId: 'file_progress_wire' }))
    .resolves.toEqual({ fileId: 'file_progress_wire', stage: 'ocr_processing',
      progress: { stage: 'ocr_processing', percent: 25, readyModes: ['text'] } });
});

it('R12-08.wire-percent: finite f32 uses the shortest serialized decimal value', async () => {
  // dstu-vfs enables arbitrary_precision: Number::from_f32 uses zmij's f32
  // shortest form rather than serializing the widened binary value as f64.
  setProgress('{"stage":"ocr_processing","percent":33.333333333333336,"readyModes":[]}');
  await expect(host.invoke('vfs_get_pdf_processing_status', { fileId: 'file_progress_wire' }))
    .resolves.toMatchObject({ progress: { percent: 33.333332 } });
});

it('R12-08 wire: exact internal usize/i64 values become JSON numbers only at kernel dispatch', async () => {
  setProgress('{"stage":"ocr_processing","percent":25,"currentPage":9007199254740993,"totalPages":18446744073709551615,"readyModes":[]}');
  storage.database('vfs').run(`UPDATE files SET processing_started_at = ?1, processing_completed_at = ?2
    WHERE id = 'file_progress_wire'`, [-9223372036854775808n, 9223372036854775807n]);
  expect(host.ctx.vfsIndex.pdf.getStatus('file_progress_wire')).toMatchObject({
    progress: { currentPage: 9007199254740993n, totalPages: 18446744073709551615n },
    startedAt: -9223372036854775808n, completedAt: 9223372036854775807n,
  });
  await expect(host.invoke('vfs_get_pdf_processing_status', { fileId: 'file_progress_wire' }))
    .resolves.toMatchObject({
      progress: { currentPage: Number(9007199254740993n), totalPages: Number(18446744073709551615n) },
      startedAt: Number(-9223372036854775808n), completedAt: Number(9223372036854775807n),
    });
});

it('R12-08.wire-percent: serde f32 overflow must remain a successful null-valued response', async () => {
  setProgress('{"stage":"ocr_processing","percent":1e40,"readyModes":[]}');
  expect(host.ctx.vfsIndex.pdf.getStatus('file_progress_wire')?.progress.percent).toBeNull();
  // Rust serialize_f32 writes null for Infinity. Keep this expected success
  // even while the generated output schema still incorrectly requires number.
  await expect(host.invoke('vfs_get_pdf_processing_status', { fileId: 'file_progress_wire' }))
    .resolves.toMatchObject({ fileId: 'file_progress_wire', progress: { percent: null } });
});
