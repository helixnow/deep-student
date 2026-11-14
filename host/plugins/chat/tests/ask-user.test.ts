import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { ChatV2Error } from '../api.ts';
import { registerAskUserCallback, type AskUserResponse } from '../src/ask-user.ts';

function commandError(kind: string, data?: unknown): string {
  const ErrorClass = ChatV2Error as unknown as new (kind: string, data?: unknown) => ChatV2Error;
  return new ErrorClass(kind, data).toCommandError();
}

describe('chat_v2 ask_user respond', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;

  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
  });
  afterEach(async () => { await host?.dispose(); f.dispose(); });

  it('rejects an empty tool_call_id before matching a waiter', async () => {
    await expect(host.invoke('chat_v2_ask_user_respond', {
      toolCallId: '   ', selectedTexts: [], selectedIndices: [], source: 'user_click',
    })).rejects.toBe(commandError('InvalidInput', 'tool_call_id must not be empty'));
  });

  it('rejects unknown sources with the Rust allowed list', async () => {
    await expect(host.invoke('chat_v2_ask_user_respond', {
      toolCallId: 'call_1', selectedTexts: [], selectedIndices: [], source: 'keyboard',
    })).rejects.toBe(commandError('InvalidInput',
      'Invalid ask_user source \'keyboard\'. Allowed: ["user_click", "custom_input", "mixed", "timeout", "channel_closed"]'));
  });

  it('delivers the response to the registered waiter and clears it', async () => {
    const received: AskUserResponse[] = [];
    registerAskUserCallback('call_2', response => received.push(response));
    await expect(host.invoke('chat_v2_ask_user_respond', {
      toolCallId: 'call_2', selectedTexts: ['A'], selectedIndices: [0],
      customText: null, source: 'user_click',
    })).resolves.toBeNull();
    expect(received).toEqual([{
      toolCallId: 'call_2', selectedTexts: ['A'], selectedIndices: [0],
      customText: null, source: 'user_click',
    }]);
    // A second response has no waiter; Rust only warns and still resolves.
    await expect(host.invoke('chat_v2_ask_user_respond', {
      toolCallId: 'call_2', selectedTexts: [], selectedIndices: [], source: 'timeout',
    })).resolves.toBeNull();
    expect(received).toHaveLength(1);
  });
});
