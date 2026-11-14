import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { createSession, getSession, listAgentSessions, updateSession } from '../repository/sessions.ts';
import { saveRagScope, saveSessionSkillState } from '../repository/session-state.ts';
import { createMessage } from '../repository/messages.ts';
import { newSession } from '../src/types.ts';
import type { ChatMessage } from '../api.ts';

const RUST_DATABASE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6}|\.\d{9})?\+00:00$/;

describe('chat_v2 storage alignment with the Rust writers', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub,
      agentApproval: { clearSessionRemembered() {} } } });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await host.dispose();
    f.dispose();
  });

  function stateRow(sessionId: string): { updated_at: string; skill_state_json: string | null } | undefined {
    return f.db.get('SELECT updated_at, skill_state_json FROM chat_v2_session_state WHERE session_id = ?1', [sessionId]);
  }

  it('sessions created inside one wall-clock millisecond keep creation order like Utc::now()', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-07T00:00:00.123Z') });
    createSession(f.db, { ...newSession('agent_first', 'agent'), metadata: { workspace_id: 'ws' } });
    createSession(f.db, { ...newSession('agent_second', 'agent'), metadata: { workspace_id: 'ws' } });
    const [first, second] = ['agent_first', 'agent_second'].map(id => f.db.pluck<string>(
      'SELECT created_at FROM chat_v2_sessions WHERE id = ?1', [id])!);
    expect(first).toMatch(RUST_DATABASE_TIMESTAMP);
    expect(second! > first!).toBe(true);
    expect(listAgentSessions(f.db, null, 10).map(session => session.id)).toEqual(['agent_second', 'agent_first']);
  });

  it('session state timestamps use Utc::now().to_rfc3339()', () => {
    createSession(f.db, newSession('sess_state_ts', 'chat'));
    saveRagScope(f.db, 'sess_state_ts', ['fld_a']);
    expect(stateRow('sess_state_ts')!.updated_at).toMatch(RUST_DATABASE_TIMESTAMP);

    createSession(f.db, newSession('sess_skill_ts', 'chat'));
    saveSessionSkillState(f.db, 'sess_skill_ts', { version: 1, manualPinnedSkillIds: ['skill-a'] });
    expect(stateRow('sess_skill_ts')!.updated_at).toMatch(RUST_DATABASE_TIMESTAMP);
  });

  it('archive writes archivedAt and updated_at from the same Utc::now() sample', async () => {
    createSession(f.db, newSession('sess_archive_now', 'chat'));
    await host.invoke('chat_v2_archive_session', { sessionId: 'sess_archive_now' });
    const row = f.db.get<{ updated_at: string; metadata_json: string }>(
      'SELECT updated_at, metadata_json FROM chat_v2_sessions WHERE id = ?1', ['sess_archive_now'])!;
    const archivedAt = (JSON.parse(row.metadata_json) as { manuallyArchivedBy: { archivedAt: string } })
      .manuallyArchivedBy.archivedAt;
    expect(archivedAt).toBe(row.updated_at);
    expect(row.updated_at).toMatch(RUST_DATABASE_TIMESTAMP);
  });

  it('import_session stores absent or null tool JSON as SQL NULL like Option<Value>', async () => {
    const snapshotJson = JSON.stringify({
      format: 'deepstudent-conversation-snapshot', version: 1,
      session: newSession('sess_import_nulls', 'chat'),
      messages: [{ id: 'msg_src', sessionId: 'sess_import_nulls', role: 'user', blockIds: ['blk_null', 'blk_absent', 'blk_tool'], timestamp: 1 }],
      blocks: [
        { id: 'blk_null', messageId: 'msg_src', type: 'content', status: 'success', content: '原问题',
          toolInput: null, toolOutput: null, citations: null },
        { id: 'blk_absent', messageId: 'msg_src', type: 'content', status: 'success', content: '原回答' },
        { id: 'blk_tool', messageId: 'msg_src', type: 'mcp_tool', status: 'success', toolName: 'echo',
          toolInput: { ref: 'blk_null' }, toolOutput: [] },
      ],
    });
    const result = await host.invoke<{ sessionId: string }>('chat_v2_import_session', { snapshotJson });
    const rows = f.db.all<{ content: string | null; tool_input_json: string | null; tool_output_json: string | null; citations_json: string | null }>(
      `SELECT b.content, b.tool_input_json, b.tool_output_json, b.citations_json FROM chat_v2_blocks b
        JOIN chat_v2_messages m ON m.id = b.message_id WHERE m.session_id = ?1 ORDER BY b.rowid`, [result.sessionId]);
    expect(rows.slice(0, 2)).toEqual([
      { content: '原问题', tool_input_json: null, tool_output_json: null, citations_json: null },
      { content: '原回答', tool_input_json: null, tool_output_json: null, citations_json: null },
    ]);
    expect(JSON.parse(rows[2]!.tool_input_json!)).toEqual({ ref: expect.stringMatching(/^blk_/) });
    expect(JSON.parse(rows[2]!.tool_input_json!).ref).not.toBe('blk_null');
    expect(rows[2]!.tool_output_json).toBe('[]');
  });

  it('restore_session rebuilds the session skill state like restore_session_in_db', async () => {
    createSession(f.db, newSession('sess_restore_skill', 'chat'));
    updateSession(f.db, { ...getSession(f.db, 'sess_restore_skill')!, persistStatus: 'deleted' });
    expect(stateRow('sess_restore_skill')).toBeUndefined();

    await host.invoke('chat_v2_restore_session', { sessionId: 'sess_restore_skill' });
    const row = stateRow('sess_restore_skill');
    expect(row).toBeDefined();
    expect(row!.updated_at).toMatch(RUST_DATABASE_TIMESTAMP);
    expect(JSON.parse(row!.skill_state_json!)).toMatchObject({ version: 0 });
  });

  it('meta_json is serde MessageMeta: struct field order, None options and None auxiliary config omitted', () => {
    createSession(f.db, newSession('sess_meta_order', 'chat'));
    const plan = { planner: { route: 'text_model_direct', activeModel: 'text', fallbackFrom: null,
      sendsOriginalImages: false, usesOcr: false, degraded: false },
    auxiliaryMultimodalConfigId: null, imageBudget: 8, historyImageBudget: 4 };
    const executionSnapshot = { resolvedModelId: 'cfg', resolvedModelName: 'model', resolvedModelIsMultimodal: false,
      capabilitySnapshot: {}, generationPlan: plan, executionRoute: 'text_model_direct', frozenAt: 1 };
    const message = { id: 'msg_meta_order', sessionId: 'sess_meta_order', role: 'user' as const, blockIds: [], timestamp: 1,
      _meta: { inboundOrigin: { kind: 'im' }, canonicalContent: [{ type: 'text', text: 'q' }], modelId: null,
        executionSnapshot } } as unknown as ChatMessage;
    createMessage(f.db, message);
    const raw = f.db.pluck<string>('SELECT meta_json FROM chat_v2_messages WHERE id = ?1', ['msg_meta_order'])!;
    const meta = JSON.parse(raw) as Record<string, { generationPlan?: Record<string, unknown> }>;
    expect(Object.keys(meta)).toEqual(['executionSnapshot', 'canonicalContent', 'inboundOrigin']);
    expect(Object.keys(meta.executionSnapshot!.generationPlan!)).toEqual(['planner', 'imageBudget', 'historyImageBudget']);
  });

  it('meta_json executionSnapshot is serde ModelExecutionSnapshot: None requestedModelId/executionRoute/reason omitted, declared order', () => {
    createSession(f.db, newSession('sess_meta_snapshot', 'chat'));
    const state = (reason: string | null) => ({ reason, indexCompatible: true, protocolCompatible: true,
      circuitOpen: false, healthy: true, configured: true });
    // Producer order and nulls as chat-pipeline freeze-execution.ts writes them before the route is compiled.
    const executionSnapshot = {
      frozenAt: 1730937600123, executionRoute: null, requestedModelId: null,
      generationPlan: { historyImageBudget: 4, imageBudget: 8, auxiliaryMultimodalConfigId: null,
        planner: { degraded: false, usesOcr: false, sendsOriginalImages: false, fallbackFrom: null, activeModel: 'text', route: 'text_model_direct' } },
      capabilitySnapshot: { ocr: state('not configured'), multimodalModel: state(null), textModel: state(null),
        multimodalEmbedding: state(null), textEmbedding: state(null) },
      resolvedModelIsMultimodal: false, resolvedModelName: 'model', resolvedModelId: 'cfg',
    };
    const message = { id: 'msg_meta_snapshot', sessionId: 'sess_meta_snapshot', role: 'assistant' as const, blockIds: [],
      timestamp: 1, _meta: { executionSnapshot } } as unknown as ChatMessage;
    createMessage(f.db, message);
    const raw = f.db.pluck<string>('SELECT meta_json FROM chat_v2_messages WHERE id = ?1', ['msg_meta_snapshot'])!;
    const rustState = (reason?: string) => `{"configured":true,"healthy":true,"circuitOpen":false,"protocolCompatible":true,"indexCompatible":true${reason === undefined ? '' : `,"reason":"${reason}"`}}`;
    expect(raw).toBe('{"executionSnapshot":{"resolvedModelId":"cfg","resolvedModelName":"model","resolvedModelIsMultimodal":false,'
      + `"capabilitySnapshot":{"textEmbedding":${rustState()},"multimodalEmbedding":${rustState()},"textModel":${rustState()},"multimodalModel":${rustState()},"ocr":${rustState('not configured')}},`
      + '"generationPlan":{"planner":{"route":"text_model_direct","activeModel":"text","fallbackFrom":null,"sendsOriginalImages":false,"usesOcr":false,"degraded":false},'
      + '"imageBudget":8,"historyImageBudget":4},"frozenAt":1730937600123}}');
  });
});
