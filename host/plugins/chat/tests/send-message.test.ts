import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { ChatV2Error, type SendPipelinePort, type BackendSendRequest } from '../api.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';

describe('send_message.rs caller and owned stream execution', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  const calls: BackendSendRequest[] = [];
  const signals: AbortSignal[] = [];
  const finishes: Array<{ resolve(value: string): void; reject(error: unknown): void }> = [];
  const settled: string[] = [];
  const window = { window: 'main', webview: 'main' };
  let sender: ReturnType<typeof host.ctx.chatSession.createMessageSender>;
  beforeEach(async () => {
    f = databaseFixture(); calls.length = signals.length = finishes.length = settled.length = 0;
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    const pipeline: SendPipelinePort = { execute(source, request, signal, state) {
      expect(source).toEqual(window); expect(state).toBeDefined();
      calls.push(request); signals.push(signal);
      return new Promise((resolve, reject) => finishes.push({ resolve, reject }));
    } };
    sender = host.ctx.chatSession.createMessageSender({ state: host.ctx.chatState, pipeline,
      llm: { async getApiConfigs() { return [{ id: 'cfg', model: 'model', isMultimodal: true }]; },
        async selectModelFor() { return [{ isMultimodal: false }, false]; } },
      events: host.ctx.backendEvents,
      goals: { spawnContinuation(_source, id) { settled.push(`continue:${id}`); },
        settleActive(_source, id, status) { settled.push(`${status}:${id}`); } },
    });
  });
  afterEach(async () => {
    for (const finish of finishes) finish.resolve('done');
    await host.ctx.chatState.shutdownTasks(1000);
    await host.dispose(); f.dispose();
  });
  it('test_message_id_generation: send returns the same generated ID passed to execute', async () => {
    const id = await sender.send({ sessionId: 'sess_send', content: 'question' }, window);
    expect(id).toMatch(/^msg_[0-9a-f-]{36}$/);
    expect(calls[0]!.assistantMessageId).toBe(id);
    expect(calls[0]!.options?.streamGeneration).toBe(1n);
    expect(host.ctx.chatState.hasActiveStream('sess_send')).toBe(true);
    finishes[0]!.resolve(id);
    expect(await host.ctx.chatState.shutdownTasks(1000)).toBe(true);
    expect(host.ctx.chatState.hasActiveStream('sess_send')).toBe(false);
    expect(settled).toEqual(['continue:sess_send']);
    const secondId = await sender.send({ sessionId: 'sess_second', content: 'question' }, window);
    expect(secondId).toMatch(/^msg_/);
    expect(secondId).not.toBe(id);
  });
  it('build_wake_request_forces_ephemeral_user_content', async () => {
    expect(await sender.wake('sess_wake', 'wake now', 'msg_wake', { skipUserMessageSave: false }, window)).toBe('msg_wake');
    expect(calls[0]).toMatchObject({ sessionId: 'sess_wake', content: 'wake now', assistantMessageId: 'msg_wake',
      options: { skipUserMessageSave: true, streamGeneration: 1n } });
    expect(calls[0]!.userMessageId ?? null).toBeNull();
    expect(calls[0]!.userContextRefs ?? null).toBeNull();
  });
  it('validates before registration and preserves the frontend ID and replay override', async () => {
    await expect(sender.send({ sessionId: 'bad', content: '' }, window)).rejects.toMatchObject({ kind: 'Validation', message: 'Validation error: Invalid session ID format: bad' });
    await expect(sender.send({ sessionId: 'sess_s', content: '\u0085' }, window)).rejects.toMatchObject({ message: 'Validation error: Message content or context refs required' });
    expect(calls).toHaveLength(0);
    const request = { sessionId: 'sess_s', content: '中文🙂', assistantMessageId: '', options: { modelId: ' cfg ', replayMode: 'original' as const, temperature: 0.8 } };
    expect(await sender.send(request, window)).toBe('');
    expect(calls[0]!.options).toMatchObject({ temperature: 0, modelId: ' cfg ' });
    expect(request.options.temperature).toBe(0.8);
    expect(host.events.find(e => e.event === 'chat_v2_request_audit')?.payload).toMatchObject({ contentLength: 3, modelId: ' cfg ', isMultimodalModel: true });
  });
  it('cancel followed by a new send cannot be removed by the old generation finishing', async () => {
    await sender.send({ sessionId: 'sess_s', content: 'first' }, window);
    await expect(sender.send({ sessionId: 'sess_s', content: 'busy' }, window)).rejects.toMatchObject({ message: 'Session has an active stream. Please wait for completion or cancel first.' });
    expect(host.ctx.chatState.cancelStream('sess_s')).toBe(true);
    expect(signals[0]!.aborted).toBe(true);
    await sender.send({ sessionId: 'sess_s', content: 'second' }, window);
    finishes[0]!.reject(new ChatV2Error('Cancelled'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(host.ctx.chatState.registrationGeneration('sess_s')).toBe(2n);
    expect(calls[1]!.options?.streamGeneration).toBe(2n);
    expect(settled).toEqual(['paused:sess_s']);
    finishes[1]!.reject(new ChatV2Error('Llm', 'provider failed'));
    expect(await host.ctx.chatState.shutdownTasks(1000)).toBe(true);
    expect(host.ctx.chatState.hasActiveStream('sess_s')).toBe(false);
    expect(settled).toEqual(['paused:sess_s', 'blocked:sess_s']);
  });
  it('kill switch rejects before model audit and execute', async () => {
    host.ctx.chatState.killSwitch.trip('stop');
    await expect(sender.send({ sessionId: 'sess_s', content: 'question' }, window)).rejects.toMatchObject({ kind: 'Other' });
    expect(calls).toHaveLength(0);
    expect(host.events).toHaveLength(0);
  });
});
