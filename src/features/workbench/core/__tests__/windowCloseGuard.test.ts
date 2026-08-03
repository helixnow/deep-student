import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appRegistry } from '../appRegistry';
import { resetWindowStoreForTests, useWindowStore } from '../windowStore';
import { workbenchBus } from '../workbenchBus';
import { requestCloseAnimated } from '../../hooks/useWindowLifecycleAnim';
import {
  __resetWindowDirtyForTests,
  isWindowDirty,
  setWindowDirty,
  subscribeWindowDirty,
} from '../windowCloseGuard';
import type { AppDefinition } from '../types';

const TYPE_ID = 'close-single-flight-test';
let canCloseImpl: () => boolean | Promise<boolean> = () => true;

appRegistry.register({
  typeId: TYPE_ID,
  nameKey: 'workbench:test.close',
  icon: null,
  instanceMode: 'multi',
  memoryWeight: 1,
  defaultFrame: { w: 400, h: 300 },
  minSize: { w: 200, h: 150 },
  render: null as unknown as AppDefinition['render'],
  canClose: () => canCloseImpl(),
});

beforeEach(() => {
  resetWindowStoreForTests({ w: 1400, h: 900 });
  workbenchBus.setEnabled(true);
  canCloseImpl = () => true;
  __resetWindowDirtyForTests();
});

function openWindow(): string {
  return useWindowStore.getState().openWindow({ typeId: TYPE_ID, instanceKey: 'one' });
}

describe('window close confirmation single-flight', () => {
  it('两个并发动画关闭只执行一次 canClose，并得到同一结果', async () => {
    const id = openWindow();
    let resolve!: (allowed: boolean) => void;
    const canClose = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    canCloseImpl = canClose;

    const first = requestCloseAnimated(id);
    const second = requestCloseAnimated(id);
    await Promise.resolve();
    expect(canClose).toHaveBeenCalledTimes(1);
    resolve(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(canClose).toHaveBeenCalledTimes(1);
    expect(useWindowStore.getState().transientPhases?.[id]).toBe('closing');
  });

  it('动画入口与 workbenchBus.closeWindow 共享同一 canClose guard', async () => {
    const id = openWindow();
    let resolve!: (allowed: boolean) => void;
    const canClose = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    canCloseImpl = canClose;

    const animated = requestCloseAnimated(id);
    const direct = workbenchBus.closeWindow(id);
    await Promise.resolve();
    expect(canClose).toHaveBeenCalledTimes(1);
    resolve(true);
    await expect(Promise.all([animated, direct])).resolves.toEqual([true, true]);
    expect(canClose).toHaveBeenCalledTimes(1);
  });
});

describe('窗口脏状态通道（P1 未保存圆点）', () => {
  it('setWindowDirty 可查询、可清除，未标记窗口默认干净', () => {
    expect(isWindowDirty('win-a')).toBe(false);
    setWindowDirty('win-a', true);
    expect(isWindowDirty('win-a')).toBe(true);
    expect(isWindowDirty('win-b')).toBe(false);
    setWindowDirty('win-a', false);
    expect(isWindowDirty('win-a')).toBe(false);
  });

  it('脏状态变化通知订阅者；幂等写入不重复通知', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWindowDirty(listener);

    setWindowDirty('win-a', true);
    expect(listener).toHaveBeenCalledTimes(1);
    // 幂等：同值再写不通知
    setWindowDirty('win-a', true);
    expect(listener).toHaveBeenCalledTimes(1);
    setWindowDirty('win-a', false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setWindowDirty('win-a', true);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
