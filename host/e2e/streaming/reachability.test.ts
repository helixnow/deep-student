import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { streamingHost } from './__fixtures__/host.ts';
import { scripts, type Scenario } from './__fixtures__/fake-llm.ts';
import type { ChatV2RetryMessageCommandArgs, ChatV2RetryVariantCommandArgs,
  ChatV2RetryVariantsCommandArgs } from '../../../contracts/ipc/generated/L04-chat-session.ts';

describe('X5 real send reachability — blockers, NOT successful E2E scenarios', () => {
  let fixture: Awaited<ReturnType<typeof streamingHost>>;
  beforeAll(async () => { fixture = await streamingHost(); }, 60_000);
  afterAll(async () => { await fixture?.dispose(); });

  it('loads the real chat/pipeline/LLM and dependency plugins', () => {
    expect(fixture.host.plugins.map(p => p.id)).toEqual(expect.arrayContaining([
      'dstu.native', 'dstu.vfs', 'dstu.vfs-repos', 'dstu.llm', 'dstu.chat', 'dstu.chat-pipeline',
      'dstu.notes', 'dstu.vfs-index',
    ]));
    expect(fixture.host.ctx.chatSession.database.getSchemaVersion()).toBeGreaterThan(0);
    expect(fixture.host.ctx.llmAdapters).toBeDefined();
    expect(fixture.host.ctx.notes).toBeDefined();
    expect(fixture.host.ctx.vfsIndex).toBeDefined();
  });

  it.each(Object.keys(scripts) as Scenario[])('%s script stays unconsumed: this fixture lacks the backgroundTasks binding for send', async scenario => {
    fixture.fake.scenario = scenario;
    expect(fixture.host.ctx.commands.has('chat_v2_send_message')).toBe(false);
    await expect(fixture.host.invoke('chat_v2_send_message', { request: {
      sessionId: 'sess_x5', content: '固定问题', userMessageId: 'msg_user_x5',
      assistantMessageId: 'msg_assistant_x5', options: {},
    } })).rejects.toBe('chat_v2_send_message not allowed. Command not found');
    expect(fixture.fake.created).toEqual([]);
    expect(fixture.host.events).toEqual([]);
  });

  it.each([
    { cmd: 'chat_v2_retry_message', args: {
      sessionId: 'sess_x5', messageId: 'msg_assistant_x5',
    } satisfies ChatV2RetryMessageCommandArgs },
    { cmd: 'chat_v2_retry_variant', args: {
      sessionId: 'sess_x5', messageId: 'msg_assistant_x5', variantId: 'var_x5',
    } satisfies ChatV2RetryVariantCommandArgs },
  ])('$cmd is registered but stops at the missing persisted message, not command lookup', async ({ cmd, args }) => {
      expect(fixture.host.ctx.commands.has(cmd)).toBe(true);
      await expect(fixture.host.invoke(cmd, args)).rejects.toBe(
        '{"code":"MESSAGE_NOT_FOUND","message":"Message not found: msg_assistant_x5"}');
      expect(fixture.fake.created).toEqual([]);
      expect(fixture.host.events).toEqual([]);
    });

  it('chat_v2_retry_variants accepts legal variantIds and reaches the real missing-message guard without writes or events', async () => {
    const { host, fake } = fixture;
    const store = host.ctx.chatSession;
    const args = { sessionId: 'sess_x5', messageId: 'msg_assistant_x5', variantIds: ['var_x5_a', 'var_x5_b'] } satisfies ChatV2RetryVariantsCommandArgs;
    const before = store.database.getStatistics();
    expect(host.ctx.commands.has('chat_v2_retry_variants')).toBe(true);
    expect(store.getSession(args.sessionId)).toBeNull();
    expect(store.getMessage(args.messageId)).toBeNull();
    expect(store.getMessageBlocks(args.messageId)).toEqual([]);

    await expect(host.invoke('chat_v2_retry_variants', args)).rejects.toBe(
      '{"code":"MESSAGE_NOT_FOUND","message":"Message not found: msg_assistant_x5"}');

    expect(store.database.getStatistics()).toEqual(before);
    expect(store.getSession(args.sessionId)).toBeNull();
    expect(store.getMessage(args.messageId)).toBeNull();
    expect(store.getMessageBlocks(args.messageId)).toEqual([]);
    expect(fake.created).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(fake.parsed).toEqual([]);
    // No production sink output is expected before the handler finds a persisted message.
    expect(host.events).toEqual([]);
    expect(host.ctx.chatState.hasActiveStream(args.sessionId)).toBe(false);
  });

  it('L02 hooks/unified stream and L03 execution are published; this fixture still lacks send backgroundTasks', () => {
    expect(typeof fixture.host.ctx.llm.subscribeCancelStream).toBe('function');
    for (const key of ['registerStreamHooks', 'unregisterStreamHooks', 'unregisterStreamHooksIfOwner', 'create']) {
      expect(typeof Reflect.get(fixture.host.ctx.llmStreamEvents, key), key).toBe('function');
    }
    for (const key of ['callUnifiedModel2Stream', 'callUnifiedModel2StreamWithConfig']) {
      expect(typeof Reflect.get(fixture.host.ctx.llmModel2Streaming, key), key).toBe('function');
    }
    for (const key of ['execute', 'executeWithEmitter', 'executeWithExistingUser']) {
      expect(typeof Reflect.get(fixture.host.ctx.chatPipeline, key), key).toBe('function');
    }
    expect(fixture.fake.created).toEqual([]);
  });
});
