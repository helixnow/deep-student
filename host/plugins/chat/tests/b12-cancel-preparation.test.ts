import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture } from './database-fixture.ts';
import { createSession } from '../repository/sessions.ts';
import { createMessage, getSessionMessageIds } from '../repository/messages.ts';
import { createBlock, getBlock } from '../repository/blocks.ts';
import { newSession } from '../src/types.ts';
import { ChatV2Error } from '../api.ts';

let f: ReturnType<typeof databaseFixture>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let release: () => void;
let entered: Promise<void>;
let execute: ReturnType<typeof vi.fn>;
let waitAt: 'model' | 'context';

beforeEach(async () => {
  f = databaseFixture();
  let notify!: () => void;
  entered = new Promise(resolve => { notify = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  execute = vi.fn(async () => 'answer');
  const wait = async (stage: typeof waitAt) => { if (waitAt === stage) { notify(); await pending; } };
  host = await createTestHost({ plugins: [plugin], provide: {
    storage: f.storage,
    vfs: { version: 1, database: { getConnSafe: () => f.db } },
    chatPipeline: { execute },
    llm: { selectModelFor: async () => { await wait('model'); return [{ isMultimodal: false }, false]; } },
    vfsRepo: { resources: { getResource: () => ({ id: 'resource', hash: 'hash', data: JSON.stringify({ refs: [
      { sourceId: 'note', resourceHash: 'hash', type: 'note', name: 'Note' },
    ] }) }) } },
    agentVfsResolver: { resolveContextRefDataToBlocks: async () => {
      await wait('context'); return [{ type: 'text', text: 'restored' }];
    } },
  } });
  createSession(f.db, newSession('session', 'chat'));
  for (const [id, role, timestamp] of [['user', 'user', 1], ['answer', 'assistant', 2], ['later', 'user', 3]] as const) {
    createMessage(f.db, { id, sessionId: 'session', role, timestamp, blockIds: [`block_${id}`],
      ...(id === 'user' ? { _meta: { contextSnapshot: { userRefs: [
        { resourceId: 'resource', hash: 'hash', typeId: 'note' },
      ] } } } : {}) });
    createBlock(f.db, { id: `block_${id}`, messageId: id, type: 'content', status: 'success', blockIndex: 0, content: id });
  }
});
afterEach(async () => {
  release();
  await host.ctx.chatState.shutdownTasks(1000);
  await host.dispose();
  f.dispose();
});

it.each([
  ['retry', 'model'], ['edit', 'model'], ['retry', 'context'], ['edit', 'context'],
] as const)('cancelled %s during %s preparation must not rewind messages or launch a stale turn', async (action, stage) => {
  waitAt = stage;
  const command = action === 'retry'
    ? host.invoke('chat_v2_retry_message', { sessionId: 'session', messageId: 'answer' })
    : host.invoke('chat_v2_edit_and_resend', { sessionId: 'session', messageId: 'user', newContent: 'edited' });
  // A second Web tab can stop this session while model/context preparation is awaiting IO.
  await entered;
  await host.invoke('chat_v2_cancel_stream', { sessionId: 'session', messageId: action === 'retry' ? 'answer' : 'user' });
  const replacement = host.ctx.chatState.tryRegisterStreamOwned('session')!;
  expect(replacement).not.toBeNull();
  const outcome = command.then(value => ({ value }), error => ({ error }));
  release();
  expect(await outcome).toEqual({ error: new ChatV2Error('Cancelled').toCommandError() });
  expect(getSessionMessageIds(f.db, 'session')).toEqual(['user', 'answer', 'later']);
  expect(getBlock(f.db, 'block_user')?.content).toBe('user');
  expect(execute).not.toHaveBeenCalled();
  expect(host.ctx.chatState.registrationGeneration('session')).toBe(replacement.generation);
  host.ctx.chatState.cancelStream('session');
});
