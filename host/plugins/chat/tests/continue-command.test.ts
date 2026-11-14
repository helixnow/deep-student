/**
 * chat_v2_continue_message through the registered IPC command (send_message.rs:2010-2237).
 * The L06 TODO persistence/memory api is real (agent-orchestration/api.ts); only the L03
 * execute entry, the L02 model lookup and the VFS owners are provider doubles.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture } from './database-fixture.ts';
import { createSession } from '../repository/sessions.ts';
import { createMessage } from '../repository/messages.ts';
import { createBlock } from '../repository/blocks.ts';
import { newSession } from '../src/types.ts';
import { ChatV2Error, type BackendSendRequest, type ChatMessage } from '../api.ts';
import { getTodoList } from '../../agent-orchestration/api.ts';

// L06's executor TODO store is process-global: every test uses its own session id.
let sequence = 0;
let SESSION = '';
const cmdError = (kind: 'Validation' | 'Other' | 'MessageNotFound', value: string) => new ChatV2Error(kind, value).toCommandError();
const PENDING = '[{"id":"step_1","description":"Review","status":"completed","createdAt":10},{"id":"step_2","description":"Write","status":"pending","createdAt":11}]';
const DONE = '[{"id":"step_1","description":"Review","status":"completed","createdAt":10}]';

describe('send_message.rs chat_v2_continue_message', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let requests: { window: { window: string; webview: string }; request: BackendSendRequest; streaming: boolean }[];
  let logs: string[];
  beforeEach(async () => {
    f = databaseFixture(); requests = []; logs = []; SESSION = `sess_continue_${++sequence}`;
    host = await createTestHost({ plugins: [plugin], provide: {
      storage: f.storage,
      vfs: { version: 1, database: { getConnSafe: () => f.db } },
      chatPipeline: { execute: async (window: { window: string; webview: string }, request: BackendSendRequest) => {
        requests.push({ window: { window: window.window, webview: window.webview }, request,
          streaming: host.ctx.chatState.hasActiveStream(request.sessionId) });
        return request.assistantMessageId!;
      } },
      llm: {
        getApiConfigs: async () => [{ id: 'cfg_vision', model: 'vision', isMultimodal: true }],
        selectModelFor: async () => [{ isMultimodal: false }, false],
      },
      vfsRepo: { resources: { getByHash: () => null, getResource: () => null, incrementRef: () => 1, decrementRef: () => 0,
        decrementRefs: () => undefined } },
      agentVfsResolver: { resolveContextRefDataToBlocks: async () => [], resolveContextRefDataToContent: async () => ({ textContents: [], imageBase64List: [] }) },
    } });
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { logs.push(String(message.args[0])); } });
    createSession(f.db, newSession(SESSION, 'chat'));
  });
  afterEach(async () => { await host.ctx.chatState.shutdownTasks(1000); await host.dispose(); f.dispose(); });

  function message(id: string, role: 'user' | 'assistant', timestamp: number, content?: string, extra: Partial<ChatMessage> = {}): void {
    const blockIds = content === undefined ? [] : [`blk_${id}`];
    createMessage(f.db, { id, sessionId: SESSION, role, blockIds, timestamp, ...extra });
    if (content !== undefined) createBlock(f.db, { id: `blk_${id}`, messageId: id, type: 'content', status: 'success', content, blockIndex: 0 });
  }
  function todo(messageId: string, variantId: string | null, steps = PENDING): void {
    f.db.run(`INSERT INTO chat_v2_todo_lists
      (session_id, message_id, variant_id, todo_list_id, title, steps_json, is_all_done, created_at, updated_at)
      VALUES (?1, ?2, ?3, 'todo_c', 'Continue task', ?4, 0, 10, 20)`, [SESSION, messageId, variantId, steps]);
  }
  function variant(id: string, status: string) {
    const value = host.ctx.chatSession.newVariant('vision', 'cfg_vision', id);
    return { ...value, status };
  }
  const invoke = (messageId: string, variantId: string | null = null, options: Record<string, unknown> | null = null) =>
    host.invoke<string>('chat_v2_continue_message', { sessionId: SESSION, messageId, variantId, options });

  it('continues the persisted message on the persisted variant with the preceding user content', async () => {
    message('msg_u1', 'user', 1, 'question ');
    message('msg_a1', 'assistant', 2, 'partial', { variants: [variant('var_p', 'interrupted')], activeVariantId: 'var_p' });
    todo('msg_a1', 'var_p');
    expect(await invoke('msg_a1', null, { modelId: 'cfg_vision', temperature: 0.3 })).toBe('msg_a1');
    expect(getTodoList(SESSION)?.id).toBe('todo_c');
    await host.ctx.chatState.shutdownTasks(1000);
    expect(requests).toHaveLength(1);
    const { request, streaming, window } = requests[0]!;
    expect(streaming).toBe(true);
    expect(window).toEqual({ window: 'main', webview: 'main' });
    expect(request).toMatchObject({ sessionId: SESSION, content: 'question ', assistantMessageId: 'msg_a1',
      userMessageId: null, pathMap: null, workspaceId: null });
    expect(request.options).toEqual({ modelId: 'cfg_vision', temperature: Math.fround(0.3), isContinue: true, continueVariantId: 'var_p',
      streamGeneration: request.options!.streamGeneration });
    expect(typeof request.options!.streamGeneration).toBe('bigint');
    expect(host.ctx.chatState.hasActiveStream(SESSION)).toBe(false);
    expect(logs).toContain(`[ChatV2::handlers] chat_v2_continue_message: session_id=${SESSION}, message_id=msg_a1, variant_id=None`);
    expect(logs).toContain('[ChatV2::handlers] Found incomplete TODO list: id=todo_c, title=Continue task, progress=1/2');
    expect(logs).toContain('[ChatV2::handlers] Continue: model_id=Some("cfg_vision"), is_multimodal=true');
    expect(logs).toContain(`[ChatV2::handlers] Continue execution completed: session_id=${SESSION}, message_id=msg_a1`);
  });

  it('uses the persisted message id on mismatch, explicit variant first, and warns for a non-interrupted variant', async () => {
    message('msg_u1', 'user', 1, 'q');
    message('msg_a1', 'assistant', 2, 'partial', { variants: [variant('var_p', 'interrupted'), variant('var_x', 'error')], activeVariantId: 'var_p' });
    todo('msg_a1', 'var_p');
    expect(await invoke('msg_other', 'var_x')).toBe('msg_a1');
    await host.ctx.chatState.shutdownTasks(1000);
    expect(requests[0]!.request.assistantMessageId).toBe('msg_a1');
    expect(requests[0]!.request.options).toMatchObject({ isContinue: true, continueVariantId: 'var_x' });
    expect(logs).toContain('[ChatV2::handlers] Message ID mismatch: expected=msg_a1, got=msg_other');
    expect(logs).toContain("[ChatV2::handlers] Variant status is 'error', not 'interrupted'. Allowing continue anyway.");
  });

  it('falls back to the active variant when neither explicit nor persisted variant exists', async () => {
    message('msg_u1', 'user', 1, 'q');
    message('msg_a1', 'assistant', 2, 'partial', { variants: [variant('var_active', 'interrupted')], activeVariantId: 'var_active' });
    todo('msg_a1', null);
    await invoke('msg_a1');
    await host.ctx.chatState.shutdownTasks(1000);
    expect(requests[0]!.request.options).toMatchObject({ continueVariantId: 'var_active' });
  });

  it('rejects without an unfinished list, or when every step is done, before registering a stream', async () => {
    message('msg_u1', 'user', 1, 'q');
    message('msg_a1', 'assistant', 2, 'partial');
    await expect(invoke('msg_a1')).rejects.toBe(cmdError('Validation', 'No incomplete TODO list found. Cannot continue execution.'));
    todo('msg_a1', null, DONE);
    await expect(invoke('msg_a1')).rejects.toBe(cmdError('Validation', 'TODO list is already complete. No need to continue.'));
    expect(getTodoList(SESSION)).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('an active stream rejects before the TODO list is restored into executor memory', async () => {
    message('msg_u1', 'user', 1, 'q');
    message('msg_a1', 'assistant', 2, 'partial');
    todo('msg_a1', null);
    const held = host.ctx.chatState.tryRegisterStreamOwned(SESSION)!;
    try {
      await expect(invoke('msg_a1')).rejects.toBe(cmdError('Other', 'Session has an active stream. Please wait for completion or cancel first.'));
      expect(getTodoList(SESSION)).toBeNull();
    } finally { host.ctx.chatState.removeStreamIfGeneration(SESSION, held.generation); }
  });

  it('a failure after registration releases the stream (StreamGuard drop) but keeps the restored list', async () => {
    message('msg_a1', 'assistant', 2, 'partial');
    todo('msg_a1', null);
    await expect(invoke('msg_a1')).rejects.toContain('No preceding user message');
    expect(host.ctx.chatState.hasActiveStream(SESSION)).toBe(false);
    expect(getTodoList(SESSION)?.id).toBe('todo_c');
    expect(requests).toHaveLength(0);
  });

  it('a corrupt steps_json surfaces the Rust double-wrapped load error', async () => {
    message('msg_a1', 'assistant', 2, 'partial');
    todo('msg_a1', null, 'not json');
    await expect(invoke('msg_a1')).rejects.toContain('Failed to load TodoList: Failed to deserialize steps: ');
    expect(host.ctx.chatState.hasActiveStream(SESSION)).toBe(false);
  });
});
