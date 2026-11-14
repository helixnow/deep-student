import { describe, expect, it } from 'vitest';
import {
  computeHonestSessionContextUsage,
  computeSubtreeCostAndTokens,
  computeTurnTelemetryBreakdown,
  resolveProjectSidebarActivityState,
  resolveSessionRowQuickAction,
  resolveSessionSidebarActivityState,
  type SessionActivity,
  type SessionCostRecord,
  type SidebarActivityState,
} from '../sidebarHierarchyAndTelemetry';
import { ProjectKnowledgeStore, withStepsCheck } from '../../../../../host/plugins/agent-workspace/src/project-knowledge-dag';

const checklist = '# Plan\n\n## Steps\n- [x] Read\n- [ ] Implement';

describe('sidebar concurrency projections', () => {
  const flags: Array<[keyof SessionActivity, SidebarActivityState]> = [
    ['permission', 'permission'], ['waitingInput', 'waiting_input'], ['evaluatingGoal', 'evaluating_goal'],
    ['runningMain', 'running_main'], ['runningSubagent', 'running_subagent'], ['runningShell', 'running_shell'],
    ['runningWorkflow', 'running_workflow'], ['zombie', 'zombie'], ['unread', 'unread'],
  ];

  it.each(flags)('resolves %s ahead of every lower-priority state', (flag, state) => {
    const start = flags.findIndex(([key]) => key === flag);
    const session = { id: 's', startedAt: 10, ...Object.fromEntries(flags.slice(start).map(([key]) => [key, true])) };
    const result = resolveSessionSidebarActivityState('s', new Map([['s', session]]));
    expect(result.state).toBe(state);
    expect(result.icon).toBeTruthy();
    expect(result.timerIntervalMs).toBe(state.startsWith('running_') ? 1000 : null);
    if (state.startsWith('running_')) expect(result.startedAt).toBe(10);
  });

  it.each(['waitingQuestion', 'waitingPage', 'waitingSecret'] as const)('treats %s as user input', (flag) => {
    expect(resolveSessionSidebarActivityState('s', new Map([['s', { id: 's', [flag]: true }]])).state).toBe('waiting_input');
  });

  it('bubbles deepest permission through a cycle ahead of a nearer form', () => {
    const sessions = new Map<string, SessionActivity>([
      ['root', { id: 'root', children: ['child'], runningMain: true }],
      ['child', { id: 'child', children: ['grandchild'], waitingPage: true }],
      ['grandchild', { id: 'grandchild', children: ['root'], permission: true }],
    ]);
    expect(resolveSessionSidebarActivityState('root', sessions)).toMatchObject({ state: 'permission', bubbledFromSessionId: 'grandchild' });
    expect(resolveProjectSidebarActivityState(['root'], sessions)).toMatchObject({ state: 'permission', bubbledFromSessionId: 'grandchild' });
  });

  it('discovers descendants by parent and preserves own blocking precedence', () => {
    const sessions = new Map<string, SessionActivity>([
      ['root', { id: 'root', waitingInput: true }],
      ['child', { id: 'child', parentId: 'root', waitingSecret: true }],
    ]);
    expect(resolveSessionSidebarActivityState('root', sessions).bubbledFromSessionId).toBeUndefined();
    sessions.set('root', { id: 'root', unread: true });
    expect(resolveSessionSidebarActivityState('root', sessions)).toMatchObject({ state: 'waiting_input', bubbledFromSessionId: 'child' });
  });

  it('does not bubble nonblocking activity to an idle parent, but folds project rows', () => {
    const sessions = new Map<string, SessionActivity>([
      ['root', { id: 'root' }], ['child', { id: 'child', parentId: 'root', runningShell: true }],
    ]);
    expect(resolveSessionSidebarActivityState('root', sessions).state).toBe('idle');
    expect(resolveProjectSidebarActivityState(['root', 'child'], sessions).state).toBe('running_shell');
    expect(resolveProjectSidebarActivityState([], sessions).state).toBe('idle');
    expect(resolveSessionSidebarActivityState('missing', sessions).state).toBe('idle');
  });

  it('marks unread success and switches hover actions with Shift', () => {
    expect(resolveSessionSidebarActivityState('s', new Map([['s', { id: 's', unread: true }]])).tone).toBe('success');
    expect(resolveSessionRowQuickAction(false)).toBe('archive');
    expect(resolveSessionRowQuickAction(true)).toBe('delete_permanent');
  });
});

describe('honest context and telemetry', () => {
  it('uses only the newest nonzero assistant snapshot, never sums round trips', () => {
    const result = computeHonestSessionContextUsage([
      { role: 'assistant', tokens: { input: 800 } },
      { role: 'assistant', tokens: { input: 100, cacheRead: 200, cacheWrite: 50, output: 50 } },
      { role: 'assistant', tokens: { input: 0 } },
      { role: 'user', tokens: { input: 9999 } },
    ], 1000, false);
    expect(result).toMatchObject({ state: 'measured', totalTokens: 400, percent: 40, displayPercent: '40%' });
  });

  it('leaves a dash after compaction, excluding the summarizer and old reports', () => {
    const old = { role: 'assistant', tokens: { input: 800 } };
    expect(computeHonestSessionContextUsage([old], 1000, true)).toMatchObject({ state: 'compacted', percent: null, displayPercent: '—' });
    const boundary = { role: 'assistant', compacted: true, tokens: { input: 600 } };
    expect(computeHonestSessionContextUsage([old, boundary], 1000, false).state).toBe('compacted');
    expect(computeHonestSessionContextUsage([old, boundary, { role: 'assistant', tokens: { input: 100 } }], 1000, true)).toMatchObject({ state: 'measured', percent: 10 });
    expect(computeHonestSessionContextUsage([{ ...old, afterCompaction: true }], 1000, true).state).toBe('measured');
  });

  it('does not invent empty-session usage and uses the model-limit fallback', () => {
    expect(computeHonestSessionContextUsage([], 0, false)).toMatchObject({ state: 'unknown', limit: 200_000, percent: null });
    expect(computeHonestSessionContextUsage([{ role: 'assistant', tokens: { input: 2000 } }], Number.NaN, false)).toMatchObject({ percent: 1 });
  });

  it('separates measured response delivery, tool time and real prompt-cache share', () => {
    expect(computeTurnTelemetryBreakdown({
      startedAt: 100, endedAt: 4100, input: 50, cacheRead: 100, cacheWrite: 50,
      responseTokens: 60, responseDurationMs: 1500,
      steps: [{ llmDurationMs: 1000, toolDurationMs: 200, ttftMs: 100 }, { llmDurationMs: 2000, toolDurationMs: 500, ttftMs: 300 }],
    })).toEqual({ elapsedMs: 4000, llmDurationMs: 3000, toolDurationMs: 700, avgTtftMs: 200, responseTokensPerSec: 40, cacheHitRate: 0.5 });
  });

  it('keeps missing timings unknown, not fabricated zeroes or whole-loop speed', () => {
    expect(computeTurnTelemetryBreakdown({})).toEqual({ elapsedMs: null, llmDurationMs: null, toolDurationMs: null, avgTtftMs: null, responseTokensPerSec: null, cacheHitRate: null });
    expect(computeTurnTelemetryBreakdown({ output: 30, steps: [{ llmDurationMs: 1000 }] }).responseTokensPerSec).toBeNull();
    expect(computeTurnTelemetryBreakdown({ output: 30, responseDurationMs: 0 }).responseTokensPerSec).toBeNull();
  });

  it('sums each descendant once and rounds cost only after aggregation', () => {
    const sessions = new Map<string, SessionCostRecord>([
      ['a', { id: 'a', children: ['b', 'missing'], tokens: { input: 10, output: 2 }, cost: 0.00006 }],
      ['b', { id: 'b', parentId: 'a', children: ['c'], tokens: { cacheRead: 20, cacheWrite: 3 }, cost: 0.00006 }],
      ['c', { id: 'c', children: ['a', 'b'], tokens: { output: 5 }, cost: 1.23456 }],
      ['other', { id: 'other', cost: 100 }],
    ]);
    expect(computeSubtreeCostAndTokens('a', sessions)).toEqual({ totalTokens: 40, totalCost: 1.2347 });
    expect(computeSubtreeCostAndTokens('absent', sessions)).toEqual({ totalTokens: 0, totalCost: 0 });
  });
});

describe('project notes', () => {
  it('supports length limits, expected-body conflicts, session pins and isolated reads', () => {
    const store = new ProjectKnowledgeStore();
    const note = store.saveNote({ body: 'n'.repeat(3000) });
    expect(() => store.saveNote({ body: 'n'.repeat(3001) })).toThrow();
    expect(() => store.saveNote({ body: ' ' })).toThrow();
    expect(() => store.saveNote({ body: 'new', expected: '' })).toThrowError(expect.objectContaining({ code: 'KNOWLEDGE_EXPECTED_REQUIRES_ID' }));
    expect(() => store.saveNote({ id: note.id, body: 'new', expected: 'stale' })).toThrowError(expect.objectContaining({ code: 'KNOWLEDGE_EXPECTED_CONFLICT' }));
    expect(store.listNotes()[0].body).toBe(note.body);
    store.saveNote({ id: note.id, body: 'new', expected: note.body });
    expect(store.pinToSession(note.id, 'session').sessionId).toBe('session');
    const read = store.listNotes();
    read[0].body = 'external mutation';
    expect(store.listNotes()[0].body).toBe('new');
    expect(new ProjectKnowledgeStore().listNotes()).toEqual([]);
    store.deleteNote(note.id);
    expect(store.listNotes()).toEqual([]);
  });
});

describe('DAG todos and dispatch', () => {
  it('filters ready across plan boundaries using all dependencies and retains omitted fields', () => {
    const store = new ProjectKnowledgeStore();
    const plan = store.savePlan({ body: checklist });
    const first = store.saveTodo({ body: 'first' });
    const second = store.saveTodo({ body: 'second', planId: plan.id, dependsOn: [first.id] });
    expect(store.listTodos({ ready: true, planId: plan.id })).toEqual([]);
    store.saveTodo({ id: first.id, completed: true });
    expect(store.listTodos({ ready: true, planId: plan.id }).map((todo) => todo.id)).toEqual([second.id]);
    expect(store.saveTodo({ id: second.id, body: 'updated' })).toMatchObject({ planId: plan.id, dependsOn: [first.id], completed: false });
    expect(store.saveTodo({ id: second.id, planId: null }).planId).toBeNull();
    expect(store.listTodos({ planId: null })).toHaveLength(2);
    store.saveTodo({ id: first.id, completed: false });
    expect(store.listTodos({ ready: true }).map((todo) => todo.id)).toEqual([first.id]);
  });

  it('rejects self and transitive cycles atomically as well as missing predecessors', () => {
    const store = new ProjectKnowledgeStore();
    const a = store.saveTodo({ body: 'a' });
    const b = store.saveTodo({ body: 'b', dependsOn: [a.id] });
    const c = store.saveTodo({ body: 'c', dependsOn: [b.id] });
    for (const dependency of [a.id, c.id]) {
      expect(() => store.saveTodo({ id: a.id, body: 'must not land', dependsOn: [dependency] })).toThrowError(expect.objectContaining({ code: 'KNOWLEDGE_DEPENDENCY_CYCLE' }));
    }
    expect(() => store.saveTodo({ id: a.id, dependsOn: ['missing'] })).toThrowError(expect.objectContaining({ code: 'KNOWLEDGE_NOT_FOUND' }));
    expect(store.listTodos()[0]).toMatchObject({ body: 'a', dependsOn: [] });
  });

  it('cleans incoming edges when deleting and protects stored dependency arrays', () => {
    const store = new ProjectKnowledgeStore();
    const a = store.saveTodo({ body: 'a' });
    const b = store.saveTodo({ body: 'b', dependsOn: [a.id, a.id] });
    expect(b.dependsOn).toEqual([a.id]);
    b.dependsOn.push('missing');
    store.listTodos()[1].dependsOn.push('another');
    expect(store.listTodos({ ready: true })).toHaveLength(1);
    store.deleteTodo(a.id);
    expect(store.listTodos({ ready: true })).toMatchObject([{ id: b.id, dependsOn: [] }]);
  });

  it.each(['current_session', 'new_session', 'new_worktree'] as const)('builds a ready task dispatch for %s', (target) => {
    const store = new ProjectKnowledgeStore();
    const plan = store.savePlan({ body: checklist });
    const todo = store.saveTodo({ body: 'implement', planId: plan.id });
    expect(store.buildTodoDispatchPayload(todo.id, target)).toEqual({ todoId: todo.id, target, planId: plan.id, prompt: `implement\n\n${checklist}` });
    store.saveTodo({ id: todo.id, completed: true });
    expect(() => store.buildTodoDispatchPayload(todo.id, target)).toThrowError(expect.objectContaining({ code: 'KNOWLEDGE_TODO_NOT_READY' }));
  });

  it('validates todo lengths and rejects nonexistent plan links or blocked dispatch', () => {
    const store = new ProjectKnowledgeStore();
    expect(store.saveTodo({ body: 'a'.repeat(1000) }).body).toHaveLength(1000);
    expect(() => store.saveTodo({ body: 'a'.repeat(1001) })).toThrow();
    expect(() => store.saveTodo({ body: 'a', planId: 'missing' })).toThrow();
    const first = store.saveTodo({ body: 'first' });
    const blocked = store.saveTodo({ body: 'blocked', dependsOn: [first.id] });
    expect(() => store.buildTodoDispatchPayload(blocked.id, 'new_session')).toThrow();
  });
});

describe('optimistically locked plans', () => {
  it('counts Steps tasks only, including nested tasks, ignoring fenced examples', () => {
    const result = withStepsCheck({ body: `${checklist}\n  - [X] nested\n\`\`\`md\n- [ ] example\n\`\`\`\n## Other\n- [ ] outside` });
    expect(result.progress).toEqual({ done: 2, total: 3 });
    expect(result.warning).toBeUndefined();
  });

  it.each(['# No steps\n- [ ] elsewhere', '# Plan\n## Steps\nNo tasks', '# Plan\n```md\n## Steps\n- [ ] example\n```'])('warns about a missing Steps checklist', (body) => {
    expect(new ProjectKnowledgeStore().savePlan({ body })).toMatchObject({ progress: { done: 0, total: 0 }, warning: expect.any(String) });
  });

  it('clears warnings after a repair, rejects stale writes and computes progress live', () => {
    const store = new ProjectKnowledgeStore();
    const plan = store.savePlan({ body: '# Plan' });
    expect(() => store.savePlan({ id: plan.id, body: checklist, expected: 'stale' })).toThrowError(expect.objectContaining({ code: 'KNOWLEDGE_EXPECTED_CONFLICT' }));
    expect(store.listPlans()[0].body).toBe('# Plan');
    const updated = store.savePlan({ id: plan.id, body: checklist, expected: plan.body });
    expect(updated.progress).toEqual({ done: 1, total: 2 });
    expect(updated.warning).toBeUndefined();
    updated.progress.done = 100;
    expect(store.listPlans()[0].progress.done).toBe(1);
  });

  it('separates plan markdown writes and session binds including explicit unbind', () => {
    const store = new ProjectKnowledgeStore();
    const plan = store.savePlan({ body: checklist });
    expect(() => store.savePlan({ id: plan.id, body: '# overwrite', sessionId: 'session' })).toThrow();
    expect(() => store.savePlan({ id: plan.id, expected: checklist, sessionId: 'session' })).toThrow();
    expect(() => store.savePlan({ sessionId: 'session' })).toThrow();
    expect(store.listPlans()[0]).toMatchObject({ body: checklist, sessionId: null });
    expect(store.savePlan({ id: plan.id, sessionId: 'session' }).sessionId).toBe('session');
    expect(store.savePlan({ id: plan.id, body: checklist, expected: checklist }).sessionId).toBe('session');
    expect(store.savePlan({ id: plan.id, sessionId: null }).sessionId).toBeNull();
  });

  it('enforces plan size limits, expected-on-create and cleans plan links on deletion', () => {
    const store = new ProjectKnowledgeStore();
    expect(store.savePlan({ body: 'p'.repeat(200_000) }).body).toHaveLength(200_000);
    expect(() => store.savePlan({ body: 'p'.repeat(200_001) })).toThrow();
    expect(() => store.savePlan({ body: checklist, expected: '' })).toThrow();
    const plan = store.savePlan({ body: checklist });
    store.saveTodo({ body: 'task', planId: plan.id });
    store.deletePlan(plan.id);
    expect(store.listTodos()[0].planId).toBeNull();
    expect(() => store.savePlan({ id: plan.id, body: checklist })).toThrow();
  });
});
