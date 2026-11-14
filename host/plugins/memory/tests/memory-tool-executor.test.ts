import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentToolExecutorRegistry } from '../../agent-skills/api.ts';
import type { ExecutionContext, ToolExecutor } from '../../chat/api.ts';
import { MEMORY_TOOL_NAMES } from '../src/memory-executor.ts';
import { MEMORY_EXECUTABLE_TOOL_NAMES, parseWriteMode } from '../src/memory-tool-executor.ts';
import { invalidArgs } from '../src/memory-tools-curation.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import { setupMemoryHost, type MemoryHost } from './support.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

async function setup(withLlm = true) {
  const registry = new AgentToolExecutorRegistry();
  current = await setupMemoryHost({
    agentTools: { registerToolExecutors: executors => registry.register(executors) },
    ...(withLlm ? { memoryDecision: () => '{"event":"ADD"}' } : {}),
  });
  const executor = registry.all().find(entry => entry.name() === 'MemoryToolExecutor') as ToolExecutor;
  return { ...current, executor, service: current.host.ctx.memory as unknown as MemoryServiceImpl };
}

function context(signal: AbortSignal | null = null) {
  const recorded = { starts: 0, ends: [] as unknown[], errors: [] as string[] };
  const ctx = {
    block_id: 'blk_m', tool_call_id: 'call_m', cancellation_token: signal,
    isCancelled: () => signal?.aborted ?? false, tryWindow: () => ({ window: 'main', webview: 'main' }),
    runId: () => 'call_m',
    emitToolCallStart: () => { recorded.starts += 1; },
    emitToolCallEnd: (result: unknown) => { recorded.ends.push(result); },
    emitToolCallError: (error: string) => { recorded.errors.push(error); },
    saveToolBlock: () => { throw new Error('memory tools do not persist tool blocks themselves'); },
  } as unknown as ExecutionContext;
  return { ctx, recorded };
}

async function call(executor: ToolExecutor, name: string, args: unknown, signal: AbortSignal | null = null) {
  const { ctx, recorded } = context(signal);
  const result = await executor.execute({ id: 'call_m', name, arguments: args }, ctx);
  return { result, recorded, output: result.output as Record<string, any> };
}

describe('MemoryToolExecutor', () => {
  it('claims only the executable memory tools, which are a subset of the frontend tool set', async () => {
    const skill = readFileSync('src/features/chat/skills/builtin-tools/vfs-memory.ts', 'utf8');
    const schemas = [...skill.slice(skill.indexOf('embeddedTools')).matchAll(/name: 'builtin-([a-z_]+)'/g)].map(m => m[1]);
    expect(schemas.sort()).toEqual([...MEMORY_TOOL_NAMES].sort());
    const { executor } = await setup();
    for (const name of MEMORY_TOOL_NAMES) {
      expect([name, executor.canHandle(`builtin-${name}`)])
        .toEqual([name, (MEMORY_EXECUTABLE_TOOL_NAMES as readonly string[]).includes(name)]);
    }
    expect(executor.sensitivityLevel!('memory_delete')).toBe('medium');
    expect(executor.concurrencyClass!('memory_read')).toBe('read_only');
    const warnings: string[] = [];
    expect(['update', ' Append ', 'create', 'bogus'].map(mode => parseWriteMode(mode, m => warnings.push(m))))
      .toEqual(['update', 'append', 'create', 'create']);
    expect(warnings).toEqual(["[Memory] Unknown WriteMode 'bogus', defaulting to Create"]);
  });

  it('writes, reads, appends, lists, updates and deletes memories with tool_call audit rows', async () => {
    const { executor, db } = await setup();
    const written = await call(executor, 'builtin-memory_write', { title: '数学弱项', content: '数学是弱项', folder: '经历' });
    expect(written.output).toMatchObject({ success: true, is_new: true });
    expect(written.recorded.ends).toHaveLength(1);
    const noteId = written.output.note_id as string;
    const read = await call(executor, 'memory_read', { note_id: noteId });
    expect(read.output).toMatchObject({ found: true, note_id: noteId, title: '数学弱项', content: '数学是弱项',
      folder_path: '经历', related_note_ids: [] });
    expect(Array.isArray(read.output.tags)).toBe(true);
    await call(executor, 'memory_write', { note_id: noteId, mode: 'append', content: '函数也弱' });
    expect((await call(executor, 'memory_read', { note_id: noteId })).output.content).toBe('数学是弱项\n\n函数也弱');
    const updated = await call(executor, 'memory_update_by_id', { note_id: noteId, title: '数学与函数' });
    expect(updated.output).toEqual({ success: true, note_id: noteId, is_new: false });
    const listed = await call(executor, 'memory_list', { limit: 1 });
    expect(listed.output).toMatchObject({ count: 1, limit: 1, offset: 0, has_more: false, next_offset: null });
    expect(listed.output.items[0]).toMatchObject({ id: noteId, title: '数学与函数' });
    const missing = await call(executor, 'memory_read', { note_id: 'note_missing' });
    expect(missing.output).toEqual({ found: false, note_id: 'note_missing' });
    const deleted = await call(executor, 'memory_delete', { note_id: noteId });
    expect(deleted.output).toEqual({ success: true, note_id: noteId });
    expect((await call(executor, 'memory_read', { note_id: noteId })).output.found).toBe(false);
    const audit = db.all<{ source: string; operation: string }>(
      "SELECT source, operation FROM memory_audit_log WHERE source = 'tool_call' ORDER BY rowid");
    expect(audit.map(row => row.operation)).toEqual(expect.arrayContaining(['write', 'update', 'delete']));
  });

  it('memory_read records the _used usage signal asynchronously without touching updated_at (record_used)', async () => {
    const { executor, db } = await setup();
    const written = await call(executor, 'memory_write', { title: '英语作文', content: '议论文结构松散', folder: '经历' });
    const noteId = written.output.note_id as string;
    db.run("UPDATE notes SET tags = ?1 WHERE id = ?2", [JSON.stringify(['_type:fact', '_used:x', '_stale', '_last_hit:1']), noteId]);
    const before = db.get<{ updated_at: string }>('SELECT updated_at FROM notes WHERE id = ?1', [noteId])!.updated_at;
    const read = await call(executor, 'memory_read', { note_id: noteId });
    expect(read.output.tags).toEqual(['_type:fact', '_used:x', '_stale', '_last_hit:1']);
    await new Promise(resolve => { setImmediate(resolve); });
    await call(executor, 'memory_read', { note_id: noteId });
    await new Promise(resolve => { setImmediate(resolve); });
    const row = db.get<{ tags: string; updated_at: string }>('SELECT tags, updated_at FROM notes WHERE id = ?1', [noteId])!;
    const tags = JSON.parse(row.tags) as string[];
    expect(tags.slice(0, 2)).toEqual(['_type:fact', '_used:2']);
    expect(tags).toHaveLength(3);
    expect(tags[2]).toMatch(/^_last_hit:\d{13}$/);
    expect(row.updated_at).toBe(before);

    db.run("UPDATE notes SET title = '__user_profile__', tags = '[]' WHERE id = ?1", [noteId]);
    await call(executor, 'memory_read', { note_id: noteId });
    await new Promise(resolve => { setImmediate(resolve); });
    expect(db.get<{ tags: string }>('SELECT tags FROM notes WHERE id = ?1', [noteId])!.tags).toBe('[]');
  });

  it('maps business failures and argument errors to tool failures like Rust', async () => {
    const { executor, db } = await setup();
    const sensitive = await call(executor, 'memory_write', { title: '联系方式', content: '我的手机号是 13812345678' });
    expect(sensitive.result).toMatchObject({ success: false,
      error: '内容包含敏感信息，已拦截。请勿在记忆中存储个人敏感信息。',
      output: { success: false, error: '内容包含敏感信息，已拦截。请勿在记忆中存储个人敏感信息。' } });
    expect(sensitive.recorded.errors).toEqual(['内容包含敏感信息，已拦截。请勿在记忆中存储个人敏感信息。']);
    expect(db.pluck("SELECT COUNT(*) FROM memory_audit_log WHERE source = 'tool_call' AND event = 'FILTERED'")).toBe(1);
    const cases: [string, unknown, string][] = [
      ['memory_read', {}, "Missing 'note_id' parameter"],
      ['memory_search', {}, "Missing 'query' parameter"],
      ['memory_write', { title: 't' }, "Missing 'content' parameter"],
      ['memory_update_by_id', { note_id: 'n' }, "Missing 'title' or 'content' parameter"],
      ['memory_add_relation', {}, invalidArgs('note_id_a', '缺少必需参数 note_id_a', 'Required parameter note_id_a is missing.')],
      ['memory_bogus', {}, 'Unknown memory tool: memory_bogus'],
    ];
    for (const [name, args, error] of cases) {
      const { result } = await call(executor, name, args);
      expect({ name, success: result.success, error: result.error, output: result.output })
        .toEqual({ name, success: false, error, output: null });
    }
    const pagination = await call(executor, 'memory_list', { limit: 21 });
    expect(JSON.parse(pagination.result.error!)).toMatchObject({ code: 'MEMORY_INVALID_ARGS', field: 'limit' });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await call(executor, 'memory_list', {}, controller.signal);
    expect(cancelled.result.error).toBe('Memory list cancelled before start');
  });

  it('requires the LLM manager like Rust get_service', async () => {
    const { executor } = await setup(false);
    const { result } = await call(executor, 'memory_list', {});
    expect(result).toMatchObject({ success: false, error: 'LLM manager not available' });
  });
});
