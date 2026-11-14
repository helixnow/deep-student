/**
 * W29: the official desktop profile registers and runs the five `build_app_state` startup items
 * that V04 found ported but never called (lib.rs:3512-3780). The composition root
 * (`host/kernel/serve.ts` finishStartup) runs every finalizer and only then marks the F2 gate;
 * this test replays that order on the real profile:
 * - before ready (Rust: synchronous in setup): V04-05 qbank, V04-03 media recovery, V04-04
 *   indexing recovery, V04-06 anki;
 * - after ready (Rust: spawn / spawn_blocking): V04-03 auto-resume and the V04-07 sweep.
 */
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../kernel/acl.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../kernel/profile.ts';
import { PluginAdmin } from '../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../kernel/profile-store.ts';
import { createTestHost, type TestHost } from '../../kernel/testing.ts';
import { hashFile, insertPreparedIntent } from '../../platform/storage/file-deletion-queue.ts';
import type { SqlExecutor } from '../../platform/storage/api.ts';
import type { PdfProcessingService } from '../../plugins/vfs-index/api.ts';
import type { VfsReposService } from '../../plugins/vfs-repos/api.ts';

const STARTUP_FINALIZERS = [
  'qbank.recover-interrupted-tasks',
  'vfs-index.startup-recovery',
  'notes.startup-sweep',
  'anki.recover-stuck-document-tasks',
];
const DAY_MS = 24 * 60 * 60 * 1000;

let root = '';
let host: TestHost;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dstu-startup-recovery-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: join(root, 'app'), platform: 'linux' }, acl: CapabilityAcl.fromDirectory('linux') });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await host?.dispose();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

interface Seeded { assetFile: string; blobFile: string }

function seed(vfs: SqlExecutor, mistakes: SqlExecutor): Seeded {
  const now = Date.now();
  const old = now - DAY_MS - 60_000;
  vfs.exec('PRAGMA foreign_keys=OFF');
  // V04-05
  for (const [id, status] of [['gen_queued', 'queued'], ['gen_running', 'running'], ['gen_done', 'completed']] as const) {
    vfs.run(`INSERT INTO qbank_generation_tasks
      (id, exam_id, status, request_json, drafts_json, rejected_count, rejection_reasons_json,
       skipped_references_json, used_reference_count, stream_event, created_at, updated_at)
      VALUES (?1, 'exam_1', ?2, '{}', NULL, 0, '[]', '[]', 0, ?3, 1, 1)`, [id, status, `stream_${id}`]);
  }
  // V04-03
  vfs.run(`INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at)
           VALUES ('res_pdf', 'h_pdf', 'file', 'external', NULL, ?1, ?1)`, [now]);
  vfs.run(`INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, size, "type", mime_type,
             status, created_at, updated_at, processing_status)
           VALUES ('file_pdf', 'res_pdf', NULL, 'sha_pdf', 'book.pdf', 12, 'file', 'application/pdf',
             'active', ?1, ?1, 'ocr_processing')`, [now]);
  // V04-04
  vfs.run(`INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at,
             index_state, index_retry_count, mm_index_state, mm_index_retry_count)
           VALUES ('res_indexing', 'h_indexing', 'note', 'inline', 'x', ?1, ?1, 'indexing', 3, 'indexing', 2)`, [now]);
  vfs.run(`INSERT INTO vfs_index_units (id, resource_id, unit_index, text_content, text_required, text_state,
             mm_required, mm_state, created_at, updated_at)
           VALUES ('unit_indexing', 'res_indexing', 0, 'x', 1, 'indexing', 1, 'indexing', 0, 0)`);
  // V04-07
  vfs.run(`INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
           VALUES ('ret_old', 'h_ret_old', 'retrieval', 'inline', 'x', 0, ?1, ?1),
                  ('note_orphan', 'h_note_orphan', 'note', 'inline', 'x', 0, ?1, ?1)`, [old]);
  vfs.run(`INSERT INTO vfs_index_units (id, resource_id, unit_index, text_content, text_required, text_state,
             mm_required, mm_state, created_at, updated_at)
           VALUES ('unit_orphan', 'res_gone', 0, 'x', 1, 'indexed', 0, 'disabled', 0, 0)`);
  vfs.exec('PRAGMA foreign_keys=ON');
  const repos = host.ctx.get('vfsRepo') as VfsReposService;
  const blobsDir = host.ctx.vfsDatabase.blobsDir();
  const blob = repos.blobs.storeBlob(vfs, blobsDir, new TextEncoder().encode('startup sweep blob'), 'text/plain', 'txt');
  vfs.run('UPDATE blobs SET ref_count = 0 WHERE hash = ?1', [blob.hash]);
  const activeDir = host.ctx.storage.locations.activeDir;
  const assetFile = join(activeDir, 'notes_assets', 'startup.bin');
  fs.mkdirSync(join(activeDir, 'notes_assets'), { recursive: true });
  fs.writeFileSync(assetFile, 'prepared asset');
  insertPreparedIntent(vfs, 'asset', 'active/notes_assets/startup.bin', 'notes_assets/startup.bin',
    hashFile(assetFile), fs.statSync(assetFile).size, 'op-w29-startup');
  // V04-06
  for (const [id, status, minutesAgo] of [['anki_stuck', 'Processing', 11], ['anki_recent', 'Processing', 2]] as const) {
    mistakes.run(`INSERT INTO document_tasks
        (id, document_id, original_document_name, segment_index, content_segment, status, created_at, updated_at,
         error_message, anki_generation_options_json, source_session_id, deleted_at)
      VALUES (?1, 'doc_1', 'doc.md', 0, 'segment', ?2,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ?3 || ' minutes'), NULL, '{}', NULL, NULL)`, [id, status, minutesAgo]);
  }
  return { assetFile, blobFile: join(blobsDir, blob.relativePath) };
}

it('registers all five V04 startup items and runs them on the desktop profile in Rust order', async () => {
  const storage = host.ctx.storage;
  expect(storage.finalizerNames()).toEqual(expect.arrayContaining(STARTUP_FINALIZERS));
  const vfs = storage.database('vfs');
  const mistakes = storage.database('mistakes');
  const seeded = seed(vfs, mistakes);
  const pdf = (host.ctx.vfsIndex as { pdf: PdfProcessingService }).pdf;
  const started = vi.spyOn(pdf, 'startPipeline').mockResolvedValue(undefined);
  const gate = host.ctx.get('startupGate' as never) as unknown as { markStartupReady(): void; isStartupReady(): boolean };
  expect(gate.isStartupReady()).toBe(false);

  const report = await storage.runStartupFinalizers();
  expect(report.completed).toEqual(expect.arrayContaining(STARTUP_FINALIZERS));

  // Synchronous Rust items are done before ready.
  expect(vfs.all('SELECT id, status, error FROM qbank_generation_tasks ORDER BY id')).toEqual([
    { id: 'gen_done', status: 'completed', error: null },
    { id: 'gen_queued', status: 'failed', error: '应用重启导致任务中断，请重新生成' },
    { id: 'gen_running', status: 'failed', error: '应用重启导致任务中断，请重新生成' },
  ]);
  expect(vfs.get("SELECT processing_status, processing_error FROM files WHERE id = 'file_pdf'"))
    .toEqual({ processing_status: 'pending', processing_error: 'recovered: interrupted by app restart' });
  expect(vfs.get(`SELECT index_state, index_retry_count, mm_index_state, mm_index_retry_count
                  FROM resources WHERE id = 'res_indexing'`))
    .toEqual({ index_state: 'pending', index_retry_count: 0, mm_index_state: 'pending', mm_index_retry_count: 0 });
  expect(vfs.get("SELECT text_state, mm_state FROM vfs_index_units WHERE id = 'unit_indexing'"))
    .toEqual({ text_state: 'pending', mm_state: 'pending' });
  expect(mistakes.all('SELECT id, status, error_message FROM document_tasks ORDER BY id')).toEqual([
    { id: 'anki_recent', status: 'Processing', error_message: null },
    { id: 'anki_stuck', status: 'Paused', error_message: '任务被中断（应用重启），可点击恢复继续' },
  ]);

  // Spawned Rust items wait for the gate.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(started).not.toHaveBeenCalled();
  expect(vfs.pluck("SELECT COUNT(*) FROM resources WHERE id IN ('ret_old', 'note_orphan')")).toBe(2);
  expect(fs.existsSync(seeded.assetFile)).toBe(true);

  gate.markStartupReady();
  await vi.waitFor(() => {
    expect(started).toHaveBeenCalledWith('file_pdf', null);
    expect(vfs.pluck("SELECT COUNT(*) FROM resources WHERE id IN ('ret_old', 'note_orphan')")).toBe(0);
  }, { timeout: 10_000 });
  expect(vfs.pluck("SELECT COUNT(*) FROM vfs_index_units WHERE id = 'unit_orphan'")).toBe(0);
  expect(fs.existsSync(seeded.assetFile)).toBe(false);
  expect(fs.existsSync(seeded.blobFile)).toBe(false);
}, 120_000);
