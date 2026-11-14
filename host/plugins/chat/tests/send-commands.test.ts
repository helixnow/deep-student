/**
 * chat_v2_send_message / chat_v2_wake_session production registration (send_message.rs:461/717)
 * and the goal continuation emit window (goal/runtime.rs:435 resolve_emit_window).
 * Only the L03 execute entry and the L02 model lookup are provider doubles; the chat plugin,
 * its database, stream state, GoalRuntime and the F4 background task registry are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createBackgroundTasks, type BackgroundTasks } from '../../../platform/diagnostics/api.ts';
import plugin from '../index.ts';
import { ChatV2Error, goalInsertWithConn, goalUpdateStatusWithConn, type BackendSendRequest } from '../api.ts';
import { newSession } from '../src/types.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';

type Source = { window: string; webview: string };
const SESSION = 'sess_send_cmd';

describe('send_message.rs send/wake registered commands', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let background: BackgroundTasks;
  let calls: { window: Source; request: BackendSendRequest }[];
  let logs: string[];
  beforeEach(async () => {
    f = databaseFixture(); background = createBackgroundTasks(); calls = []; logs = [];
    host = await createTestHost({ plugins: [plugin], provide: {
      storage: f.storage, vfs: vfsStub, backgroundTasks: background,
      chatPipeline: { execute: async (window: Source, request: BackendSendRequest) => {
        calls.push({ window: { window: window.window, webview: window.webview }, request });
        // The second turn is the goal continuation: finishing the goal ends the loop.
        if (calls.length > 1) goalUpdateStatusWithConn(f.db, request.sessionId, 'goal_send', 'complete');
        return request.assistantMessageId!;
      } },
      llm: {
        getApiConfigs: async () => [{ id: 'cfg', model: 'm', isMultimodal: false }],
        selectModelFor: async () => [{ isMultimodal: false }, false],
      },
    } });
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { logs.push(String(message.args[0])); } });
    host.ctx.chatSession.createSession(newSession(SESSION, 'chat'));
  });
  afterEach(async () => { await background.shutdown(); await host.dispose(); f.dispose(); });

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  };
  const activeGoal = () => goalInsertWithConn(f.db, { sessionId: SESSION, goalId: 'goal_send', objective: 'finish',
    status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, continuationCount: 0, createdAtMs: 0, updatedAtMs: 0 });

  it('send runs the pipeline on the invoking window and returns the assistant message id', async () => {
    const aux = { window: 'aux', webview: 'aux' };
    const id = await host.invoke<string>('chat_v2_send_message',
      { request: { sessionId: SESSION, content: 'hello', assistantMessageId: 'msg_send_cmd' } }, aux);
    expect(id).toBe('msg_send_cmd');
    await until(() => calls.length === 1 && !host.ctx.chatState.hasActiveStream(SESSION));
    expect(calls[0]!.window).toEqual(aux);
    expect(calls[0]!.request).toMatchObject({ sessionId: SESSION, content: 'hello', assistantMessageId: 'msg_send_cmd' });
  });

  it('wake sets skipUserMessageSave and rejects empty content like Rust', async () => {
    const id = await host.invoke<string>('chat_v2_wake_session', { sessionId: SESSION, content: 'wake', assistantMessageId: 'msg_wake_cmd' });
    expect(id).toBe('msg_wake_cmd');
    await until(() => calls.length === 1);
    expect(calls[0]!.request.options).toMatchObject({ skipUserMessageSave: true });
    await expect(host.invoke('chat_v2_wake_session', { sessionId: SESSION, content: '  ' }))
      .rejects.toBe(new ChatV2Error('Validation', 'Wake content cannot be empty').toCommandError());
  });

  it('goal continuation emits to the "main" webview even when another window was created first', async () => {
    host.window({ window: 'aux', webview: 'aux' }, 'created');
    host.window({ window: 'main', webview: 'main' }, 'created');
    activeGoal();
    await host.invoke('chat_v2_send_message', { request: { sessionId: SESSION, content: 'go' } }, { window: 'aux', webview: 'aux' });
    await until(() => calls.length === 2);
    await background.shutdown();
    expect(calls[0]!.window.webview).toBe('aux');
    expect(calls[1]!.window.webview).toBe('main');
    expect(calls[1]!.request.options).toMatchObject({ skipUserMessageSave: true });
  });

  it('without "main" the first webview is used; with none the continuation stops with a warning', async () => {
    host.window({ window: 'aux', webview: 'aux' }, 'created');
    host.window({ window: 'second', webview: 'second' }, 'created');
    activeGoal();
    await host.invoke('chat_v2_send_message', { request: { sessionId: SESSION, content: 'go' } });
    await until(() => calls.length === 2);
    await until(() => logs.some(line => line.includes('goal not active (status=complete); stop continuation')));
    expect(calls[1]!.window.webview).toBe('aux');

    host.window({ window: 'aux', webview: 'aux' }, 'destroyed');
    host.window({ window: 'second', webview: 'second' }, 'destroyed');
    goalUpdateStatusWithConn(f.db, SESSION, 'goal_send', 'active');
    // resolve_emit_window runs before the goal reload, so the loop stops on the missing window.
    await host.invoke('chat_v2_send_message', { request: { sessionId: SESSION, content: 'again' } });
    await until(() => logs.some(line => line.includes('no window available; stop continuation')));
    await background.shutdown();
    expect(calls).toHaveLength(3);
  });

  it('goal_handlers.rs:167: resuming a paused goal spawns the continuation; a goal that cannot resume does not', async () => {
    host.window({ window: 'main', webview: 'main' }, 'created');
    goalInsertWithConn(f.db, { sessionId: SESSION, goalId: 'goal_send', objective: 'finish',
      status: 'paused', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, continuationCount: 0, createdAtMs: 0, updatedAtMs: 0 });
    const shared = host.ctx.chatSession.activeGoalRuntime();
    expect(shared).toBeDefined();
    const spawn = vi.spyOn(shared!, 'spawnContinuation');
    await expect(host.invoke('chat_v2_goal_resume', { sessionId: SESSION })).resolves.toMatchObject({ status: 'active' });
    expect(spawn).toHaveBeenCalledWith(expect.anything(), SESSION);
    await until(() => calls.length === 2);
    await until(() => logs.some(line => line.includes('goal not active (status=complete); stop continuation')));
    expect(calls[0]!.window.webview).toBe('main');
    expect(calls[0]!.request.options).toMatchObject({
      skipUserMessageSave: true, schemaToolIds: ['goal_create', 'goal_update', 'goal_get'],
    });

    await expect(host.invoke('chat_v2_goal_resume', { sessionId: SESSION })).resolves.toMatchObject({ status: 'complete' });
    await new Promise(resolve => setTimeout(resolve, 300));
    await background.shutdown();
    expect(calls).toHaveLength(2);
  });
});

describe('send/wake stay unregistered without the L03 execute entry', () => {
  it('chat_v2_send_message is not registered when chatPipeline has no execute', async () => {
    const f = databaseFixture();
    const host = await createTestHost({ plugins: [plugin], provide: {
      storage: f.storage, vfs: vfsStub, backgroundTasks: createBackgroundTasks(), chatPipeline: {},
      llm: { getApiConfigs: async () => [], selectModelFor: async () => [{ isMultimodal: false }, false] },
    } });
    try {
      host.ctx.chatSession.createSession(newSession(SESSION, 'chat'));
      await expect(host.invoke('chat_v2_send_message', { request: { sessionId: SESSION, content: 'x' } })).rejects.toContain('Command not found');
      await expect(host.invoke('chat_v2_wake_session', { sessionId: SESSION, content: 'x' })).rejects.toContain('Command not found');
      expect(host.ctx.chatSession.activeGoalRuntime()).toBeUndefined();
    } finally { await host.dispose(); f.dispose(); }
  });
});
