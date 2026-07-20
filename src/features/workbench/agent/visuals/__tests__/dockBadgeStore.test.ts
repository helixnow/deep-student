/**
 * ACR 4.0（A5）— Dock 后台完成角标数据层单测
 * 覆盖：presence 'done'（非聚焦窗）→ 记角标；聚焦窗完成不记；
 * 窗口获得焦点 / 被关闭 → 清除；订阅清理后不再记录。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePresenceStore } from '../../presenceStore';
import { resetWindowStoreForTests, useWindowStore } from '../../../core/windowStore';
import { registerTestApp } from '../../../core/__tests__/testUtils';
import type { PresenceState } from '../../types';
import {
  startDockAgentBadgeTracking,
  useDockAgentBadgeStore,
} from '../dockBadgeStore';

registerTestApp('badge-note');
registerTestApp('badge-pdf');

function presenceOf(over: Partial<PresenceState>): PresenceState {
  return {
    runKey: 'rk-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    windowId: 'w-1',
    typeId: 'badge-note',
    status: 'acting',
    label: '插入段落',
    startedAt: Date.now(),
    ttlMs: 8000,
    ...over,
  };
}

describe('dockBadgeStore — presence done → 角标 → 聚焦清除', () => {
  let stop: (() => void) | null = null;
  let winA = '';
  let winB = '';

  beforeEach(() => {
    resetWindowStoreForTests({ w: 1600, h: 900 });
    usePresenceStore.getState().clearAll();
    useDockAgentBadgeStore.getState().clearAll();
    winA = useWindowStore.getState().openWindow({ typeId: 'badge-note' });
    winB = useWindowStore.getState().openWindow({ typeId: 'badge-pdf' });
    // winB 后开 → 前台聚焦；winA 处于后台
    stop = startDockAgentBadgeTracking();
  });

  afterEach(() => {
    stop?.();
    stop = null;
    usePresenceStore.getState().clearAll();
    useDockAgentBadgeStore.getState().clearAll();
  });

  it('非聚焦窗口 run 完成 → 记录该应用角标', () => {
    usePresenceStore.getState().setPresence(presenceOf({ windowId: winA }));
    expect(useDockAgentBadgeStore.getState().byWindow).toEqual({});

    usePresenceStore.getState().updateStatus('rk-1', 'done');
    expect(useDockAgentBadgeStore.getState().byWindow[winA]).toBe('badge-note');
  });

  it('前台聚焦窗口 run 完成 → 不记角标', () => {
    usePresenceStore
      .getState()
      .setPresence(presenceOf({ windowId: winB, typeId: 'badge-pdf' }));
    usePresenceStore.getState().updateStatus('rk-1', 'done');
    expect(useDockAgentBadgeStore.getState().byWindow).toEqual({});
  });

  it('用户聚焦带角标窗口 → 清除', () => {
    usePresenceStore.getState().setPresence(presenceOf({ windowId: winA }));
    usePresenceStore.getState().updateStatus('rk-1', 'done');
    expect(useDockAgentBadgeStore.getState().byWindow[winA]).toBe('badge-note');

    useWindowStore.getState().focusWindow(winA);
    expect(useDockAgentBadgeStore.getState().byWindow[winA]).toBeUndefined();
  });

  it('带角标窗口被关闭 → 清除（不留悬挂角标）', () => {
    usePresenceStore.getState().setPresence(presenceOf({ windowId: winA }));
    usePresenceStore.getState().updateStatus('rk-1', 'done');
    expect(useDockAgentBadgeStore.getState().byWindow[winA]).toBe('badge-note');

    useWindowStore.getState().closeWindow(winA);
    expect(useDockAgentBadgeStore.getState().byWindow[winA]).toBeUndefined();
  });

  it('同一 run 重复 done 更新不重复写入；订阅清理后不再记录', () => {
    usePresenceStore.getState().setPresence(presenceOf({ windowId: winA }));
    usePresenceStore.getState().updateStatus('rk-1', 'done');
    const snapshot = useDockAgentBadgeStore.getState().byWindow;
    // 同 run 再次 done（label 覆写等场景）不产生新引用
    usePresenceStore.getState().updateStatus('rk-1', 'done', '重复');
    expect(useDockAgentBadgeStore.getState().byWindow).toBe(snapshot);

    stop?.();
    stop = null;
    useDockAgentBadgeStore.getState().clearAll();
    usePresenceStore
      .getState()
      .setPresence(presenceOf({ windowId: winA, runKey: 'rk-2', status: 'done' }));
    expect(useDockAgentBadgeStore.getState().byWindow).toEqual({});
  });
});
