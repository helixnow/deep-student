/**
 * Super-agent inbox delivery (audit V01-02). Settings › 自动化 › 启用 Super-agent is the only switch for the
 * resident Super session (`SuperAgentSettingsSection.tsx`). Once it is on, the main window's resident controller
 * (`src/features/chat/superSession/residentController.ts`) attaches the session and, after its startup restore
 * and on every inbox change, calls `chat_v2_super_deliver_inbox`. Rust registers that command unconditionally
 * (`lib.rs:2580`) and runs `run_send_message_pipeline_owned` for a non-empty inbox; an empty inbox answers
 * `{ status: 'empty' }` and the controller waits for the next signal without retrying.
 *
 * The Host registers the command only when `chat.send@1` is provided (`agent-orchestration/index.ts:582-597`);
 * 891d75ed includes that provider. The real resident controller must get an empty result instead of retrying
 * with an error backoff (2 s doubling to 60 s, `residentController.ts:57-58`).
 */
import { expect, test, type Page } from '@playwright/test';
import { callsFromWire, launchApp, waitForIpcIdle, type LaunchedApp } from '../support/app.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { startFakeLlm, type FakeLlm } from '../support/fake-llm.ts';
import { configureFakeModel } from '../support/llm-config.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';
import { navigateSettingsTab } from '../support/renderer.ts';

const focused = (page: Page) => page.locator('[data-wb-window][data-focused="true"]');

function deliverCalls(app: LaunchedApp) {
  return callsFromWire(app.wire()).filter((c) => c.cmd === 'chat_v2_super_deliver_inbox');
}

function resultOf(body: unknown): unknown {
  const b = body as { kind?: string; data?: string } | undefined;
  return b?.kind === 'json' && b.data !== undefined ? JSON.parse(b.data) : body;
}

test.describe.serial('⑰ Super-agent inbox delivery (V01-02)', () => {
  let app: LaunchedApp;
  let llm: FakeLlm;

  test.beforeAll(async () => {
    llm = await startFakeLlm();
    app = await launchApp({ label: 'super-inbox' });
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
    await configureFakeModel(app, llm.baseUrl);
  });
  test.afterAll(async () => {
    await app?.close();
    await llm?.close();
  });

  test('启用 Super-agent in Settings › 自动化 turns the resident Super session on', async () => {
    const { page } = app;
    await app.mark('super-enable');
    await page.getByTestId('wb-dock-item-settings').click();
    await expect(focused(page).locator('[data-wb-settings-active-tab]').first()).toBeVisible();
    const toggle = focused(page).getByRole('switch', { name: '启用 Super-agent', exact: true });
    await expect.poll(async () => {
      await navigateSettingsTab(page, { tab: 'automation' });
      return toggle.isVisible();
    }).toBe(true);
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    const state = await app.call<{ enabled?: boolean; sessionId?: string | null }>('super_session_get_state');
    test.info().annotations.push({ type: 'super-state', description: JSON.stringify(state) });
    expect(state.enabled).toBe(true);
    expect(state.sessionId ?? '').not.toBe('');
    expect(await app.call('get_setting', { key: 'super_agent.enabled' })).toBe('true');
    await waitForIpcIdle(app);
    // The delivery call this switch starts is the next test's subject; everything else on this path must be clean.
    const health = collectHealth(app, ['super-enable']);
    const delivery = (text: string) => text.includes('chat_v2_super_deliver_inbox');
    expect(describeFailures({
      ...health,
      failedCalls: health.failedCalls.filter((c) => c.cmd !== 'chat_v2_super_deliver_inbox'),
      consoleErrors: health.consoleErrors.filter((m) => !delivery(m)),
      logErrors: health.logErrors.filter((l) => !delivery(l)),
    })).toBe('');
  });

  test('[V01-02] the resident session\'s inbox delivery is answered by the Host: an empty inbox is "empty" and not retried', async () => {
    await expect.poll(() => deliverCalls(app).filter((c) => c.outcome !== 'pending').length,
      { timeout: 30_000, message: 'the resident controller never asked the Host to deliver the inbox' }).toBeGreaterThan(0);
    const first = deliverCalls(app)[0]!;
    test.info().annotations.push({ type: 'deliver', description: JSON.stringify({ outcome: first.outcome, body: first.body }).slice(0, 400) });
    expect(first.outcome, JSON.stringify(first.body)).toBe('result');
    expect(resultOf(first.body)).toEqual({ status: 'empty' });
    const settled = deliverCalls(app).length;
    await app.page.waitForTimeout(15_000);
    expect(deliverCalls(app).length, 'an empty inbox is not polled again without a new signal').toBe(settled);
    expect(deliverCalls(app).every((c) => c.outcome === 'result')).toBe(true);
  });
});
