/**
 * Golden path ② through the visible settings only: add an OpenAI-compatible vendor pointing at the fake LLM,
 * discover and add its model, then chat. The first send auto-assigns the only usable model as chat model.
 */
import { expect, test, type Page } from '@playwright/test';
import { launchApp, waitForIpcIdle, type LaunchedApp } from '../support/app.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { promptText, REPLY_TEXT, startFakeLlm, type FakeLlm } from '../support/fake-llm.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';
import { navigateSettingsTab } from '../support/renderer.ts';

const API_KEY = 'sk-smoke-ui';
const MESSAGE = '你好，UI 配置的模型';
/** memory/src/auto-extractor.ts extraction prompt. */
const EXTRACT_HEAD = '你是一个用户记忆提取器。';
const focused = (page: Page) => page.locator('[data-wb-window][data-focused="true"]');

test.describe.serial('② model configured from Settings', () => {
  let app: LaunchedApp;
  let llm: FakeLlm;

  test.beforeAll(async () => {
    llm = await startFakeLlm();
    app = await launchApp({ label: 'model-settings-ui' });
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
  });
  test.afterAll(async () => {
    await app?.close();
    await llm?.close();
  });

  test('a vendor and its discovered model are added from Settings › 模型服务', async () => {
    const { page } = app;
    await page.getByTestId('wb-dock-item-settings').click();
    await expect(focused(page).locator('[data-wb-settings-active-tab]').first()).toBeVisible();
    const addVendor = focused(page).getByRole('button', { name: '添加供应商' }).first();
    await expect.poll(async () => {
      await navigateSettingsTab(page, { tab: 'apis' });
      return addVendor.isVisible();
    }).toBe(true);
    await waitForIpcIdle(app);

    await app.mark('settings-vendor');
    await addVendor.click();
    const modal = page.getByRole('dialog').filter({ hasText: '配置供应商的 API 凭据' }).last();
    await modal.getByLabel('供应商名称').fill('Smoke Local UI');
    await modal.getByLabel(/接口地址/).fill(llm.baseUrl);
    await modal.getByPlaceholder('sk-...').fill(API_KEY);
    await modal.getByRole('button', { name: '保存' }).click();
    await expect(focused(page).getByText(llm.baseUrl)).toBeVisible();

    // The first button opens the discovery panel, the one inside it queries the vendor.
    await focused(page).getByRole('button', { name: '获取模型列表' }).first().click();
    await focused(page).getByRole('button', { name: '获取模型列表' }).last().click();
    await focused(page).getByRole('button', { name: /全部添加 \(1\)/ }).click();
    await expect.poll(async () => (await app.call<Array<{ model: string }>>('get_model_profiles')).some((p) => p.model === 'fake-chat')).toBe(true);
    expect(llm.requests.filter((r) => r.path.endsWith('/models')).map((r) => r.authorization)).toEqual([`Bearer ${API_KEY}`]);
    expect(describeFailures(collectHealth(app, ['settings-vendor']))).toBe('');
  });

  test('the first chat message uses the new model and streams the reply', async () => {
    const { page } = app;
    await app.mark('settings-chat');
    await focused(page).locator('.wb-traffic-close').click();
    await page.getByTestId('wb-dock-item-chat').click();
    await page.getByTestId('input-bar-v2-textarea').first().fill(MESSAGE);
    await page.getByTestId('btn-send').first().click();
    await expect(page.getByText(REPLY_TEXT)).toBeVisible();
    const chat = llm.streamRequests();
    expect(chat).toHaveLength(1);
    expect(chat[0]?.authorization).toBe(`Bearer ${API_KEY}`);
    // The only other requests are the post-turn session-metadata call (W02) and the memory auto-extraction
    // (persistence.rs:1584; the message reaches the balanced 10-character threshold), made with the same model and key.
    await expect.poll(() => llm.metadataRequests().length).toBe(1);
    await expect.poll(() => llm.completions(EXTRACT_HEAD).length).toBe(1);
    expect(llm.chatRequests()).toHaveLength(3);
    expect(llm.metadataRequests()[0]?.authorization).toBe(`Bearer ${API_KEY}`);
    const extraction = llm.completions(EXTRACT_HEAD)[0]!;
    expect(extraction.authorization).toBe(`Bearer ${API_KEY}`);
    expect(promptText(extraction.body)).toContain(MESSAGE);
    const profile = (await app.call<Array<{ id: string; model: string }>>('get_model_profiles')).find((p) => p.model === 'fake-chat')!;
    expect((await app.call<{ model2_config_id: string | null }>('get_model_assignments')).model2_config_id).toBe(profile.id);
    expect(describeFailures(collectHealth(app, ['settings-chat']))).toBe('');
  });
});
