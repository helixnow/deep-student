import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createBackgroundTasks, type BackgroundTasks } from '../../../platform/diagnostics/api.ts';
import plugin from '../index.ts';
import { ChatV2Error, goalInsertWithConn, goalUpdateStatusWithConn, type BackendSendRequest, type SendPipelinePort } from '../api.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';

describe('C04-03 goal runtime through the published chat service', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let background: BackgroundTasks;
  const requests: BackendSendRequest[] = [];
  const window = { window: 'main', webview: 'main' };
  beforeEach(async () => {
    f = databaseFixture(); background = createBackgroundTasks(); requests.length = 0;
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    goalInsertWithConn(f.db, { sessionId: 'sess_goal_runtime', goalId: 'goal_runtime', objective: '完成<高数>第3章习题 & 整理错题',
      status: 'active', tokenBudget: 100000, tokensUsed: 12345, timeUsedSeconds: 600, continuationCount: 2,
      createdAtMs: 0, updatedAtMs: 0 });
  });
  afterEach(async () => { await background.shutdown(); await host.dispose(); f.dispose(); });
  function runtime(pipeline?: SendPipelinePort | null) {
    return host.ctx.chatSession.createGoalRuntime({ state: host.ctx.chatState, background,
      pipeline: () => pipeline === null ? undefined : pipeline ?? { async execute(_source, request) {
        requests.push(request);
        expect(host.ctx.chatState.hasActiveStream(request.sessionId)).toBe(true);
        goalUpdateStatusWithConn(f.db, request.sessionId, 'goal_runtime', 'complete');
        return request.assistantMessageId!;
      } },
      resolveWindow: async () => window, events: host.ctx.backendEvents,
      // L05 owns XML escaping; only this not-yet-public provider boundary is replaced.
      escapeObjective: objective => {
        expect(objective).toBe('完成<高数>第3章习题 & 整理错题');
        return '完成&lt;高数&gt;第3章习题 &amp; 整理错题';
      },
    });
  }
  function goal() { return f.db.get<{ status: string; continuation_count: number }>('SELECT status, continuation_count FROM chat_v2_goals')!; }

  it('steering_contains_objective_budget_and_waiting_user through the actual continuation request', async () => {
    runtime().spawnContinuation(window, 'sess_goal_runtime'); await background.shutdown();
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.content).toContain('继续推进当前会话目标');
    expect(request.content).toContain('<objective>完成&lt;高数&gt;第3章习题 &amp; 整理错题</objective>');
    for (const text of ['已用 tokens：12345', '预算：100000', '剩余：87655', 'waiting_user',
      'goal_update(status="complete")', 'goal_update(status="blocked")', '不要仅因为预算将尽或准备停手就标记完成']) expect(request.content).toContain(text);
    expect(request.options).toMatchObject({ skipUserMessageSave: true, schemaToolIds: ['goal_create', 'goal_update', 'goal_get'], streamGeneration: 1n });
    expect(request.userMessageId).toBeNull(); expect(request.assistantMessageId).toMatch(/^msg_/);
    expect(goal()).toEqual({ status: 'complete', continuation_count: 3 });
    expect(host.ctx.chatState.hasActiveStream('sess_goal_runtime')).toBe(false);
  });
  it('steering_without_budget_shows_unlimited', async () => {
    f.db.run('UPDATE chat_v2_goals SET token_budget = NULL');
    runtime().spawnContinuation(window, 'sess_goal_runtime'); await background.shutdown();
    expect(requests[0]!.content).toContain('已用 tokens：12345；预算：不限');
    expect(requests[0]!.content).not.toContain('剩余：');
  });
  it('C04-03 budget checks retain a one-token margin above 2^53', async () => {
    f.db.run('UPDATE chat_v2_goals SET token_budget = ?, tokens_used = ?', [9007199254740993n, 9007199254740992n]);
    runtime().spawnContinuation(window, 'sess_goal_runtime'); await background.shutdown();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.content).toContain('已用 tokens：9007199254740992；预算：9007199254740993；剩余：1');
  });
  it('C04-03 continuation cap stops before registration and broadcasts the persisted status', async () => {
    f.db.run('UPDATE chat_v2_goals SET continuation_count = 20');
    runtime().spawnContinuation(window, 'sess_goal_runtime'); await background.shutdown();
    expect(requests).toHaveLength(0); expect(goal()).toEqual({ status: 'budget_limited', continuation_count: 20 });
    expect(host.ctx.chatState.activeStreamCount()).toBe(0);
    expect(host.events.at(-1)?.payload).toMatchObject({ eventType: 'goal_updated', goal: { status: 'budget_limited' } });
  });
  it.each(['busy', 'kill-switch', 'missing-pipeline'])('C04-03 %s leaves the active goal and count unchanged', async mode => {
    if (mode === 'busy') host.ctx.chatState.registerStream('sess_goal_runtime');
    if (mode === 'kill-switch') host.ctx.chatState.killSwitch.trip('stop');
    runtime(mode === 'missing-pipeline' ? null : undefined).spawnContinuation(window, 'sess_goal_runtime');
    await background.shutdown();
    expect(requests).toHaveLength(0); expect(goal()).toEqual({ status: 'active', continuation_count: 2 });
    expect(host.events).toHaveLength(0);
  });
  it.each(['IGNORE', "ABORT, 'claim failed'"])('C04-03 real claim failure %s releases its generation without execution', async failure => {
    f.db.exec(`CREATE TRIGGER reject_goal_claim BEFORE UPDATE OF continuation_count ON chat_v2_goals BEGIN SELECT RAISE(${failure}); END;`);
    runtime().spawnContinuation(window, 'sess_goal_runtime'); await background.shutdown();
    expect(requests).toHaveLength(0); expect(host.ctx.chatState.activeStreamCount()).toBe(0);
    expect(goal()).toEqual({ status: 'active', continuation_count: 2 });
  });
  it.each(['Cancelled', 'Llm'] as const)('C04-03 %s settles after runner cleanup', async kind => {
    const failure = kind === 'Cancelled' ? new ChatV2Error('Cancelled') : new ChatV2Error('Llm', 'failed');
    runtime({ async execute() { throw failure; } }).spawnContinuation(window, 'sess_goal_runtime'); await background.shutdown();
    expect(host.ctx.chatState.activeStreamCount()).toBe(0);
    expect(goal()).toEqual({ status: kind === 'Cancelled' ? 'paused' : 'blocked', continuation_count: 3 });
  });
  it('C04-03 settlement touches only active goals and cancellation touches only in-flight continuations', () => {
    const goals = runtime();
    const user = host.ctx.chatState.registerStream('sess_goal_runtime');
    expect(goals.cancelInFlight('sess_goal_runtime')).toBe(false); expect(user.signal.aborted).toBe(false);
    goals.settleActive(window, 'sess_goal_runtime', 'paused');
    expect(goal().status).toBe('paused');
    goals.settleActive(window, 'sess_goal_runtime', 'blocked');
    expect(goal().status).toBe('paused');
  });
});
