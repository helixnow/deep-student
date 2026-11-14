import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { ChatV2Emitter, BackendEventsSink } from '../api.ts';
import { newSession } from '../src/types.ts';
import type { BackendEvent, ToolResultInfo } from '../api.ts';

describe('tools/executor.rs ExecutionContext production factory', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => {
    f = databaseFixture(); host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    host.ctx.chatSession.createSession(newSession('sess_ctx', 'chat'));
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  function context() {
    return host.ctx.chatSession.createExecutionContext({ sessionId: 'sess_ctx', messageId: 'msg_ctx', blockId: 'blk_ctx',
      services: host.ctx, emitter: ChatV2Emitter.withSinkAndBatching(new BackendEventsSink(host.ctx.backendEvents), 'sess_ctx', false),
      toolRegistry: { async detectToolConflicts() { return []; }, stripMcpNamespace: name => name,
        async callTool() { throw new Error('This context test does not dispatch MCP tools'); } },
    });
  }
  function result(): ToolResultInfo {
    return { blockId: 'blk_result', toolName: 'builtin-rag_search', input: null, output: { text: 'result' }, success: true, durationMs: 120 };
  }
  it('defaults retain optional window, feature flags, cancellation and run ID semantics', () => {
    const ctx = context();
    expect(ctx.hasFrontend()).toBe(false); expect(ctx.tryWindow()).toBeNull();
    expect(() => ctx.windowRef()).toThrow('ExecutionContext.window_ref() called without a Tauri window');
    expect(ctx.isCancelled()).toBe(false); expect(ctx.runId()).toBe('blk_ctx');
    ctx.tool_call_id = ''; expect(ctx.runId()).toBe('blk_ctx');
    ctx.tool_call_id = 'call_1'; expect(ctx.runId()).toBe('call_1');
    expect([ctx.memory_enabled, ctx.rag_enabled, ctx.web_search_enabled]).toEqual([true, true, true]);
    ctx.tauri_window = { window: 'main', webview: 'main' };
    expect(ctx.hasFrontend()).toBe(true); expect(ctx.windowRef()).toEqual(ctx.tryWindow());
  });
  it('scoped cancellation clones skill values and shares host services without cancelling the parent', () => {
    const ctx = context(); const parent = new AbortController(); const child = new AbortController();
    ctx.cancellation_token = parent.signal; ctx.skill_contents = { skill: 'body' };
    ctx.execution_allowed_tools = ['read']; ctx.shell_guard_approved = true;
    const scoped = ctx.scopedWithCancellationToken(child.signal);
    expect(scoped.services).toBe(ctx.services); expect(scoped.emitter).toBe(ctx.emitter);
    expect(scoped.shell_guard_approved).toBe(true);
    scoped.skill_contents!.skill = 'changed'; scoped.execution_allowed_tools!.push('write');
    expect(ctx.skill_contents).toEqual({ skill: 'body' }); expect(ctx.execution_allowed_tools).toEqual(['read']);
    child.abort(); expect(scoped.isCancelled()).toBe(true); expect(ctx.isCancelled()).toBe(false);
  });
  it('saveToolBlock preserves foreign keys, type mapping, timings and atomic block-id append', () => {
    const ctx = context(); ctx.chat_v2_db = host.ctx.chatSession.database;
    ctx.saveToolBlock(result()); ctx.saveToolBlock(result());
    const message = host.ctx.chatSession.getMessage('msg_ctx')!;
    expect(message.role).toBe('assistant'); expect(message.blockIds).toEqual(['blk_result']);
    const block = host.ctx.chatSession.getBlock('blk_result')!;
    expect(block).toMatchObject({ type: 'rag', status: 'success', toolInput: null, toolOutput: { text: 'result' } });
    expect(block.endedAt! - block.startedAt!).toBe(120); expect(block.firstChunkAt).toBe(block.startedAt);
    expect(f.db.pluck('SELECT block_index FROM chat_v2_blocks WHERE id = ?', ['blk_result'])).toBe(0);
    ctx.saveToolBlock({ ...result(), blockId: 'blk_error', success: false, error: 'tool failed' });
    expect(host.ctx.chatSession.getBlock('blk_error')).toMatchObject({ status: 'error', error: 'tool failed' });
    expect(host.ctx.chatSession.getMessage('msg_ctx')?.blockIds).toEqual(['blk_result', 'blk_error']);
  });
  it('missing DB/result block ID warn and return before any database write', () => {
    const ctx = context(); const warnings: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { if (message.type === 'warn') warnings.push(String(message.args[0])); } });
    ctx.saveToolBlock(result()); ctx.chat_v2_db = host.ctx.chatSession.database;
    const { blockId: _id, ...withoutBlock } = result(); ctx.saveToolBlock(withoutBlock);
    expect(warnings).toEqual(['[ExecutionContext] chat_v2_db not set, skipping tool block save',
      '[ExecutionContext] block_id not set in result, skipping tool block save']);
    expect(host.ctx.chatSession.getMessage('msg_ctx')).toBeNull();
  });
  it('append failure propagates after the block is already persisted', () => {
    const ctx = context(); ctx.chat_v2_db = host.ctx.chatSession.database;
    f.db.exec("CREATE TRIGGER fail_append BEFORE UPDATE ON chat_v2_messages BEGIN SELECT RAISE(FAIL, 'append blocked'); END");
    expect(() => ctx.saveToolBlock(result())).toThrow('append blocked');
    expect(host.ctx.chatSession.getBlock('blk_result')).not.toBeNull();
    expect(host.ctx.chatSession.getMessage('msg_ctx')?.blockIds).toEqual([]);
  });
  it('tool lifecycle carries event metadata while progress uses variantless NDJSON chunks', () => {
    const ctx = context(); ctx.variant_id = 'var_1'; ctx.skill_state_version = 3; ctx.round_id = 'round_1';
    ctx.emitToolCallStart('tool', { a: 1 }, null); ctx.emitToolCallEnd({ success: true }); ctx.emitToolCallError('bad');
    ctx.emitToolProgress('reading', 120, ''); ctx.emitToolProgressPayload({ papers: ['a'] });
    const events = host.eventsNamed('chat_v2_event_sess_ctx') as BackendEvent[];
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({ type: 'tool_call', phase: 'start', messageId: 'msg_ctx', blockId: 'blk_ctx',
      variantId: 'var_1', skillStateVersion: 3, roundId: 'round_1', payload: { toolName: 'tool', toolInput: { a: 1 }, toolCallId: null } });
    expect(events[1]).toMatchObject({ phase: 'end', variantId: 'var_1', skillStateVersion: 3, roundId: 'round_1' });
    expect(events[2]).toMatchObject({ phase: 'error', variantId: 'var_1', error: 'bad' });
    expect(events[3]).toMatchObject({ phase: 'chunk', chunk: '{"progress":{"phase":"reading","percent":100}}\n' });
    expect(JSON.parse(JSON.stringify(events[3]))).not.toHaveProperty('variantId');
    expect(events[4]).toMatchObject({ chunk: '{"papers":["a"]}\n' });
  });
});
