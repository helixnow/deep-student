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
 * - 仅当存在「有资格」的注册宿主时才消费按键。资格分承载环境：
 *   - legacy 页面（TodoSidebar 由 App 壳渲染）：宿主可见即有资格
 *     （display:none / visibility:hidden 双重判定）；
 *   - workbench 窗口（宿主祖先带 data-wb-window，见 WindowShell）：可见
 *     之外还要求**窗口处于聚焦态**（data-focused 仅焦点窗持有）——
 *     桌面上仅仅开着一扇待办窗不足以让 ⌘1..8 全局改写视图；
 * - 复用 workbench 的 isShortcutGuardedEvent：焦点在输入框 / IME 组合中不触发；
 * - 多实例共存（Shell 侧栏 + workbench 窗口）时只执行一次（模块级单监听）。
 *
 * 冲突说明（2026-08 复核）：
 * - workbench 快捷键表（shortcuts.ts）与 Tauri 原生菜单（src-tauri/src/menu.rs）
 *   均未占用 ⌘/Ctrl+数字，无冲突；
 * - 命令面板把 mod+1（跳转智能对话）/ mod+2（技能管理）/ mod+5（仪表盘）等
 *   注册为**全局导航热键**（navigation.commands.ts，document 冒泡阶段消费）。
 *   本模块在 window 捕获阶段先行判定：待办宿主有资格（legacy 待办页可见，
 *   或 workbench 待办窗聚焦）时消费并 preventDefault + stopPropagation，
 *   命令面板收不到该事件——语义为「待办上下文内数字键属于待办视图切换」；
 *   宿主无资格时完全放行，mod+数字仍是命令面板的全局导航。该优先级为
 *   有意设计（上下文就近优先），并有测试锁定（todoShellNav.test.ts）。
 */

import { useEffect, type RefObject } from 'react';
import { isShortcutGuardedEvent, isMacShortcutPlatform } from '@/features/workbench/core/shortcuts';
import { isEffectivelyVisible, isHostWindowFocused } from '../utils/domVisibility';
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

// 可见性（display:none / visibility:hidden 双重判定）与窗口聚焦门禁
// 均改用共享 util（utils/domVisibility），语义与旧本地实现完全一致。

/**
 * 注册视图跳转热键宿主。rootRef 指向宿主可见性判定元素
 * （TodoSidebar 的 aside / TodoIconRail 的根）；宿主全部不可见时热键不消费；
 * workbench 窗口内的宿主还需所在窗口聚焦（⌘1..8 不跨窗生效）。
 */
export function useTodoViewHotkeys(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const host: HotkeyHost = {
      isEligible: () => {
        const el = rootRef.current;
        return Boolean(el && isEffectivelyVisible(el) && isHostWindowFocused(el));
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
