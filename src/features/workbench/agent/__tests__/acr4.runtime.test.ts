/**
 * ACR 4.0 — A1 核心运行时加固测试
 *
 * 覆盖：
 * - gates 命令集合从 ACR_COMMAND_ACCESS 派生（单一真相源）
 * - 启动竞态：settings 未就绪时 mutating 请求先等 refreshSettings
 * - seenForwardRuns LRU 逐出（per-session / session 数上限）
 * - pausedByUser 写入 abortDeadline；显式 pauseRun 写入 resumable，resumeRun 可续放
 * - placementHint 结构化直落原因（A5 已接线：label 不再拼中文后缀）
 * - legacy cancel 身份收紧（token / sessionId 匹配）
 * - presenceStore.markSuggestionReviewing
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const settingValues: Record<string, string | null> = {};
let settingGate: Promise<void> | null = null;

vi.mock('@/utils/settingsApi', () => ({
  getSetting: vi.fn(async (key: string) => {
    if (settingGate) await settingGate;
    return settingValues[key] ?? null;
  }),
}));

vi.mock('../probe', () => ({
  probeTarget: vi.fn(() => ({ state: 'clean', windowId: 'win-a' })),
}));

vi.mock('../bridge', () => ({
  emitAcrProgress: vi.fn(),
}));

vi.mock('../../core/scheduler', async () => {
  const actual = await vi.importActual<typeof import('../../core/scheduler')>(
    '../../core/scheduler',
  );
  return {
    ...actual,
    requestWakePrefetch: vi.fn(),
    reportSchedulerActivity: vi.fn(),
  };
});

import {
  resetWindowStoreForTests,
  useWindowStore,
} from '../../core/windowStore';
import { registerTestApp } from '../../core/__tests__/testUtils';
import { workbenchBus } from '../../core/workbenchBus';
import {
  ACR_MUTATING_COMMANDS,
  ACR_READONLY_COMMANDS,
  isCommandAllowedWhenOff,
} from '../gates';
import { probeTarget } from '../probe';
import {
  markSuggestionReviewing,
  usePresenceStore,
} from '../presenceStore';
import {
  MAX_FORWARD_RUNS_PER_SESSION,
  MAX_FORWARD_RUN_SESSIONS,
  __getSeenForwardRunsForTests,
  __handleCancelForTests,
  __rememberForwardRunForTests,
  resetStageManagerForTests,
  setAgentControlForTests,
  stageManager,
} from '../stageManager';
import type {
  AcrBridgeRequest,
  AcrReceipt,
  CollabDriver,
} from '../types';
import { ACR_COMMAND_ACCESS, ACR_ERROR_CODES } from '../types';

registerTestApp('mock-app');

function baseReq(
  partial: Partial<AcrBridgeRequest> & Pick<AcrBridgeRequest, 'command'>,
): AcrBridgeRequest {
  return {
    correlationId: 'corr-1',
    args: {},
    timeoutMs: 30_000,
    runId: 'run-1',
    sessionId: 'sess-1',
    ...partial,
  };
}

function makeDriver(overrides: Partial<CollabDriver> = {}): CollabDriver {
  return {
    typeId: 'mock-app',
    probe: () => 'clean',
    apply: vi.fn(async () => ({
      status: 'completed',
      mode: 'frontend',
      applied: 1,
      totalOps: 1,
      entityIds: ['e1'],
      done: ['ok'],
      undone: [],
    })),
    abort: vi.fn(
      (): AcrReceipt => ({
        status: 'cancelled',
        mode: 'frontend',
        applied: 0,
        totalOps: 1,
        entityIds: [],
        done: [],
        undone: ['aborted'],
      }),
    ),
    ...overrides,
  };
}

function setupWindow(): void {
  resetWindowStoreForTests({ w: 1400, h: 900 });
  useWindowStore.setState({
    windows: {
      'win-a': {
        id: 'win-a',
        typeId: 'mock-app',
        instanceKey: 'res-1',
        title: 'Mock',
        frame: { x: 40, y: 40, w: 400, h: 300 },
        restoreFrame: null,
        displayMode: 'floating',
        minimized: false,
        zIndex: 10,
        createdAt: 1,
        lastFocusedAt: 1,
      },
    },
    focusStack: ['win-a'],
    lifecycles: { 'win-a': 'focused' },
  });
}

const APPLY_ARGS = {
  target: { typeId: 'mock-app', resourceId: 'res-1' },
  ops: [{ kind: 'add', destructive: false, label: '添加节点', payload: {} }],
};

describe('ACR 4.0 gates 派生一致性', () => {
  it('ACR_READONLY_COMMANDS / ACR_MUTATING_COMMANDS 与 ACR_COMMAND_ACCESS 一致', () => {
    const readonly = Object.entries(ACR_COMMAND_ACCESS)
      .filter(([, access]) => access === 'read-only')
      .map(([command]) => command);
    const mutating = Object.entries(ACR_COMMAND_ACCESS)
      .filter(([, access]) => access === 'mutating')
      .map(([command]) => command);

    expect([...ACR_READONLY_COMMANDS].sort()).toEqual(readonly.sort());
    expect([...ACR_MUTATING_COMMANDS].sort()).toEqual(mutating.sort());
    // dynamic（act）不进任何静态集合
    expect(ACR_READONLY_COMMANDS.has('act')).toBe(false);
    expect(ACR_MUTATING_COMMANDS.has('act')).toBe(false);
    expect(isCommandAllowedWhenOff('probe')).toBe(true);
    expect(isCommandAllowedWhenOff('apply_ops')).toBe(false);
  });
});

describe('ACR 4.0 seenForwardRuns LRU', () => {
  beforeEach(() => {
    resetStageManagerForTests();
  });
  afterEach(() => {
    resetStageManagerForTests();
  });

  it('每 session 超过上限逐出最旧 runId', () => {
    for (let i = 0; i <= MAX_FORWARD_RUNS_PER_SESSION; i++) {
      __rememberForwardRunForTests('sess-lru', `run-${i}`);
    }
    const seen = __getSeenForwardRunsForTests().get('sess-lru')!;
    expect(seen.size).toBe(MAX_FORWARD_RUNS_PER_SESSION);
    expect(seen.has('run-0')).toBe(false);
    expect(seen.has('run-1')).toBe(true);
    expect(seen.has(`run-${MAX_FORWARD_RUNS_PER_SESSION}`)).toBe(true);
  });

  it('session 数超过上限逐出最旧 session', () => {
    for (let i = 0; i <= MAX_FORWARD_RUN_SESSIONS; i++) {
      __rememberForwardRunForTests(`sess-${i}`, 'run-x');
    }
    const map = __getSeenForwardRunsForTests();
    expect(map.size).toBe(MAX_FORWARD_RUN_SESSIONS);
    expect(map.has('sess-0')).toBe(false);
    expect(map.has(`sess-${MAX_FORWARD_RUN_SESSIONS}`)).toBe(true);
  });

  it('重复写入同 session 触发 touch，不重复计数', () => {
    __rememberForwardRunForTests('sess-a', 'run-1');
    __rememberForwardRunForTests('sess-a', 'run-1');
    __rememberForwardRunForTests('sess-a', 'run-2');
    expect(__getSeenForwardRunsForTests().get('sess-a')!.size).toBe(2);
  });
});

describe('ACR 4.0 markSuggestionReviewing', () => {
  beforeEach(() => {
    usePresenceStore.getState().clearAll();
  });

  it('设置 reviewing presence，清除函数只清自己', () => {
    const clear = markSuggestionReviewing('win-a', 'run-key-1', '等待用户确认建议');
    const presence = usePresenceStore.getState().byWindow['win-a'];
    expect(presence).toMatchObject({
      runKey: 'run-key-1',
      status: 'reviewing',
      label: '等待用户确认建议',
      windowId: 'win-a',
    });

    clear();
    expect(usePresenceStore.getState().byWindow['win-a']).toBeUndefined();
    // 幂等
    clear();
  });

  it('presence 已被其他 run 覆盖时清除函数不误删', () => {
    const clear = markSuggestionReviewing('win-a', 'run-key-1', '等待确认');
    usePresenceStore.getState().setPresence({
      runKey: 'run-key-other',
      runId: 'other',
      sessionId: 's',
      windowId: 'win-a',
      typeId: 'note',
      status: 'acting',
      label: '其他 run',
      startedAt: Date.now(),
      ttlMs: 8000,
    });
    clear();
    expect(usePresenceStore.getState().byWindow['win-a']?.runKey).toBe(
      'run-key-other',
    );
  });

  it('沿用同 runKey 既有 presence 的身份字段', () => {
    usePresenceStore.getState().setPresence({
      runKey: 'run-key-1',
      runId: 'tool-call-1',
      sessionId: 'sess-9',
      windowId: 'win-a',
      typeId: 'mindmap',
      status: 'acting',
      label: '进行中',
      startedAt: Date.now(),
      ttlMs: 8000,
    });
    const clear = markSuggestionReviewing('win-a', 'run-key-1', '等待确认');
    const presence = usePresenceStore.getState().byWindow['win-a']!;
    expect(presence.status).toBe('reviewing');
    expect(presence.runId).toBe('tool-call-1');
    expect(presence.sessionId).toBe('sess-9');
    expect(presence.typeId).toBe('mindmap');
    clear();
  });
});

describe('ACR 4.0 StageManager 运行时', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingGate = null;
    for (const key of Object.keys(settingValues)) delete settingValues[key];
    // start() 会异步 refreshSettings；默认档位设为 background，
    // 避免 mock 缺省 null → follow 触发 focus/唤醒改变测试前提
    settingValues['desktop.workbenchAgentControl'] = 'background';
    resetStageManagerForTests();
    workbenchBus.setEnabled(true);
    setupWindow();
    vi.mocked(probeTarget).mockReturnValue({ state: 'clean', windowId: 'win-a' });
  });

  afterEach(() => {
    resetStageManagerForTests();
    workbenchBus.setEnabled(false);
    settingGate = null;
  });

  it('启动竞态：settings=follow 未就绪时 mutating 请求等待后按 follow 放行', async () => {
    // 模拟旧竞态前置条件：本地镜像 off、真实设置 follow、读取尚未完成
    setAgentControlForTests('off');
    settingValues['desktop.workbenchAgentControl'] = 'follow';
    let releaseSettings!: () => void;
    settingGate = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });

    stageManager.start();
    const pending = stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        args: {
          target: { typeId: 'missing-driver-app', resourceId: 'x' },
          ops: [{ kind: 'noop', destructive: false, label: 'noop' }],
        },
      }),
    );
    releaseSettings();
    const res = await pending;
    // 通过了 off 闸门（否则是 WORKBENCH_DISABLED），落在 DRIVER_NOT_FOUND
    expect(res.ok).toBe(false);
    expect(JSON.parse(res.error!).code).toBe(ACR_ERROR_CODES.DRIVER_NOT_FOUND);
    stageManager.stop();
  });

  it('启动竞态：settings=off 未就绪时 mutating 请求等待后被拒', async () => {
    setAgentControlForTests('follow');
    settingValues['desktop.workbenchAgentControl'] = 'off';
    let releaseSettings!: () => void;
    settingGate = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });

    stageManager.start();
    const pending = stageManager.handleBridgeRequest(
      baseReq({ command: 'open_app', args: { typeId: 'mock-app' } }),
    );
    releaseSettings();
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(JSON.parse(res.error!).code).toBe(ACR_ERROR_CODES.WORKBENCH_DISABLED);
    // 只读命令不受影响
    const list = await stageManager.handleBridgeRequest(
      baseReq({ command: 'list_windows', correlationId: 'c-ro', runId: 'run-ro' }),
    );
    expect(list.ok).toBe(true);
    stageManager.stop();
  });

  it('pausedByUser 写入 abortDeadline；显式 pauseRun→resumable；resumeRun 续放并清除', async () => {
    setAgentControlForTests('background');
    stageManager.start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stageManager.registerDriver(
      makeDriver({
        apply: vi.fn(async () => {
          await gate;
          return {
            status: 'completed',
            mode: 'frontend',
            applied: 1,
            totalOps: 1,
            entityIds: [],
            done: ['done'],
            undone: [],
          } satisfies AcrReceipt;
        }),
      }),
    );

    const pending = stageManager.handleBridgeRequest(
      baseReq({ command: 'apply_ops', args: APPLY_ARGS }),
    );
    await vi.waitFor(() => {
      expect(usePresenceStore.getState().byWindow['win-a']?.runKey).toBeTruthy();
    });
    const runKey = usePresenceStore.getState().byWindow['win-a']!.runKey;

    // 用户输入 → pausedByUser + abortDeadline（≈now+15s），非显式不可续放
    const before = Date.now();
    stageManager.notifyUserInput('win-a');
    let presence = usePresenceStore.getState().byWindow['win-a']!;
    expect(presence.status).toBe('pausedByUser');
    expect(presence.abortDeadline).toBeGreaterThanOrEqual(before + 14_000);
    expect(presence.abortDeadline).toBeLessThanOrEqual(Date.now() + 15_000);
    expect(presence.resumable).toBeFalsy();

    // 显式暂停 → resumable:true
    stageManager.pauseRun(runKey);
    presence = usePresenceStore.getState().byWindow['win-a']!;
    expect(presence.status).toBe('pausedByUser');
    expect(presence.resumable).toBe(true);
    expect(presence.abortDeadline).toBeGreaterThan(before);

    // 显式续放 → acting，字段清除
    stageManager.resumeRun(runKey);
    presence = usePresenceStore.getState().byWindow['win-a']!;
    expect(presence.status).toBe('acting');
    expect(presence.abortDeadline).toBeUndefined();
    expect(presence.resumable).toBeUndefined();

    release();
    const res = await pending;
    expect(res.ok).toBe(true);
    stageManager.stop();
  });

  it('placementHint：最小化窗口直落 → background（A5 接线后 label 无中文后缀）', async () => {
    setAgentControlForTests('background');
    stageManager.start();
    stageManager.registerDriver(makeDriver());
    useWindowStore.setState((state) => ({
      windows: {
        ...state.windows,
        'win-a': { ...state.windows['win-a']!, minimized: true },
      },
    }));

    const res = await stageManager.handleBridgeRequest(
      baseReq({ command: 'apply_ops', args: APPLY_ARGS }),
    );
    expect(res.ok).toBe(true);
    // presence 在 done 保留期内仍可读
    const presence = usePresenceStore.getState().byWindow['win-a'];
    expect(presence?.placementHint).toBe('background');
    // A5 已接线 placementHint i18n 括注：label 恢复为纯步骤名，不再拼中文后缀
    expect(presence?.label).not.toContain('直落');
    stageManager.stop();
  });

  describe('legacy cancel 身份收紧', () => {
    async function startHangingApply(
      overrides: Partial<AcrBridgeRequest> = {},
    ): Promise<{
      pending: Promise<unknown>;
      release: () => void;
      abort: ReturnType<typeof vi.fn>;
    }> {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const abort = vi.fn(
        (): AcrReceipt => ({
          status: 'cancelled',
          mode: 'frontend',
          applied: 0,
          totalOps: 1,
          entityIds: [],
          done: [],
          undone: ['aborted'],
        }),
      );
      stageManager.registerDriver(
        makeDriver({
          apply: vi.fn(async () => {
            await gate;
            return {
              status: 'completed',
              mode: 'frontend',
              applied: 1,
              totalOps: 1,
              entityIds: [],
              done: ['done'],
              undone: [],
            } satisfies AcrReceipt;
          }),
          abort,
        }),
      );
      const pending = stageManager.handleBridgeRequest(
        baseReq({ command: 'apply_ops', args: APPLY_ARGS, ...overrides }),
      );
      await vi.waitFor(() => {
        expect(usePresenceStore.getState().byWindow['win-a']).toBeTruthy();
      });
      return { pending, release, abort };
    }

    beforeEach(() => {
      setAgentControlForTests('background');
      stageManager.start();
    });

    it('无 token run：sessionId 不一致的取消被拒绝，一致则命中', async () => {
      const { pending, release, abort } = await startHangingApply();

      __handleCancelForTests({
        correlationId: 'corr-1',
        sessionId: 'sess-other',
      });
      expect(abort).not.toHaveBeenCalled();

      __handleCancelForTests({
        correlationId: 'corr-1',
        sessionId: 'sess-1',
        runId: 'run-1',
      });
      expect(abort).toHaveBeenCalledTimes(1);

      release();
      await pending;
    });

    it('无 token run：带 token 的取消载荷不能命中', async () => {
      const { pending, release, abort } = await startHangingApply();

      __handleCancelForTests({
        correlationId: 'corr-1',
        bridgeToken: 'forged-token',
      });
      expect(abort).not.toHaveBeenCalled();

      // 无 token + 无 sessionId（纯 correlationId）仍允许命中无 token run
      __handleCancelForTests({ correlationId: 'corr-1' });
      expect(abort).toHaveBeenCalledTimes(1);

      release();
      await pending;
    });

    it('有 token run（Rust 路径）：token 匹配才命中，行为不变', async () => {
      const { pending, release, abort } = await startHangingApply({
        bridgeToken: 'token-rust',
      });

      // 无 token 载荷不能取消有 token 的 run
      __handleCancelForTests({ correlationId: 'corr-1', sessionId: 'sess-1' });
      expect(abort).not.toHaveBeenCalled();

      // 错误 token 拒绝
      __handleCancelForTests({
        correlationId: 'corr-1',
        bridgeToken: 'wrong',
        sessionId: 'sess-1',
      });
      expect(abort).not.toHaveBeenCalled();

      // 正确 token + sessionId 命中
      __handleCancelForTests({
        correlationId: 'corr-1',
        bridgeToken: 'token-rust',
        sessionId: 'sess-1',
        runId: 'run-1',
      });
      expect(abort).toHaveBeenCalledTimes(1);

      release();
      await pending;
    });
  });
});
