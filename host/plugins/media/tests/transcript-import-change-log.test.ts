/**
 * G3 `media.transcript.import_formats_and_errors` step 8：字幕导入后 VFS `__change_log` 的写序。
 *
 * Rust 期望序列（上传之后）：
 * 1. `import_subtitle_impl` → `write_transcript_text`：files UPDATE（extracted_text）
 * 2. `refresh_index` → `sync_resource_units` → `set_index_state`：resources UPDATE
 * 3. `PdfProcessingService::start_pipeline` → `update_processing_status(Queued)`：files UPDATE
 * 4. 转写器（导入计划）`write_transcript_text`：files UPDATE
 * 5. 转写器 `refresh_index`：resources UPDATE
 * 6. `transcriber_hook.rs` 进度通道：导入分支无 await，`transcribe_resource` 首次 poll 即完成，
 *    `send(Queued)` 只在完成后的 `try_recv` 排空中落库：files UPDATE
 * 7. `emit_media_progress(indexing 92%)`：files UPDATE
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';

interface ChangeRow { id: number; table_name: string; record_id: string; operation: string }
interface Scenario { id: string; steps: Array<{ cmd: string; args: Record<string, unknown> }> }

let host: TestHost | undefined;
let base: string | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
  vi.unstubAllEnvs();
  if (base !== undefined) fs.rmSync(base, { recursive: true, force: true });
  base = undefined;
}, 60_000);

function scenario(): Scenario {
  const file = path.join(import.meta.dirname, '../equivalence/media-transcripts.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8')) as { scenarios: Scenario[] };
  const found = all.scenarios.find(s => s.id === 'media.transcript.import_formats_and_errors');
  if (found === undefined) throw new Error('scenario media.transcript.import_formats_and_errors missing');
  return found;
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for media pipeline');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

it('subtitle import writes __change_log in the Rust order (queued progress drains after the import plan)', async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'w04-transcript-changelog-'));
  vi.stubEnv('XDG_DATA_HOME', path.join(base, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(base, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(base, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: path.join(base, 'app'), debug: true } });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(path.join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);

  const [, uploadStep, vttStep] = scenario().steps;
  const importStep = scenario().steps[8];
  if (uploadStep === undefined || vttStep === undefined || importStep === undefined) throw new Error('scenario steps missing');
  expect(uploadStep.cmd).toBe('vfs_upload_file');
  expect(importStep.cmd).toBe('media_transcript_import');
  const conn = host.ctx.vfsDatabase.getConnSafe();
  const log = () => conn.all<ChangeRow>('SELECT id, table_name, record_id, operation FROM __change_log ORDER BY id');

  const upload = await host.invoke('vfs_upload_file', uploadStep.args) as { file: { id: string; resourceId: string } };
  const fileId = upload.file.id;
  const resourceId = upload.file.resourceId;
  const afterUpload = log().length;

  const subtitle = path.join(base, 'a.vtt');
  fs.writeFileSync(subtitle, String((vttStep.args as { content: string }).content));
  await host.invoke('media_transcript_import', { resourceId: fileId, path: subtitle });
  const status = () => conn.pluck<string>('SELECT processing_status FROM files WHERE id = ?1', [fileId]);
  await waitFor(() => status() === 'completed' || status() === 'completed_with_issues', 60_000);

  const rows = log().slice(afterUpload).map(r => [r.table_name, r.record_id, r.operation]);
  expect(rows.slice(0, 7)).toEqual([
    ['files', fileId, 'UPDATE'],
    ['resources', resourceId, 'UPDATE'],
    ['files', fileId, 'UPDATE'],
    ['files', fileId, 'UPDATE'],
    ['resources', resourceId, 'UPDATE'],
    ['files', fileId, 'UPDATE'],
    ['files', fileId, 'UPDATE'],
  ]);
}, 180_000);

/**
 * G3 step 8 return value. Rust `import_subtitle_bytes` (dstu-media/src/media/commands.rs:470-478)
 * builds the view right after `start_pipeline`, which writes `Queued` and then `tokio::spawn`s the
 * task (dstu-vfs/src/vfs/pdf_processing_service.rs:724-735): A returns `queued`/0 %, never the
 * `indexing` 92 % the pipeline reaches later.
 */
it('subtitle import returns the queued view before the spawned pipeline runs (commands.rs:470-478, pdf_processing_service.rs:724-735)', async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'w04-transcript-spawn-'));
  vi.stubEnv('XDG_DATA_HOME', path.join(base, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(base, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(base, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: path.join(base, 'app'), debug: true } });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(path.join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);

  const [, uploadStep, vttStep] = scenario().steps;
  if (uploadStep === undefined || vttStep === undefined) throw new Error('scenario steps missing');
  const conn = host.ctx.vfsDatabase.getConnSafe();
  const upload = await host.invoke('vfs_upload_file', uploadStep.args) as { file: { id: string } };
  const fileId = upload.file.id;
  const progressOf = () => (host!.eventsNamed('media-processing-progress') as Array<{ fileId: string; status: { stage: string; percent: number } }>)
    .filter(event => event.fileId === fileId).map(event => [event.status.stage, event.status.percent]);
  expect(progressOf()).toEqual([]);

  const subtitle = path.join(base, 'a.vtt');
  fs.writeFileSync(subtitle, String((vttStep.args as { content: string }).content));
  const view = await host.invoke('media_transcript_import', { resourceId: fileId, path: subtitle }) as {
    status: string; progress: { stage: string; percent: number; source: string | null };
  };
  expect(view.status).toBe('queued');
  expect(view.progress).toMatchObject({ stage: 'queued', percent: 0, source: 'import' });
  expect(conn.get('SELECT processing_status, processing_progress FROM files WHERE id = ?1', [fileId]))
    .toEqual({ processing_status: 'queued', processing_progress: null });
  expect(host.ctx.vfsIndex.pdf.isRunning(fileId)).toBe(true);
  expect(progressOf()).toEqual([]);

  const status = () => conn.pluck<string>('SELECT processing_status FROM files WHERE id = ?1', [fileId]);
  await waitFor(() => status() === 'completed' || status() === 'completed_with_issues', 60_000);
  expect(progressOf()).toContainEqual(['indexing', 92]);
}, 180_000);
