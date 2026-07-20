/**
 * A45-2 — taskDashboard 可操作能力 manifest 单测（docs/dev/acr/ACR-4.5.md）
 *
 * mock 制卡域 taskControl 门面（taskDashboardAgentActions 动态 import 同样被拦截），
 * 覆盖：retry/cancel 的 changed 语义、no-op 诚实回执、不可逆不注册 undo inverse、
 * 状态令牌观察、失败分段实体、targetRef 纪律与未挂载/读失败诚实路径。
 *
 * 注意：本轮（ACR 4.5）约束为「测试只写不跑」，本文件未在本轮执行过。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTask {
  id: string;
  status: string;
  segment_index: number;
  error_message: string | null;
}

/** vi.mock 工厂会被提升到 import 之前执行，共享状态必须走 vi.hoisted */
const harness = vi.hoisted(() => {
  const state = {
    tasksBySession: {} as Record<string, FakeTask[]>,
    /** 模拟后端拒绝触发的任务 id（如「任务正在处理中」） */
    retryRejects: new Set<string>(),
    cancelFails: false,
    loadFails: false,
  };
  const FAILED = ['Failed', 'Truncated', 'Cancelled'];
  const CANCELLABLE = ['Pending', 'Processing', 'Streaming', 'Paused'];
  const findTask = (taskId: string): FakeTask | undefined => {
    for (const tasks of Object.values(state.tasksBySession)) {
      const task = tasks.find((item) => item.id === taskId);
      if (task) return task;
    }
    return undefined;
  };
  const getDocumentTasks = vi.fn(async (documentId: string) => {
    if (state.loadFails) throw new Error('数据库读取失败');
    return (state.tasksBySession[documentId] ?? []).map((task) => ({ ...task }));
  });
  const isFailedTaskStatus = (status: string) => FAILED.includes(status);
  const listFailedDocumentTasks = vi.fn(async (documentId: string) => {
    const tasks = await getDocumentTasks(documentId);
    return tasks
      .filter((task) => isFailedTaskStatus(task.status))
      .sort((a, b) => a.segment_index - b.segment_index);
  });
  // 模拟真实 controlDocumentTask：retry → trigger_task_processing 状态机校验；
  // cancel → cancel_document_processing 批量转 Cancelled
  const controlDocumentTask = vi.fn(async (opts: Record<string, unknown>) => {
    if (opts.action === 'retry') {
      const task = findTask(String(opts.taskId));
      if (!task) throw new Error('任务不存在');
      if (!['Pending', ...FAILED].includes(task.status)) {
        throw new Error('任务状态不是待处理');
      }
      if (state.retryRejects.has(task.id)) {
        throw new Error('任务正在处理中，请勿重复触发');
      }
      task.status = 'Processing';
      return;
    }
    if (opts.action === 'cancel') {
      if (state.cancelFails) throw new Error('取消调度失败');
      for (const task of state.tasksBySession[String(opts.documentId)] ?? []) {
        if (CANCELLABLE.includes(task.status)) task.status = 'Cancelled';
      }
      return;
    }
    throw new Error(`unexpected action: ${String(opts.action)}`);
  });
  return { state, getDocumentTasks, listFailedDocumentTasks, controlDocumentTask, isFailedTaskStatus };
});

vi.mock('@/features/anki/taskControl', () => ({
  getDocumentTasks: harness.getDocumentTasks,
  listFailedDocumentTasks: harness.listFailedDocumentTasks,
  controlDocumentTask: harness.controlDocumentTask,
  isFailedTaskStatus: harness.isFailedTaskStatus,
  FAILED_TASK_STATUSES: ['Failed', 'Truncated', 'Cancelled'],
}));

import { taskDashboardAgentManifest } from '../agentManifests';
import {
  registerTaskDashboardAgentSurface,
  type TaskDashboardAgentSurface,
} from '../agentSurfaceRegistry';
import type {
  TaskDashboardAgentItemDetailed,
  TaskDashboardAgentSnapshotDetailed,
  TaskDashboardFocusedFailedTasks,
} from '@/features/anki-tasks/agentSurface';

const WINDOW_ID = 'task-dashboard-ops-window';
const ctx = { windowId: WINDOW_ID, typeId: 'taskDashboard', instanceKey: null };

function sessionRef(id: string): string {
  return `taskDashboard:session:${id}`;
}

function taskRef(id: string): string {
  return `taskDashboard:task:${id}`;
}

function makeSession(
  overrides: Partial<TaskDashboardAgentItemDetailed> & { id: string },
): TaskDashboardAgentItemDetailed {
  return {
    name: overrides.id,
    status: 'completed',
    sourceSessionId: null,
    updatedAt: '2026-07-20T00:00:00Z',
    totalTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
    activeTasks: 0,
    pausedTasks: 0,
    totalCards: 0,
    ...overrides,
  };
}

/** 表面快照直接投影自可变测试状态（与真实 AnkiTasksApp 的 ref 快照同构） */
const surfaceState: {
  filter: 'all' | 'active' | 'attention' | 'completed';
  focusedSessionId: string | null;
  sessions: TaskDashboardAgentItemDetailed[];
  focusedFailedTasks: TaskDashboardFocusedFailedTasks | null;
} = {
  filter: 'all',
  focusedSessionId: null,
  sessions: [],
  focusedFailedTasks: null,
};

function buildSurface(): TaskDashboardAgentSurface {
  return {
    snapshot: (): TaskDashboardAgentSnapshotDetailed => ({
      filter: surfaceState.filter,
      searchQuery: '',
      focusedSessionId: surfaceState.focusedSessionId,
      loading: false,
      sessions: surfaceState.sessions,
      totalSessions: surfaceState.sessions.length,
      focusedFailedTasks: surfaceState.focusedFailedTasks,
    }),
    focusSession: (sessionId) => {
      if (!surfaceState.sessions.some((session) => session.id === sessionId)) return false;
      surfaceState.focusedSessionId = sessionId;
      return true;
    },
    filter: (filter) => {
      surfaceState.filter = filter;
      return true;
    },
  };
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  harness.state.tasksBySession = {
    'doc-failed': [
      { id: 't-1', status: 'Failed', segment_index: 0, error_message: '上下文超限' },
      { id: 't-2', status: 'Truncated', segment_index: 1, error_message: null },
      { id: 't-3', status: 'Completed', segment_index: 2, error_message: null },
    ],
    'doc-active': [
      { id: 'a-1', status: 'Processing', segment_index: 0, error_message: null },
      { id: 'a-2', status: 'Pending', segment_index: 1, error_message: null },
      { id: 'a-3', status: 'Paused', segment_index: 2, error_message: null },
      { id: 'a-4', status: 'Completed', segment_index: 3, error_message: null },
    ],
    'doc-done': [
      { id: 'd-1', status: 'Completed', segment_index: 0, error_message: null },
    ],
  };
  harness.state.retryRejects = new Set();
  harness.state.cancelFails = false;
  harness.state.loadFails = false;
  surfaceState.filter = 'all';
  surfaceState.focusedSessionId = null;
  surfaceState.focusedFailedTasks = null;
  surfaceState.sessions = [
    makeSession({ id: 'doc-failed', name: '高数讲义', status: 'attention', totalTasks: 3, completedTasks: 1, failedTasks: 2, totalCards: 8 }),
    makeSession({ id: 'doc-active', name: '英语单词', status: 'active', totalTasks: 4, completedTasks: 1, activeTasks: 2, pausedTasks: 1, totalCards: 5 }),
    makeSession({ id: 'doc-done', name: '历史笔记', status: 'completed', totalTasks: 1, completedTasks: 1, totalCards: 3 }),
  ];
  cleanups.push(registerTaskDashboardAgentSurface(WINDOW_ID, buildSurface()));
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.clearAllMocks();
});

describe('taskDashboard manifest 能力表契约', () => {
  it('风险与可逆性如实标注：重试 medium、取消 high，全部 reversible:false', () => {
    const byName = new Map(taskDashboardAgentManifest.capabilities.map((cap) => [cap.name, cap]));
    expect(taskDashboardAgentManifest.version).toBe(3);
    expect(byName.get('retryTask')).toMatchObject({ risk: 'medium', mutates: true, reversible: false, idempotent: false });
    expect(byName.get('retryFailedTasks')).toMatchObject({ risk: 'medium', mutates: true, reversible: false, idempotent: false });
    expect(byName.get('cancelSession')).toMatchObject({ risk: 'high', mutates: true, reversible: false, idempotent: true });
  });

  it('不伪造「创建任务」能力（创建入口在 chat 制卡流）', () => {
    const names = taskDashboardAgentManifest.capabilities.map((cap) => cap.name);
    expect(names).toEqual(['focusSession', 'filter', 'retryTask', 'retryFailedTasks', 'cancelSession']);
    expect(names.some((name) => /create/i.test(name))).toBe(false);
  });
});

describe('observe 状态令牌与失败分段实体', () => {
  it('会话实体携带计数令牌，写动作按真实状态按需暴露', async () => {
    const observation = (await taskDashboardAgentManifest.observe?.(ctx)) as unknown as {
      entities: Array<{ ref: string; actions: string[]; state: Record<string, unknown> }>;
      availableActions: string[];
      state: Record<string, unknown>;
    };
    const failed = observation.entities.find((entity) => entity.ref === sessionRef('doc-failed'));
    expect(failed?.actions).toEqual(expect.arrayContaining(['focusSession', 'retryFailedTasks']));
    expect(failed?.actions).not.toContain('cancelSession');
    expect(failed?.state).toMatchObject({ failedTasks: 2, activeTasks: 0, totalTasks: 3, totalCards: 8 });
    const active = observation.entities.find((entity) => entity.ref === sessionRef('doc-active'));
    expect(active?.actions).toEqual(expect.arrayContaining(['focusSession', 'cancelSession']));
    expect(active?.actions).not.toContain('retryFailedTasks');
    const done = observation.entities.find((entity) => entity.ref === sessionRef('doc-done'));
    expect(done?.actions).toEqual(['focusSession']);
    expect(observation.availableActions).toEqual(
      expect.arrayContaining(['focusSession', 'filter', 'retryFailedTasks', 'cancelSession']),
    );
    expect(observation.state.stateTokensAvailable).toBe(true);
  });

  it('焦点会话失败分段作为 task-segment 实体暴露（含错误信息）', async () => {
    surfaceState.focusedSessionId = 'doc-failed';
    surfaceState.focusedFailedTasks = {
      sessionId: 'doc-failed',
      loading: false,
      loadError: null,
      tasks: [
        { id: 't-1', status: 'Failed', segmentIndex: 0, errorMessage: '上下文超限' },
        { id: 't-2', status: 'Truncated', segmentIndex: 1, errorMessage: null },
      ],
    };
    const observation = (await taskDashboardAgentManifest.observe?.(ctx)) as unknown as {
      entities: Array<{ ref: string; kind: string; actions: string[]; state: Record<string, unknown> }>;
      state: { focusedFailedTasks: Record<string, unknown> | null };
    };
    const segment = observation.entities.find((entity) => entity.ref === taskRef('t-1'));
    expect(segment).toMatchObject({
      kind: 'task-segment',
      actions: ['retryTask'],
      state: { sessionId: 'doc-failed', taskId: 't-1', status: 'Failed', errorMessage: '上下文超限' },
    });
    expect(observation.state.focusedFailedTasks).toMatchObject({ sessionId: 'doc-failed', loading: false, taskCount: 2 });
  });

  it('失败分段仍在加载时不暴露实体，并在 state 里诚实标注 loading', async () => {
    surfaceState.focusedSessionId = 'doc-failed';
    surfaceState.focusedFailedTasks = { sessionId: 'doc-failed', loading: true, loadError: null, tasks: [] };
    const observation = (await taskDashboardAgentManifest.observe?.(ctx)) as unknown as {
      entities: Array<{ kind: string }>;
      state: { focusedFailedTasks: { loading: boolean } | null };
    };
    expect(observation.entities.some((entity) => entity.kind === 'task-segment')).toBe(false);
    expect(observation.state.focusedFailedTasks?.loading).toBe(true);
  });

  it('旧形状表面（无状态令牌）诚实降级为只读定位，不虚报写能力', async () => {
    const legacyWindow = 'task-dashboard-legacy-window';
    cleanups.push(registerTaskDashboardAgentSurface(legacyWindow, {
      snapshot: () => ({
        filter: 'all',
        searchQuery: '',
        focusedSessionId: null,
        loading: false,
        sessions: [{ id: 'doc-legacy', name: 'Legacy', status: 'attention', sourceSessionId: null, updatedAt: '2026-01-01' }],
        totalSessions: 1,
      }),
      focusSession: () => true,
      filter: () => true,
    }));
    const observation = (await taskDashboardAgentManifest.observe?.(
      { windowId: legacyWindow, typeId: 'taskDashboard', instanceKey: null },
    )) as unknown as {
      entities: Array<{ actions: string[] }>;
      state: { stateTokensAvailable: boolean };
    };
    expect(observation.entities[0]?.actions).toEqual(['focusSession']);
    expect(observation.state.stateTokensAvailable).toBe(false);
  });
});

describe('retryTask（单分段重试，不可逆）', () => {
  it('失败任务重新触发：changed:true、无 undo、写后重读状态如实', async () => {
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'retryTask',
      args: { sessionId: 'doc-failed', taskId: 't-1' },
      targetRef: taskRef('t-1'),
    });
    expect(result).toMatchObject({ handled: true, changed: true, acknowledged: true });
    expect(result?.undo).toBeUndefined();
    expect(result?.details).toMatchObject({ sessionId: 'doc-failed', taskId: 't-1', beforeStatus: 'Failed', afterStatus: 'Processing' });
    expect(result?.entityRefs).toEqual([sessionRef('doc-failed'), taskRef('t-1')]);
    expect(result?.postconditions).toEqual([{ kind: 'ref_exists', ref: sessionRef('doc-failed') }]);
    expect(result?.message).toContain('不可撤销');
    expect(harness.state.tasksBySession['doc-failed'][0].status).toBe('Processing');
  });

  it('重试未失败的任务诚实 no-op：changed:false + 结构化 code/hint，不触发域调用', async () => {
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'retryTask',
      args: { sessionId: 'doc-failed', taskId: 't-3' },
      targetRef: taskRef('t-3'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });
    expect(result?.hint).toContain('no-op');
    expect(harness.controlDocumentTask).not.toHaveBeenCalled();
  });

  it('任务不在会话中时 ENTITY_NOT_FOUND', async () => {
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'retryTask',
      args: { sessionId: 'doc-failed', taskId: 't-ghost' },
      targetRef: taskRef('t-ghost'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ENTITY_NOT_FOUND' });
  });

  it('缺少 targetRef 时按纪律拒绝（TARGET_REQUIRED）', async () => {
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'retryTask',
      args: { sessionId: 'doc-failed', taskId: 't-1' },
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'TARGET_REQUIRED' });
    expect(harness.controlDocumentTask).not.toHaveBeenCalled();
  });

  it('targetRef 与 taskId 不一致时拒绝（TARGET_REF_MISMATCH）', async () => {
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'retryTask',
      args: { sessionId: 'doc-failed', taskId: 't-1' },
      targetRef: taskRef('t-2'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'TARGET_REF_MISMATCH' });
  });

  it('后端拒绝触发时返回结构化 ACTION_FAILED（携带原因）', async () => {
    harness.state.retryRejects.add('t-1');
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'retryTask',
      args: { sessionId: 'doc-failed', taskId: 't-1' },
      targetRef: taskRef('t-1'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ACTION_FAILED' });
    expect(result?.hint).toContain('请勿重复触发');
    expect(harness.state.tasksBySession['doc-failed'][0].status).toBe('Failed');
  });

  it('域读取失败时诚实 LOAD_FAILED，不盲目触发', async () => {
    harness.state.loadFails = true;
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'retryTask',
      args: { sessionId: 'doc-failed', taskId: 't-1' },
      targetRef: taskRef('t-1'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'LOAD_FAILED' });
    expect(harness.controlDocumentTask).not.toHaveBeenCalled();
  });
});

describe('retryFailedTasks（批量重试，不可逆）', () => {
  it('全部失败任务重新触发：changed:true、无 undo、回执含计数与任务 id', async () => {
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'retryFailedTasks',
      args: { sessionId: 'doc-failed' },
      targetRef: sessionRef('doc-failed'),
    });
    expect(result).toMatchObject({ handled: true, changed: true, acknowledged: true });
    expect(result?.undo).toBeUndefined();
    expect(result?.details).toMatchObject({
      total: 2,
      succeeded: 2,
      failedToTrigger: 0,
      retriedTaskIds: ['t-1', 't-2'],
    });
    expect(harness.state.tasksBySession['doc-failed'][0].status).toBe('Processing');
    expect(harness.state.tasksBySession['doc-failed'][1].status).toBe('Processing');
    // 已完成任务不受批量重试影响
    expect(harness.state.tasksBySession['doc-failed'][2].status).toBe('Completed');
  });

  it('没有失败任务时诚实 no-op，不触发任何域写调用', async () => {
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'retryFailedTasks',
      args: { sessionId: 'doc-done' },
      targetRef: sessionRef('doc-done'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });
    expect(result?.hint).toContain('no-op');
    expect(harness.controlDocumentTask).not.toHaveBeenCalled();
  });

  it('部分触发失败时如实报告 partial（changed:true + failedToTrigger）', async () => {
    harness.state.retryRejects.add('t-2');
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'retryFailedTasks',
      args: { sessionId: 'doc-failed' },
      targetRef: sessionRef('doc-failed'),
    });
    expect(result).toMatchObject({ handled: true, changed: true });
    expect(result?.details).toMatchObject({ total: 2, succeeded: 1, failedToTrigger: 1, retriedTaskIds: ['t-1'] });
    expect(result?.message).toContain('触发失败');
    expect(result?.message).toContain('请勿重复触发');
  });

  it('全部触发失败时返回 ACTION_FAILED，changed:false', async () => {
    harness.state.retryRejects.add('t-1');
    harness.state.retryRejects.add('t-2');
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'retryFailedTasks',
      args: { sessionId: 'doc-failed' },
      targetRef: sessionRef('doc-failed'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ACTION_FAILED' });
  });

  it('未截断清单中不存在的会话拒绝 ENTITY_NOT_FOUND', async () => {
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'retryFailedTasks',
      args: { sessionId: 'doc-ghost' },
      targetRef: sessionRef('doc-ghost'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ENTITY_NOT_FOUND' });
    expect(harness.listFailedDocumentTasks).not.toHaveBeenCalled();
  });
});

describe('cancelSession（不可逆，不注册 inverse）', () => {
  it('取消进行中会话：changed:true、无 undo、回执如实标注不可逆', async () => {
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'cancelSession',
      args: { sessionId: 'doc-active' },
      targetRef: sessionRef('doc-active'),
    });
    expect(result).toMatchObject({ handled: true, changed: true, acknowledged: true });
    expect(result?.undo).toBeUndefined();
    expect(result?.details).toMatchObject({ sessionId: 'doc-active', cancellableBefore: 3, cancellableAfter: 0 });
    expect(result?.message).toContain('不可逆');
    const statuses = harness.state.tasksBySession['doc-active'].map((task) => task.status);
    expect(statuses).toEqual(['Cancelled', 'Cancelled', 'Cancelled', 'Completed']);
  });

  it('没有可取消任务时诚实 no-op，不触发域写调用', async () => {
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'cancelSession',
      args: { sessionId: 'doc-done' },
      targetRef: sessionRef('doc-done'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });
    expect(result?.hint).toContain('no-op');
    expect(harness.controlDocumentTask).not.toHaveBeenCalled();
  });

  it('域取消调用失败时返回结构化 ACTION_FAILED', async () => {
    harness.state.cancelFails = true;
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'cancelSession',
      args: { sessionId: 'doc-active' },
      targetRef: sessionRef('doc-active'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ACTION_FAILED' });
    expect(result?.hint).toContain('取消调度失败');
  });

  it('缺少 targetRef 时按纪律拒绝（TARGET_REQUIRED）', async () => {
    const result = await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'cancelSession',
      args: { sessionId: 'doc-active' },
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'TARGET_REQUIRED' });
  });
});

describe('未挂载失败路径', () => {
  it('表面未注册时 execute 返回 APP_NOT_READY', async () => {
    const result = await taskDashboardAgentManifest.execute?.(
      { windowId: 'not-mounted-window', typeId: 'taskDashboard', instanceKey: null },
      { name: 'retryFailedTasks', args: { sessionId: 'doc-failed' }, targetRef: sessionRef('doc-failed') },
    );
    expect(result).toMatchObject({ handled: false, changed: false, code: 'APP_NOT_READY' });
  });

  it('表面未注册时 observe 诚实报告 ready:false', async () => {
    const observation = await taskDashboardAgentManifest.observe?.(
      { windowId: 'not-mounted-window', typeId: 'taskDashboard', instanceKey: null },
    );
    expect(observation).toMatchObject({ busy: true, state: { ready: false } });
  });
});
