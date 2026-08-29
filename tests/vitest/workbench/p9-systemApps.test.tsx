/**
 * P9 — 系统应用群 register 元数据 + 投射源行为测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(async () => null as unknown) }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  },
}));

import { appRegistry } from '@/features/workbench/core/appRegistry';
import { registerSystemApps } from '@/features/workbench/apps/system/register';
import { registerSandboxApp } from '@/features/workbench/apps/sandbox/register';
import {
  pomodoroProjectionSource,
  pomodoroBadgeSource,
  POMODORO_INSTANCE_KEY,
  POMODORO_CLOSE_LINGER_MS,
} from '@/features/workbench/apps/system/pomodoroSource';
import {
  ankiTaskBadgeSource,
  refreshAnkiTaskCount,
  getActiveAnkiTaskCount,
  ANKI_TASKS_INSTANCE_KEY,
  ankiTaskProjectionSource,
  stopAnkiTaskWatcher,
} from '@/features/workbench/apps/system/ankiTaskSource';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';

describe('P9 system apps register', () => {
  it('注册全部系统应用与沙箱应用，元数据符合契约', () => {
    registerSystemApps();
    registerSandboxApp();

    const expectations: Array<{
      typeId: string;
      weight: number;
      hasBadge: boolean;
    }> = [
      { typeId: 'todo', weight: 2, hasBadge: false },
      { typeId: 'skills', weight: 2, hasBadge: false },
      { typeId: 'templates', weight: 2, hasBadge: false },
      { typeId: 'taskDashboard', weight: 1, hasBadge: true },
      { typeId: 'settings', weight: 2, hasBadge: false },
      { typeId: 'pomodoro', weight: 1, hasBadge: true },
      { typeId: 'sandbox', weight: 2, hasBadge: false },
    ];

    for (const { typeId, weight, hasBadge } of expectations) {
      const def = appRegistry.get(typeId);
      expect(def, `app "${typeId}" should be registered`).toBeDefined();
      expect(def!.instanceMode).toBe('single');
      expect(def!.memoryWeight).toBe(weight);
      expect(def!.nameKey).toBe(`workbench:apps.${typeId}`);
      expect(def!.render).toBeDefined();
      expect(def!.icon).toBeTruthy();
      expect(def!.defaultFrame.w).toBeGreaterThanOrEqual(def!.minSize.w);
      expect(def!.defaultFrame.h).toBeGreaterThanOrEqual(def!.minSize.h);
      if (hasBadge) expect(def!.badgeSource).toBeTypeOf('function');
    }

    expect(appRegistry.get('sandbox')?.showInLauncher).toBe(false);
  });

  it('registerSystemApps 幂等：重复调用不触发覆盖 warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerSystemApps();
    registerSystemApps();
    registerSandboxApp();
    registerSandboxApp();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('P9 pomodoro projection source', () => {
  beforeEach(() => {
    usePomodoroStore.setState({ mode: 'idle', status: 'paused', currentTaskTitle: null });
  });

  it('badgeSource：运行中 dot，空闲 null', () => {
    expect(pomodoroBadgeSource()).toBeNull();
    usePomodoroStore.setState({ mode: 'work', status: 'running' });
    expect(pomodoroBadgeSource()).toEqual({ kind: 'dot' });
    usePomodoroStore.setState({ mode: 'short_break' });
    expect(pomodoroBadgeSource()).toEqual({ kind: 'dot' });
  });

  it('subscribe：立即回调当前状态，运行↔空闲切换各 notify 一次（idle 收口经余韵延迟）', () => {
    vi.useFakeTimers();
    try {
      const notify = vi.fn();
      const unsubscribe = pomodoroProjectionSource.subscribe(notify);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenLastCalledWith([]);

      usePomodoroStore.setState({ mode: 'work', status: 'running', currentTaskTitle: '写论文' });
      expect(notify).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenLastCalledWith([
        expect.objectContaining({ instanceKey: POMODORO_INSTANCE_KEY, title: '写论文' }),
      ]);

      // 同为活跃态的内部变化（work→break）不重复 notify
      usePomodoroStore.setState({ mode: 'short_break' });
      expect(notify).toHaveBeenCalledTimes(2);

      // stop 余韵：idle 不立即收口，POMODORO_CLOSE_LINGER_MS 后才 notify([])
      usePomodoroStore.setState({ mode: 'idle' });
      expect(notify).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(POMODORO_CLOSE_LINGER_MS);
      expect(notify).toHaveBeenCalledTimes(3);
      expect(notify).toHaveBeenLastCalledWith([]);

      unsubscribe();
      usePomodoroStore.setState({ mode: 'work' });
      expect(notify).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('P9 anki task source', () => {
  beforeEach(async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    await refreshAnkiTaskCount(); // 归零
  });

  afterEach(() => {
    stopAnkiTaskWatcher();
  });

  it('活跃任务数 = activeTasks 求和；badge 为 count；归零后 badge 消失', async () => {
    invokeMock.mockResolvedValue([
      { activeTasks: 2, pausedTasks: 1 },
      { activeTasks: 1 },
      { activeTasks: 0 },
    ]);
    await refreshAnkiTaskCount();
    expect(invokeMock).toHaveBeenCalledWith('list_document_sessions', expect.anything());
    expect(getActiveAnkiTaskCount()).toBe(3);
    expect(ankiTaskBadgeSource()).toEqual({ kind: 'count', value: 3 });

    invokeMock.mockResolvedValue([]);
    await refreshAnkiTaskCount();
    expect(getActiveAnkiTaskCount()).toBe(0);
    expect(ankiTaskBadgeSource()).toBeNull();
  });

  it('invoke 失败（非 Tauri 环境）不抛错，保持上次计数', async () => {
    invokeMock.mockResolvedValue([{ activeTasks: 2 }]);
    await refreshAnkiTaskCount();
    expect(getActiveAnkiTaskCount()).toBe(2);

    invokeMock.mockRejectedValue(new Error('no backend'));
    await expect(refreshAnkiTaskCount()).resolves.toBeUndefined();
    expect(getActiveAnkiTaskCount()).toBe(2);
  });

  it('projection source 为 badge-only：subscribe 即刷新并按计数产出 0/1 个实例', async () => {
    expect(ankiTaskProjectionSource.projectWindows).toBe(false);

    invokeMock.mockResolvedValue([{ activeTasks: 1 }]);
    const notify = vi.fn();
    const unsubscribe = ankiTaskProjectionSource.subscribe(notify);
    // subscribe 时立即回调当前值（此时仍为 0）
    expect(notify).toHaveBeenCalledWith([]);

    await refreshAnkiTaskCount();
    expect(notify).toHaveBeenLastCalledWith([
      expect.objectContaining({ instanceKey: ANKI_TASKS_INSTANCE_KEY }),
    ]);

    invokeMock.mockResolvedValue([]);
    await refreshAnkiTaskCount();
    expect(notify).toHaveBeenLastCalledWith([]);

    unsubscribe();
  });
});
