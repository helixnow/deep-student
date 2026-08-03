/**
 * P9 — core/projection 投射管理器测试
 *
 * 生命周期：实例出现→自动开窗（幂等）；消失→默认关窗 / keepShell 保留；
 * badge-only 源不投窗；workbench 未启用期间累积、启用后 resync 补投。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));

import {
  registerProjectionSource,
  resyncProjections,
  getProjectedInstances,
  resetProjections,
  type ProjectionInstance,
  type ProjectionSource,
} from '@/features/workbench/core/projection';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { useWindowStore } from '@/features/workbench/core/windowStore';

function makeSource(opts?: Pick<ProjectionSource, 'keepShell' | 'projectWindows'>) {
  let notifyFn: ((instances: ProjectionInstance[]) => void) | null = null;
  const source: ProjectionSource = {
    ...opts,
    subscribe(notify) {
      notifyFn = notify;
      notify([]);
      return () => {
        notifyFn = null;
      };
    },
  };
  return {
    source,
    emit: (instances: ProjectionInstance[]) => notifyFn?.(instances),
    isSubscribed: () => notifyFn != null,
  };
}

function findWindow(typeId: string, instanceKey: string) {
  return Object.values(useWindowStore.getState().windows).find(
    (w) => w.typeId === typeId && w.instanceKey === instanceKey,
  );
}

describe('P9 projection manager', () => {
  beforeEach(() => {
    resetProjections();
    workbenchBus.setEnabled(true);
    useWindowStore.setState({
      windows: {},
      focusStack: [],
      lifecycles: {},
      launchPayloads: {},
      tilingRatios: {},
      desktopSize: { w: 1600, h: 900 },
    });
  });

  afterEach(() => {
    resetProjections();
    workbenchBus.setEnabled(false);
  });

  it('实例出现 → 自动投射窗口（标题/身份正确）', () => {
    const { source, emit } = makeSource();
    registerProjectionSource('proj-a', source);

    emit([{ instanceKey: 'task_1', title: '任务一', initialFrame: { w: 400, h: 300 } }]);

    const win = findWindow('proj-a', 'task_1');
    expect(win).toBeDefined();
    expect(win!.title).toBe('任务一');
    expect(win!.frame.w).toBe(400);
    expect(win!.frame.h).toBe(300);
  });

  it('同一实例重复出现幂等，不产生第二个窗口', () => {
    const { source, emit } = makeSource();
    registerProjectionSource('proj-b', source);

    emit([{ instanceKey: 'task_1', title: 'T' }]);
    emit([{ instanceKey: 'task_1', title: 'T' }]);
    emit([
      { instanceKey: 'task_1', title: 'T' },
      { instanceKey: 'task_2', title: 'T2' },
    ]);

    const windows = Object.values(useWindowStore.getState().windows).filter(
      (w) => w.typeId === 'proj-b',
    );
    expect(windows).toHaveLength(2);
  });

  it('实例消失 → 默认关窗', () => {
    const { source, emit } = makeSource();
    registerProjectionSource('proj-c', source);

    emit([{ instanceKey: 'task_1', title: 'T' }]);
    expect(findWindow('proj-c', 'task_1')).toBeDefined();

    emit([]);
    expect(findWindow('proj-c', 'task_1')).toBeUndefined();
  });

  it('keepShell=true → 实例消失后窗口保留', () => {
    const { source, emit } = makeSource({ keepShell: true });
    registerProjectionSource('proj-d', source);

    emit([{ instanceKey: 'task_1', title: 'T' }]);
    emit([]);
    expect(findWindow('proj-d', 'task_1')).toBeDefined();
    expect(getProjectedInstances('proj-d')).toEqual([]);
  });

  it('projectWindows=false（badge-only）→ 不投窗但实例状态可查', () => {
    const { source, emit } = makeSource({ projectWindows: false });
    registerProjectionSource('proj-e', source);

    emit([{ instanceKey: 'anki-tasks', title: '' }]);
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(0);
    expect(getProjectedInstances('proj-e')).toEqual(['anki-tasks']);
  });

  it('workbench 未启用期间静默累积，启用后 resyncProjections 补投', () => {
    workbenchBus.setEnabled(false);
    const { source, emit } = makeSource();
    registerProjectionSource('proj-f', source);

    emit([{ instanceKey: 'task_1', title: 'T' }]);
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(0);
    expect(getProjectedInstances('proj-f')).toEqual(['task_1']);

    workbenchBus.setEnabled(true);
    resyncProjections();
    expect(findWindow('proj-f', 'task_1')).toBeDefined();
  });

  it('注销投射源后不再响应 notify；已投射窗口保留', () => {
    const { source, emit, isSubscribed } = makeSource();
    const dispose = registerProjectionSource('proj-g', source);

    emit([{ instanceKey: 'task_1', title: 'T' }]);
    dispose();
    expect(isSubscribed()).toBe(false);
    expect(findWindow('proj-g', 'task_1')).toBeDefined();
    expect(getProjectedInstances('proj-g')).toEqual([]);
  });

  it('同 typeId 重复注册 → 替换旧源并 warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = makeSource();
    const second = makeSource();
    registerProjectionSource('proj-h', first.source);
    registerProjectionSource('proj-h', second.source);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('proj-h'));
    expect(first.isSubscribed()).toBe(false);
    expect(second.isSubscribed()).toBe(true);
    warnSpy.mockRestore();
  });
});
