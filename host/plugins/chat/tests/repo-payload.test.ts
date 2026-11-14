import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, MessageMeta, ReplaySkillPayloadSnapshot, ToolResultInfo } from '../api.ts';
import { databaseFixture } from './database-fixture.ts';
import { createSession } from '../repository/sessions.ts';
import { createMessage, getMessage, updateMessage, loadSessionMessagesWindow } from '../repository/messages.ts';
import { createBlock } from '../repository/blocks.ts';
import { loadSessionTail, loadSessionTailWithBudget } from '../repository/load-session.ts';
import { newSession } from '../src/types.ts';

function runtime(reverse = false): ReplaySkillPayloadSnapshot {
  const schema = (name: string) => ({ name, description: `${name} 的说明`, inputSchema: { type: 'object' } });
  const keys = Array.from({ length: 8 }, (_, i) => i);
  if (reverse) keys.reverse();
  return { activeSkillIds: ['skill-a'],
    skillDependencies: Object.fromEntries(keys.map(i => [`skill-${i}`, [`dep-${i}`]])),
    skillEmbeddedTools: Object.fromEntries(keys.map(i => [`skill-${i}`, [schema(`tool_${i}`)]])),
    mcpToolSchemas: [schema('builtin-rag_search')] };
}
function result(blockId: string | null): ToolResultInfo {
  return { toolCallId: 'call_469', blockId, toolName: 'builtin-rag_search', input: { query: '资料' },
    output: { sources: ['x'.repeat(4096)] }, success: true, durationMs: 12,
    reasoningContent: '先检索', thoughtSignature: 'sig-469' };
}

describe('repo.rs #469 persisted payload regressions', () => {
  let f: ReturnType<typeof databaseFixture>;
  beforeEach(() => { f = databaseFixture(); });
  afterEach(() => f.dispose());
  const message = (id: string, sessionId: string): ChatMessage => ({ id, sessionId, role: 'assistant', timestamp: 1, blockIds: [] });
  function rawMeta(id: string): MessageMeta {
    return JSON.parse(f.db.pluck<string>('SELECT meta_json FROM chat_v2_messages WHERE id = ?', [id])!);
  }
  function seed(sessionId: string, count: number, payload: number) {
    createSession(f.db, newSession(sessionId, 'chat'));
    f.db.transaction(tx => {
      for (let i = 0; i < count; i++) {
        const id = `${sessionId}_msg_${String(i).padStart(2, '0')}`;
        const blockId = `${sessionId}_blk_${String(i).padStart(2, '0')}`;
        createMessage(tx, { id, sessionId, timestamp: 1000 + i, role: i % 2 === 0 ? 'user' : 'assistant', blockIds: [blockId] });
        createBlock(tx, { id: blockId, messageId: id, type: 'content', status: 'success', content: 'x'.repeat(payload) });
      }
    });
  }

  it('test_issue469_meta_write_collapses_duplicate_runtime_and_slims_tool_results', () => {
    createSession(f.db, newSession('sess_issue469_write', 'chat'));
    const value = message('msg_issue469_write', 'sess_issue469_write');
    value._meta = { skillRuntimeBefore: runtime(), skillRuntimeAfter: runtime(true),
      toolResults: [result('blk_issue469_tool'), result(null)] };
    createMessage(f.db, value);
    const raw = rawMeta(value.id);
    expect(raw.skillRuntimeBefore).toBeDefined();
    expect(raw.skillRuntimeAfter).toBeUndefined();
    expect(raw.toolResults![0]!.output).toBeNull();
    expect(raw.toolResults![0]!.input).toBeNull();
    expect(raw.toolResults![0]!.thoughtSignature).toBe('sig-469');
    expect(raw.toolResults![0]!.reasoningContent).toBe('先检索');
    expect(raw.toolResults![0]!.blockId).toBe('blk_issue469_tool');
    expect((raw.toolResults![1]!.output as { sources: unknown }).sources).toBeInstanceOf(Array);
    const meta = getMessage(f.db, value.id)!._meta!;
    expect(meta.skillRuntimeAfter ?? meta.skillRuntimeBefore).toEqual(runtime());
    const changed = runtime();
    changed.activeSkillIds!.push('skill-b');
    value._meta = { skillRuntimeBefore: runtime(), skillRuntimeAfter: changed };
    updateMessage(f.db, value);
    expect(rawMeta(value.id).skillRuntimeBefore).toBeDefined();
    expect(rawMeta(value.id).skillRuntimeAfter).toBeDefined();
    const reloaded = getMessage(f.db, value.id)!._meta!;
    expect(reloaded.skillRuntimeAfter ?? reloaded.skillRuntimeBefore).toEqual(changed);
  });

  it('test_issue469_legacy_duplicated_meta_row_reads_back_slim_and_replayable', () => {
    createSession(f.db, newSession('sess_issue469_legacy', 'chat'));
    const value = message('msg_issue469_legacy', 'sess_issue469_legacy');
    createMessage(f.db, value);
    const meta = { skillRuntimeBefore: runtime(), skillRuntimeAfter: runtime(true),
      toolResults: [result('blk_issue469_legacy_tool')] };
    const variants = [{ id: 'var_legacy', modelId: 'model-a', status: 'pending', blockIds: [], createdAt: 0,
      meta: { skillRuntimeBefore: runtime(), skillRuntimeAfter: runtime(true) } }];
    f.db.run('UPDATE chat_v2_messages SET meta_json = ?, variants_json = ? WHERE id = ?',
      [JSON.stringify(meta), JSON.stringify(variants), value.id]);
    const loaded = getMessage(f.db, value.id)!;
    expect(loaded._meta!.skillRuntimeAfter).toBeUndefined();
    expect(loaded._meta!.skillRuntimeAfter ?? loaded._meta!.skillRuntimeBefore).toEqual(runtime());
    expect(loaded._meta!.toolResults![0]!.output).toBeNull();
    expect(loaded._meta!.toolResults![0]!.thoughtSignature).toBe('sig-469');
    expect(loaded._meta!.toolResults![0]!.reasoningContent).toBe('先检索');
    expect(loaded.variants![0]!.meta!.skillRuntimeAfter).toBeUndefined();
    expect(loaded.variants![0]!.meta!.skillRuntimeBefore).toEqual(runtime());
    const wire = JSON.parse(JSON.stringify(loaded));
    expect(wire._meta).toHaveProperty('skillRuntimeBefore');
    expect(wire._meta).not.toHaveProperty('skillRuntimeAfter');
  });

  it('test_issue469_tail_window_is_capped_by_payload_budget', () => {
    seed('sess_issue469_heavy', 26, 10_000);
    const response = loadSessionTailWithBudget(f.db, 'sess_issue469_heavy', 80, 35_000);
    expect(response.totalMessageCount).toBe(26);
    const ids = response.messages.map(m => m.id);
    expect(ids).toEqual(['sess_issue469_heavy_msg_23', 'sess_issue469_heavy_msg_24', 'sess_issue469_heavy_msg_25']);
    expect(response.blocks).toHaveLength(3);
    expect(response.blocks.every(block => ids.includes(block.messageId))).toBe(true);
    const start = 26 - response.messages.length;
    const page = loadSessionMessagesWindow(f.db, 'sess_issue469_heavy', start - 3, 3, null);
    expect(page.total).toBe(26);
    expect(page.messages.map(m => m.id)).toEqual(['sess_issue469_heavy_msg_20', 'sess_issue469_heavy_msg_21', 'sess_issue469_heavy_msg_22']);
    const minimum = loadSessionTailWithBudget(f.db, 'sess_issue469_heavy', 80, 1);
    expect(minimum.messages).toHaveLength(2);
    expect(minimum.totalMessageCount).toBe(26);
  });

  it('test_issue469_light_session_tail_unchanged', () => {
    seed('sess_issue469_light', 26, 200);
    const light = loadSessionTail(f.db, 'sess_issue469_light', 80);
    expect(light.messages).toHaveLength(26);
    expect(light.totalMessageCount).toBeUndefined();
    seed('sess_issue469_long', 30, 200);
    const long = loadSessionTail(f.db, 'sess_issue469_long', 10);
    expect(long.messages).toHaveLength(10);
    expect(long.totalMessageCount).toBe(30);
    expect(long.messages[0]!.id).toBe('sess_issue469_long_msg_20');
  });
});
