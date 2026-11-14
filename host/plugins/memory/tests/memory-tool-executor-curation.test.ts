import { afterEach, describe, expect, it } from 'vitest';
import { AgentToolExecutorRegistry } from '../../agent-skills/api.ts';
import type { ExecutionContext, ToolExecutor } from '../../chat/api.ts';
import { localDate } from '../src/daily-log.ts';
import { MEMORY_TOOL_NAMES } from '../src/memory-executor.ts';
import { MEMORY_EXECUTABLE_TOOL_NAMES } from '../src/memory-tool-executor.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import { setupMemoryHost, type MemoryHost } from './support.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

async function setup() {
  const registry = new AgentToolExecutorRegistry();
  current = await setupMemoryHost({
    agentTools: { registerToolExecutors: executors => registry.register(executors) },
    memoryDecision: () => '{"event":"ADD"}',
  });
  const executor = registry.all().find(entry => entry.name() === 'MemoryToolExecutor') as ToolExecutor;
  return { ...current, executor, service: current.host.ctx.memory as unknown as MemoryServiceImpl };
}

async function call(executor: ToolExecutor, name: string, args: unknown, options: { signal?: AbortSignal | null; window?: boolean } = {}) {
  const signal = options.signal ?? null;
  const ctx = {
    session_id: 'sess_c', message_id: 'msg_c', block_id: 'blk_c', tool_call_id: 'call_c', cancellation_token: signal,
    isCancelled: () => signal?.aborted ?? false,
    tryWindow: () => (options.window === false ? null : { window: 'main', webview: 'main' }),
    runId: () => 'run_c',
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined, emitToolCallError: () => undefined,
    saveToolBlock: () => { throw new Error('memory tools do not persist tool blocks themselves'); },
  } as unknown as ExecutionContext;
  const result = await executor.execute({ id: 'call_c', name, arguments: args }, ctx);
  return { result, output: result.output as Record<string, any> };
}

async function writeNote(executor: ToolExecutor, title: string, content: string, folder = '经历') {
  const written = await call(executor, 'memory_write', { title, content, folder });
  const noteId = written.output.note_id as string;
  const read = await call(executor, 'memory_read', { note_id: noteId });
  return { noteId, updatedAt: read.output.updated_at as string };
}

function structured(error: string | null | undefined): Record<string, any> {
  return JSON.parse(error!) as Record<string, any>;
}

describe('MemoryToolExecutor curation tools', () => {
  it('claims all 16 Rust memory tools', async () => {
    const { executor } = await setup();
    expect([...MEMORY_EXECUTABLE_TOOL_NAMES].sort()).toEqual([...MEMORY_TOOL_NAMES].sort());
    for (const name of MEMORY_TOOL_NAMES) expect(executor.canHandle(`builtin-${name}`)).toBe(true);
  });

  it('memory_write_smart filters sensitive/oversized input and writes facts through the smart path with tool_call audit', async () => {
    const { executor, db } = await setup();
    const sensitive = await call(executor, 'memory_write_smart', { title: '电话', content: '手机号 13812345678' });
    expect(sensitive.result.success).toBe(true);
    expect(sensitive.output).toEqual({ note_id: '', event: 'FILTERED', is_new: false, confidence: 1,
      reason: '内容包含敏感信息（手机号/身份证/银行卡/邮箱/密码），已拦截。请勿在记忆中存储个人敏感信息。', downgraded: false });
    const long = await call(executor, 'memory_write_smart', { title: '长事实', content: '很'.repeat(201) });
    expect(long.output.reason).toBe("原子事实记忆内容过长（超过 200 字）。请拆分为多条简短事实，或使用 memory_type='study' / 'note'。");
    expect(db.pluck("SELECT COUNT(*) FROM memory_audit_log WHERE source = 'tool_call' AND event = 'FILTERED'")).toBe(2);
    const studyLong = await call(executor, 'memory_write_smart', { title: '长学习', content: '很'.repeat(4001), memory_type: 'study' });
    expect(studyLong.output.reason).toBe('学习记忆内容过长（超过 4000 字）。请精简或拆分为多条。');

    const invalid = await call(executor, 'memory_write_smart', { title: 't', content: 'c', memory_type: 'Fact' });
    expect(invalid.result).toMatchObject({ success: false, error: "Invalid memory_type 'Fact': expected fact, study, or note" });
    expect((await call(executor, 'memory_write_smart', { content: 'c' })).result.error).toBe("Missing 'title' parameter");

    const added = await call(executor, 'memory_write_smart', { title: '偏好', content: '喜欢用图解学几何', folder: '偏好' });
    expect(added.output).toMatchObject({ event: 'ADD', is_new: true, downgraded: false });
    expect(added.output.note_id).toMatch(/\S/);
    const replay = await call(executor, 'memory_write_smart', { title: '偏好', content: '喜欢用图解学几何', folder: '偏好' });
    expect(replay.output.note_id).toBe(added.output.note_id);
    expect(db.pluck("SELECT session_id FROM memory_audit_log WHERE source = 'tool_call' AND operation = 'write_smart' AND event = 'ADD'"))
      .toBe('sess_c');
  });

  it('memory_write_batch writes fact/study/note items with Rust counters and per-item results', async () => {
    const { executor } = await setup();
    const batch = await call(executor, 'memory_write_batch', { folder: '学习', items: [
      { title: '函数', content: '二次函数顶点式' },
      { title: '经验', content: '错题先归因再重做', memory_type: 'note', folder_path: '经验' },
      { title: '事实', content: '高三理科生', memory_type: 'fact' },
    ] });
    expect(batch.output).toMatchObject({ total: 3, succeeded: 3, failed: 0, added: 3, updated: 0, skipped: 0, filtered: 0 });
    expect(batch.output.results.map((item: Record<string, unknown>) => [item.title, item.event]))
      .toEqual([['函数', 'ADD'], ['经验', 'ADD'], ['事实', 'ADD']]);
    expect(Object.keys(batch.output.results[0])).toEqual(['title', 'note_id', 'event', 'is_new', 'confidence', 'reason', 'downgraded']);
    const listed = await call(executor, 'memory_list', { folder: '经验' });
    expect(listed.output.items.map((item: { title: string }) => item.title)).toEqual(['经验']);
    expect((await call(executor, 'memory_write_batch', { items: [{ content: 'x' }] })).result.error)
      .toBe("Each batch item requires 'title'");
    expect((await call(executor, 'memory_write_batch', {})).result.error).toBe("Missing 'items' parameter");
  });

  it('memory_batch_move moves with per-note OCC, reports conflicts structurally and emits memory://changed', async () => {
    const { executor, host } = await setup();
    const a = await writeNote(executor, '甲', '内容甲');
    const b = await writeNote(executor, '乙', '内容乙');
    const moved = await call(executor, 'memory_batch_move', {
      note_ids: [a.noteId, b.noteId], target_folder_path: ' 归档 ',
      expected_updated_at_by_id: { [a.noteId]: a.updatedAt, [b.noteId]: '2000-01-01T00:00:00.000Z' },
    });
    expect(moved.result.success).toBe(false);
    expect(moved.result.error).toBe('memory operation failed');
    expect(moved.output).toMatchObject({ success: false, total: 2, processed: 2, remaining: 0, succeeded: 1, failed: 1,
      cancelled: false, target_folder_path: '归档', reversible: true,
      messageKey: 'chat.tools.memory.batch_move_completed', messageParams: { succeeded: 1, failed: 1, total: 2 } });
    expect(moved.output.results[0]).toMatchObject({ success: true, note_id: a.noteId, previous_folder_path: '经历', folder_path: '归档' });
    expect(moved.output.results[1]).toMatchObject({ success: false, note_id: b.noteId,
      error: { code: 'MEMORY_CONFLICT', action: 'batch_move', retryable: false, current: [{ note_id: b.noteId, title: '乙', folder_path: '经历' }] } });
    expect(moved.output.undo).toEqual([{ tool: 'builtin-memory_batch_move', note_ids: [a.noteId], target_folder_path: '经历',
      expected_updated_at_by_id: { [a.noteId]: moved.output.results[0].updated_at } }]);
    expect(host.eventsNamed('memory://changed')).toEqual([{ source: 'agent', action: 'batch_move', entityIds: [a.noteId], runId: 'run_c' }]);
    expect((await call(executor, 'memory_read', { note_id: a.noteId })).output.folder_path).toBe('归档');

    const cancelled = new AbortController();
    cancelled.abort();
    const early = await call(executor, 'memory_batch_move', {}, { signal: cancelled.signal });
    expect(structured(early.result.error)).toMatchObject({ code: 'MEMORY_INVALID_ARGS', field: 'cancellation',
      messageFallback: { 'zh-CN': '批量移动在开始前已取消' } });
    const tooLong = await call(executor, 'memory_batch_move', { note_ids: [a.noteId], target_folder_path: 'x'.repeat(1001),
      expected_updated_at_by_id: { [a.noteId]: 'v' } });
    expect(structured(tooLong.result.error)).toMatchObject({ field: 'target_folder_path' });
  });

  it('memory_add_relation/remove_relation maintain _ref tags with OCC, undo payloads and events', async () => {
    const { executor, host, db } = await setup();
    const a = await writeNote(executor, '甲', '内容甲');
    const b = await writeNote(executor, '乙', '内容乙');
    const same = await call(executor, 'memory_add_relation', { note_id_a: a.noteId, note_id_b: ` ${a.noteId} `,
      expected_updated_at_a: a.updatedAt, expected_updated_at_b: a.updatedAt });
    expect(structured(same.result.error)).toMatchObject({ code: 'MEMORY_INVALID_ARGS', field: 'note_id_b' });
    const missingVersion = await call(executor, 'memory_add_relation', { note_id_a: a.noteId, note_id_b: b.noteId });
    expect(structured(missingVersion.result.error)).toMatchObject({ field: 'expected_updated_at_a' });

    const added = await call(executor, 'memory_add_relation', { note_id_a: a.noteId, note_id_b: b.noteId,
      expected_updated_at_a: a.updatedAt, expected_updated_at_b: b.updatedAt });
    expect(added.output).toMatchObject({ success: true, changed: true, reversible: true,
      note_a: { note_id: a.noteId, related_note_ids: [b.noteId] }, note_b: { note_id: b.noteId, related_note_ids: [a.noteId] },
      messageKey: 'chat.tools.memory.relation_added', messageParams: { changed: true } });
    expect(added.output.undo).toEqual({ tool: 'builtin-memory_remove_relation', note_id_a: a.noteId, note_id_b: b.noteId,
      expected_updated_at_a: added.output.note_a.updated_at, expected_updated_at_b: added.output.note_b.updated_at });
    expect(db.pluck("SELECT session_id FROM memory_audit_log WHERE source = 'tool_call' AND operation = 'add_relation'")).toBe('sess_c');

    const stale = await call(executor, 'memory_add_relation', { note_id_a: a.noteId, note_id_b: b.noteId,
      expected_updated_at_a: a.updatedAt, expected_updated_at_b: b.updatedAt });
    expect(structured(stale.result.error)).toMatchObject({ code: 'MEMORY_CONFLICT', action: 'add_relation',
      current: [{ note_id: a.noteId }, { note_id: b.noteId }] });

    const removed = await call(executor, 'memory_remove_relation', { ...added.output.undo });
    expect(removed.output).toMatchObject({ success: true, changed: true, note_a: { related_note_ids: [] },
      undo: { tool: 'builtin-memory_add_relation' }, messageKey: 'chat.tools.memory.relation_removed' });
    const noop = await call(executor, 'memory_remove_relation', { note_id_a: a.noteId, note_id_b: b.noteId,
      expected_updated_at_a: removed.output.note_a.updated_at, expected_updated_at_b: removed.output.note_b.updated_at });
    expect(noop.output).toMatchObject({ success: true, changed: false, reversible: false, undo: null });
    expect(host.eventsNamed('memory://changed').map((event: any) => event.action)).toEqual(['add_relation', 'remove_relation']);
    const missing = await call(executor, 'memory_add_relation', { note_id_a: a.noteId, note_id_b: 'note_missing',
      expected_updated_at_a: 'v', expected_updated_at_b: 'v' });
    expect(structured(missing.result.error)).toMatchObject({ code: 'MEMORY_NOT_FOUND', current: [{ note_id: a.noteId }, null] });
  });

  it('memory_update_tags keeps system tags, optionally clears _stale and always emits memory://changed', async () => {
    const { executor, host, db } = await setup();
    const a = await writeNote(executor, '甲', '内容甲');
    await new Promise(resolve => { setImmediate(resolve); });
    // Tag rewrite without touching updated_at, after memory_read's record_used has settled.
    db.run('UPDATE notes SET tags = ?1 WHERE id = ?2', [JSON.stringify(['_type:study', '_stale', '_last_hit:5', 'old']), a.noteId]);
    const version = a.updatedAt;
    const updated = await call(executor, 'memory_update_tags', { note_id: a.noteId, expected_updated_at: version,
      tags: ['几何', ' 几何 ', '_hits:9', '代数'], remove_stale: true });
    expect(updated.output).toMatchObject({ success: true, note_id: a.noteId, user_tags: ['几何', '代数'],
      system_tags_preserved: true, stale_removed: true, reversible: true, messageKey: 'chat.tools.memory.tags_updated' });
    expect(updated.output.tags).toEqual(['_type:study', '几何', '代数']);
    expect(updated.output.undo).toEqual({ tool: 'builtin-memory_update_tags', note_id: a.noteId, tags: ['old'],
      expected_updated_at: updated.output.updated_at });
    expect(db.pluck("SELECT reason FROM memory_audit_log WHERE source = 'tool_call' AND operation = 'update_tags' AND reason IS NOT NULL"))
      .toBe('移除 _stale 标记（用户确认记忆仍然有效）');
    const plain = await call(executor, 'memory_update_tags', { note_id: a.noteId, expected_updated_at: updated.output.updated_at,
      tags: [], remove_stale: true });
    expect(plain.output).toMatchObject({ stale_removed: false, tags: ['_type:study'] });
    expect(host.eventsNamed('memory://changed')).toHaveLength(2);
    const conflict = await call(executor, 'memory_update_tags', { note_id: a.noteId, expected_updated_at: version, tags: [] });
    expect(structured(conflict.result.error)).toMatchObject({ code: 'MEMORY_CONFLICT', action: 'update_tags' });
    expect(structured((await call(executor, 'memory_update_tags', { note_id: a.noteId, expected_updated_at: 'v' })).result.error))
      .toMatchObject({ field: 'tags' });
  });

  it('memory_log_activity appends once per day and validates the 80-character bound', async () => {
    const { executor } = await setup();
    const first = await call(executor, 'memory_log_activity', { activity: '  完成二次函数练习  ' });
    expect(first.output).toMatchObject({ success: true, appended: true, date: localDate(), reason: expect.any(String),
      messageKey: 'chat.tools.memory.activity_logged', messageParams: { appended: true } });
    expect(first.output.note_id).toMatch(/\S/);
    const again = await call(executor, 'memory_log_activity', { activity: '完成二次函数练习' });
    expect(again.output).toMatchObject({ success: true, appended: false, note_id: first.output.note_id,
      messageKey: 'chat.tools.memory.activity_skipped' });
    expect(structured((await call(executor, 'memory_log_activity', { activity: '长'.repeat(81) })).result.error))
      .toMatchObject({ code: 'MEMORY_INVALID_ARGS', field: 'activity' });
    expect(structured((await call(executor, 'memory_log_activity', { activity: '   ' })).result.error))
      .toMatchObject({ field: 'activity', messageFallback: { 'zh-CN': '缺少必需参数 activity' } });
  });

  it('memory_export_all pages real content with truncation flags', async () => {
    const { executor } = await setup();
    await writeNote(executor, '甲', '内容甲');
    await call(executor, 'memory_write_smart', { title: '长学习', content: '字'.repeat(2001), memory_type: 'study' });
    const page = await call(executor, 'memory_export_all', { page_size: 1 });
    expect(page.output).toMatchObject({ success: true, page: 1, page_size: 1, returned: 1, has_more: true, next_page: 2,
      content_limit_chars: 2000, messageKey: 'chat.tools.memory.export_page_ready', messageParams: { page: 1, returned: 1, hasMore: true } });
    const last = await call(executor, 'memory_export_all', { page: 2, page_size: 1 });
    expect(last.output).toMatchObject({ returned: 1, has_more: false, next_page: null });
    const all = [page.output.items[0], last.output.items[0]];
    expect(all.some(item => item.content_truncated === true && Array.from(item.content as string).length === 2000)).toBe(true);
    expect(page.output.truncated || last.output.truncated).toBe(true);
    expect(structured((await call(executor, 'memory_export_all', { page: 0 })).result.error)).toMatchObject({ field: 'page' });
  });

  it('learner_profile_get/update round-trip the structured profile with the reject limit policy', async () => {
    const { executor, db } = await setup();
    const none = await call(executor, 'learner_profile_get', {});
    expect(none.output).toEqual({ found: false,
      hint: '学习者画像尚未建立。可通过 learner_profile_update 写入首批内容，或等待系统从每日学习日志自动晋升。' });
    const empty = await call(executor, 'learner_profile_update', { preferences: null });
    expect(empty.result).toMatchObject({ success: false,
      error: '更新内容为空：请至少提供 weak_points_add / preferences / goals_add / recent_status 之一。' });
    const invalid = await call(executor, 'learner_profile_update', { goals_add: 'x' });
    expect(invalid.result.error).toMatch(/^Invalid learner_profile_update arguments: /);
    const sensitive = await call(executor, 'learner_profile_update', { recent_status: '联系 13812345678' });
    expect(sensitive.result.error).toBe('更新内容包含敏感信息（手机号/身份证/银行卡/邮箱/密码），已拦截。');

    const update = await call(executor, 'learner_profile_update', {
      weak_points_add: [{ subject: '数学', knowledge_point: '配方', error_pattern: '符号错误', evidence_count: 2 }],
      goals_add: [{ goal: '数学 130' }], recent_status: '冲刺期',
    });
    expect(update.output).toMatchObject({ success: true, changed: true, version: 1, reason: '画像已更新' });
    expect(update.output.rendered_chars).toBeGreaterThan(0);
    const unchanged = await call(executor, 'learner_profile_update', { recent_status: '冲刺期' });
    expect(unchanged.output).toMatchObject({ success: true, changed: false, reason: '更新与当前画像一致，无变更' });
    expect(db.pluck("SELECT COUNT(*) FROM memory_audit_log WHERE source = 'tool_call'")).toBeGreaterThan(0);

    const got = await call(executor, 'learner_profile_get', {});
    expect(got.output).toMatchObject({ found: true, version: 1 });
    expect(got.output.profile).toEqual({ version: 1, updated_at: got.output.updated_at,
      weak_points: [{ subject: '数学', knowledge_point: '配方', error_pattern: '符号错误', evidence_count: 2, last_seen: null }],
      preferences: { explanation_style: null, language: null, pace: null, others: [] },
      goals: [{ goal: '数学 130', deadline: null }], recent_status: '冲刺期' });
    expect(got.output.rendered_markdown).toContain('# 学习者画像（v1');

    const huge = await call(executor, 'learner_profile_update', { recent_status: '状'.repeat(500),
      goals_add: Array.from({ length: 10 }, (_, i) => ({ goal: `${'目标'.repeat(200)}${i}` })) });
    expect(huge.result.success).toBe(false);
    expect(huge.output).toMatchObject({ success: false, max_chars: 4000 });
    expect(huge.output.rendered_chars).toBeGreaterThan(4000);
    expect(huge.output.error).toContain('画像是策展层而非日志');
    expect(huge.output.error).toContain('当前画像全文（用于决定合并/移除对象）：\n# 学习者画像（v1');
    expect(huge.output.current_profile).toContain('# 学习者画像（v1');
  });

  it('memory_write_batch runs bounded concurrently in input order and aborts early on cancellation', async () => {
    const { executor, service } = await setup();
    const started: string[] = [];
    const origWriteSmart = service.writeSmart.bind(service);
    let inFlight = 0;
    let peakInFlight = 0;

    service.writeSmart = (async (...args: Parameters<MemoryServiceImpl['writeSmart']>) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      started.push(args[1]);
      // Delay earlier items longer to verify output ordering stays in input order.
      const delayMs = args[1] === 'F1' ? 35 : 5;
      await new Promise(resolve => { setTimeout(resolve, delayMs); });
      try {
        return await origWriteSmart(...args);
      } finally {
        inFlight -= 1;
      }
    }) as MemoryServiceImpl['writeSmart'];

    const batch = await call(executor, 'memory_write_batch', {
      memory_type: 'fact',
      items: [
        { title: 'F1', content: 'fact one' },
        { title: 'F2', content: 'fact two' },
        { title: 'F3', content: 'fact three' },
        { title: 'F4', content: 'fact four' },
        { title: 'F5', content: 'fact five' },
        { title: 'S6', content: 'study six', memory_type: 'study' },
      ],
    });
    expect(batch.result.success).toBe(true);
    expect(batch.output.total).toBe(6);
    expect(batch.output.succeeded).toBe(6);
    expect((batch.output.results as Array<{ title: string }>).map(r => r.title)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'S6']);
    expect(peakInFlight).toBeGreaterThan(1);
    expect(peakInFlight).toBeLessThanOrEqual(4);

    const controller = new AbortController();
    let slowStarted = false;
    service.writeSmart = (async () => {
      slowStarted = true;
      return await new Promise<never>(() => undefined);
    }) as MemoryServiceImpl['writeSmart'];
    const pending = call(executor, 'memory_write_batch', {
      memory_type: 'fact',
      items: Array.from({ length: 8 }, (_, i) => ({ title: `C${i}`, content: `content ${i}` })),
    }, { signal: controller.signal });
    await new Promise(resolve => { setTimeout(resolve, 20); });
    expect(slowStarted).toBe(true);
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.result.success).toBe(false);
    expect(cancelled.result.error).toContain('cancelled');
  });
});
