import { describe, expect, it } from 'vitest';
import type { ExecutionContext, ToolCall, ToolResultInfo } from '../../chat/api.ts';
import { ToolPackExecutor, createToolPackSubContext, type ToolPackRegistry } from '../src/tool-pack-executor.ts';

type Event = [string, string, unknown];

function harness(options: {
  dispatch?: (call: ToolCall, ctx: ExecutionContext) => Promise<ToolResultInfo>;
  dispatcher?: boolean; registry?: ToolPackRegistry | null; graceMs?: number; parent?: AbortSignal;
} = {}) {
  const events: Event[] = [], saved: ToolResultInfo[] = [], seen: ExecutionContext[] = [], logs: string[] = [];
  const dispatch = options.dispatch ?? (async call => ({ toolCallId: call.id, blockId: 'x', toolName: call.name,
    input: call.arguments, output: { ok: call.name }, success: true, durationMs: 5 }));
  const ctx = {
    session_id: 'sess_parent', message_id: 'msg', block_id: 'blk', tool_call_id: 'run_1',
    cancellation_token: options.parent ?? null, shell_guard_approved: true, shell_authority_admission: ['full', 'p'],
    admitted_tool_dispatcher: options.dispatcher === false ? null
      : { dispatchWithAdmission: (call: ToolCall, sub: ExecutionContext) => { seen.push(sub); return dispatch(call, sub); } },
    emitToolCallStart(this: ExecutionContext, name: string, input: unknown, id: string | null) { events.push([this.block_id, 'start', [name, id]]); },
    emitToolCallEnd(this: ExecutionContext, result: unknown) { events.push([this.block_id, 'end', result]); },
    emitToolCallError(this: ExecutionContext, error: string) { events.push([this.block_id, 'error', error]); },
    saveToolBlock(result: ToolResultInfo) { saved.push(result); },
  } as unknown as ExecutionContext;
  const registry: ToolPackRegistry = {
    hasSpecificExecutor: name => ['builtin-note_read', 'builtin-qbank_list', 'builtin-ask_user', 'custom_tool'].includes(name),
    isNoTimeoutTool: name => name === 'builtin-ask_user',
  };
  const executor = new ToolPackExecutor({ registry: () => options.registry === undefined ? registry : options.registry,
    log: { info: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) },
    ...(options.graceMs === undefined ? {} : { cancelGraceMs: options.graceMs }) });
  const run = (args: unknown) => executor.execute({ id: 'pack_call', name: 'builtin-tool_pack', arguments: args }, ctx);
  return { executor, ctx, run, events, saved, seen, logs };
}

const sub = (name: string, args?: unknown) => (args === undefined ? { name } : { name, args });

describe('tool_pack_executor.rs ToolPackExecutor', () => {
  it('rejects malformed packs with the Rust messages and closes the pack block', async () => {
    const cases: [unknown, string, Parameters<typeof harness>[0]?][] = [
      [{ tools: [sub('note_read')] }, 'ToolExecutorRegistry has been dropped', { registry: null }],
      [{ tools: [sub('note_read')] }, 'tool_pack requires the central admitted tool dispatcher', { dispatcher: false }],
      [{}, "tool_pack requires a 'tools' array in arguments"],
      [{ tools: [] }, 'tool_pack requires at least 1 sub-tool'],
      [{ tools: Array.from({ length: 21 }, () => sub('note_read')) }, 'tool_pack supports at most 20 sub-tools, got 21'],
      [{ tools: [sub('note_read'), { args: {} }] }, "sub-tool 1 missing 'name' field"],
      [{ tools: [sub('tool_pack')] }, 'tool_pack cannot invoke itself (recursive call)'],
      [{ tools: [sub('builtin-missing')] }, "tool 'builtin-missing' not found in tool registry"],
      [{ tools: [sub('missing')] }, "tool 'missing' not found in tool registry"],
      [{ tools: [sub('ask_user')] }, "tool_pack cannot execute blocking/no-timeout tool 'builtin-ask_user'"],
    ];
    for (const [args, message, options] of cases) {
      const h = harness(options);
      await expect(h.run(args)).rejects.toThrow(message);
      expect(h.events).toEqual([['blk', 'start', ['builtin-tool_pack', 'pack_call']], ['blk', 'error', message]]);
      expect(h.seen).toEqual([]);
    }
  });

  it('dispatches children through central admission with fresh sub-contexts and aggregates in index order', async () => {
    const h = harness({ dispatch: async (call, ctx) => {
      if (call.name === 'builtin-qbank_list') {
        await new Promise(resolve => setTimeout(resolve, 20));
        return { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
          output: null, success: false, error: 'denied by policy', durationMs: 1 };
      }
      if (call.name === 'custom_tool') throw new Error('executor exploded');
      return { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments,
        output: { title: 'n' }, success: true, durationMs: 3 };
    } });
    const result = await h.run({ tools: [sub('qbank_list', { page: 1 }), sub('builtin-note_read', null), sub('custom_tool')], timeout: 0 });
    expect(h.logs).toContain('[ToolPack] timeout value 0 out of range, using default 300s');
    expect(h.seen.map(ctx => [ctx.session_id, ctx.block_id, ctx.tool_call_id, ctx.shell_guard_approved, ctx.shell_authority_admission]))
      .toEqual(expect.arrayContaining([
        ['sess_parent', 'blk-tool_pack-0', 'run_1', false, null],
        ['sess_parent', 'blk-tool_pack-1', 'run_1', false, null],
        ['sess_parent', 'blk-tool_pack-2', 'run_1', false, null]]));
    expect(h.seen.every(ctx => ctx.cancellation_token instanceof AbortSignal && !ctx.cancellation_token.aborted)).toBe(true);
    expect(result).toMatchObject({ toolCallId: 'pack_call', blockId: 'blk', toolName: 'builtin-tool_pack', success: true });
    const output = result.output as Record<string, any>;
    expect(Object.keys(output)).toEqual(['total_ms', 'succeeded', 'failed', 'status', 'results']);
    expect(output).toMatchObject({ succeeded: 1, failed: 2, status: 'partial' });
    expect(output.results.map((r: Record<string, unknown>) => Object.keys(r))[0])
      .toEqual(['index', 'tool_call_id', 'tool_name', 'success', 'output', 'error', 'duration_ms', 'block_id']);
    expect(output.results.map((r: Record<string, unknown>) => [r.index, r.tool_call_id, r.tool_name, r.success, r.error]))
      .toEqual([[0, 'blk-tp-0', 'builtin-qbank_list', false, 'denied by policy'],
        [1, 'blk-tp-1', 'builtin-note_read', true, null],
        [2, 'blk-tp-2', 'custom_tool', false, 'executor exploded']]);
    expect(h.seen.find(ctx => ctx.block_id === 'blk-tool_pack-1')).toBeDefined();
    expect(h.saved.map(r => [r.toolName, r.error])).toEqual(expect.arrayContaining([
      ['builtin-qbank_list', 'denied by policy'], ['custom_tool', 'executor exploded']]));
    expect(h.saved).toHaveLength(2);
    expect(h.events).toContainEqual(['blk-tool_pack-2', 'error', 'executor exploded']);
    expect(h.events.filter(([block, kind]) => block === 'blk-tool_pack-2' && kind === 'start')).toEqual([]);
    expect(h.events.at(-1)).toEqual(['blk', 'end', { result: output, durationMs: output.total_ms }]);
  });

  it('reports a pack where every child failed as a failure with up to three bounded samples', async () => {
    const long = 'x'.repeat(400);
    const h = harness({ dispatch: async call => { throw new Error(call.name === 'builtin-note_read' ? long : 'nope'); } });
    const result = await h.run({ tools: [sub('note_read'), sub('qbank_list'), sub('custom_tool'), sub('note_read')] });
    const summary = `tool_pack 全部 4 个子工具执行失败 / all 4 sub-tool(s) failed. Sample failures: builtin-note_read: ${'x'.repeat(300)} | builtin-qbank_list: nope | custom_tool: nope`;
    expect(result).toMatchObject({ success: false, error: summary, output: { succeeded: 0, failed: 4, status: 'all_failed' } });
    expect(h.events.at(-1)).toEqual(['blk', 'error', summary]);
  });

  it('runs at most ten children at once', async () => {
    let active = 0, peak = 0;
    const h = harness({ dispatch: async (call, ctx) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
      return { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output: 1, success: true, durationMs: 1 };
    } });
    const result = await h.run({ tools: Array.from({ length: 20 }, () => sub('note_read')) });
    expect(peak).toBe(10);
    expect(result.output).toMatchObject({ succeeded: 20, status: 'ok' });
  });

  it('times out stragglers after the grace period and cancels children when the parent is cancelled', async () => {
    const hang = (_call: ToolCall, ctx: ExecutionContext) => new Promise<ToolResultInfo>(() => { void ctx; });
    const h = harness({ graceMs: 20, dispatch: async (call, ctx) => call.name === 'builtin-note_read' ? hang(call, ctx)
      : ({ toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, output: 1, success: true, durationMs: 1 }) });
    const timed = await h.run({ tools: [sub('note_read'), sub('qbank_list')], timeout: 1 });
    expect(timed.output).toMatchObject({ status: 'partial', results: [
      { index: 0, success: false, error: 'tool_pack timeout: sub-tool did not complete within grace period', duration_ms: 1000 },
      { index: 1, success: true }] });
    expect(h.seen[0]!.cancellation_token!.aborted).toBe(true);
    expect(h.events).toContainEqual(['blk-tool_pack-0', 'start', ['builtin-note_read', 'blk-tp-0']]);

    const parent = new AbortController();
    const c = harness({ graceMs: 20, parent: parent.signal, dispatch: hang });
    const running = c.run({ tools: [sub('note_read'), sub('qbank_list')] });
    await new Promise(resolve => setTimeout(resolve, 10));
    parent.abort();
    const cancelled = await running;
    expect(cancelled).toMatchObject({ success: false, output: { status: 'all_failed', results: [
      { error: 'Tool execution was cancelled' }, { error: 'Tool execution was cancelled' }] } });
    expect(c.logs).toContain('[ToolPack] Pack cancelled, draining completed sub-tools');
  }, 10_000);

  it('sub-contexts keep the parent session for the tree budget and the executor metadata matches Rust', () => {
    const { executor, ctx } = harness();
    const child = createToolPackSubContext(ctx, 'sub-block', new AbortController().signal);
    expect([child.session_id, child.block_id, child.shell_guard_approved]).toEqual(['sess_parent', 'sub-block', false]);
    expect(ctx.block_id).toBe('blk');
    expect([executor.name(), executor.canHandle('tool_pack'), executor.canHandle('builtin-tool_pack'), executor.canHandle('builtin-note_read'),
      executor.sensitivityLevel(), executor.managesCancellation()]).toEqual(['ToolPackExecutor', true, true, false, 'low', true]);
  });
});
