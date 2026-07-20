/**
 * R2-08 — 三档闸门 / probe disabled / OS·control off abort
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

vi.mock('@/utils/settingsApi', () => ({
  getSetting: vi.fn(async () => null),
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

import { resetWindowStoreForTests, useWindowStore } from '../../core/windowStore';
import { registerTestApp } from '../../core/__tests__/testUtils';
import { workbenchBus } from '../../core/workbenchBus';
import {
  isCommandAllowedWhenOff,
  isMutatingCommand,
  parseAgentControlMode,
} from '../gates';
import { probeTarget } from '../probe';
import { usePresenceStore } from '../presenceStore';
import {
  resetStageManagerForTests,
  setAgentControlForTests,
  stageManager,
} from '../stageManager';
import type { AcrBridgeRequest, AcrReceipt, CollabDriver } from '../types';
import { ACR_ERROR_CODES } from '../types';

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
        status: 'partial',
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

describe('gates helpers', () => {
  it('parseAgentControlMode', () => {
    expect(parseAgentControlMode('off')).toBe('off');
    expect(parseAgentControlMode('follow')).toBe('follow');
    expect(parseAgentControlMode('')).toBe('follow');
    expect(parseAgentControlMode(null)).toBe('follow');
    expect(parseAgentControlMode('weird')).toBe('off');
  });

  it('off 只读允许 / 写导航拒绝', () => {
    expect(isCommandAllowedWhenOff('list_windows')).toBe(true);
    expect(isCommandAllowedWhenOff('query_state')).toBe(true);
    expect(isCommandAllowedWhenOff('probe')).toBe(true);
    // 与 ACR_COMMAND_ACCESS 对齐补录的只读命令
    expect(isCommandAllowedWhenOff('get_capabilities')).toBe(true);
    expect(isCommandAllowedWhenOff('observe')).toBe(true);
    expect(isCommandAllowedWhenOff('wait_for')).toBe(true);
    expect(isCommandAllowedWhenOff('open_app')).toBe(false);
    expect(isMutatingCommand('apply_ops')).toBe(true);
  });
});

describe('StageManager R2-08 gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStageManagerForTests();
    resetWindowStoreForTests({ w: 1400, h: 900 });
    workbenchBus.setEnabled(true);
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
  });

  afterEach(() => {
    resetStageManagerForTests();
    workbenchBus.setEnabled(true);
  });

  it('off：list_windows / query_state 允许，open_app 拒 WORKBENCH_DISABLED', async () => {
    setAgentControlForTests('off');
    const list = await stageManager.handleBridgeRequest(baseReq({ command: 'list_windows' }));
    expect(list.ok).toBe(true);

    const query = await stageManager.handleBridgeRequest(
      baseReq({ command: 'query_state', correlationId: 'c2', args: { scope: 'focused' } }),
    );
    expect(query.ok).toBe(true);

    const open = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'open_app',
        correlationId: 'c3',
        args: { typeId: 'mock-app' },
      }),
    );
    expect(open.ok).toBe(false);
    const parsed = JSON.parse(open.error!);
    expect(parsed.code).toBe(ACR_ERROR_CODES.WORKBENCH_DISABLED);
  });

  it('off：probe 返回 disabled（legacy 后端降级）', () => {
    setAgentControlForTests('off');
    workbenchBus.setEnabled(true);
    const r = probeTarget({ typeId: 'mock-app', resourceId: 'res-1' });
    expect(r).toEqual({ state: 'disabled', windowId: null });
  });

  it('control 切到 off：活跃 run abort', async () => {
    setAgentControlForTests('background');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const abort = vi.fn(
      (): AcrReceipt => ({
        status: 'partial',
        mode: 'frontend',
        applied: 0,
        totalOps: 1,
        entityIds: [],
        done: [],
        undone: ['aborted'],
      }),
    );
    stageManager.start();
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
          };
        }),
        abort,
      }),
    );

    const pending = stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        args: {
          target: { typeId: 'mock-app', resourceId: 'res-1' },
          ops: [{ kind: 'add', destructive: false, label: 'add', payload: {} }],
        },
      }),
    );

    await vi.waitFor(() => {
      expect(usePresenceStore.getState().byWindow['win-a']?.runId).toBe('run-1');
    });

    window.dispatchEvent(
      new CustomEvent('workbench:settings-changed', {
        detail: { key: 'desktop.workbenchAgentControl', value: 'off' },
      }),
    );
    expect(abort).toHaveBeenCalled();
    expect(usePresenceStore.getState().byWindow['win-a']?.status).toBe('aborted');

    release();
    await pending;
    stageManager.stop();
  });

  it('OS mode-changed enabled=false：活跃 run abort', async () => {
    setAgentControlForTests('background');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const abort = vi.fn(
      (): AcrReceipt => ({
        status: 'partial',
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
          };
        }),
        abort,
      }),
    );

    stageManager.start();
    const pending = stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        args: {
          target: { typeId: 'mock-app', resourceId: 'res-1' },
          ops: [{ kind: 'add', destructive: false, label: 'add', payload: {} }],
        },
      }),
    );

    await vi.waitFor(() => {
      expect(usePresenceStore.getState().byWindow['win-a']?.runId).toBe('run-1');
    });

    window.dispatchEvent(
      new CustomEvent('workbench:mode-changed', { detail: { enabled: false } }),
    );
    expect(abort).toHaveBeenCalled();
    expect(usePresenceStore.getState().byWindow['win-a']?.status).toBe('aborted');

    release();
    await pending;
    stageManager.stop();
  });
});
