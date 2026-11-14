import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { ChatV2Error, type BackendSendRequest, type SendPipelinePort } from '../api.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';

describe('X5-01 chat.send owned/headless execution contract', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  const window = { window: 'main', webview: 'main' };
  beforeEach(async () => {
    f = databaseFixture(); host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  function request(): BackendSendRequest {
    return { sessionId: 'sess_execution', content: 'inbound task', userMessageId: 'msg_user', assistantMessageId: 'msg_assistant',
      options: { userMessageOrigin: { kind: 'worker', nested: null }, executionAllowedTools: [], streamGeneration: 999n } };
  }
  it('owned execution preserves the exact source, token, backend options and assistant ID without registering twice', async () => {
    const state = host.ctx.chatState;
    const registration = state.tryRegisterStreamOwned('sess_execution')!;
    const input = request();
    const pipeline: SendPipelinePort = { async execute(source, prepared, signal, passedState) {
      expect(source).toBe(window); expect(passedState).toBe(state); expect(signal).toBe(registration.token.signal);
      expect(prepared).toMatchObject({ userMessageId: 'msg_user', assistantMessageId: 'msg_assistant',
        options: { streamGeneration: registration.generation, userMessageOrigin: { kind: 'worker', nested: null }, executionAllowedTools: [] } });
      expect(state.registrationGeneration('sess_execution')).toBe(registration.generation);
      return 'msg_assistant';
    } };
    const runner = host.ctx.chatSession.createSendExecution(pipeline, state);
    expect(await runner.runSendMessage(window, input, registration)).toBe('msg_assistant');
    expect(input.options?.streamGeneration).toBe(999n);
    expect(state.hasActiveStream('sess_execution')).toBe(false);
  });
  it('headless compatibility obtains the registered generation and propagates the original error after cleanup', async () => {
    const state = host.ctx.chatState;
    const token = state.tryRegisterStream('sess_execution')!;
    const generation = state.registrationGeneration('sess_execution');
    const failure = new ChatV2Error('Llm', 'provider failed');
    const runner = host.ctx.chatSession.createSendExecution({ async execute(_window, prepared, signal) {
      expect(prepared.options?.streamGeneration).toBe(generation); expect(signal).toBe(token.signal);
      throw failure;
    } }, state);
    await expect(runner.runHeadlessMessage(window, request(), token)).rejects.toBe(failure);
    expect(state.hasActiveStream('sess_execution')).toBe(false);
  });
  it('a cancelled old headless token neither borrows nor clears the immediate retry generation', async () => {
    const state = host.ctx.chatState;
    const old = state.tryRegisterStream('sess_execution')!;
    state.cancelStream('sess_execution');
    const retry = state.tryRegisterStreamOwned('sess_execution')!;
    const runner = host.ctx.chatSession.createSendExecution({ async execute(_window, prepared, signal) {
      expect(signal).toBe(old.signal); expect(signal.aborted).toBe(true);
      expect(prepared.options?.streamGeneration).toBe(999n);
      throw new ChatV2Error('Cancelled');
    } }, state);
    await expect(runner.runHeadlessMessage(window, request(), old)).rejects.toMatchObject({ kind: 'Cancelled' });
    expect(state.registrationGeneration('sess_execution')).toBe(retry.generation);
    expect(retry.token.signal.aborted).toBe(false);
  });
  it('owned cleanup preserves a replacement generation even after an unexpected executor exception', async () => {
    const state = host.ctx.chatState;
    const registration = state.tryRegisterStreamOwned('sess_execution')!;
    const failure = new TypeError('executor panic');
    let nextGeneration: bigint | null = null;
    const runner = host.ctx.chatSession.createSendExecution({ async execute() {
      state.cancelStream('sess_execution');
      nextGeneration = state.tryRegisterStreamOwned('sess_execution')!.generation;
      throw failure;
    } }, state);
    await expect(runner.runSendMessage(window, request(), registration)).rejects.toBe(failure);
    expect(state.registrationGeneration('sess_execution')).toBe(nextGeneration);
  });
});
