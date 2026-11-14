import { expect, test } from '@playwright/test';
import type { LoadSessionResponse } from '../../../../../contracts/ipc/generated/L04-chat-session.ts';
import { launchApp } from '../support/app.ts';
import { REPLY_TEXT, startFakeLlm } from '../support/fake-llm.ts';
import { configureFakeModel } from '../support/llm-config.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';

test('a question sent without a model survives reload and can be retried in place', async () => {
  const app = await launchApp({ label: 'missing-model-retry' });
  let llm: Awaited<ReturnType<typeof startFakeLlm>> | undefined;
  try {
    const { page } = app;
    await waitForBridge(page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(page);
    await page.getByTestId('wb-dock-item-chat').click();
    const question = '没有配置模型时也要保留这条问题';
    await page.getByTestId('input-bar-v2-textarea').first().fill(question);
    await page.getByTestId('btn-send').first().click();
    const error = 'LLM error: 没有可用的文本或多模态生成模型';
    await expect(page.getByRole('button', { name: /^(重试|Retry)$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /去设置添加模型|Add models in Settings/ })).toBeVisible();

    const send = app.wire().find(row => row.kind === 'renderer-invoke' && row.message?.cmd === 'chat_v2_send_message');
    const { request: { sessionId } } = JSON.parse((send?.message?.payload as { data: string }).data);
    const load = () => app.call<LoadSessionResponse>('chat_v2_load_session', { sessionId });
    const failed = await load();
    expect(failed.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    const [user, reply] = failed.messages;
    if (!user || !reply) throw new Error('Expected user and assistant messages after a model error');
    expect(failed.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: user.id, content: question }),
      expect.objectContaining({ messageId: reply.id, status: 'error', error }),
    ]));

    const title = '无模型重试验证';
    await app.call('chat_v2_update_session_settings', { sessionId, settings: { title } });
    await page.reload();
    await waitForBridge(page);
    await page.getByTestId('wb-dock-item-chat').click();
    await page.getByLabel(title, { exact: true }).click();
    await expect(page.getByText(question, { exact: true })).toBeVisible();
    await expect(page.locator('.chat-message-failure')).toContainText('没有可用的文本或多模态生成模型');

    llm = await startFakeLlm();
    await configureFakeModel(app, llm.baseUrl);
    await page.getByRole('button', { name: /^(重试|Retry)$/ }).click();
    await expect(page.getByText(REPLY_TEXT)).toBeVisible();
    await expect.poll(() => app.call('chat_v2_has_active_stream', { sessionId })).toBe(false);
    const retried = await load();
    expect(retried.messages.map(message => message.id)).toEqual([user.id, reply.id]);
    expect(llm.streamRequests()).toHaveLength(1);
    expect(JSON.stringify(llm.streamRequests()[0]?.body)).toContain(question);
  } finally {
    try { await app.close(); } finally { await llm?.close(); }
  }
});
