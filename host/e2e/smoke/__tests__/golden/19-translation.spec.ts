/**
 * Translation app: 新建翻译, type, 翻译, relaunch, reopen. Rust `translate_text_stream` (`translation/mod.rs:35`,
 * `dstu-translation-core/src/engine.rs:88-215`) streams the model2 / translation-model answer as
 * `translation_stream_{session_id}` data events and writes nothing itself; the workbench then saves the session
 * through DSTU (`TranslateWorkbench.tsx` onSessionSave → `buildTranslationContent`), and `dstu_update` stores that
 * `{ source, translated, meta }` JSON as the translation's resource data unchanged (`content_helpers.rs:640-676`).
 * The list reads it back after a relaunch.
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, waitForIpcIdle, type LaunchedApp } from '../support/app.ts';
import { activeSlotDir, query } from '../support/db.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { promptText, startFakeLlm, type FakeLlm } from '../support/fake-llm.ts';
import { configureFakeModel } from '../support/llm-config.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';
import { openDockApp } from '../support/renderer.ts';

const SOURCE = 'SMOKE-TRANSLATE-SOURCE Mitochondria are the powerhouse of the cell.';
const TRANSLATED = 'SMOKE-TRANSLATE-RESULT 线粒体是细胞的动力工厂。';

interface TranslationRow { id: string; src_lang: string; tgt_lang: string; data: string | null }

const workspace = (page: Page) => page.getByTestId('wb-translation-workspace');

test.describe.serial('⑲ translation app', () => {
  let app: LaunchedApp;
  let llm: FakeLlm;
  let root = '';
  let saved: TranslationRow | undefined;

  const rows = () => query<TranslationRow>(join(activeSlotDir(app.dataDir), 'databases', 'vfs.db'),
    `select t.id, t.src_lang, t.tgt_lang, r.data from translations t join resources r on r.id = t.resource_id where t.deleted_at is null`);

  test.beforeAll(async () => {
    llm = await startFakeLlm();
    app = await launchApp({ label: 'translation' });
    root = app.root;
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
    await configureFakeModel(app, llm.baseUrl);
  });
  test.afterAll(async () => {
    await app?.close();
    await llm?.close();
  });

  test('新建翻译 › 翻译 streams the model answer into the result pane and saves source and translation to the resource', async () => {
    const { page } = app;
    await app.mark('translate');
    await openDockApp(page, 'translation');
    const ws = workspace(page);
    await ws.getByTitle('新建翻译', { exact: true }).click();
    await expect.poll(() => rows().length, { message: '新建翻译 created no translation resource' }).toBe(1);

    const before = llm.streamRequests().length;
    llm.script = () => ({ text: TRANSLATED });
    await ws.getByRole('textbox', { name: '待翻译文本' }).fill(SOURCE);
    await ws.getByTitle(/^翻译 · /).click();
    await expect(ws.getByText(TRANSLATED)).toBeVisible({ timeout: 30_000 });
    llm.script = null;

    const requests = llm.streamRequests().slice(before);
    expect(requests.length, 'one streaming request for one short segment').toBe(1);
    expect(promptText(requests[0]!.body), 'the source text reaches the model').toContain(SOURCE);
    expect((requests[0]!.body as { model?: string }).model).toBe('fake-chat');

    // English source detected from the text (src 'auto'), default target zh-CN.
    await expect.poll(() => rows()[0]?.data && JSON.parse(rows()[0]!.data!), { message: 'the translation was not saved to its resource' })
      .toEqual({
        source: SOURCE, translated: TRANSLATED,
        meta: { schemaVersion: 2, srcLang: 'en', tgtLang: 'zh-CN', formality: 'auto', domain: 'general' },
      });
    saved = rows()[0];
    await waitForIpcIdle(app);
    expect(describeFailures(collectHealth(app, ['translate']))).toBe('');
  });

  test('after a relaunch the translation is listed and opens with its source and result', async () => {
    expect(saved, 'precondition: the first test saved a translation').toBeDefined();
    await app.close();
    app = await launchApp({ root, label: 'translation' });
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await app.mark('reopen');
    const { page } = app;
    await openDockApp(page, 'translation');
    const ws = workspace(page);
    await expect(ws.getByRole('option')).toHaveCount(1);
    await ws.getByRole('option').click();
    await expect(ws.getByRole('textbox', { name: '待翻译文本' })).toHaveValue(SOURCE);
    await expect(ws.getByText(TRANSLATED)).toBeVisible();
    expect(rows()).toEqual([saved]);
    expect(llm.streamRequests().filter((r) => promptText(r.body).includes(SOURCE)), 'reopening does not translate again').toHaveLength(1);
    await waitForIpcIdle(app);
    expect(describeFailures(collectHealth(app, ['reopen']))).toBe('');
  });
});
