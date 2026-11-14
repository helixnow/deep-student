/**
 * G3 `textbooks.add.pdf_render_error_recorded`：损坏 PDF 导入后流水线的写序与事件（Rust A1/A2 轨迹）。
 *
 * Rust `run_pdf_pipeline_internal` 没有文本提取/预览渲染阶段；无预览时跳过压缩与 OCR，只记 OCR issue：
 * 1. `start_pipeline` → `update_processing_status(OcrProcessing)`：files UPDATE
 * 2. `update_processing_status(VectorIndexing)`：files UPDATE
 * 3. `stage_vector_indexing` `emit_progress(75%)`：files UPDATE + 事件
 * 4. `sync_resource_units`（只写 vfs_index_units）后 `emit_progress(85%)`：files UPDATE + 事件
 * 5. `index_resource`：resources UPDATE ×3
 * 6. `emit_progress(95%)`：files UPDATE + 事件
 * 7. `update_processing_status(CompletedWithIssues)`：files UPDATE，随后 completed 事件
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
interface Step { cmd: string; args: Record<string, unknown> }

const OCR_ISSUE = 'PDF 页面渲染失败且缺少文本层，无法执行 OCR，内容不可检索。可尝试删除后重新导入，或检查 PDF 是否损坏/加密';

let host: TestHost | undefined;
let base: string | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
  vi.unstubAllEnvs();
  if (base !== undefined) fs.rmSync(base, { recursive: true, force: true });
  base = undefined;
}, 60_000);

function scenarioSteps(): Step[] {
  const file = path.join(import.meta.dirname, '../../media/equivalence/textbooks-files.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8')) as { scenarios: Array<{ id: string; steps: Step[] }> };
  const found = all.scenarios.find(s => s.id === 'textbooks.add.pdf_render_error_recorded');
  if (found === undefined) throw new Error('scenario textbooks.add.pdf_render_error_recorded missing');
  return found.steps;
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the PDF pipeline');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

it('corrupt PDF textbook import follows the Rust pipeline writes and events', async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'w04-pdf-pipeline-'));
  vi.stubEnv('XDG_DATA_HOME', path.join(base, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(base, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(base, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: path.join(base, 'app'), debug: true } });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(path.join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);
  const h = host;

  const [, saveStep] = scenarioSteps();
  if (saveStep === undefined) throw new Error('scenario steps missing');
  const source = path.join(base, 'w0-src', 'corrupt.pdf');
  await h.invoke('save_text_to_file', { ...saveStep.args, path: source });
  const conn = h.ctx.vfsDatabase.getConnSafe();
  const before = conn.all<ChangeRow>('SELECT id FROM __change_log').length;
  const eventsBefore = h.events.length;

  const [textbook] = await h.invoke('textbooks_add', { sources: [source] }) as Array<{ id: string }>;
  if (textbook === undefined) throw new Error('textbooks_add returned nothing');
  const fileId = textbook.id;
  const status = () => conn.pluck<string | null>('SELECT processing_status FROM files WHERE id = ?1', [fileId]);
  await waitFor(() => status() === 'completed' || status() === 'completed_with_issues', 60_000);
  await waitFor(() => h.events.slice(eventsBefore).some(e => e.event === 'pdf-processing-completed'), 10_000);

  const rows = conn.all<ChangeRow>('SELECT id, table_name, record_id, operation FROM __change_log ORDER BY id')
    .slice(before).map(r => [r.table_name, r.operation]);
  expect(rows).toEqual([
    ['blobs', 'INSERT'], ['resources', 'INSERT'], ['files', 'INSERT'],
    ['files', 'UPDATE'], ['files', 'UPDATE'], ['files', 'UPDATE'], ['files', 'UPDATE'],
    ['resources', 'UPDATE'], ['resources', 'UPDATE'], ['resources', 'UPDATE'],
    ['files', 'UPDATE'], ['files', 'UPDATE'],
  ]);

  const pipelineEvents = h.events.slice(eventsBefore)
    .filter(e => e.event.startsWith('media-processing-') || e.event.startsWith('pdf-processing-'))
    .map(e => [e.event, e.payload]);
  const progress = (percent: number) => ({
    fileId, status: { stage: 'vector_indexing', totalPages: 0, percent, readyModes: [], mediaType: 'pdf' }, mediaType: 'pdf',
  });
  const completed = { fileId, readyModes: [], stage: 'completed_with_issues', mediaType: 'pdf' };
  expect(pipelineEvents).toEqual([
    ['media-processing-progress', progress(75)], ['pdf-processing-progress', progress(75)],
    ['media-processing-progress', progress(85)], ['pdf-processing-progress', progress(85)],
    ['media-processing-progress', progress(95)], ['pdf-processing-progress', progress(95)],
    ['media-processing-completed', completed], ['pdf-processing-completed', completed],
  ]);

  const row = conn.get<{ processing_progress: string; processing_error: string }>(
    'SELECT processing_progress, processing_error FROM files WHERE id = ?1', [fileId]);
  expect(row?.processing_error).toBe(`ocr_processing: ${OCR_ISSUE}`);
  expect(row?.processing_progress).toBe('{"stage":"completed_with_issues","totalPages":0,"percent":100.0,'
    + `"readyModes":[],"mediaType":"pdf","failedStages":[{"stage":"ocr_processing","message":"${OCR_ISSUE}","retriable":true}]}`);
}, 180_000);
