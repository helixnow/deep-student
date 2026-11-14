import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { createSession, getSession, updateSession } from '../repository/sessions.ts';
import { createMessage, getMessage } from '../repository/messages.ts';
import { createBlock, getBlock, updateBlock, upsertStreamingBlock, type StoredBlock } from '../repository/blocks.ts';
import { newSession } from '../src/types.ts';
import { insertGoal } from '../repository/goals.ts';
import { getGoal } from '../repository/goals.ts';
import { createGroup, getGroup } from '../repository/groups.ts';
import { createCompaction, getActiveCompaction, setSessionLastCompaction } from '../repository/compactions.ts';
import { advanceToolFacePrefix, freezeAvailableSkillsSnapshot, markAvailableSkillsSnapshotStale,
  setMicrocompactAnchor } from '../src/session-metadata.ts';
import { ChatV2State } from '../api.ts';
import { ChatV2Error } from '../api.ts';
import type { ChatV2ErrorData } from '../api.ts';
import type { ChatSession, CopyBlockContentResponse, LoadMessagesPageResponse, LoadSessionResponse } from '../api.ts';

function superMetadata(workspaceId: string): Record<string, unknown> {
  return {
    super_agent: { active: true, version: 1, workspace_id: workspaceId, hidden: false },
    pinned: true,
  };
}

function commandError(kind: keyof ChatV2ErrorData, data: string): string {
  const ErrorClass = ChatV2Error as unknown as new (kind: string, data: string) => ChatV2Error;
  return new ErrorClass(kind, data).toCommandError();
}

describe('chat_v2 session and block commands', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let clearedApprovals: string[];
  beforeEach(async () => {
    f = databaseFixture();
    clearedApprovals = [];
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub,
      agentApproval: { clearSessionRemembered(id: string) { clearedApprovals.push(id); } },
    } });
  });
  afterEach(async () => {
    await host.dispose();
    f.dispose();
    // SQLite fixtures and resolved command promises can keep successive tests in microtasks.
    // Let the worker receive Vitest RPC replies between cases on slower CI machines.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  function seedSession(id = 'sess_cmd', metadata?: unknown): void {
    const session = newSession(id, 'chat');
    if (metadata !== undefined) session.metadata = metadata;
    createSession(f.db, session);
  }

  it('streaming upsert warns and succeeds after append_block_id_to_message fails', async () => {
    seedSession();
    createMessage(f.db, { id: 'msg_append', sessionId: 'sess_cmd', role: 'assistant', blockIds: [], timestamp: 1 });
    f.db.exec(`CREATE TRIGGER fail_append BEFORE UPDATE OF block_ids_json ON chat_v2_messages
      BEGIN SELECT RAISE(FAIL, 'append blocked'); END`);
    const warnings: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 3 }, export(message) {
      if (message.type === 'warn') warnings.push(String(message.args[0]));
    } });
    await expect(host.invoke('chat_v2_upsert_streaming_block', {
      blockId: 'blk_append', messageId: 'msg_append', sessionId: 'sess_cmd', blockType: 'content', content: 'persisted',
    })).resolves.toBeNull();
    expect(getBlock(f.db, 'blk_append')!.content).toBe('persisted');
    expect(getMessage(f.db, 'msg_append')!.blockIds).toEqual([]);
    expect(warnings).toEqual(['[ChatV2::handlers] Failed to append block_id to message: Database error: append blocked']);
  });

  it('tag validation follows Rust White_Space: NEL is blank and BOM is content', async () => {
    seedSession();
    await expect(host.invoke('chat_v2_add_tag', { sessionId: 'sess_cmd', tag: '\u0085' }))
      .rejects.toBe(commandError('Validation', 'Tag must not be empty'));
    await host.invoke('chat_v2_add_tag', { sessionId: 'sess_cmd', tag: '\ufeff' });
    expect(await host.invoke('chat_v2_get_session_tags', { sessionId: 'sess_cmd' })).toEqual(['\ufeff']);
  });

  it('permission preset clears remembered approvals after validation and before a failing DB write', async () => {
    seedSession();
    await expect(host.invoke('chat_v2_set_permission_preset', { sessionId: 'sess_cmd', preset: 'danger_full_access' }))
      .rejects.toBe(commandError('Validation', 'Enabling danger_full_access requires the explicit danger confirmation (confirm=true).'));
    expect(clearedApprovals).toEqual([]);
    f.db.exec(`CREATE TRIGGER reject_preset BEFORE UPDATE ON chat_v2_sessions
      BEGIN SELECT RAISE(FAIL, 'preset write failed'); END`);
    await expect(host.invoke('chat_v2_set_permission_preset', { sessionId: 'sess_cmd', preset: 'cautious' }))
      .rejects.toBe(commandError('Database', 'preset write failed'));
    expect(clearedApprovals).toEqual(['sess_cmd']);
    expect(getSession(f.db, 'sess_cmd')!.metadata).toBeUndefined();
  });

  function newBlock(messageId: string, id: string, index = 0): StoredBlock {
    return { id, messageId, type: 'content', status: 'pending', blockIndex: index };
  }

  // ========== manage_session.rs ==========

  it('archive_rejects_active_super_session_but_allows_regular_ones', async () => {
    seedSession('sess_super', superMetadata('ws_a'));
    seedSession('sess_plain');

    await expect(host.invoke('chat_v2_archive_session', { sessionId: 'sess_super' })).rejects.toContain(
      'Super-agent 会话不能归档');
    expect(getSession(f.db, 'sess_super')!.persistStatus).toBe('active');

    await expect(host.invoke('chat_v2_archive_session', { sessionId: 'sess_plain' })).resolves.toBeNull();
    expect(getSession(f.db, 'sess_plain')!.persistStatus).toBe('archived');
  });

  it('restore_retires_old_super_session_when_another_active_super_exists', async () => {
    seedSession('sess_super_old', superMetadata('ws_old'));
    updateSession(f.db, { ...getSession(f.db, 'sess_super_old')!, persistStatus: 'deleted' as const });
    seedSession('sess_super_new', superMetadata('ws_new'));

    const restored = await host.invoke<ChatSession>('chat_v2_restore_session', { sessionId: 'sess_super_old' });
    expect(restored).toMatchObject({ persistStatus: 'active' });
    const metadata = restored.metadata as Record<string, unknown>;
    expect((metadata.super_agent as Record<string, unknown>).active).toBe(false);
    expect('pinned' in metadata).toBe(false);

    const reloaded = getSession(f.db, 'sess_super_old')!;
    expect((reloaded.metadata as Record<string, unknown>).super_agent).toMatchObject({ active: false });
    const current = getSession(f.db, 'sess_super_new')!;
    expect((current.metadata as Record<string, unknown>).super_agent).toMatchObject({ active: true });
  });

  it('restore_keeps_super_marker_when_no_other_active_super_exists', async () => {
    seedSession('sess_super_only', superMetadata('ws_a'));
    updateSession(f.db, { ...getSession(f.db, 'sess_super_only')!, persistStatus: 'deleted' as const });

    const restored = await host.invoke<ChatSession>('chat_v2_restore_session', { sessionId: 'sess_super_only' });
    const metadata = restored.metadata as Record<string, unknown>;
    expect((metadata.super_agent as Record<string, unknown>).active).toBe(true);
  });

  it('settings_patch_cannot_strip_super_marker', async () => {
    seedSession('sess_super_patch', superMetadata('ws_a'));
    const updated = await host.invoke<ChatSession>('chat_v2_update_session_settings', {
      sessionId: 'sess_super_patch', settings: { metadata: { pinned: true, note: 'x' } },
    });
    const metadata = updated.metadata as Record<string, unknown>;
    expect((metadata.super_agent as Record<string, unknown>).active).toBe(true);
    expect(metadata.note).toBe('x');
  });

  it('settings_metadata_replaces_normal_fields_and_preserves_runtime_keys', async () => {
    seedSession('sess_settings_normal_patch', {
      authorityMode: 'plan', plan: { batchId: 'batch-1' }, pinned: false,
      legacyKey: 'remove-me', chatV2Draft: { hidden: true, scope: 'chat:ungrouped' },
      availableSkillsSnapshot: 'catalog-keep',
    });

    await host.invoke('chat_v2_update_session_settings', {
      sessionId: 'sess_settings_normal_patch',
      settings: { metadata: { authorityMode: 'craft', workspaceId: 'ws-9', pinned: true, legacyKey: null } },
    });
    let metadata = getSession(f.db, 'sess_settings_normal_patch')!.metadata as Record<string, unknown>;
    expect(metadata.authorityMode).toBe('craft');
    expect(metadata.workspaceId).toBe('ws-9');
    expect(metadata.pinned).toBe(true);
    expect('plan' in metadata).toBe(false);
    expect('legacyKey' in metadata).toBe(false);
    expect('chatV2Draft' in metadata).toBe(false);
    expect(metadata.availableSkillsSnapshot).toBe('catalog-keep');

    await host.invoke('chat_v2_update_session_settings', {
      sessionId: 'sess_settings_normal_patch', settings: { metadata: null },
    });
    metadata = getSession(f.db, 'sess_settings_normal_patch')!.metadata as Record<string, unknown>;
    expect(metadata).toEqual({ availableSkillsSnapshot: 'catalog-keep' });
  });

  it('test_valid_modes', async () => {
    const validModes = ['chat', 'analysis', 'review', 'textbook', 'bridge', 'general_chat'];
    for (const mode of validModes) {
      const created = await host.invoke<ChatSession>('chat_v2_create_session', { mode });
      expect(created.mode).toBe(mode);
    }
    await expect(host.invoke('chat_v2_create_session', { mode: 'invalid_mode' })).rejects.toBe(
      commandError('Validation',
        'Invalid session mode: invalid_mode. Valid modes: ["chat", "analysis", "review", "textbook", "bridge", "general_chat"]'));
  });

  it('test_session_id_generation', async () => {
    const first = await host.invoke<ChatSession>('chat_v2_create_session', { mode: 'chat' });
    const second = await host.invoke<ChatSession>('chat_v2_create_session', { mode: 'chat' });
    expect(first.id.startsWith('sess_')).toBe(true);
    expect(second.id.startsWith('sess_')).toBe(true);
    expect(first.id).not.toBe(second.id);
  });

  it('test_session_id_format_validation', () => {
    const valid = ['sess_12345', 'sess_a1b2c3d4-e5f6-7890-abcd-ef1234567890'];
    for (const id of valid) expect(id.startsWith('sess_')).toBe(true);
    expect('session_12345'.startsWith('sess_')).toBe(false);
    expect('invalid'.startsWith('sess_')).toBe(false);
  });

  it('create_session locks an explicit title and validates groups', async () => {
    const created = await host.invoke<ChatSession>('chat_v2_create_session', { mode: 'chat', title: 'Named' });
    expect(created).toMatchObject({ title: 'Named', titleLocked: true, persistStatus: 'active' });
    const untitled = await host.invoke<ChatSession>('chat_v2_create_session', { mode: 'chat', title: null });
    expect(untitled.titleLocked).toBe(false);
    await expect(host.invoke('chat_v2_create_session', { mode: 'chat', groupId: 'group_missing' }))
      .rejects.toContain('not found');
  });

  it('save_session upserts the incoming state and rejects unknown sessions', async () => {
    seedSession('sess_save');
    await expect(host.invoke('chat_v2_save_session', {
      sessionId: 'sess_save',
      sessionState: { sessionId: 'sess_save', inputValue: 'hello', updatedAt: '2026-11-03T00:00:00+00:00' },
    })).resolves.toBeNull();
    const loaded = await host.invoke<LoadSessionResponse>('chat_v2_load_session', { sessionId: 'sess_save' });
    expect(loaded.state).toMatchObject({ inputValue: 'hello' });
    await expect(host.invoke('chat_v2_save_session', {
      sessionId: 'sess_missing',
      sessionState: { sessionId: 'sess_missing', updatedAt: '2026-11-03T00:00:00+00:00' },
    })).rejects.toBe(commandError('SessionNotFound', 'sess_missing'));
  });

  it('updateSessionGroupWithConn is the public update_session_group_with_conn seam', async () => {
    const { updateSessionGroupWithConn } = await import('../api.ts');
    seedSession('sess_group_seam');
    const now = new Date().toISOString();
    createGroup(f.db, { id: 'grp_seam', name: 'Seam', defaultSkillIds: [], pinnedResourceIds: [],
      sortOrder: 0, persistStatus: 'active', createdAt: now, updatedAt: now });
    updateSessionGroupWithConn(f.db, 'sess_group_seam', 'grp_seam');
    expect(getSession(f.db, 'sess_group_seam')?.groupId).toBe('grp_seam');
    updateSessionGroupWithConn(f.db, 'sess_group_seam', null);
    expect(f.db.get<{ group_id: string | null }>(
      "SELECT group_id FROM chat_v2_sessions WHERE id='sess_group_seam'")?.group_id).toBeNull();
    expect(() => updateSessionGroupWithConn(f.db, 'sess_absent', null)).not.toThrow();
  });

  it('save_session keeps only serde ChatParams/PanelStates fields so the session reloads', async () => {
    seedSession('sess_extra');
    await expect(host.invoke('chat_v2_save_session', {
      sessionId: 'sess_extra',
      sessionState: {
        sessionId: 'sess_extra', updatedAt: '2026-11-03T00:00:00+00:00',
        chatParams: { modelId: 'cfg_1', modelIdPinnedByUser: true, temperature: 0.5, topP: null, maxTokens: 4096 },
        panelStates: { rag: true, fooPanel: true },
        features: { web: true },
      },
    })).resolves.toBeNull();
    const row = f.db.get<{ chat_params_json: string; panel_states_json: string }>(
      "SELECT chat_params_json, panel_states_json FROM chat_v2_session_state WHERE session_id='sess_extra'");
    expect(row?.chat_params_json).toBe('{"modelId":"cfg_1","temperature":0.5,"maxTokens":4096}');
    expect(row?.panel_states_json).toBe('{"rag":true}');
    const loaded = await host.invoke<LoadSessionResponse>('chat_v2_load_session', { sessionId: 'sess_extra' });
    expect(loaded.state?.chatParams).toEqual({ modelId: 'cfg_1', temperature: 0.5, maxTokens: 4096 });
    expect(loaded.state?.panelStates).toEqual({ rag: true });
    expect(loaded.state?.features).toEqual({ web: true });
    await host.invoke('chat_v2_save_session', { sessionId: 'sess_extra', sessionState: {
      sessionId: 'sess_extra', updatedAt: '2026-11-03T00:00:01+00:00',
      chatParams: { temperature: 1, topP: 0.123456789 },
    } });
    expect(f.db.get<{ chat_params_json: string }>(
      "SELECT chat_params_json FROM chat_v2_session_state WHERE session_id='sess_extra'")?.chat_params_json)
      .toBe('{"temperature":1.0,"topP":0.12345679}');
  });

  it('load_session drops meta_json keys that serde MessageMeta does not know', async () => {
    seedSession('sess_meta_extra');
    createMessage(f.db, { id: 'msg_meta_extra', sessionId: 'sess_meta_extra', role: 'user', blockIds: [], timestamp: 1 });
    f.db.run("UPDATE chat_v2_messages SET meta_json='{\"modelId\":\"m1\",\"frontendOnlyFlag\":true}' WHERE id='msg_meta_extra'");
    const loaded = await host.invoke<LoadSessionResponse>('chat_v2_load_session', { sessionId: 'sess_meta_extra' });
    expect((loaded.messages[0] as unknown as { _meta?: unknown })._meta).toEqual({ modelId: 'm1' });
  });

  it('load_session drops extra fields already stored and mistyped columns like serde .ok()', async () => {
    seedSession('sess_legacy_state');
    f.db.run(`INSERT INTO chat_v2_session_state (session_id, chat_params_json, features_json, panel_states_json, updated_at)
      VALUES ('sess_legacy_state', ?1, ?2, ?3, '2026-11-03T00:00:00+00:00')`, [
      '{"modelIdPinnedByUser":true,"modelId":"cfg_2","contextLimit":8192}',
      '{"web":"yes"}',
      '{"skill":true,"legacyPanel":1}',
    ]);
    const loaded = await host.invoke<LoadSessionResponse>('chat_v2_load_session', { sessionId: 'sess_legacy_state' });
    expect(loaded.state?.chatParams).toEqual({ modelId: 'cfg_2', contextLimit: 8192 });
    expect(loaded.state?.panelStates).toEqual({ skill: true });
    expect(loaded.state).not.toHaveProperty('features');
    f.db.run("UPDATE chat_v2_session_state SET chat_params_json='{\"maxTokens\":-1}' WHERE session_id='sess_legacy_state'");
    const mistyped = await host.invoke<LoadSessionResponse>('chat_v2_load_session', { sessionId: 'sess_legacy_state' });
    expect(mistyped.state).not.toHaveProperty('chatParams');
  });

  it('list_agent_sessions filters active agent rows by workspace and limit', async () => {
    createSession(f.db, { ...newSession('agent_one', 'agent'), metadata: { workspace_id: 'ws_1' } });
    createSession(f.db, { ...newSession('agent_two', 'agent'), metadata: { workspace_id: 'ws_2' } });
    const archived = { ...newSession('agent_three', 'agent'), metadata: { workspace_id: 'ws_1' }, persistStatus: 'archived' as const };
    createSession(f.db, archived);
    await expect(host.invoke('chat_v2_list_agent_sessions')).resolves.toMatchObject([{ id: 'agent_two' }, { id: 'agent_one' }]);
    await expect(host.invoke('chat_v2_list_agent_sessions', { workspaceId: 'ws_1' })).resolves.toMatchObject([{ id: 'agent_one' }]);
    await expect(host.invoke('chat_v2_list_agent_sessions', { limit: 1 })).resolves.toHaveLength(1);
  });

  it('message summary and per-session counts use raw row totals', async () => {
    seedSession('sess_counts');
    createMessage(f.db, { id: 'msg_u', sessionId: 'sess_counts', role: 'user', blockIds: [], timestamp: 1 });
    createMessage(f.db, { id: 'msg_a', sessionId: 'sess_counts', role: 'assistant', blockIds: [], timestamp: 2 });
    await expect(host.invoke('chat_v2_session_message_count', { sessionId: 'sess_counts' })).resolves.toBe(2);
    await expect(host.invoke('chat_v2_session_message_count', { sessionId: 'sess_unknown' })).resolves.toBe(0);
    await expect(host.invoke('chat_v2_get_message_summary')).resolves.toEqual({
      total_messages: 2, user_messages: 1, assistant_messages: 1,
    });
  });

  it('authority mode and permission preset persist with exact validation', async () => {
    seedSession('sess_authority');
    const setMode = await host.invoke<ChatSession>('chat_v2_set_authority_mode', { sessionId: 'sess_authority', mode: 'Plan' });
    expect(setMode.metadata).toMatchObject({ authorityMode: 'plan', authority_mode: 'plan' });
    await expect(host.invoke('chat_v2_set_authority_mode', { sessionId: 'sess_authority', mode: 'bogus' }))
      .rejects.toBe(commandError('Validation', "Invalid authority mode 'bogus'. Valid modes: ask, plan, craft"));

    const relaxed = await host.invoke<ChatSession>('chat_v2_set_permission_preset', { sessionId: 'sess_authority', preset: 'relaxed' });
    expect(relaxed.metadata).toMatchObject({ permissionPreset: 'relaxed', permission_preset: 'relaxed' });
    await expect(host.invoke('chat_v2_set_permission_preset', { sessionId: 'sess_authority', preset: 'danger_full_access' }))
      .rejects.toBe(commandError('Validation',
        'Enabling danger_full_access requires the explicit danger confirmation (confirm=true).'));
    const danger = await host.invoke<ChatSession>('chat_v2_set_permission_preset', {
      sessionId: 'sess_authority', preset: 'danger_full_access', confirm: true,
    });
    expect(danger.metadata).toMatchObject({ permissionPreset: 'danger_full_access' });
    await expect(host.invoke('chat_v2_set_permission_preset', { sessionId: 'sess_missing', preset: 'bogus' }))
      .rejects.toBe(commandError('Validation',
        "Invalid permission preset 'bogus'. Valid presets: cautious, relaxed, full_access, danger_full_access"));
  });

  it('rag scope trims folders, deduplicates empties and reads back a plain array', async () => {
    seedSession('sess_scope');
    await expect(host.invoke('chat_v2_get_rag_scope', { sessionId: 'sess_scope' })).resolves.toEqual([]);
    await expect(host.invoke('chat_v2_set_rag_scope', {
      sessionId: 'sess_scope', folderIds: [' folder_a ', '', 'folder_b'],
    })).resolves.toBeNull();
    await expect(host.invoke('chat_v2_get_rag_scope', { sessionId: 'sess_scope' })).resolves.toEqual(['folder_a', 'folder_b']);
    await expect(host.invoke('chat_v2_set_rag_scope', { sessionId: 'sess_scope', folderIds: ['  '] })).resolves.toBeNull();
    await expect(host.invoke('chat_v2_get_rag_scope', { sessionId: 'sess_scope' })).resolves.toEqual([]);
    await expect(host.invoke('chat_v2_set_rag_scope', { sessionId: 'sess_unpersisted', folderIds: ['x'] }))
      .rejects.toBe('会话尚未保存，请先发送一条消息后再设置检索范围');
  });

  // ========== block_actions.rs ==========

  it('test_block_id_validation', async () => {
    expect('blk_12345'.startsWith('blk_')).toBe(true);
    expect('blk_a1b2c3d4-e5f6-7890-abcd-ef1234567890'.startsWith('blk_')).toBe(true);
    await expect(host.invoke('chat_v2_copy_block_content', { blockId: 'block_12345' }))
      .rejects.toBe(commandError('Validation', 'Invalid block ID format: block_12345'));
  });

  it('test_message_id_validation', async () => {
    expect('msg_12345'.startsWith('msg_')).toBe(true);
    expect('msg_a1b2c3d4-e5f6-7890-abcd-ef1234567890'.startsWith('msg_')).toBe(true);
    await expect(host.invoke('chat_v2_upsert_streaming_block', {
      blockId: 'blk_1', messageId: 'message_12345', blockType: 'content', content: 'x',
    })).rejects.toBe(commandError('Validation', 'Invalid message ID format: message_12345'));
  });

  it('streaming_upsert_preserves_first_timestamps', () => {
    seedSession('sess_stream_times');
    createMessage(f.db, {
      id: 'msg_stream_times', sessionId: 'sess_stream_times', role: 'assistant',
      blockIds: ['blk_stream_times'], timestamp: 1,
    });

    const block = { ...newBlock('msg_stream_times', 'blk_stream_times'), content: 'first', startedAt: 100, firstChunkAt: 110, endedAt: 120 };
    upsertStreamingBlock(f.db, block);
    upsertStreamingBlock(f.db, { ...block, content: 'second', startedAt: 200, firstChunkAt: 210, endedAt: 220 });

    const saved = getBlock(f.db, 'blk_stream_times')!;
    expect(saved.content).toBe('second');
    expect(saved.startedAt).toBe(100);
    expect(saved.firstChunkAt).toBe(110);
    expect(saved.endedAt).toBe(220);
  });

  it('copy block content renders text, markdown and pretty JSON', async () => {
    seedSession('sess_copy');
    createMessage(f.db, { id: 'msg_copy', sessionId: 'sess_copy', role: 'assistant', blockIds: ['blk_copy'], timestamp: 1 });
    createBlock(f.db, { ...newBlock('msg_copy', 'blk_copy'), content: 'hello', status: 'success', toolName: 'tool', startedAt: 1, endedAt: 2 });

    await expect(host.invoke('chat_v2_copy_block_content', { blockId: 'blk_copy' }))
      .resolves.toEqual({ content: 'hello', contentType: 'text' });
    await expect(host.invoke('chat_v2_copy_block_content', { blockId: 'blk_copy', format: 'markdown' }))
      .resolves.toEqual({ content: 'hello', contentType: 'markdown' });
    const json = await host.invoke<CopyBlockContentResponse>('chat_v2_copy_block_content', { blockId: 'blk_copy', format: 'json' });
    expect(json.contentType).toBe('json');
    expect(JSON.parse(json.content)).toEqual({
      id: 'blk_copy', type: 'content', status: 'success', content: 'hello', toolName: 'tool',
      toolInput: null, toolOutput: null, citations: null, error: null, startedAt: 1, endedAt: 2,
    });
    await expect(host.invoke('chat_v2_copy_block_content', { blockId: 'blk_missing' }))
      .rejects.toBe(commandError('BlockNotFound', 'blk_missing'));
  });

  it('update block content guards streaming sessions and missing rows', async () => {
    seedSession('sess_update_block');
    createMessage(f.db, { id: 'msg_ub', sessionId: 'sess_update_block', role: 'assistant', blockIds: ['blk_ub'], timestamp: 1 });
    createBlock(f.db, { ...newBlock('msg_ub', 'blk_ub'), content: 'old', status: 'success' });

    await expect(host.invoke('chat_v2_update_block_content', { blockId: 'blk_ub', content: 'new' })).resolves.toBeNull();
    expect(getBlock(f.db, 'blk_ub')!.content).toBe('new');
    await expect(host.invoke('chat_v2_update_block_content', { blockId: 'blk_missing', content: 'x' }))
      .rejects.toBe(commandError('BlockNotFound', 'blk_missing'));
  });

  it('update block tool output validates JSON before writing', async () => {
    seedSession('sess_tool_output');
    createMessage(f.db, { id: 'msg_to', sessionId: 'sess_tool_output', role: 'assistant', blockIds: ['blk_to'], timestamp: 1 });
    createBlock(f.db, { ...newBlock('msg_to', 'blk_to'), content: 'card', status: 'success', toolOutput: { old: true } });

    await expect(host.invoke('chat_v2_update_block_tool_output', { blockId: 'blk_to', toolOutputJson: '{bad' }))
      .rejects.toContain('Invalid tool_output_json:');
    await expect(host.invoke('chat_v2_update_block_tool_output', {
      blockId: 'blk_to', toolOutputJson: JSON.stringify({ edited: true }),
    })).resolves.toBeNull();
    expect(getBlock(f.db, 'blk_to')!.toolOutput).toEqual({ edited: true });
  });

  it('upsert_streaming_block creates placeholders and rejects cross-session writes', async () => {
    seedSession('sess_stream');
    seedSession('sess_other');
    await expect(host.invoke('chat_v2_upsert_streaming_block', {
      blockId: 'blk_stream', messageId: 'msg_stream', sessionId: 'sess_stream',
      blockType: 'content', content: 'partial', status: 'streaming',
    })).resolves.toBeNull();
    expect(getMessage(f.db, 'msg_stream')!.blockIds).toEqual(['blk_stream']);
    const block = getBlock(f.db, 'blk_stream')!;
    expect(block).toMatchObject({ content: 'partial', status: 'streaming', blockIndex: 0 });
    expect(block.startedAt).toBeGreaterThan(0);

    createMessage(f.db, { id: 'msg_owned', sessionId: 'sess_other', role: 'assistant', blockIds: [], timestamp: 1 });
    await expect(host.invoke('chat_v2_upsert_streaming_block', {
      blockId: 'blk_cross', messageId: 'msg_owned', sessionId: 'sess_stream',
      blockType: 'content', content: 'x',
    })).rejects.toBe(commandError('Validation', 'Message msg_owned does not belong to session sess_stream'));

    await expect(host.invoke('chat_v2_upsert_streaming_block', {
      blockId: 'blk_big', messageId: 'msg_stream', blockType: 'content', content: 'x'.repeat(8 * 1024 * 1024 + 1),
    })).rejects.toContain('Streaming block payload too large:');
  });

  // ========== load_session.rs ==========

  it('test_session_id_validation', async () => {
    expect('sess_12345'.startsWith('sess_')).toBe(true);
    expect('agent_12345'.startsWith('agent_')).toBe(true);
    expect('subagent_foo_bar'.startsWith('subagent_')).toBe(true);
    await expect(host.invoke('chat_v2_load_session', { sessionId: '   ' })).rejects.toBe(
      commandError('Validation', 'Invalid session ID: empty or whitespace-only'));
    await expect(host.invoke('chat_v2_load_session', { sessionId: 'legacy_session' })).rejects.toBe(
      commandError('SessionNotFound', 'legacy_session'));
  });

  it.each([
    { authorityMode: 'plan', permissionPreset: 'full_access' },
    { authority_mode: 'plan', permission_preset: 'full_access' },
  ])('loading_session_persists_retired_authority_mode_as_craft: one input naming convention %j', async metadata => {
    // Test each accepted naming convention alone so one cannot conceal a broken other key.
    seedSession('sess_retired_plan', metadata);
    const loaded = await host.invoke<LoadSessionResponse>('chat_v2_load_session', { sessionId: 'sess_retired_plan' });
    // types.rs:713-727 deliberately writes both aliases; plan=None removes the key (:735-736).
    expect(loaded.session.metadata).toEqual({
      authorityMode: 'craft', authority_mode: 'craft',
      permissionPreset: 'full_access', permission_preset: 'full_access',
    });
    expect(loaded.session.metadata).not.toHaveProperty('plan');
    const persisted = getSession(f.db, 'sess_retired_plan')!;
    expect(persisted.metadata).toEqual(loaded.session.metadata);
  });

  it('load_session tail returns totalMessageCount and full load omits it', async () => {
    seedSession('sess_tail');
    for (let index = 0; index < 4; index += 1) {
      createMessage(f.db, { id: `msg_tail_${index}`, sessionId: 'sess_tail', role: 'user', blockIds: [], timestamp: 1_000 + index });
    }
    const full = await host.invoke<LoadSessionResponse>('chat_v2_load_session', { sessionId: 'sess_tail' });
    expect(full.messages).toHaveLength(4);
    expect('totalMessageCount' in full).toBe(false);
    const tail = await host.invoke<LoadSessionResponse>('chat_v2_load_session', { sessionId: 'sess_tail', tailLimit: 2 });
    expect(tail.messages.map((message: { id: string }) => message.id)).toEqual(['msg_tail_2', 'msg_tail_3']);
    expect(tail.totalMessageCount).toBe(4);
  });

  it('load_messages_page clamps limits and emits nextOffset only with more rows', async () => {
    seedSession('sess_page');
    for (let index = 0; index < 3; index += 1) {
      const messageId = `msg_page_${index}`;
      createMessage(f.db, { id: messageId, sessionId: 'sess_page', role: 'user', blockIds: [], timestamp: 1_000 + index });
      createBlock(f.db, newBlock(messageId, `blk_page_${index}`));
    }
    const first = await host.invoke<LoadMessagesPageResponse>('chat_v2_load_messages_page', { sessionId: 'sess_page', limit: 2 });
    expect(first).toMatchObject({ offset: 0, limit: 2, totalMessageCount: 3, nextOffset: 2 });
    expect(first.messages.map((message: { id: string }) => message.id)).toEqual(['msg_page_0', 'msg_page_1']);
    expect(first.blocks[0]).not.toHaveProperty('blockIndex');

    const last = await host.invoke<LoadMessagesPageResponse>('chat_v2_load_messages_page', { sessionId: 'sess_page', offset: 2, limit: 0 });
    expect(last).toMatchObject({ offset: 2, limit: 1, totalMessageCount: 3 });
    expect('nextOffset' in last).toBe(false);

    await expect(host.invoke('chat_v2_load_messages_page', { sessionId: ' ' })).rejects.toBe(
      commandError('Validation', 'Invalid session ID: empty or whitespace-only'));
  });
});

describe('chat_v2 goal, group and session lifecycle commands', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  function seedSession(id: string, metadata?: unknown): void {
    const session = newSession(id, 'chat');
    if (metadata !== undefined) session.metadata = metadata;
    createSession(f.db, session);
  }

  it('cancel_stream aborts a registered token and errors when idle', async () => {
    const state = host.ctx.get('chatState') as ChatV2State;
    await expect(host.invoke('chat_v2_cancel_stream', { sessionId: 'sess_cancel', messageId: 'msg_1' }))
      .rejects.toBe(commandError('Other', 'No active stream to cancel'));
    const token = state.registerStream('sess_cancel');
    await expect(host.invoke('chat_v2_cancel_stream', { sessionId: 'sess_cancel', messageId: 'msg_1' })).resolves.toBeNull();
    expect(token.signal.aborted).toBe(true);
    expect(state.hasActiveStream('sess_cancel')).toBe(false);
  });

  it('goal pause/resume/clear emit only on actual transitions', async () => {
    seedSession('sess_goal');
    insertGoal(f.db, { sessionId: 'sess_goal', goalId: 'goal_1', objective: 'do', status: 'active',
      tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, continuationCount: 0, createdAtMs: 1, updatedAtMs: 1 });

    const paused = await host.invoke('chat_v2_goal_pause', { sessionId: 'sess_goal' });
    expect(paused).toMatchObject({ status: 'paused' });
    await host.invoke('chat_v2_goal_pause', { sessionId: 'sess_goal' });
    const eventsAfterPause = host.eventsNamed('chat_v2_session_sess_goal');
    expect(eventsAfterPause).toHaveLength(1);

    const resumed = await host.invoke('chat_v2_goal_resume', { sessionId: 'sess_goal' });
    expect(resumed).toMatchObject({ status: 'active' });
    await host.invoke('chat_v2_goal_resume', { sessionId: 'sess_goal' });
    expect(host.eventsNamed('chat_v2_session_sess_goal')).toHaveLength(2);

    await expect(host.invoke('chat_v2_goal_clear', { sessionId: 'sess_goal' })).resolves.toBeNull();
    expect(getGoal(f.db, 'sess_goal')).toBeNull();
    expect(host.eventsNamed('chat_v2_session_sess_goal').at(-1)).toEqual({ eventType: 'goal_updated', sessionId: 'sess_goal', goal: null });
    await expect(host.invoke('chat_v2_goal_clear', { sessionId: 'sess_goal' })).resolves.toBeNull();

    await expect(host.invoke('chat_v2_goal_pause', { sessionId: 'sess_goal' }))
      .rejects.toBe(commandError('Validation', 'cannot pause goal because this session has no goal'));
    await expect(host.invoke('chat_v2_goal_resume', { sessionId: 'sess_goal' }))
      .rejects.toBe(commandError('Validation', 'cannot resume goal because this session has no goal'));
  });

  it('soft delete validates streaming and running anki blocks before trashing', async () => {
    const state = host.ctx.get('chatState') as ChatV2State;
    seedSession('sess_soft');
    await expect(host.invoke('chat_v2_soft_delete_session', { sessionId: 'bad' }))
      .rejects.toBe(commandError('Validation', 'Invalid session ID format: bad'));

    const token = state.registerStream('sess_soft');
    await expect(host.invoke('chat_v2_soft_delete_session', { sessionId: 'sess_soft' }))
      .rejects.toBe(commandError('Other',
        'Cannot delete session while streaming. Please wait for completion or cancel first.'));
    state.removeStream('sess_soft');
    token.abort();

    createMessage(f.db, { id: 'msg_anki', sessionId: 'sess_soft', role: 'assistant', blockIds: ['blk_anki'], timestamp: 1 });
    createBlock(f.db, { id: 'blk_anki', messageId: 'msg_anki', type: 'anki_cards', status: 'pending', blockIndex: 0 });
    await expect(host.invoke('chat_v2_soft_delete_session', { sessionId: 'sess_soft' }))
      .rejects.toContain('Cannot delete session while ChatAnki generation is still running.');
    updateBlock(f.db, { ...getBlock(f.db, 'blk_anki')!, status: 'success' });

    await expect(host.invoke('chat_v2_soft_delete_session', { sessionId: 'sess_soft' })).resolves.toBeNull();
    expect(getSession(f.db, 'sess_soft')!.persistStatus).toBe('deleted');
  });

  it('reorder_groups and move_session_to_group persist ordering and membership', async () => {
    seedSession('sess_move');
    const now = new Date().toISOString();
    createGroup(f.db, { id: 'group_a', name: 'A', defaultSkillIds: [], pinnedResourceIds: [],
      sortOrder: 5, persistStatus: 'active', createdAt: now, updatedAt: now });
    createGroup(f.db, { id: 'group_b', name: 'B', defaultSkillIds: [], pinnedResourceIds: [],
      sortOrder: 6, persistStatus: 'active', createdAt: now, updatedAt: now });

    await expect(host.invoke('chat_v2_reorder_groups', { groupIds: ['group_b', 'group_a'] })).resolves.toBeNull();
    expect(getGroup(f.db, 'group_b')!.sortOrder).toBe(0);
    expect(getGroup(f.db, 'group_a')!.sortOrder).toBe(1);

    await expect(host.invoke('chat_v2_move_session_to_group', { sessionId: 'sess_move', groupId: 'group_a' })).resolves.toBeNull();
    expect(getSession(f.db, 'sess_move')!.groupId).toBe('group_a');
    await expect(host.invoke('chat_v2_move_session_to_group', { sessionId: 'sess_move', groupId: 'group_missing' }))
      .rejects.toBe(commandError('GroupNotFound', 'group_missing'));
    await expect(host.invoke('chat_v2_move_session_to_group', { sessionId: 'sess_move', groupId: '  ' })).resolves.toBeNull();
    expect(getSession(f.db, 'sess_move')!.groupId ?? null).toBeNull();
  });

  it('freeze snapshot is first-write-wins until a pending generation is declared', async () => {
    seedSession('sess_freeze');
    await expect(host.invoke('chat_v2_freeze_available_skills_snapshot', { sessionId: 'sess_freeze', snapshot: 'catalog-v0' }))
      .resolves.toBe('catalog-v0');
    await expect(host.invoke('chat_v2_freeze_available_skills_snapshot', { sessionId: 'sess_freeze', snapshot: 'catalog-ignored' }))
      .resolves.toBe('catalog-v0');
    expect(markAvailableSkillsSnapshotStale(f.db, 'sess_freeze')).toBe(1);
    await expect(host.invoke('chat_v2_freeze_available_skills_snapshot', { sessionId: 'sess_freeze', snapshot: 'catalog-v1' }))
      .resolves.toBe('catalog-v1');
    const metadata = getSession(f.db, 'sess_freeze')!.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({ availableSkillsSnapshot: 'catalog-v1', availableSkillsSnapshotGeneration: 1 });
    expect('availableSkillsSnapshotPendingGeneration' in metadata).toBe(false);
    await expect(host.invoke('chat_v2_freeze_available_skills_snapshot', { sessionId: 'bad', snapshot: 'x' }))
      .rejects.toBe(commandError('Validation', 'Invalid session ID format: bad'));
  });

  it('finds_sessions_by_context_ref_and_pdf_marker_and_skips_deleted: newest hit per active session', async () => {
    seedSession('sess_ref_a');
    seedSession('sess_ref_b');
    seedSession('sess_ref_deleted');
    updateSession(f.db, { ...getSession(f.db, 'sess_ref_deleted')!, persistStatus: 'deleted' });
    createMessage(f.db, { id: 'msg_ref_a1', sessionId: 'sess_ref_a', role: 'user', blockIds: [], timestamp: 10,
      _meta: { context_snapshot: { resources: [{ id: 'doc_1' }] } } as never });
    createMessage(f.db, { id: 'msg_ref_a2', sessionId: 'sess_ref_a', role: 'assistant', blockIds: ['blk_ref_a2'], timestamp: 20 });
    createBlock(f.db, { id: 'blk_ref_a2', messageId: 'msg_ref_a2', type: 'content', status: 'success',
      blockIndex: 0, content: 'see [PDF@doc_1:12]' });
    createMessage(f.db, { id: 'msg_ref_b', sessionId: 'sess_ref_b', role: 'assistant', blockIds: [], timestamp: 15,
      attachments: [{ id: 'doc_1' }] as never });
    createMessage(f.db, { id: 'msg_ref_del', sessionId: 'sess_ref_deleted', role: 'user', blockIds: [], timestamp: 30,
      _meta: { context_snapshot: { resources: [{ id: 'doc_1' }] } } as never });

    const hits = await host.invoke<Array<{ sessionId: string; messageId: string }>>(
      'chat_v2_list_sessions_referencing', { sourceIds: ['doc_1'], limit: 10 });
    expect(hits).toEqual([
      { sessionId: 'sess_ref_a', title: null, messageId: 'msg_ref_a2', lastReferencedAt: 20 },
      { sessionId: 'sess_ref_b', title: null, messageId: 'msg_ref_b', lastReferencedAt: 15 },
    ]);
    await expect(host.invoke('chat_v2_list_sessions_referencing', { sourceIds: [], limit: 10 })).resolves.toEqual([]);
  });

  it('settings_patch_preserves_runtime_metadata_against_stale_snapshot', async () => {
    seedSession('sess_settings_runtime_patch', { authorityMode: 'plan', plan: { batchId: 'batch-1' } });
    freezeAvailableSkillsSnapshot(f.db, 'sess_settings_runtime_patch', 'catalog-v0');
    markAvailableSkillsSnapshotStale(f.db, 'sess_settings_runtime_patch');
    freezeAvailableSkillsSnapshot(f.db, 'sess_settings_runtime_patch', 'catalog-v1');
    markAvailableSkillsSnapshotStale(f.db, 'sess_settings_runtime_patch');
    advanceToolFacePrefix(f.db, 'sess_settings_runtime_patch', {
      generation: 3, order: ['builtin-load_skills', 'builtin-qbank_list'], schemaDigest: 'digest-3',
    });
    setMicrocompactAnchor(f.db, 'sess_settings_runtime_patch', { lineage: 'cmp-1', eligibleUserTurns: 4 });

    const updated = await host.invoke<ChatSession>('chat_v2_update_session_settings', {
      sessionId: 'sess_settings_runtime_patch',
      settings: {
        title: 'Renamed',
        metadata: {
          authorityMode: 'craft', workspace_id: 'ws-2', plan: { batchId: 'batch-2' },
          availableSkillsSnapshot: 'stale-catalog', availableSkillsSnapshotGeneration: 99,
          availableSkillsSnapshotPendingGeneration: 99, toolFacePrefixGeneration: 99,
          frozenToolSchemaOrder: ['stale-tool'], toolSchemaDigest: 'stale-digest', microcompactAnchor: null,
        },
      },
    });
    expect(updated.title).toBe('Renamed');
    expect(updated.titleLocked).toBe(true);
    const metadata = getSession(f.db, 'sess_settings_runtime_patch')!.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      availableSkillsSnapshot: 'catalog-v1', availableSkillsSnapshotGeneration: 1,
      availableSkillsSnapshotPendingGeneration: 2, toolFacePrefixGeneration: 3,
      frozenToolSchemaOrder: ['builtin-load_skills', 'builtin-qbank_list'], toolSchemaDigest: 'digest-3',
      microcompactAnchor: { lineage: 'cmp-1', eligibleUserTurns: 4 },
      authorityMode: 'craft', workspace_id: 'ws-2', plan: { batchId: 'batch-2' },
    });
  });

  it('settings_patch_leaves_487_compaction_boundaries_unchanged', async () => {
    seedSession('sess_settings_compaction_stamp');
    createMessage(f.db, { id: 'msg_original', sessionId: 'sess_settings_compaction_stamp', role: 'user', blockIds: [], timestamp: 1_000 });
    createMessage(f.db, { id: 'msg_summary', sessionId: 'sess_settings_compaction_stamp', role: 'assistant',
      blockIds: ['blk_summary'], timestamp: 2_000 });
    createBlock(f.db, { id: 'blk_summary', messageId: 'msg_summary', type: 'compaction_summary',
      status: 'success', blockIndex: 0, content: 'Saved task state' });
    const record = {
      id: 'cmp_1', sessionId: 'sess_settings_compaction_stamp', summaryMessageId: 'msg_summary',
      tailStartMessageId: 'msg_summary', tailStartTimeCreated: 1_000, reason: 'overflow',
      isAuto: false, isOverflow: true, tokensBefore: null, tokensAfter: null, modelId: null,
      modelConfigId: null, previousCompactionId: null, rangeStartMessageId: 'msg_original',
      rangeEndMessageId: 'msg_original', compactedMessageCount: 1, createdAt: 2_000,
    };
    createCompaction(f.db, record);
    setSessionLastCompaction(f.db, 'sess_settings_compaction_stamp', record.id);
    const before = getActiveCompaction(f.db, 'sess_settings_compaction_stamp')!;

    await host.invoke('chat_v2_update_session_settings', {
      sessionId: 'sess_settings_compaction_stamp', settings: { metadata: { pinned: true } },
    });

    const after = getActiveCompaction(f.db, 'sess_settings_compaction_stamp')!;
    expect(after.summaryMessageId).toBe(before.summaryMessageId);
    expect(after.tailStartMessageId).toBe(before.tailStartMessageId);
    expect(after.rangeEndMessageId).toBe(before.rangeEndMessageId);
    expect(after.compactedMessageCount).toBe(before.compactedMessageCount);
    expect(after.tailStartMessageId).toBe(after.summaryMessageId);
    expect(f.db.pluck<string>('SELECT last_compaction_id FROM chat_v2_sessions WHERE id = ?1',
      ['sess_settings_compaction_stamp'])).toBe(record.id);
  });
});
