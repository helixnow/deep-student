/**
 * todoShellNav — 待办外壳级导航动作 + 视图跳转热键（Cmd/Ctrl+1..9）
 *
 * 动作层：TodoSidebar / TodoIconRail / 热键共用的一组无组件依赖的
 * 导航动作（直接操作 useTodoStore / useTodoTrashView 的 getState），
 * 保证各入口切视图的副作用（关回收站、切 workspaceView、收敛 activeList）
 * 完全一致。
 *
 * 热键层：⌘/Ctrl+1..6 = 智能视图（收件箱/今日/即将到期/四象限/已过期/已完成），
 * ⌘/Ctrl+7 = 定时任务，⌘/Ctrl+8 = 回收站；9 暂未分配。
 * - 仅当存在可见的注册宿主（TodoSidebar / TodoIconRail 挂载且未被
 *   display:none / visibility:hidden 隐藏）时才消费按键；
 * - 复用 workbench 的 isShortcutGuardedEvent：焦点在输入框 / IME 组合中不触发；
 * - 多实例共存（Shell 侧栏 + workbench 窗口）时只执行一次（模块级单监听）。
 *
 * 冲突排查（2026-07）：workbench 快捷键表（shortcuts.ts）与 Tauri 原生菜单
 * （src-tauri/src/menu.rs）均未占用 ⌘/Ctrl+数字，无冲突。
 */

import { useEffect, type RefObject } from 'react';
import { isShortcutGuardedEvent, isMacShortcutPlatform } from '@/features/workbench/core/shortcuts';
import { useTodoStore } from '../stores/useTodoStore';
import { useTodoTrashView } from './TodoTrashDialog';
import type { TodoViewFilter } from '../types';

/** 智能视图的规范顺序（热键 1..6 与侧栏/图标栏渲染顺序的单一来源） */
export const TODO_SMART_VIEW_ORDER: readonly TodoViewFilter[] = [
  'all',
  'today',
  'upcoming',
  'matrix',
  'overdue',
  'completed',
];

/** 视图跳转热键的键帽提示（tooltip 用）：macOS "⌘1"，其他平台 "Ctrl+1" */
export function todoHotkeyHint(slot: number): string {
  return isMacShortcutPlatform() ? `⌘${slot}` : `Ctrl+${slot}`;
}

// ============================================================================
// 导航动作（与 TodoSidebar 点击行为语义一致）
// ============================================================================

export function activateTodoSmartView(view: TodoViewFilter): void {
  const store = useTodoStore.getState();
  if (view === 'all') {
    // 收件箱语义 = 默认清单的 all 视图
    const defaultList = store.lists.find((l) => l.isDefault) || store.lists[0];
    if (defaultList) store.setActiveList(defaultList.id);
  } else {
    store.setActiveList(null);
  }
  useTodoTrashView.getState().close();
  store.setWorkspaceView('todos');
  store.setViewFilter(view);
}

export function activateTodoList(listId: string): void {
  const store = useTodoStore.getState();
  useTodoTrashView.getState().close();
  store.setWorkspaceView('todos');
  if (store.filter.view !== 'all') {
    store.setActiveList(listId);
    store.setViewFilter('all');
  } else {
    store.setActiveList(listId);
  }
}

export function activateTodoAutomations(): void {
  useTodoTrashView.getState().close();
  useTodoStore.getState().setWorkspaceView('automations');
}

export function openTodoTrashView(): void {
  useTodoTrashView.getState().open();
}

// ============================================================================
// 热键（模块级单监听 + 可见宿主注册表）
// ============================================================================

interface HotkeyHost {
  isEligible: () => boolean;
}

const hotkeyHosts = new Set<HotkeyHost>();
let hotkeyListenerAttached = false;

function anyHostEligible(): boolean {
  for (const host of hotkeyHosts) {
    if (host.isEligible()) return true;
  }
  return false;
}

function handleHotkeyKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  const match = /^Digit([1-9])$/.exec(e.code);
  if (!match) return;
  if (isShortcutGuardedEvent(e)) return;
  if (!anyHostEligible()) return;

  const n = Number(match[1]);
  if (n >= 1 && n <= TODO_SMART_VIEW_ORDER.length) {
    activateTodoSmartView(TODO_SMART_VIEW_ORDER[n - 1]);
  } else if (n === 7) {
    activateTodoAutomations();
  } else if (n === 8) {
    openTodoTrashView();
  } else {
    return; // 9 未分配，放行给其他消费者
  }
  e.preventDefault();
  e.stopPropagation();
}

/** display:none（无 rects）与 visibility:hidden（ViewLayerRenderer 离场层）双重判定 */
function isElementVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  if (el.getClientRects().length === 0) return false;
  if (typeof window.getComputedStyle === 'function') {
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
  }
  return true;
}

/**
 * 注册视图跳转热键宿主。rootRef 指向宿主可见性判定元素
 * （TodoSidebar 的 aside / TodoIconRail 的根）；宿主全部不可见时热键不消费。
 */
export function useTodoViewHotkeys(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const host: HotkeyHost = {
      isEligible: () => {
        const el = rootRef.current;
        return Boolean(el && isElementVisible(el));
      },
    };
    hotkeyHosts.add(host);
    if (!hotkeyListenerAttached) {
      window.addEventListener('keydown', handleHotkeyKeyDown, true);
      hotkeyListenerAttached = true;
    }
    return () => {
      hotkeyHosts.delete(host);
      if (hotkeyHosts.size === 0 && hotkeyListenerAttached) {
        window.removeEventListener('keydown', handleHotkeyKeyDown, true);
        hotkeyListenerAttached = false;
      }
    };
  }, [rootRef]);
}
