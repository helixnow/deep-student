/**
 * R1-07 — probeTarget 六态判定矩阵
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetContentDirtyRegistry,
  registerContentDirtyChecker,
} from '@/features/workbench/apps/content/contentDirtyRegistry';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { resetWindowStoreForTests, useWindowStore } from '@/features/workbench/core/windowStore';
import { registerTestApp } from '@/features/workbench/core/__tests__/testUtils';
import { probeTarget } from '../probe';
import { setAgentControlForTests, stageManager } from '../stageManager';
import type { AcrProbeState, AcrTarget, CollabDriver } from '../types';

registerTestApp('acr-probe-note', { instanceMode: 'multi' });
registerTestApp('acr-probe-todo', { instanceMode: 'single' });

function openNote(resourceId: string): string {
  return useWindowStore.getState().openWindow({
    typeId: 'acr-probe-note',
    instanceKey: resourceId,
  });
}

function makeDriver(typeId: string, state: AcrProbeState): CollabDriver {
  return {
    typeId,
    probe: vi.fn(() => state),
    async apply() {
      return {
        status: 'completed',
        mode: 'frontend',
        applied: 0,
        totalOps: 0,
        entityIds: [],
        done: [],
        undone: [],
      };
    },
    abort() {
      return {
        status: 'cancelled',
        mode: 'frontend',
        applied: 0,
        totalOps: 0,
        entityIds: [],
        done: [],
        undone: [],
      };
    },
  };
}

describe('probeTarget 六态矩阵', () => {
  beforeEach(() => {
    resetWindowStoreForTests({ w: 1400, h: 900 });
    __resetContentDirtyRegistry();
    workbenchBus.setEnabled(true);
    setAgentControlForTests('background');
    // 清掉可能残留的 driver（stageManager 为模块单例）
    for (const typeId of ['acr-probe-note', 'acr-probe-todo']) {
      const existing = stageManager.getDriver(typeId);
      if (existing) {
        // 无 unregister：用 clean 桩覆盖
        stageManager.registerDriver(makeDriver(typeId, 'clean'));
      }
    }
  });

  afterEach(() => {
    workbenchBus.setEnabled(false);
    setAgentControlForTests('background');
    __resetContentDirtyRegistry();
    resetWindowStoreForTests();
  });

  it('disabled：workbenchBus 关闭', () => {
    workbenchBus.setEnabled(false);
    const r = probeTarget({ typeId: 'acr-probe-note', resourceId: 'n1' });
    expect(r).toEqual({ state: 'disabled', windowId: null });
  });

  it('disabled：agentControl=off（legacy 后端降级）', () => {
    setAgentControlForTests('off');
    openNote('n-off');
    const r = probeTarget({ typeId: 'acr-probe-note', resourceId: 'n-off' });
    expect(r).toEqual({ state: 'disabled', windowId: null });
  });

  it('closed：无匹配窗口', () => {
    const r = probeTarget({ typeId: 'acr-probe-note', resourceId: 'missing' });
    expect(r).toEqual({ state: 'closed', windowId: null });
  });

  it('frozen：lifecycle === frozen', () => {
    const id = openNote('n-frozen');
    useWindowStore.getState().setLifecycles({ [id]: 'frozen' });
    const r = probeTarget({ typeId: 'acr-probe-note', resourceId: 'n-frozen' });
    expect(r).toEqual({ state: 'frozen', windowId: id });
  });

  it('hot：焦点窗且 driver.probe 返回 hot', () => {
    const id = openNote('n-hot');
    useWindowStore.getState().setLifecycles({ [id]: 'focused' });
    stageManager.registerDriver(makeDriver('acr-probe-note', 'hot'));
    const r = probeTarget({ typeId: 'acr-probe-note', resourceId: 'n-hot' });
    expect(r).toEqual({ state: 'hot', windowId: id });
  });

  it('hot 降级：非焦点窗即使 driver 报 hot → clean', () => {
    const id = openNote('n-hot-bg');
    useWindowStore.getState().setLifecycles({ [id]: 'background' });
    // 清空 focusStack 语义：最小化再开另一窗会更真实，这里直接标 background + 无栈顶匹配
    stageManager.registerDriver(makeDriver('acr-probe-note', 'hot'));
    // openWindow 会把本窗推入 focusStack；再开一窗抢焦点
    const other = openNote('n-other-focus');
    useWindowStore.getState().setLifecycles({ [id]: 'background', [other]: 'focused' });
    const r = probeTarget({ typeId: 'acr-probe-note', resourceId: 'n-hot-bg' });
    expect(r).toEqual({ state: 'clean', windowId: id });
  });

  it('dirty：driver.probe 返回 dirty', () => {
    const id = openNote('n-dirty-drv');
    useWindowStore.getState().setLifecycles({ [id]: 'visible' });
    stageManager.registerDriver(makeDriver('acr-probe-note', 'dirty'));
    const r = probeTarget({ typeId: 'acr-probe-note', resourceId: 'n-dirty-drv' });
    expect(r).toEqual({ state: 'dirty', windowId: id });
  });

  it('dirty：driver 报 clean 但 isContentDirty 为真', () => {
    const id = openNote('n-dirty-reg');
    useWindowStore.getState().setLifecycles({ [id]: 'focused' });
    stageManager.registerDriver(makeDriver('acr-probe-note', 'clean'));
    registerContentDirtyChecker('acr-probe-note', 'n-dirty-reg', () => true);
    const r = probeTarget({ typeId: 'acr-probe-note', resourceId: 'n-dirty-reg' });
    expect(r).toEqual({ state: 'dirty', windowId: id });
  });

  it('clean：开窗、非 frozen、无脏', () => {
    const id = openNote('n-clean');
    useWindowStore.getState().setLifecycles({ [id]: 'focused' });
    stageManager.registerDriver(makeDriver('acr-probe-note', 'clean'));
    const r = probeTarget({ typeId: 'acr-probe-note', resourceId: 'n-clean' });
    expect(r).toEqual({ state: 'clean', windowId: id });
  });

  it('无 resourceId 时匹配同 typeId 任意窗（单例）', () => {
    const id = useWindowStore.getState().openWindow({ typeId: 'acr-probe-todo' });
    useWindowStore.getState().setLifecycles({ [id]: 'focused' });
    const target: AcrTarget = { typeId: 'acr-probe-todo' };
    expect(probeTarget(target)).toEqual({ state: 'clean', windowId: id });
  });
});
