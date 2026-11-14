/**
 * Startup recovery of interrupted media processing and indexing (audit V04-03 / V04-04, W29
 * `host/plugins/vfs-index/src/startup-recovery.ts`). Rust `build_app_state` (`lib.rs:3606-3644`) runs, before
 * the frontend can call anything:
 *
 * 1. `backfill_missing_previews`: historical PDFs without `preview_json` get their page previews rendered;
 * 2. `recover_stuck_tasks` (`pdf_processing_service.rs:3034-3089`): files left in an intermediate
 *    `processing_status` go back to `pending` and `resume_recovered_tasks` restarts their pipeline;
 * 3. `VfsFullIndexingService::recover_stuck_indexing` (`indexing.rs:1978-2045`): resources and index units left
 *    in `indexing` go back to `pending`, which the index worker picks up again.
 *
 * Without these the rows stay "processing"/"indexing" forever: the worker only picks up `pending`, retry only
 * accepts `error`, and the UI has no entry to restart them. The spec imports a text file and two text-layer
 * PDFs through the Files app, lets them finish, closes the app, leaves the rows the way a crash mid-run leaves
 * them, and relaunches on the same data.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from '../support/app.ts';
import { activeSlotDir, execute, query } from '../support/db.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { answerNextOpenDialog } from '../support/dialogs.ts';
import { startFakeLlm, type FakeLlm } from '../support/fake-llm.ts';
import { configureFakeEmbedding, configureFakeModel } from '../support/llm-config.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';
import { textPdf } from '../support/pdf.ts';
import { openDockApp } from '../support/renderer.ts';

const TEXT_FILE = 'smoke-recover-index.txt';
const TEXT_MARKER = 'SMOKE-RECOVER-INDEX-细胞呼吸';
const PDF_STUCK = 'smoke-recover-stuck.pdf';
const PDF_PREVIEW = 'smoke-recover-preview.pdf';
const PDF_LINES = (marker: string) => [
  marker,
  'Photosynthesis converts light energy into chemical energy stored in glucose.',
  'Cellular respiration releases that energy as ATP in the mitochondria.',
  'Both processes exchange carbon dioxide, water and oxygen with the environment.',
];
const TERMINAL = ['completed', 'completed_with_issues', 'error'];

interface FileRow { id: string; processing_status: string | null; processing_error: string | null; preview_json: string | null; page_count: number | null }

test.describe.serial('⑭ startup recovery of interrupted processing and indexing (V04-03 / V04-04)', () => {
  let app: LaunchedApp;
  let llm: FakeLlm;
  let root = '';
  let resourceId = '';
  let unitCount = 0;
  const pdfIds: Record<string, string> = {};
  const finalStatus: Record<string, string> = {};

  const vfsDb = () => join(activeSlotDir(app.dataDir), 'databases', 'vfs.db');
  const file = (name: string) => query<FileRow>(vfsDb(),
    `select id, processing_status, processing_error, preview_json, page_count from files where file_name = '${name}' and deleted_at is null`)[0];
  const indexState = () => query<{ index_state: string | null; index_error: string | null }>(vfsDb(),
    `select index_state, index_error from resources where id = '${resourceId}'`)[0];

  test.beforeAll(async () => {
    llm = await startFakeLlm();
    app = await launchApp({ label: 'startup-recovery' });
    root = app.root;
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
    await configureFakeModel(app, llm.baseUrl);
    await configureFakeEmbedding(app);
  });
  test.afterAll(async () => {
    await app?.close();
    await llm?.close();
  });

  test('a text file and two PDFs imported from the Files app finish processing and indexing', async () => {
    const dir = join(root, 'import');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, TEXT_FILE), `${TEXT_MARKER}\n线粒体通过有氧呼吸把葡萄糖分解为二氧化碳和水。\n`);
    writeFileSync(join(dir, PDF_STUCK), textPdf(PDF_LINES('SMOKE-RECOVER-STUCK')));
    writeFileSync(join(dir, PDF_PREVIEW), textPdf(PDF_LINES('SMOKE-RECOVER-PREVIEW')));

    await app.mark('recovery-import');
    await openDockApp(app.page, 'files');
    await answerNextOpenDialog(app, [TEXT_FILE, PDF_STUCK, PDF_PREVIEW].map((name) => join(dir, name)));
    const focused = app.page.locator('[data-wb-window][data-focused="true"]');
    await focused.getByRole('button', { name: /^新建$/ }).first().click();
    await app.page.getByRole('menuitem', { name: '导入资料…' }).click();

    await expect.poll(() => query<{ id: string }>(vfsDb(), `select id from resources where data like '%${TEXT_MARKER}%' and deleted_at is null`).length,
      { timeout: 30_000, message: 'the text file was not imported as a resource' }).toBe(1);
    resourceId = query<{ id: string }>(vfsDb(), `select id from resources where data like '%${TEXT_MARKER}%' and deleted_at is null`)[0]!.id;
    await expect.poll(() => indexState()?.index_state, { timeout: 60_000, message: 'the worker never indexed the text resource' }).toBe('indexed');

    for (const name of [PDF_STUCK, PDF_PREVIEW]) {
      await expect.poll(() => file(name)?.processing_status ?? null, { timeout: 60_000, message: `${name} never finished its pipeline` })
        .toMatch(/^completed/);
      const row = file(name)!;
      pdfIds[name] = row.id;
      finalStatus[name] = row.processing_status!;
      expect(row.preview_json, `${name} has page previews after the import`).not.toBeNull();
      expect(row.page_count).toBe(1);
    }
    test.info().annotations.push({ type: 'first-run', description: JSON.stringify(finalStatus) });
    expect(describeFailures(collectHealth(app, ['recovery-import']))).toBe('');
  });

  test('after a crash mid-run the relaunch resets and resumes the stuck PDF, backfills the missing preview and re-indexes the resource', async () => {
    unitCount = query<{ n: number }>(vfsDb(), `select count(*) as n from vfs_index_units where resource_id = '${resourceId}'`)[0]!.n;
    expect(unitCount).toBeGreaterThan(0);
    await app.close();

    // What a crash leaves behind: the pipeline was in OCR, the preview of a historical PDF was never written,
    // and the worker had claimed the resource and its units.
    const db = join(activeSlotDir(join(root, 'data')), 'databases', 'vfs.db');
    execute(db, `update files set processing_status = 'ocr_processing', processing_error = null where id = '${pdfIds[PDF_STUCK]}';
      update files set preview_json = null where id = '${pdfIds[PDF_PREVIEW]}';
      update resources set index_state = 'indexing', index_error = null, index_retry_count = 2 where id = '${resourceId}';
      update vfs_index_units set text_state = 'indexing' where resource_id = '${resourceId}';`);
    const embeddingsBefore = llm.embeddingRequests().length;

    app = await launchApp({ root, label: 'startup-recovery' });
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await app.mark('recovery-restart');

    // ② stuck pipeline: back to pending, auto-resumed, and finishes the way the clean run did.
    await expect.poll(() => file(PDF_STUCK)?.processing_status ?? null, { timeout: 60_000, message: 'the interrupted PDF stayed in an intermediate stage' })
      .toBe(finalStatus[PDF_STUCK]);
    const status = await app.call<{ stage?: string } | null>('vfs_get_pdf_processing_status', { fileId: pdfIds[PDF_STUCK] });
    expect(status?.stage, 'the frontend\'s status query sees the finished pipeline').toBe(finalStatus[PDF_STUCK]);

    // ① preview backfill.
    await expect.poll(() => file(PDF_PREVIEW)?.preview_json ?? null, { timeout: 60_000, message: 'the missing preview was not backfilled' }).not.toBeNull();
    expect(file(PDF_PREVIEW)?.processing_status).toBe(finalStatus[PDF_PREVIEW]);

    // ③ stuck indexing: reset to pending, picked up by the worker, indexed again with the resource text.
    await expect.poll(() => indexState()?.index_state, { timeout: 60_000, message: 'the resource stayed in indexing' }).toBe('indexed');
    const reindexed = llm.embeddingRequests().slice(embeddingsBefore).map((r) => JSON.stringify((r.body as { input?: unknown }).input));
    expect(reindexed.some((input) => input.includes(TEXT_MARKER)), 'the worker embedded the resource text again after the relaunch').toBe(true);
    expect(query<{ n: number }>(vfsDb(), `select count(*) as n from vfs_index_units where resource_id = '${resourceId}' and text_state = 'indexing'`)[0]!.n).toBe(0);

    const log = app.mainLog();
    test.info().annotations.push({ type: 'recovery-log', description: (log.match(/\[(AppSetup|MediaProcessingService|PdfProcessingService|VfsFullIndexingService)\][^\n]*/g) ?? []).join(' | ').slice(0, 2_000) });
    expect(log).toContain('[AppSetup] Recovered 1 stuck media processing tasks, scheduling auto-resume');
    expect(log).toContain(`[MediaProcessingService] Auto-resumed pipeline for recovered file: ${pdfIds[PDF_STUCK]}`);
    expect(log).toContain(`[AppSetup] Recovered ${unitCount + 1} stuck indexing records`);
    expect(log).toContain('[PdfProcessingService] Backfill: found 1 historical PDFs missing preview_json');
    expect(describeFailures(collectHealth(app, ['recovery-restart']))).toBe('');
  });
});
