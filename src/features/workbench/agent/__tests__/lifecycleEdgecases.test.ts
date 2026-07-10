/**
 * R2-09 — 生命周期边界防御测试
 *
 * 覆盖：关窗中断 run、resourceSync 关窗 abort、follow 唤醒 frozen、
 * 最小化直落 pacing、快照恢复后失效 windowId、多窗 instanceKey 去重、
 * chat 无 instanceKey 找窗。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

vi.mock('@/utils/settingsApi', () => ({
  getSetting: vi.fn(async () => null),
}));

vi.mock('../bridge', () => ({
  emitAcrProgress: vi.fn(),
}));

vi.mock('../drivers', () => ({
  registerAllDrivers: vi.fn(),
  disposeAllDrivers: vi.fn(),
}));

vi.mock('../queryProviders', () => ({
  registerBuiltinQueryProviders: vi.fn(),
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

import { closeWindowsForDeletedResource } from '../../apps/files/resourceSync';
import { registerTestApp } from '../../core/__tests__/testUtils';
import { requestWakePrefetch } from '../../core/scheduler';
import {
  resetWindowStoreForTests,
  useWindowStore,
} from '../../core/windowStore';
import { workbenchBus } from '../../core/workbenchBus';
import { probeTarget } from '../probe';
import { usePresenceStore } from '../presenceStore';
import {
  resetStageManagerForTests,
  setAgentControlForTests,
  stageManager,
} from '../stageManager';
import type { AcrBridgeRequest, AcrReceipt, CollabDriver } from '../types';

registerTestApp('acr-edge-note', { instanceMode: 'multi' });
registerTestApp('acr-edge-chat', { instanceMode: 'multi' });
registerTestApp('note', { instanceMode: 'multi' });

function baseReq(
  partial: Partial<AcrBridgeRequest> & Pick<AcrBridgeRequest, 'command'>,
): AcrBridgeRequest {
  return {
    correlationId: 'corr-edge',
    args: {},
    timeoutMs: 30_000,
    runId: 'run-edge',
    sessionId: 'sess-edge',
    ...partial,
  };
}

function makeDriver(overrides: Partial<CollabDriver> = {}): CollabDriver & {
  abortFlag: { value: boolean };
} {
  const abortFlag = { value: false };
  return {
    typeId: 'acr-edge-note',
    abortFlag,
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
    abort: vi.fn((): AcrReceipt => {
      abortFlag.value = true;
      return {
        status: 'cancelled',
        mode: 'frontend',
        applied: 0,
        totalOps: 1,
        entityIds: [],
        done: [],
        undone: ['aborted'],
        message: 'aborted',
      };
    }),
    ...overrides,
  };
}

describe('R2-09 lifecycle edgecases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStageManagerForTests();
    resetWindowStoreForTests({ w: 1400, h: 900 });
    workbenchBus.setEnabled(true);
    stageManager.start();
    setAgentControlForTests('background');
  });

  afterEach(() => {
    stageManager.stop();
    resetStageManagerForTests();
    resetWindowStoreForTests();
    workbenchBus.setEnabled(false);
  });

  it('close_window 中断该窗活跃 run（abort）', async () => {
    const winId = useWindowStore.getState().openWindow({
      typeId: 'acr-edge-note',
      instanceKey: 'note-close',
    });
    useWindowStore.getState().setLifecycles({ [winId]: 'focused' });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const driver = makeDriver();
    driver.apply = vi.fn(async () => {
      await gate;
      return {
        status: driver.abortFlag.value ? 'cancelled' : 'completed',
        mode: 'frontend',
        applied: driver.abortFlag.value ? 0 : 1,
        totalOps: 1,
        entityIds: [],
        done: driver.abortFlag.value ? [] : ['ok'],
        undone: driver.abortFlag.value ? ['aborted'] : [],
      } satisfies AcrReceipt;
    });
    stageManager.registerDriver(driver);

    const applyP = stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        runId: 'run-close',
        correlationId: 'corr-close',
        args: {
          target: { typeId: 'acr-edge-note', resourceId: 'note-close' },
          ops: [{ kind: 'add', destructive: false, label: 'add' }],
        },
      }),
    );

    await vi.waitFor(() => {
      expect(usePresenceStore.getState().byWindow[winId]?.runId).toBe(
        'run-close',
      );
    });

    const closeRes = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'close_window',
        correlationId: 'corr-close-win',
        args: { windowId: winId },
      }),
    );
    expect(closeRes.ok).toBe(true);
    expect(driver.abort).toHaveBeenCalledWith('run-close');
    expect(driver.abortFlag.value).toBe(true);

    release();
    const applyRes = await applyP;
    expect(applyRes.ok).toBe(true);
    expect((applyRes.data as AcrReceipt).status).toBe('cancelled');
  });

  it('resourceSync 关窗（store.closeWindow）经订阅中断活跃 run', async () => {
    stageManager.start();
    const winId = useWindowStore.getState().openWindow({
      typeId: 'acr-edge-note',
      instanceKey: 'res-del-1',
    });
    useWindowStore.getState().setLifecycles({ [winId]: 'focused' });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const driver = makeDriver();
    driver.apply = vi.fn(async () => {
      await gate;
      return {
        status: driver.abortFlag.value ? 'partial' : 'completed',
        mode: 'frontend',
        applied: 0,
        totalOps: 1,
        entityIds: [],
        done: [],
        undone: ['resource deleted'],
        message: driver.abortFlag.value ? 'window gone' : 'ok',
      } satisfies AcrReceipt;
    });
    stageManager.registerDriver(driver);

    const applyP = stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        runId: 'run-resdel',
        correlationId: 'corr-resdel',
        args: {
          target: { typeId: 'acr-edge-note', resourceId: 'res-del-1' },
          ops: [{ kind: 'add', destructive: false, label: 'add' }],
        },
      }),
    );

    await vi.waitFor(() => {
      expect(usePresenceStore.getState().byWindow[winId]?.runId).toBe(
        'run-resdel',
      );
    });

    useWindowStore.getState().closeWindow(winId);
    expect(useWindowStore.getState().windows[winId]).toBeUndefined();

    await vi.waitFor(() => {
      expect(driver.abort).toHaveBeenCalledWith('run-resdel');
    });

    release();
    const applyRes = await applyP;
    expect(applyRes.ok).toBe(true);
    expect((applyRes.data as AcrReceipt).status).toBe('partial');
  });

  it('follow 档：frozen 窗 apply_ops 前 focus 唤醒', async () => {
    const winId = useWindowStore.getState().openWindow({
      typeId: 'acr-edge-note',
      instanceKey: 'note-frozen',
    });
    const other = useWindowStore.getState().openWindow({
      typeId: 'acr-edge-note',
      instanceKey: 'note-other',
    });
    useWindowStore.getState().setLifecycles({
      [winId]: 'frozen',
      [other]: 'focused',
    });
    expect(
      probeTarget({ typeId: 'acr-edge-note', resourceId: 'note-frozen' }).state,
    ).toBe('frozen');

    setAgentControlForTests('follow');
    let seenWindowId: string | null = null;
    const driver = makeDriver({
      apply: vi.fn(async (run) => {
        seenWindowId = run.windowId;
        return {
          status: 'completed',
          mode: 'frontend',
          applied: 1,
          totalOps: 1,
          entityIds: [],
          done: ['ok'],
          undone: [],
        };
      }),
    });
    stageManager.registerDriver(driver);

    const res = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        args: {
          target: { typeId: 'acr-edge-note', resourceId: 'note-frozen' },
          ops: [{ kind: 'add', destructive: false, label: 'add' }],
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(seenWindowId).toBe(winId);
    expect(useWindowStore.getState().focusStack.at(-1)).toBe(winId);
    expect(useWindowStore.getState().lifecycles[winId]).toBe('focused');
    expect(requestWakePrefetch).toHaveBeenCalledWith(winId);
  });

  it('最小化窗 apply_ops 强制 instant（直落终态）', async () => {
    const winId = useWindowStore.getState().openWindow({
      typeId: 'acr-edge-note',
      instanceKey: 'note-min',
    });
    useWindowStore.getState().minimizeWindow(winId, true);
    useWindowStore.getState().setLifecycles({ [winId]: 'background' });

    let instant: boolean | undefined;
    const driver = makeDriver({
      apply: vi.fn(async (run) => {
        instant = run.pacing.profile.instant;
        return {
          status: 'completed',
          mode: 'frontend',
          applied: 1,
          totalOps: 1,
          entityIds: [],
          done: ['ok'],
          undone: [],
        };
      }),
    });
    stageManager.registerDriver(driver);

    const res = await stageManager.handleBridgeRequest(
      baseReq({
        command: 'apply_ops',
        args: {
          target: { typeId: 'acr-edge-note', resourceId: 'note-min' },
          ops: [{ kind: 'add', destructive: false, label: 'add' }],
          pacing: 'demo',
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(instant).toBe(true);
  });

  it('快照恢复后旧 windowId 失效：probe 按 instanceKey 重解析', () => {
    const winId = useWindowStore.getState().openWindow({
      typeId: 'acr-edge-note',
      instanceKey: 'note-snap',
    });
    useWindowStore.getState().setLifecycles({ [winId]: 'focused' });

    useWindowStore.getState().closeWindow(winId);
    const newId = useWindowStore.getState().openWindow({
      typeId: 'acr-edge-note',
      instanceKey: 'note-snap',
    });
    useWindowStore.getState().setLifecycles({ [newId]: 'focused' });

    const probed = probeTarget({
      typeId: 'acr-edge-note',
      resourceId: 'note-snap',
    });
    expect(probed.windowId).toBe(newId);
    expect(probed.windowId).not.toBe(winId);
    expect(probed.state).toBe('clean');
  });

  it('多窗同 instanceKey：openWindow 去重只 focus', () => {
    const a = useWindowStore.getState().openWindow({
      typeId: 'acr-edge-note',
      instanceKey: 'same-res',
    });
    const b = useWindowStore.getState().openWindow({
      typeId: 'acr-edge-note',
      instanceKey: 'same-res',
    });
    expect(a).toBe(b);
    const same = Object.values(useWindowStore.getState().windows).filter(
      (w) => w.typeId === 'acr-edge-note' && w.instanceKey === 'same-res',
    );
    expect(same).toHaveLength(1);
  });

  it('chat 无 instanceKey：null-key 壳不可用 resourceId 寻址；精确 session 可命中', () => {
    const nullKey = useWindowStore.getState().openWindow({
      typeId: 'acr-edge-chat',
      instanceKey: null,
    });
    const withKey = useWindowStore.getState().openWindow({
      typeId: 'acr-edge-chat',
      instanceKey: 'sess_abc',
    });
    useWindowStore.getState().setLifecycles({
      [nullKey]: 'visible',
      [withKey]: 'focused',
    });

    // null-key 壳存在，但 resourceId 寻址不会误命中它
    expect(useWindowStore.getState().windows[nullKey]?.instanceKey).toBeNull();
    const miss = probeTarget({
      typeId: 'acr-edge-chat',
      resourceId: 'sess_missing',
    });
    expect(miss.state).toBe('closed');

    const exact = probeTarget({
      typeId: 'acr-edge-chat',
      resourceId: 'sess_abc',
    });
    expect(exact).toEqual({ state: 'clean', windowId: withKey });

    // 无 resourceId：同 typeId 任意窗（含 null-key），不抛错
    const any = probeTarget({ typeId: 'acr-edge-chat' });
    expect(any.state).not.toBe('closed');
    expect([nullKey, withKey]).toContain(any.windowId);
  });

  it('closeWindowsForDeletedResource 关闭匹配资源窗', () => {
    const id = useWindowStore.getState().openWindow({
      typeId: 'note',
      instanceKey: 'note_gone',
    });
    expect(closeWindowsForDeletedResource('note_gone')).toBe(1);
    expect(useWindowStore.getState().windows[id]).toBeUndefined();
  });
});
