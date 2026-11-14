/**
 * V09 P2-2: streams run detached through `state.spawnTracked`; unloading chat must abort them
 * and wait (bounded by 2 s) for the tracked work before the plugin's services go away.
 * Only the L03 execute entry is a double; the chat plugin, its stream state and database are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createBackgroundTasks, type BackgroundTasks } from '../../../platform/diagnostics/api.ts';
import plugin from '../index.ts';
import { ChatV2Error, type BackendSendRequest, type ChatV2State } from '../api.ts';
import { CompletionDispatcherRuntime } from '../src/completion-dispatcher.ts';
import { newSession } from '../src/types.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';

const SESSION = 'sess_unload_stream';

describe('V09-P2-2 chat unload cancels streams and drains tracked tasks', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let background: BackgroundTasks;
  let signals: AbortSignal[];
  let settled: string[];
  let honorAbort: boolean;

  beforeEach(async () => {
    f = databaseFixture(); background = createBackgroundTasks(); signals = []; settled = []; honorAbort = true;
    host = await createTestHost({ plugins: [plugin], provide: {
      storage: f.storage, vfs: vfsStub, backgroundTasks: background,
      agentTools: {
        toolExecutors: () => [],
        registerToolExecutors: () => Object.assign(() => {}, { dispose: () => { settled.push('tools-unregistered'); } }),
      },
      chatPipeline: { execute: (_window: unknown, request: BackendSendRequest, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<string>((resolve, reject) => {
          if (!honorAbort) {
            setTimeout(() => { settled.push('late'); resolve(request.assistantMessageId!); }, 10_000).unref?.();
            return;
          }
          signal.addEventListener('abort', () => {
            settled.push('cancelled');
            reject(new ChatV2Error('Cancelled'));
          }, { once: true });
        });
      } },
      llm: {
        getApiConfigs: async () => [{ id: 'cfg', model: 'm', isMultimodal: false }],
        selectModelFor: async () => [{ isMultimodal: false }, false],
      },
    } });
    host.ctx.chatSession.createSession(newSession(SESSION, 'chat'));
  });
  afterEach(async () => { await background.shutdown(); await host.dispose(); f.dispose(); });

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  };

  it('V09-P2-2: unloading chat mid-stream aborts the stream and waits for the tracked task to settle', async () => {
    const state = host.ctx.chatState as ChatV2State;
    await host.invoke('chat_v2_send_message', { request: { sessionId: SESSION, content: 'hello', assistantMessageId: 'msg_unload' } });
    await until(() => signals.length === 1 && state.hasActiveStream(SESSION));
    expect(state.trackedTaskCount()).toBe(1);

    const started = Date.now();
    await host.unload('dstu.chat');
    const elapsed = Date.now() - started;

    expect(signals[0]!.aborted).toBe(true);
    expect(settled).toEqual(['cancelled', 'tools-unregistered']);
    expect(state.activeStreamCount()).toBe(0);
    expect(state.trackedTaskCount()).toBe(0);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('V09-P2-2: a stream that ignores the abort holds unload for about 2 s, not until it finishes', async () => {
    honorAbort = false;
    const state = host.ctx.chatState as ChatV2State;
    await host.invoke('chat_v2_send_message', { request: { sessionId: SESSION, content: 'hello', assistantMessageId: 'msg_stuck' } });
    await until(() => signals.length === 1);

    const started = Date.now();
    await host.unload('dstu.chat');
    const elapsed = Date.now() - started;

    expect(signals[0]!.aborted).toBe(true);
    expect(settled).toEqual(['tools-unregistered']);
    expect(state.trackedTaskCount()).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(4_000);
  });

  it('V09-P2-2: unload aborts the streams before the rest of chat tears down', async () => {
    const state = host.ctx.chatState as ChatV2State;
    await host.invoke('chat_v2_send_message', { request: { sessionId: SESSION, content: 'hello', assistantMessageId: 'msg_order' } });
    await until(() => signals.length === 1 && state.hasActiveStream(SESSION));
    const order: string[] = [];
    const cancelAll = state.cancelAllStreams.bind(state);
    vi.spyOn(state, 'cancelAllStreams').mockImplementation(() => { order.push('cancelAllStreams'); return cancelAll(); });
    const stop = CompletionDispatcherRuntime.prototype.stop;
    vi.spyOn(CompletionDispatcherRuntime.prototype, 'stop').mockImplementation(function (this: CompletionDispatcherRuntime) {
      order.push('completionDispatcher.stop');
      return stop.call(this);
    });

    await host.unload('dstu.chat');
    vi.restoreAllMocks();

    expect(order).toEqual(['cancelAllStreams', 'completionDispatcher.stop']);
    expect(settled).toEqual(['cancelled', 'tools-unregistered']);
    expect(state.trackedTaskCount()).toBe(0);
  });
});
