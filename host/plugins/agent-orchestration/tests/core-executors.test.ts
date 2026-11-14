import { describe, expect, it } from 'vitest';
import { handleAskUserResponse, type ExecutionContext, type ToolResultInfo } from '../../chat/api.ts';
import { AttemptCompletionExecutor } from '../src/attempt-completion-executor.ts';
import { AskUserExecutor, parseAskUserOptions } from '../src/ask-user-executor.ts';
import { TodoListExecutor, todoSessionKey } from '../src/todo-executor.ts';
import { GoalExecutor } from '../src/goal-executor.ts';
import { CoordinatorSleepExecutor } from '../src/coordinator-sleep-executor.ts';
import { RolePackExecutor } from '../src/role-pack-executor.ts';
import { SelfInspectExecutor } from '../src/self-inspect-executor.ts';
import { getTodoList } from '../src/todo-store.ts';
import { ATTEMPT_COMPLETION_TOOL_DESCRIPTION } from '../src/attempt-completion.ts';

const log = { info: () => {}, warn: () => {} };

interface Recorded { starts: unknown[][]; ends: unknown[]; errors: string[]; saved: ToolResultInfo[] }
function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext & { recorded: Recorded } {
  const recorded: Recorded = { starts: [], ends: [], errors: [], saved: [] };
  return {
    session_id: 'sess_1', message_id: 'msg_1', block_id: 'blk_1', variant_id: null, skill_state_version: null,
    round_id: null, tool_call_id: null, cancellation_token: null, chat_v2_db: null,
    emitToolCallStart: (...args: unknown[]) => { recorded.starts.push(args); },
    emitToolCallEnd: (payload: unknown) => { recorded.ends.push(payload); },
    emitToolCallError: (error: string) => { recorded.errors.push(error); },
    saveToolBlock: (result: ToolResultInfo) => { recorded.saved.push(result); },
    tryWindow: () => null,
    ...overrides,
    recorded,
  } as unknown as ExecutionContext & { recorded: Recorded };
}

describe('attempt_completion.rs AttemptCompletionExecutor', () => {
  it('returns task_completed and the Rust output fields, emitting under the bare tool name', async () => {
    const executor = new AttemptCompletionExecutor(log);
    const ctx = context();
    const result = await executor.execute({ id: 'c1', name: 'builtin-attempt_completion', arguments: { result: '好了' } }, ctx);
    expect(result).toMatchObject({ toolCallId: 'c1', blockId: 'blk_1', toolName: 'attempt_completion', success: true,
      output: { completed: true, result: '好了', command: null, task_completed: true } });
    expect(Object.keys(result.output as object)).toEqual(['completed', 'result', 'command', 'task_completed']);
    expect(ctx.recorded.starts[0]![0]).toBe('attempt_completion');
    expect(ctx.recorded.ends).toEqual([{ result: result.output, durationMs: result.durationMs }]);
    expect(ctx.recorded.saved).toEqual([result]);
  });

  it('rejects a missing result or malformed artifacts as a failed (saved) result, not a thrown error', async () => {
    const executor = new AttemptCompletionExecutor(log);
    const ctx = context();
    const missing = await executor.execute({ id: 'c2', name: 'attempt_completion', arguments: {} }, ctx);
    expect(missing).toMatchObject({ success: false, output: null, error: '缺少必需参数: result' });
    const bad = await executor.execute({ id: 'c3', name: 'attempt_completion', arguments: { result: 'x', artifacts: 'no' } }, ctx);
    expect(bad.success).toBe(false);
    expect(ctx.recorded.errors).toHaveLength(2);
    expect(ctx.recorded.saved).toHaveLength(2);
  });

  it('routes only builtin spellings, is low sensitivity and publishes the Rust schema', () => {
    const executor = new AttemptCompletionExecutor(log);
    expect(executor.canHandle('attempt_completion')).toBe(true);
    expect(executor.canHandle('mcp_attempt_completion')).toBe(false);
    expect(executor.sensitivityLevel('attempt_completion')).toBe('low');
    const [tool] = executor.schemaTools();
    expect(tool!.id).toBe('attempt_completion');
    expect((tool!.schema as { function: { description: string } }).function.description).toBe(ATTEMPT_COMPLETION_TOOL_DESCRIPTION);
  });
});

describe('ask_user_executor.rs AskUserExecutor', () => {
  it('parses string/object options with trimming, value/text fallbacks and stringified arrays', () => {
    expect(parseAskUserOptions({ options: [' A ', '', { value: 'B', reason: ' r ' }, { text: 'C', reason: '  ' }, { label: '  ' }, 3] }))
      .toEqual([{ label: 'A' }, { label: 'B', reason: 'r' }, { label: 'C' }]);
    expect(parseAskUserOptions({ options: '["x", {"label": "y"}]' })).toEqual([{ label: 'x' }, { label: 'y' }]);
    expect(parseAskUserOptions({})).toEqual([]);
  });

  it('waits without timeout for the matching response and reports it in Rust field order', async () => {
    const executor = new AskUserExecutor(log);
    const ctx = context();
    const running = executor.execute({ id: 'ask_1', name: 'builtin-ask_user',
      arguments: { question: 'Q?', options: ['a', 'b'], multiple: true, timeoutSeconds: 5 } }, ctx);
    expect(handleAskUserResponse({ toolCallId: 'ask_1', selectedTexts: ['a', 'b'], selectedIndices: [0, 1],
      customText: 'more', source: 'mixed' })).toBe(true);
    const result = await running;
    expect(result.output).toEqual({ question: 'Q?', selected: ['a', 'b'], selected_indices: [0, 1], custom_text: 'more',
      source: 'mixed', options: [{ label: 'a' }, { label: 'b' }], multiple: true });
    expect(Object.keys(result.output as object)).toEqual(
      ['question', 'selected', 'selected_indices', 'custom_text', 'source', 'options', 'multiple']);
    expect(ctx.recorded.saved).toEqual([result]);
  });

  it('cancellation withdraws the waiter and resolves as channel_closed', async () => {
    const executor = new AskUserExecutor(log);
    const controller = new AbortController();
    const running = executor.execute({ id: 'ask_2', name: 'ask_user', arguments: { question: 'Q' } },
      context({ cancellation_token: controller.signal }));
    controller.abort();
    expect((await running).output).toMatchObject({ selected: [], selected_indices: [], custom_text: null, source: 'channel_closed' });
    expect(handleAskUserResponse({ toolCallId: 'ask_2', selectedTexts: [], selectedIndices: [], customText: null,
      source: 'user_click' })).toBe(false);
  });

  it('fails fast with channel_closed in non-interactive contexts and guards null cancellation_token with fallback timeout', async () => {
    const executor = new AskUserExecutor(log, 30);
    const headlessCtx = context({ hasFrontend: () => false });
    const headless = await executor.execute(
      { id: 'ask_headless', name: 'ask_user', arguments: { question: 'Q?' } },
      headlessCtx,
    );
    expect(headless.output).toMatchObject({ source: 'channel_closed', selected: [] });
    expect(headlessCtx.recorded.starts).toHaveLength(1);
    expect(headlessCtx.recorded.ends).toHaveLength(1);
    expect(headlessCtx.recorded.saved).toEqual([headless]);

    const noSignalCtx = context({ cancellation_token: null });
    const timedOut = await executor.execute(
      { id: 'ask_nosig', name: 'ask_user', arguments: { question: 'Q?' } },
      noSignalCtx,
    );
    expect(timedOut.output).toMatchObject({ source: 'channel_closed', selected: [] });
    expect(noSignalCtx.recorded.ends).toHaveLength(1);
    expect(noSignalCtx.recorded.saved).toEqual([timedOut]);
  });

  it('preserves optional html, ui and title in output when provided while allowing empty options', async () => {
    const executor = new AskUserExecutor(log);
    const ctx = context();
    const running = executor.execute({
      id: 'ask_rich_1',
      name: 'builtin-ask_user',
      arguments: {
        question: 'Select layout',
        title: 'Layout Picker',
        ui: 'root = Stack([Button("Apply", "primary", "apply")])',
        html: '<div class="oc-box">Canvas</div>',
      },
    }, ctx);
    expect(handleAskUserResponse({
      toolCallId: 'ask_rich_1',
      selectedTexts: ['Apply'],
      selectedIndices: [],
      customText: JSON.stringify({ button: 'Apply', value: 'apply', values: {} }),
      source: 'mixed',
    })).toBe(true);
    const result = await running;
    expect(result.output).toEqual({
      question: 'Select layout',
      selected: ['Apply'],
      selected_indices: [],
      custom_text: JSON.stringify({ button: 'Apply', value: 'apply', values: {} }),
      source: 'mixed',
      options: [],
      multiple: false,
      html: '<div class="oc-box">Canvas</div>',
      ui: 'root = Stack([Button("Apply", "primary", "apply")])',
      title: 'Layout Picker',
    });
  });
});

describe('todo_executor.rs TodoListExecutor', () => {
  it('isolates parallel variants and falls back to the message id for an empty session', () => {
    expect(todoSessionKey({ session_id: 's', message_id: 'm', variant_id: null })).toBe('s');
    expect(todoSessionKey({ session_id: 's', message_id: 'm', variant_id: 'v' })).toBe('s:v');
    expect(todoSessionKey({ session_id: '', message_id: 'm', variant_id: 'v' })).toBe('m');
  });

  it('init/add/update/get follow Rust ids, aliases, insertion and continue_execution', async () => {
    let now = 1_000;
    const executor = new TodoListExecutor(log, () => ++now);
    const ctx = context({ session_id: 'todo_sess' });
    const call = (name: string, args: unknown) => executor.execute({ id: name, name, arguments: args }, ctx);
    const init = await call('todo_init', { title: 'T', steps: [{ description: 'a' }, {}] });
    expect(init.output).toMatchObject({ totalSteps: 2, isAllDone: false, continue_execution: true,
      steps: [{ id: 'step_1', description: 'a', status: 'pending', createdAt: 1001 }, { id: 'step_2', description: '未命名步骤' }] });
    expect((init.output as { steps: object[] }).steps[0]).not.toHaveProperty('result');
    const added = await call('builtin-todo_add', { description: 'mid', afterStepId: 'step_1' });
    expect((added.output as { steps: { id: string }[] }).steps.map(step => step.id)).toEqual(['step_1', 'step_3', 'step_2']);
    await call('todo_update', { stepId: 'step_1', status: 'in_progress' });
    await call('todo_update', { stepId: 'step_3', status: 'skip' });
    const update = await call('todo_update', { stepId: 'step_2', status: 'error', result: 'boom' });
    expect(update.output).toMatchObject({ newStatus: 'error', progress: '0/3', isAllDone: false, continue_execution: true,
      nextStep: null });
    const get = await call('todo_get', {});
    expect(get.output).toMatchObject({ progress: '0/3', currentRunning: { id: 'step_1', status: 'running' } });
    const done = await call('todo_update', { stepId: 'step_1', status: 'completed' });
    expect(done.output).toMatchObject({ isAllDone: true, message: '🎉 所有任务已完成！', continue_execution: false });
    expect(getTodoList('todo_sess')?.steps.map(step => step.status)).toEqual(['completed', 'skipped', 'failed']);
  });

  it('reports Rust error strings as failed results', async () => {
    const executor = new TodoListExecutor(log);
    const ctx = context({ session_id: 'todo_missing' });
    const errors = await Promise.all([
      executor.execute({ id: '1', name: 'todo_get', arguments: {} }, ctx),
      executor.execute({ id: '2', name: 'todo_init', arguments: { title: 't', steps: [] } }, ctx),
      executor.execute({ id: '3', name: 'todo_update', arguments: { stepId: 'step_1', status: 'paused' } }, ctx),
    ]);
    expect(errors.map(result => result.error)).toEqual(['未找到任务列表，请先调用 todo_init', '步骤列表不能为空', '无效的状态: paused']);
    expect(errors.every(result => result.success === false && result.output === null)).toBe(true);
  });
});

describe('sleep_executor.rs CoordinatorSleepExecutor', () => {
  function sleepHarness(wake: (resolve: (payload: unknown) => void) => void) {
    const begun: Record<string, unknown>[] = [];
    const cancelled: string[] = [];
    const manager = {
      beginSleep: (data: Record<string, unknown>) => {
        begun.push(data);
        return { wait: () => new Promise(resolve => wake(resolve)) };
      },
      checkInitialWakeConditions: () => [],
      cancel: (id: string) => { cancelled.push(id); return true; },
    };
    const coordinator = {
      listAgents: () => [{ sessionId: 'coord', role: 'coordinator' }, { sessionId: 'w1', role: 'worker' }, { sessionId: 'w2', role: 'worker' }],
      getSleepManager: () => manager,
      emitCoordinatorAwakened: () => {},
    };
    const executor = new CoordinatorSleepExecutor(coordinator as never, log);
    return { executor, begun, cancelled };
  }

  it('enriches awaiting agents from the workspace, caps the timeout and reports the wake payload', async () => {
    const { executor, begun } = sleepHarness(resolve => resolve({ sleepId: 's', awakenedBy: 'w1', reason: 'message',
      message: { senderSessionId: 'w1', content: '完成', messageType: 'result' } }));
    const ctx = context();
    const before = Date.now();
    const result = await executor.execute({ id: 'z1', name: 'builtin-coordinator_sleep',
      arguments: { workspace_id: 'ws_1', timeout_ms: 10 * 60 * 60 * 1000, wake_condition: 'all_completed' } }, ctx);
    expect(ctx.recorded.starts[0]![1]).toMatchObject({ awaiting_agents: ['w1', 'w2'] });
    expect(begun[0]).toMatchObject({ workspaceId: 'ws_1', coordinatorSessionId: 'sess_1', awaitingAgents: ['w1', 'w2'],
      wakeCondition: { type: 'all_completed' }, messageId: 'msg_1', blockId: 'blk_1', status: 'sleeping' });
    const timeoutAt = Date.parse(begun[0]!.timeoutAt as string);
    expect(timeoutAt - before).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
    expect(timeoutAt - before).toBeGreaterThan(59 * 60 * 1000);
    expect(result).toMatchObject({ success: true, output: { workspace_id: 'ws_1', awaiting_agents: ['w1', 'w2'],
      status: 'awakened', awakened_by: 'w1', awaken_message: '完成', reason: 'Message',
      message: { sender: 'w1', content: '完成', type: 'Result' } } });
    expect(ctx.recorded.ends).toHaveLength(1);
    expect(ctx.recorded.saved).toEqual([result]);
  });

  it('cancellation cancels the registered sleep and fails the call', async () => {
    const { executor, cancelled } = sleepHarness(() => {});
    const controller = new AbortController();
    const cancelCtx = context({ cancellation_token: controller.signal });
    const running = executor.execute({ id: 'z2', name: 'coordinator_sleep', arguments: { workspace_id: 'ws_1',
      awaiting_agents: ['w9'] } }, cancelCtx);
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    const result = await running;
    expect(result).toMatchObject({ success: false, error: 'Coordinator sleep cancelled', output: null });
    expect(cancelled).toHaveLength(1);
    expect(cancelCtx.recorded.errors).toEqual(['Coordinator sleep cancelled']);
    expect(cancelCtx.recorded.saved).toEqual([result]);
  });

  it('requires workspace_id and routes the builtin/workspace spellings', async () => {
    const { executor } = sleepHarness(() => {});
    const errCtx = context();
    const missing = await executor.execute({ id: 'z3', name: 'coordinator_sleep', arguments: {} }, errCtx);
    expect(missing.error).toBe('workspace_id is required');
    expect(errCtx.recorded.errors).toEqual(['workspace_id is required']);
    expect(errCtx.recorded.saved).toEqual([missing]);
    expect(executor.canHandle('workspace_coordinator_sleep')).toBe(true);
    expect(executor.canHandle('mcp_coordinator_sleep')).toBe(false);
  });

  it('emits terminal tool_call error and saves block when rejected from a subagent session', async () => {
    const { executor } = sleepHarness(() => {});
    const fakeDb = {
      getConnSafe: () => ({
        get: () => ({
          id: 'sess_1',
          mode: 'chat',
          persist_status: 'active',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          metadata_json: JSON.stringify({ is_subagent: true }),
          title_locked: 0,
        }),
      }),
    };
    const subCtx = context({ chat_v2_db: fakeDb as never });
    const rejected = await executor.execute({ id: 'z4', name: 'coordinator_sleep', arguments: { workspace_id: 'ws_1' } }, subCtx);
    expect(rejected.success).toBe(false);
    expect(subCtx.recorded.starts).toHaveLength(1);
    expect(subCtx.recorded.errors).toHaveLength(1);
    expect(subCtx.recorded.saved).toEqual([rejected]);
  });
});

describe('role_pack_executor.rs RolePackExecutor', () => {
  it('lists, gets with session provenance, and reports unknown packs as failed results', async () => {
    const executor = new RolePackExecutor(() => {});
    const ctx = context({ session_id: 'sess_rp', message_id: 'msg_rp' });
    const list = await executor.execute({ id: 'r1', name: 'builtin-role_pack_list', arguments: {} }, ctx);
    const packs = (list.output as { packs: { id: string; version: string }[] }).packs;
    expect(list.success).toBe(true);
    expect(packs.length).toBeGreaterThan(0);
    const get = await executor.execute({ id: 'r2', name: 'role_pack_get', arguments: { pack_id: packs[0]!.id } }, ctx);
    expect(get.output).toMatchObject({ pack: { id: packs[0]!.id },
      taskProvenance: { rolePackId: packs[0]!.id, sessionId: 'sess_rp', messageId: 'msg_rp', inputDigest: null } });
    const missing = await executor.execute({ id: 'r3', name: 'role_pack_get', arguments: { pack_id: 'no-such-pack' } }, ctx);
    expect(missing).toMatchObject({ success: false, output: null });
    expect(ctx.recorded.saved).toHaveLength(3);
    expect(executor.concurrencyClass('role_pack_list')).toBe('read_only');
  });
});

describe('goal_executor.rs GoalExecutor (argument and context guards)', () => {
  it('validates token_budget and the model-settable status whitelist before touching the database', async () => {
    const executor = new GoalExecutor(log);
    const ctx = context();
    const create = await executor.execute({ id: 'g1', name: 'goal_create', arguments: { objective: 'x', token_budget: 0 } }, ctx);
    expect(create.error).toBe('token_budget 必须是正整数');
    const update = await executor.execute({ id: 'g2', name: 'goal_update', arguments: { status: 'paused' } }, ctx);
    expect(update.error).toMatch(/^update_goal can only mark the existing goal complete, blocked, or waiting_user/);
    const get = await executor.execute({ id: 'g3', name: 'goal_get', arguments: {} }, ctx);
    expect(get.error).toBe('chat_v2_db unavailable in ExecutionContext');
    expect(executor.canHandle('builtin-goal_get')).toBe(true);
    expect(executor.schemaTools().map(tool => tool.id)).toEqual(['goal_create', 'goal_update', 'goal_get']);
  });
});

describe('self_inspect_executor.rs SelfInspectExecutor', () => {
  const executor = new SelfInspectExecutor(() => {});
  it('records Rust limitations when the execution context carries no main or chat database', async () => {
    const ctx = context({ main_db: null, chat_v2_db: null, skill_contents: null, skill_admission_errors: { bad: 'untrusted' },
      web_search_enabled: true } as Partial<ExecutionContext>);
    const result = await executor.execute({ id: 'si1', name: 'builtin-self_inspect', arguments: { section: ' Skills ' } }, ctx as never);
    expect(result.output).toEqual({ section: 'skills', skills: {
      registered_skills: [{ id: 'bad', content_length: null, runtime_admitted: false, admission_error: 'untrusted', loaded: null, active: null }],
      loaded_skill_ids: null, active_skill_ids: null, session_skill_state_available: false,
      note: 'registered_skills reflects this request\'s immutable runtime catalog snapshot, including rejected entries; loaded/active state was unavailable in this execution context.' },
    limitations: ['session skill state unavailable in this execution context'] });
    const search = await executor.execute({ id: 'si2', name: 'self_inspect', arguments: { section: 'search' } }, ctx as never);
    expect(search.output).toMatchObject({ section: 'search', search: { runtime_enabled: true, settings: [] },
      limitations: ['main database unavailable in this execution context'] });
    const mcp = await executor.execute({ id: 'si3', name: 'self_inspect', arguments: { section: 'mcp' } }, ctx as never);
    expect(mcp.output).toMatchObject({ mcp: { available: false, servers: [] } });
  });

  it('rejects an unknown section with the Rust error text, Low / read-only', async () => {
    const ctx = context();
    const result = await executor.execute({ id: 'si4', name: 'self_inspect', arguments: { section: 'Secrets' } }, ctx as never);
    expect(result).toMatchObject({ success: false, output: null,
      error: 'Unsupported section \'secrets\'. Allowed values: roots, skills, mcp, search, all' });
    expect([executor.canHandle('builtin-self_inspect'), executor.canHandle('self_inspect_extra')]).toEqual([true, false]);
    expect([executor.sensitivityLevel('self_inspect'), executor.concurrencyClass('self_inspect')]).toEqual(['low', 'read_only']);
  });
});
