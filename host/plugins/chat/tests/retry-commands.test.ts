/**
 * chat_v2_retry_message / chat_v2_edit_and_resend through the registered IPC
 * commands (send_message.rs:919-1698 and its #[cfg(test)] module). Only the L03
 * execute entry (not yet on main) and the VFS owners are provider doubles; the
 * chat plugin, its database and stream state are real.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture } from './database-fixture.ts';
import { createSession } from '../repository/sessions.ts';
import { createMessage, getMessage, getSessionMessages } from '../repository/messages.ts';
import { createBlock, getBlock } from '../repository/blocks.ts';
import { createCompaction, getActiveCompaction, setSessionLastCompaction } from '../repository/compactions.ts';
import { newSession } from '../src/types.ts';
import { ChatV2Error, type BackendSendRequest, type ChatMessage, type MessageMeta } from '../api.ts';
import { KILL_SWITCH_BLOCKED_MESSAGE } from '../src/state.ts';
import { applyOriginalSkillSnapshotOverrides } from '../src/context-restore.ts';
import type { SendContextRef, SendOptions } from '../../../../contracts/ipc/generated/_shared.ts';
import type { VfsContextRefData } from '../../agent-workspace/api.ts';

const SESSION = 'sess_retry';
const cmdError = (kind: ConstructorParameters<typeof ChatV2Error>[0], value?: string) =>
  (value === undefined ? new ChatV2Error(kind as 'Cancelled') : new ChatV2Error(kind as 'Other', value)).toCommandError();

describe('send_message.rs retry / edit_and_resend production commands', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let requests: { request: BackendSendRequest; signal: AbortSignal; streaming: boolean }[];
  let execute: (request: BackendSendRequest) => Promise<string>;
  let resources: Map<string, { id: string; hash: string; data?: string }>;
  let resolved: { data: VfsContextRefData; multimodal: boolean }[];
  let refCalls: unknown[][];
  let cancelled: [string, string[]][];
  let logs: string[];
  let variantCalls: { args: unknown[]; options: SendOptions; signal: AbortSignal; session: boolean; cancelKey: boolean }[];
  let variantExecute: () => Promise<void>;
  let batchCalls: { args: unknown[]; options: SendOptions; session: boolean; state: unknown }[];
  beforeEach(async () => {
    f = databaseFixture(); requests = []; resources = new Map(); resolved = []; refCalls = []; cancelled = []; logs = [];
    execute = async request => request.assistantMessageId!;
    variantCalls = []; variantExecute = async () => undefined; batchCalls = [];
    host = await createTestHost({ plugins: [plugin], provide: {
      storage: f.storage,
      vfs: { version: 1, database: { getConnSafe: () => f.db } },
      chatPipeline: { execute: async (_window: unknown, request: BackendSendRequest, signal: AbortSignal) => {
        requests.push({ request, signal, streaming: host.ctx.chatState.hasActiveStream(request.sessionId) });
        return execute(request);
      },
      executeVariantRetry: async (...args: unknown[]) => {
        const sessionId = args[1] as string; const variantId = args[3] as string;
        variantCalls.push({ args: args.slice(1, 8), options: args[8] as SendOptions, signal: args[9] as AbortSignal,
          session: host.ctx.chatState.hasActiveStream(sessionId), cancelKey: host.ctx.chatState.hasActiveStream(`${sessionId}:${variantId}`) });
        await variantExecute();
      },
      executeVariantsRetryBatch: async (...args: unknown[]) => {
        batchCalls.push({ args: args.slice(1, 7), options: args[7] as SendOptions,
          session: host.ctx.chatState.hasActiveStream(args[1] as string), state: args[9] });
      } },
      llm: {
        getApiConfigs: async () => [{ id: 'cfg_vision', model: 'vision', isMultimodal: true }],
        selectModelFor: async () => [{ isMultimodal: false }, false],
      },
      vfsRepo: { resources: {
        getByHash: (_conn: unknown, hash: string) => [...resources.values()].find(r => r.hash === hash) ?? null,
        getResource: (_conn: unknown, id: string) => resources.get(id) ?? null,
        incrementRef: () => 1, decrementRef: () => 0,
        decrementRefs: (_conn: unknown, ids: string[]) => { refCalls.push(['decrementMany', [...ids]]); },
      } },
      agentVfsResolver: { resolveContextRefDataToBlocks: async (data: VfsContextRefData, multimodal: boolean) => {
        resolved.push({ data: structuredClone(data), multimodal });
        return data.refs.map(ref => ({ type: 'text', text: `resolved:${ref.name}` }));
      },
      resolveContextRefDataToContent: async (data: VfsContextRefData, multimodal: boolean) => {
        resolved.push({ data: structuredClone(data), multimodal });
        return { textContents: data.refs.map(ref => `text:${ref.name}`), imageBase64List: ['aW1n'] };
      } },
      agentSubagent: { cancelWorkersDispatchedIn: (sessionId: string, ids: string[]) => { cancelled.push([sessionId, [...ids]]); } },
    } });
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { logs.push(String(message.args[0])); } });
    createSession(f.db, newSession(SESSION, 'chat'));
  });
  afterEach(async () => { await host.ctx.chatState.shutdownTasks(1000); await host.dispose(); f.dispose(); });

  function message(id: string, role: 'user' | 'assistant', timestamp: number, meta?: MessageMeta, content?: string): ChatMessage {
    const blockIds = content === undefined ? [] : [`blk_${id}`];
    const value: ChatMessage = { id, sessionId: SESSION, role, blockIds, timestamp, ...(meta ? { _meta: meta } : {}) };
    createMessage(f.db, value);
    if (content !== undefined) createBlock(f.db, { id: `blk_${id}`, messageId: id, type: 'content', status: 'success', content, blockIndex: 0 });
    return value;
  }
  async function drain() { await host.ctx.chatState.shutdownTasks(1000); }
  function retry(options?: SendOptions | null, messageId = 'msg_a1') {
    return host.invoke<{ message_id: string; deleted_message_ids?: string[] }>('chat_v2_retry_message',
      { sessionId: SESSION, messageId, options: options ?? null });
  }
  function sendRef(resourceId: string): SendContextRef {
    return { resourceId, hash: `hash_${resourceId}`, typeId: 'file', formattedBlocks: [{ type: 'text', text: 'test' }] };
  }

  it('is not registered without the L03 execute entry', async () => {
    const g = databaseFixture();
    const bare = await createTestHost({ plugins: [plugin], provide: { storage: g.storage, vfs: { version: 1, database: { getConnSafe: () => g.db } },
      chatPipeline: {}, llm: {}, vfsRepo: { resources: {} }, agentVfsResolver: {} } });
    try {
      await expect(bare.invoke('chat_v2_retry_message', { sessionId: SESSION, messageId: 'msg_x' })).rejects.toContain('Command not found');
      await expect(bare.invoke('chat_v2_edit_and_resend', { sessionId: SESSION, messageId: 'msg_x', newContent: 'x' })).rejects.toContain('Command not found');
    } finally { await bare.dispose(); g.dispose(); }
  });

  it('retry rewinds from the assistant message, keeps its id and replays the preceding user content', async () => {
    message('msg_u1', 'user', 1, { contextSnapshot: { userRefs: [{ resourceId: 'res_old', hash: 'h_old', typeId: 'note' }] } }, 'hello ');
    message('msg_a1', 'assistant', 2, undefined, 'answer');
    message('msg_u2', 'user', 3, { contextSnapshot: { userRefs: [{ resourceId: 'res_late', hash: 'h_late', typeId: 'note' }] } }, 'later');
    message('msg_a2', 'assistant', 4);
    expect(await retry({ modelId: 'cfg_vision', replayMode: 'current', temperature: 0.7, skipUserMessageSave: false }))
      .toEqual({ message_id: 'msg_a1', deleted_message_ids: ['msg_a1', 'msg_u2', 'msg_a2'] });
    expect(getSessionMessages(f.db, SESSION).map(m => m.id)).toEqual(['msg_u1']);
    expect(getBlock(f.db, 'blk_msg_a1')).toBeNull();
    expect(cancelled).toEqual([[SESSION, ['msg_a1', 'msg_u2', 'msg_a2']]]);
    expect(refCalls).toEqual([['decrementMany', ['res_late']]]);
    await drain();
    expect(requests).toHaveLength(1);
    const { request, streaming } = requests[0]!;
    expect(streaming).toBe(true);
    expect(request).toMatchObject({ sessionId: SESSION, content: 'hello ', userMessageId: null, assistantMessageId: 'msg_a1',
      userContextRefs: [], pathMap: null, workspaceId: null });
    expect(request.options).toEqual({ modelId: 'cfg_vision', replayMode: 'current', temperature: 0, skipUserMessageSave: true,
      streamGeneration: request.options!.streamGeneration });
    expect(typeof request.options!.streamGeneration).toBe('bigint');
    expect(host.ctx.chatState.hasActiveStream(SESSION)).toBe(false);
    expect(logs).toContain('[ChatV2::handlers] Retry: model_id=Some("cfg_vision"), is_multimodal=true');
    expect(logs).toContain('[ChatV2::handlers] Failed to restore context ref (resource not found): resource_id=res_old');
    expect(logs).toContain('[ChatV2::handlers] Retry pipeline completed: session_id=sess_retry, assistant_message_id=msg_a1');
  });

  it('retry validates writable, existence, role and admission before any destructive step', async () => {
    message('msg_u1', 'user', 1, undefined, 'q');
    message('msg_a1', 'assistant', 2);
    await expect(retry(null, 'msg_missing')).rejects.toBe(cmdError('MessageNotFound', 'msg_missing'));
    await expect(retry(null, 'msg_u1')).rejects.toBe(cmdError('Validation',
      'Retry is only for assistant messages. Use edit_and_resend for user messages.'));
    host.ctx.chatState.registerStream(SESSION);
    await expect(retry()).rejects.toBe(cmdError('Other', 'Session has an active stream. Please wait for completion or cancel first.'));
    host.ctx.chatState.cancelStream(SESSION);
    host.ctx.chatState.killSwitch.trip('stop');
    await expect(retry()).rejects.toBe(cmdError('Other', KILL_SWITCH_BLOCKED_MESSAGE));
    host.ctx.chatState.killSwitch.reset();
    expect(getSessionMessages(f.db, SESSION)).toHaveLength(2);
    expect(requests).toHaveLength(0);
  });

  it('retry releases only its own registration when preprocessing fails', async () => {
    message('msg_a1', 'assistant', 2);
    await expect(retry()).rejects.toBe(cmdError('Other', 'No preceding user message found'));
    expect(host.ctx.chatState.hasActiveStream(SESSION)).toBe(false);
    message('msg_u0', 'user', 1);
    await expect(retry()).rejects.toBe(cmdError('Other', 'Message has no content blocks'));
    expect(host.ctx.chatState.hasActiveStream(SESSION)).toBe(false);
    expect(getMessage(f.db, 'msg_a1')).not.toBeNull();
  });

  it('retry restores context refs from the VFS snapshot with inject modes and staged metadata', async () => {
    resources.set('res_ref', { id: 'res_ref', hash: 'h_ref', data: JSON.stringify({ refs: [
      { sourceId: 'note_1', resourceHash: 'rh', type: 'note', name: 'Note 1' }] }) });
    resources.set('res_legacy', { id: 'res_legacy', hash: 'h_legacy', data: 'plain text' });
    message('msg_u1', 'user', 1, { contextSnapshot: {
      userRefs: [
        { resourceId: 'res_ref', hash: 'h_ref', typeId: 'note', injectModes: { image: ['ocr'] } },
        { resourceId: 'res_legacy', hash: 'h_legacy', typeId: 'note', displayName: '旧笔记' },
      ],
      pathMap: { res_ref: '/a', '__staged_attachment__:res_ref:0': '{"page":1}', other: '/b' },
    } }, 'q');
    message('msg_a1', 'assistant', 2);
    await retry();
    await drain();
    expect(resolved).toEqual([{ multimodal: false, data: { refs: [{ sourceId: 'note_1', resourceHash: 'rh', type: 'note', name: 'Note 1',
      injectModes: { image: ['ocr'] } }], truncated: false, totalCount: 0 } }]);
    expect(requests[0]!.request.userContextRefs).toEqual([
      { resourceId: 'res_ref', hash: 'h_ref', typeId: 'note', displayName: null, injectModes: { image: ['ocr'] }, formattedBlocks: [
        { type: 'text', text: 'resolved:Note 1' }, { type: 'text', text: '<attachment_metadata>[{"page":1}]</attachment_metadata>' }] },
      { resourceId: 'res_legacy', hash: 'h_legacy', typeId: 'note', displayName: '旧笔记', injectModes: null, formattedBlocks: [
        { type: 'text', text: '[旧版上下文引用已忽略: 旧笔记]' }] },
    ]);
    expect(requests[0]!.request.pathMap).toEqual({ res_ref: '/a', '__staged_attachment__:res_ref:0': '{"page":1}' });
    expect(logs).toContain('[ChatV2::handlers] Retry with restored context refs: count=2');
  });

  // ---- send_message.rs::tests::test_filter_path_map_for_send_refs_* via edit_and_resend ----
  async function editPathMap(refs: SendContextRef[] | null, pathMap: Record<string, string> | null) {
    message('msg_u1', 'user', 1, undefined, 'q');
    await host.invoke('chat_v2_edit_and_resend', { sessionId: SESSION, messageId: 'msg_u1', newContent: 'new',
      newContextRefs: refs, newPathMap: pathMap });
    await drain();
    return requests.at(-1)!.request.pathMap;
  }
  it('test_filter_path_map_for_send_refs_returns_none_when_path_map_missing', async () => {
    expect(await editPathMap([sendRef('res_1')], null)).toBeNull();
  });
  it('test_filter_path_map_for_send_refs_returns_none_when_refs_missing_or_empty', async () => {
    expect(await editPathMap([], { res_1: '/tmp/a.pdf' })).toBeNull();
  });
  it('test_filter_path_map_for_send_refs_keeps_only_matched_resource_ids', async () => {
    expect(await editPathMap([sendRef('res_1'), sendRef('res_3')], { res_1: '/tmp/a.pdf', res_2: '/tmp/b.pdf', res_3: '/tmp/c.pdf' }))
      .toEqual({ res_1: '/tmp/a.pdf', res_3: '/tmp/c.pdf' });
  });
  it('test_filter_path_map_for_send_refs_returns_none_when_no_match', async () => {
    expect(await editPathMap([sendRef('res_2')], { res_1: '/tmp/a.pdf' })).toBeNull();
  });

  // ---- send_message.rs::tests::test_apply_original_skill_snapshot_* via retry ----
  async function retryOptions(options: SendOptions & { executionAllowedTools?: string[] }, assistantMeta?: MessageMeta, userMeta?: MessageMeta) {
    message('msg_u1', 'user', 1, userMeta, 'q');
    message('msg_a1', 'assistant', 2, assistantMeta);
    await retry(options);
    await drain();
    return requests.at(-1)!.request.options!;
  }
  it('test_apply_original_skill_snapshot_overrides_restores_manual_pins_only', async () => {
    const updated = await retryOptions({ replayMode: 'original' }, { skillSnapshotAfter: { version: 0,
      manualPinnedSkillIds: ['manual-a'], modeRequiredBundleIds: ['mode-a'], agenticSessionSkillIds: ['agentic-a'],
      branchLocalSkillIds: ['branch-a'], effectiveAllowedExternalServers: ['server-a'] } });
    expect(updated.activeSkillIds).toEqual(['manual-a']);
    expect(updated.executionAllowedTools).toBeUndefined();
    expect(updated.mcpTools).toEqual(['server-a']);
  });
  it('test_apply_original_skill_snapshot_overrides_restores_runtime_skill_payload', async () => {
    // Stored meta drops private skill bodies (types.rs normalized_for_storage), so this Rust unit
    // test of the pure override is ported against the exported function used by the commands.
    const updated = applyOriginalSkillSnapshotOverrides({ replayMode: 'original' }, { skillRuntimeAfter: {
      activeSkillIds: ['runtime-skill'], executionAllowedTools: ['builtin-runtime_tool'],
      skillContents: { 'runtime-skill': 'runtime body' }, skillDependencies: { 'runtime-skill': ['dep-a'] },
      skillEmbeddedTools: {}, mcpToolSchemas: [{ name: 'fetch', serverId: 'server-a', description: 'fetch from server a', inputSchema: { type: 'object' } }],
      selectedMcpServers: ['server-a'] } }, null);
    expect(updated.activeSkillIds).toEqual(['runtime-skill']);
    expect(updated.executionAllowedTools).toEqual(['builtin-runtime_tool']);
    expect(updated.skillContents?.['runtime-skill']).toBe('runtime body');
    expect(updated.replaySkillContents?.['runtime-skill']).toBe('runtime body');
    expect(updated.skillDependencies?.['runtime-skill']).toEqual(['dep-a']);
    expect(updated.mcpTools).toEqual(['server-a']);
    expect(updated.mcpToolSchemas?.[0]?.serverId).toBe('server-a');
    // Same payload through retry: everything except the dropped bodies reaches L03.
    const viaRetry = await retryOptions({ replayMode: 'original' }, { skillRuntimeAfter: {
      activeSkillIds: ['runtime-skill'], executionAllowedTools: ['builtin-runtime_tool'],
      skillContents: { 'runtime-skill': 'runtime body' }, skillDependencies: { 'runtime-skill': ['dep-a'] },
      selectedMcpServers: ['server-a'] } });
    expect(viaRetry).toMatchObject({ activeSkillIds: ['runtime-skill'], executionAllowedTools: ['builtin-runtime_tool'],
      skillDependencies: { 'runtime-skill': ['dep-a'] }, mcpTools: ['server-a'] });
    expect(viaRetry.skillContents).toBeUndefined();
  });
  it('test_apply_original_skill_snapshot_preserves_current_admission_projection', async () => {
    const schema = { name: 'builtin-revoked_tool', serverId: null, description: 'historical schema', inputSchema: { type: 'object' } };
    const updated = await retryOptions({ replayMode: 'original', activeSkillIds: ['currently-trusted'],
      executionAllowedTools: ['builtin-current_tool'], skillAdmissionErrors: { 'revoked-skill': 'untrusted: revoked' } },
    { skillRuntimeAfter: { activeSkillIds: ['revoked-skill'], executionAllowedTools: ['builtin-revoked_tool'],
      skillEmbeddedTools: { 'revoked-skill': [schema] }, mcpToolSchemas: [schema] } });
    expect(updated.activeSkillIds).toEqual(['currently-trusted']);
    expect(updated.executionAllowedTools).toEqual(['builtin-current_tool']);
    expect(updated.skillEmbeddedTools).toBeUndefined();
    expect(updated.mcpToolSchemas).toBeUndefined();
  });
  it('test_apply_original_skill_snapshot_overrides_keeps_current_replay_unchanged', async () => {
    const updated = await retryOptions({ replayMode: 'current', activeSkillIds: ['current-skill'] },
      { skillRuntimeAfter: { activeSkillIds: ['historical-skill'] } });
    expect(updated.activeSkillIds).toEqual(['current-skill']);
  });
  it('test_apply_original_skill_snapshot_overrides_prefers_preferred_meta_over_fallback', async () => {
    const updated = await retryOptions({ replayMode: 'original' },
      { skillRuntimeAfter: { activeSkillIds: ['variant-skill'] } }, { skillRuntimeAfter: { activeSkillIds: ['message-skill'] } });
    expect(updated.activeSkillIds).toEqual(['variant-skill']);
  });
  it('test_apply_original_skill_snapshot_overrides_preserves_explicit_empty_execution_allowed_tools', async () => {
    const updated = await retryOptions({ replayMode: 'original', executionAllowedTools: ['current-tool'] },
      { skillRuntimeAfter: { activeSkillIds: ['instruction-only'], executionAllowedTools: [] } });
    expect(updated.executionAllowedTools).toEqual([]);
  });
  it('test_apply_original_skill_snapshot_overrides_does_not_invent_empty_policy_for_legacy_meta', async () => {
    const updated = await retryOptions({ replayMode: 'original', executionAllowedTools: ['current-tool'] },
      { skillSnapshotAfter: { version: 0, manualPinnedSkillIds: ['legacy-skill'] } });
    expect(updated.executionAllowedTools).toEqual(['current-tool']);
  });

  it('edit_and_resend rewrites content, invalidates compaction, keeps the user message and rewinds the tail', async () => {
    message('msg_u1', 'user', 1, { contextSnapshot: { userRefs: [{ resourceId: 'res_keep', hash: 'h', typeId: 'note' }] } }, 'old');
    message('msg_a1', 'assistant', 2, { contextSnapshot: { retrievalRefs: [{ resourceId: 'res_r', hash: 'h_r', typeId: 'retrieval' }] } });
    message('msg_s', 'assistant', 0);
    createCompaction(f.db, { id: 'cmp_1', sessionId: SESSION, summaryMessageId: 'msg_s', tailStartMessageId: 'msg_u1',
      tailStartTimeCreated: 1, reason: 'overflow', isAuto: false, isOverflow: true, tokensBefore: null, tokensAfter: null,
      modelId: null, modelConfigId: null, previousCompactionId: null, rangeStartMessageId: 'msg_s',
      rangeEndMessageId: 'msg_s', compactedMessageCount: 1, createdAt: 3 });
    setSessionLastCompaction(f.db, SESSION, 'cmp_1');
    f.db.run('UPDATE chat_v2_blocks SET llm_content = ? WHERE id = ?', ['<user_query>old</user_query>', 'blk_msg_u1']);
    const result = await host.invoke<{ new_message_id: string; deleted_message_ids?: string[] }>('chat_v2_edit_and_resend',
      { sessionId: SESSION, messageId: 'msg_u1', newContent: 'new text', newContextRefs: [], options: { modelId: 'm' } });
    expect(result.new_message_id).toMatch(/^msg_/);
    expect(result.deleted_message_ids).toEqual(['msg_a1']);
    expect(getBlock(f.db, 'blk_msg_u1')?.content).toBe('new text');
    expect(f.db.pluck('SELECT llm_content FROM chat_v2_blocks WHERE id = ?', ['blk_msg_u1'])).toBeNull();
    expect(getMessage(f.db, 'msg_u1')?._meta?.contextSnapshot).toBeUndefined();
    expect(getActiveCompaction(f.db, SESSION)).toBeNull();
    expect(refCalls).toEqual([['decrementMany', ['res_r']]]);
    await drain();
    expect(requests[0]!.request).toMatchObject({ content: 'new text', userMessageId: 'msg_u1',
      assistantMessageId: result.new_message_id, userContextRefs: [], pathMap: null });
    expect(requests[0]!.request.options).toMatchObject({ modelId: 'm', skipUserMessageSave: true });
  });

  it('edit_and_resend persists new refs into the user snapshot with the filtered path map', async () => {
    message('msg_u1', 'user', 1, undefined, 'old');
    await host.invoke('chat_v2_edit_and_resend', { sessionId: SESSION, messageId: 'msg_u1', newContent: 'x',
      newContextRefs: [{ ...sendRef('res_1'), displayName: 'A', injectModes: { pdf: ['text'] } }],
      newPathMap: { res_1: '/a', res_2: '/b' } });
    expect(getMessage(f.db, 'msg_u1')?._meta?.contextSnapshot).toEqual({
      userRefs: [{ resourceId: 'res_1', hash: 'hash_res_1', typeId: 'file', displayName: 'A', injectModes: { pdf: ['text'] } }],
      pathMap: { res_1: '/a' } });
    expect(logs).toContain('[ChatV2::handlers] Edit and resend with NEW context refs: count=1');
  });

  it('edit_and_resend validation order matches Rust', async () => {
    message('msg_u1', 'user', 1, undefined, 'q');
    message('msg_a1', 'assistant', 2);
    createSession(f.db, newSession('sess_other', 'chat'));
    const edit = (args: Record<string, unknown>) => host.invoke('chat_v2_edit_and_resend', { sessionId: SESSION, messageId: 'msg_u1', newContent: 'x', ...args });
    await expect(edit({ newContent: ' 　 ' })).rejects.toBe(cmdError('Validation', 'New content cannot be empty'));
    await expect(edit({ messageId: 'msg_nope' })).rejects.toBe(cmdError('MessageNotFound', 'msg_nope'));
    await expect(edit({ messageId: 'msg_a1' })).rejects.toBe(cmdError('Validation', 'Can only edit user messages'));
    await expect(edit({ sessionId: 'sess_other' })).rejects.toBe(cmdError('Validation', 'Message msg_u1 does not belong to session sess_other'));
    host.ctx.chatState.registerStream(SESSION);
    await expect(edit({})).rejects.toBe(cmdError('Other', 'Session has an active stream. Please wait for completion or cancel first.'));
    host.ctx.chatState.cancelStream(SESSION);
    expect(getBlock(f.db, 'blk_msg_u1')?.content).toBe('q');
    expect(requests).toHaveLength(0);
  });

  it('pipeline errors and cancellation are logged and always release the generation', async () => {
    message('msg_u1', 'user', 1, undefined, 'q');
    message('msg_a1', 'assistant', 2);
    execute = async () => { throw new ChatV2Error('Cancelled'); };
    await retry();
    await drain();
    expect(logs).toContain('[ChatV2::handlers] Retry pipeline cancelled: session_id=sess_retry');
    expect(host.ctx.chatState.hasActiveStream(SESSION)).toBe(false);
    execute = async () => { throw new ChatV2Error('Llm', 'boom'); };
    await host.invoke('chat_v2_edit_and_resend', { sessionId: SESSION, messageId: 'msg_u1', newContent: 'again' });
    await drain();
    expect(logs).toContain('[ChatV2::handlers] Edit and resend pipeline error: session_id=sess_retry, error=LLM error: boom');
    expect(host.ctx.chatState.hasActiveStream(SESSION)).toBe(false);
  });

  // ---- variant_handlers.rs retry_variant_impl ----
  function variantMessage(status: string, extra: Partial<ChatMessage> = {}) {
    message('msg_u1', 'user', 1, undefined, 'question');
    const value: ChatMessage = { id: 'msg_a1', sessionId: SESSION, role: 'assistant', blockIds: ['blk_v1', 'blk_keep'], timestamp: 2,
      activeVariantId: 'var_1', variants: [
        { id: 'var_1', modelId: 'Model One', configId: 'cfg_one', blockIds: ['blk_v1'], status, error: 'old failure', createdAt: 1 },
        { id: 'var_2', modelId: 'Model Two', blockIds: ['blk_keep'], status: 'success', createdAt: 1 }], ...extra };
    createMessage(f.db, value);
    createBlock(f.db, { id: 'blk_v1', messageId: 'msg_a1', type: 'content', status: 'error', content: 'x', blockIndex: 0 });
    createBlock(f.db, { id: 'blk_keep', messageId: 'msg_a1', type: 'content', status: 'success', content: 'y', blockIndex: 1 });
  }
  const retryVariant = (args: Record<string, unknown> = {}) => host.invoke('chat_v2_retry_variant',
    { sessionId: SESSION, messageId: 'msg_a1', variantId: 'var_1', ...args });

  it('retry_variant resets the variant, awaits L03 with the session and cancel-key registrations, then releases both', async () => {
    variantMessage('error', { _meta: { chatParams: { temperature: 0.3, maxTokens: 512, enableThinking: true } },
      sharedContext: undefined });
    expect(await retryVariant()).toBeNull();
    const stored = getMessage(f.db, 'msg_a1')!;
    expect(stored.blockIds).toEqual(['blk_keep']);
    expect(stored.variants![0]).toEqual({ id: 'var_1', modelId: 'cfg_one', configId: 'cfg_one', blockIds: [], status: 'pending', createdAt: 1 });
    expect(getBlock(f.db, 'blk_v1')).toBeNull();
    expect(variantCalls).toHaveLength(1);
    const call = variantCalls[0]!;
    expect(call.args).toEqual([SESSION, 'msg_a1', 'var_1', 'cfg_one', 'question', [], {}]);
    expect(call.options).toEqual({ modelId: 'cfg_one', model2OverrideId: 'cfg_one', temperature: 0.3, maxTokens: 512,
      enableThinking: true, streamGeneration: (call.options as { streamGeneration: bigint }).streamGeneration });
    expect(call.session && call.cancelKey).toBe(true);
    expect(host.ctx.chatState.hasActiveStream(SESSION)).toBe(false);
    expect(host.ctx.chatState.hasActiveStream(`${SESSION}:var_1`)).toBe(false);
  });

  it('retry_variant validation order and errors match Rust', async () => {
    variantMessage('success');
    createSession(f.db, newSession('sess_other', 'chat'));
    await expect(retryVariant({ messageId: 'msg_none' })).rejects.toBe(cmdError('MessageNotFound', 'msg_none'));
    await expect(retryVariant({ sessionId: 'sess_other' })).rejects.toBe(cmdError('Validation',
      'Permission denied: cannot retry variant for message in another session'));
    await expect(retryVariant({ messageId: 'msg_u1' })).rejects.toBe(cmdError('Validation', 'Can only retry variants on assistant messages'));
    await expect(retryVariant({ variantId: 'var_x' })).rejects.toBe(cmdError('VariantNotFound', 'var_x'));
    await expect(retryVariant()).rejects.toBe(new ChatV2Error('VariantCannotRetry', ['var_1', 'success']).toCommandError());
    host.ctx.chatState.registerStream(SESSION);
    await expect(retryVariant()).rejects.toBe(cmdError('Other',
      'Cannot retry variant while session is streaming. Please wait for completion or cancel first.'));
    host.ctx.chatState.cancelStream(SESSION);
    expect(variantCalls).toHaveLength(0);
    expect(getBlock(f.db, 'blk_v1')).not.toBeNull();
  });

  it('retry_variant uses the override model, restores snapshot text/images and the sources shared context', async () => {
    resources.set('res_ref', { id: 'res_ref', hash: 'h_ref', data: JSON.stringify({ refs: [
      { sourceId: 'n1', resourceHash: 'rh', type: 'note', name: 'N' }] }) });
    resources.set('res_note', { id: 'res_note', hash: 'h_note', data: 'inline body', metadata: { title: '笔记' } } as never);
    createMessage(f.db, { id: 'msg_u1', sessionId: SESSION, role: 'user', blockIds: ['blk_u'], timestamp: 1,
      attachments: [{ id: 'att_1', name: 'a.txt', type: 'document', mimeType: 'text/plain', size: 2, status: 'ready',
        previewUrl: `data:text/plain;base64,${Buffer.from('hi').toString('base64')}` }],
      _meta: { contextSnapshot: { userRefs: [{ resourceId: 'res_ref', hash: 'h_ref', typeId: 'note' },
        { resourceId: 'res_note', hash: 'h_note', typeId: 'note' }] } } });
    createBlock(f.db, { id: 'blk_u', messageId: 'msg_u1', type: 'content', status: 'success', content: 'Q', blockIndex: 0 });
    createMessage(f.db, { id: 'msg_a1', sessionId: SESSION, role: 'assistant', blockIds: [], timestamp: 2,
      _meta: { sources: { rag: [{ title: 'r' }] } },
      variants: [{ id: 'var_1', modelId: 'm', blockIds: [], status: 'cancelled', createdAt: 1 }] });
    await retryVariant({ modelOverride: 'cfg_vision', options: { modelId: 'ignored', parallelModelIds: ['a', 'b'], replayMode: 'current', temperature: 1 } });
    expect(resolved).toEqual([{ multimodal: true, data: { refs: [{ sourceId: 'n1', resourceHash: 'rh', type: 'note', name: 'N' }], truncated: false, totalCount: 0 } }]);
    const call = variantCalls[0]!;
    expect(call.args[3]).toBe('cfg_vision');
    expect(call.args[4]).toBe('text:N\n\n<injected_context>\n[笔记]\ninline body\n</injected_context>\n\n---\n\nQ');
    expect(call.args[5]).toEqual([
      { name: 'a.txt', mimeType: 'text/plain', base64Content: null, textContent: 'hi', metadata: null },
      { name: 'context_image_1', mimeType: 'image/png', base64Content: 'aW1n', textContent: null, metadata: null }]);
    expect(call.args[6]).toEqual({ ragSources: [{ title: 'r' }], memorySources: null, graphSources: null, webSearchSources: null,
      multimodalSources: null, ragBlockId: null, memoryBlockId: null, graphBlockId: null, webSearchBlockId: null, multimodalBlockId: null });
    expect(call.options).toMatchObject({ modelId: 'cfg_vision', model2OverrideId: 'cfg_vision', parallelModelIds: null, temperature: 0 });
  });

  it('retry_variant propagates the awaited pipeline error and still releases both registrations', async () => {
    variantMessage('error');
    variantExecute = async () => { throw new ChatV2Error('Llm', 'variant failed'); };
    await expect(retryVariant()).rejects.toBe(cmdError('Llm', 'variant failed'));
    expect(host.ctx.chatState.hasActiveStream(SESSION)).toBe(false);
    expect(host.ctx.chatState.hasActiveStream(`${SESSION}:var_1`)).toBe(false);
  });

  // ---- variant_handlers.rs retry_variants_impl ----
  it('retry_variants dedups ids, allows success variants, resets them and awaits the batch entry under the session lock', async () => {
    variantMessage('error');
    expect(await host.invoke('chat_v2_retry_variants', { sessionId: SESSION, messageId: 'msg_a1',
      variantIds: ['var_2', 'var_1', 'var_2'] })).toBeNull();
    const stored = getMessage(f.db, 'msg_a1')!;
    expect(stored.blockIds).toEqual([]);
    expect(stored.variants!.map(v => [v.id, v.status, v.blockIds, v.modelId, v.error])).toEqual([
      ['var_1', 'pending', [], 'Model One', undefined], ['var_2', 'pending', [], 'Model Two', undefined]]);
    expect(batchCalls).toHaveLength(1);
    const call = batchCalls[0]!;
    expect(call.args).toEqual([SESSION, 'msg_a1', [
      { variantId: 'var_2', modelId: 'Model Two', configId: 'Model Two', isMultimodal: false, meta: null },
      { variantId: 'var_1', modelId: 'Model One', configId: 'cfg_one', isMultimodal: false, meta: null }],
    'question', [], {}]);
    expect(call.options).toMatchObject({ modelId: 'Model Two', model2OverrideId: 'Model Two' });
    expect(call.session).toBe(true);
    expect(call.state).toBe(host.ctx.chatState);
    expect(host.ctx.chatState.hasActiveStream(SESSION)).toBe(false);
  });

  it('retry_variants validation matches Rust', async () => {
    variantMessage('streaming');
    const batch = (args: Record<string, unknown>) => host.invoke('chat_v2_retry_variants', { sessionId: SESSION, messageId: 'msg_a1', variantIds: ['var_2'], ...args });
    await expect(batch({ variantIds: [] })).rejects.toBe(cmdError('Validation', 'No variant IDs provided for retry'));
    await expect(batch({ messageId: 'msg_none' })).rejects.toBe(cmdError('MessageNotFound', 'msg_none'));
    createSession(f.db, newSession('sess_other', 'chat'));
    await expect(batch({ sessionId: 'sess_other' })).rejects.toBe(cmdError('Validation',
      'Permission denied: cannot retry variants for message in another session'));
    await expect(batch({ variantIds: ['var_x'] })).rejects.toBe(cmdError('VariantNotFound', 'var_x'));
    await expect(batch({ variantIds: ['var_2', 'var_1'] })).rejects.toBe(cmdError('VariantAlreadyStreaming', 'var_1'));
    host.ctx.chatState.registerStream(SESSION);
    await expect(batch({})).rejects.toBe(cmdError('Other',
      'Cannot retry variants while session is streaming. Please wait for completion or cancel first.'));
    host.ctx.chatState.cancelStream(SESSION);
    expect(batchCalls).toHaveLength(0);
    expect(getBlock(f.db, 'blk_keep')).not.toBeNull();
  });
});
