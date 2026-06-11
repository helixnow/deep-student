/**
 * Android 系统返回键全局协调器（A-5 P0 修复）
 *
 * 链路：
 *   MainActivity.OnBackPressedCallback
 *     → webView.evaluateJavascript('window.__DEEP_STUDENT_HANDLE_BACK__()')
 *     → handleAndroidBack()（本模块）
 *     → 按优先级分发：显式 handler 栈 → Radix 浮层 Escape 兜底 → 应用导航后退
 *     → 返回 false 时 native 执行 moveTaskToBack（应用退到后台，不杀进程）
 *
 * 接入方式：
 * - overlay/抽屉等组件在打开时调用 registerBackHandler(close, priority) 注册，
 *   关闭/卸载时调用返回的注销函数。
 * - App 层注册 priority 最低的导航 fallback（canGoBack ? goBack : false）。
 */

import { debugLog } from '@/debug-panel/debugMasterSwitch';

export type BackHandler = () => boolean;

/** 优先级约定：数值越大越先处理 */
export const BACK_PRIORITY = {
  /** 模态层：Dialog/Sheet/抽屉等 */
  overlay: 100,
  /** 视图内部导航（如 Learning Hub 内部历史） */
  view: 50,
  /** 应用级视图历史 fallback */
  navigation: 0,
} as const;

interface RegisteredHandler {
  handler: BackHandler;
  priority: number;
  seq: number;
}

let seqCounter = 0;
const handlers: RegisteredHandler[] = [];

/**
 * 注册返回键处理器。
 * handler 返回 true 表示事件已消费（native 不再处理）。
 * 同优先级后注册者先执行（栈语义，符合「最后打开的 overlay 最先关闭」）。
 */
export function registerBackHandler(handler: BackHandler, priority: number = BACK_PRIORITY.overlay): () => void {
  const entry: RegisteredHandler = { handler, priority, seq: seqCounter++ };
  handlers.push(entry);
  return () => {
    const idx = handlers.indexOf(entry);
    if (idx >= 0) handlers.splice(idx, 1);
  };
}

/**
 * Radix 系浮层兜底探测：Dialog/AlertDialog/Menu/Popover/Select 打开时，
 * 向 document 派发 Escape 让 Radix 自行关闭。
 * 仅匹配明确的 overlay 角色，避免误伤 accordion/collapsible 等非浮层 data-state。
 */
const OPEN_OVERLAY_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[data-radix-popper-content-wrapper] [role="menu"][data-state="open"]',
  '[data-radix-popper-content-wrapper] [role="listbox"][data-state="open"]',
  '[data-radix-popper-content-wrapper] [role="dialog"]',
].join(', ');

function dismissTopOverlayViaEscape(): boolean {
  const openOverlay = document.querySelector(OPEN_OVERLAY_SELECTOR);
  if (!openOverlay) return false;

  const escapeEvent = new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    bubbles: true,
    cancelable: true,
  });
  // Radix 在 document 上监听 keydown；派发到当前焦点元素可同时覆盖局部监听者
  (document.activeElement ?? document).dispatchEvent(escapeEvent);
  return true;
}

/**
 * 系统返回键统一入口。返回 true 表示前端已消费。
 */
export function handleAndroidBack(): boolean {
  // 1. 显式 handler：高优先级在前，同优先级后注册在前
  const sorted = [...handlers].sort((a, b) => (b.priority - a.priority) || (b.seq - a.seq));
  for (const { handler } of sorted) {
    try {
      if (handler()) {
        debugLog.log('[AndroidBack] consumed by registered handler');
        return true;
      }
    } catch (err) {
      debugLog.error('[AndroidBack] handler threw:', err);
    }
  }

  // 2. Radix 浮层兜底：未显式接入的 Dialog/Menu 等
  if (dismissTopOverlayViaEscape()) {
    debugLog.log('[AndroidBack] dismissed Radix overlay via Escape');
    return true;
  }

  debugLog.log('[AndroidBack] not consumed, native will moveTaskToBack');
  return false;
}

declare global {
  interface Window {
    __DEEP_STUDENT_HANDLE_BACK__?: () => boolean;
  }
}

/** 暴露给 Android native 的同步入口（模块加载即生效） */
export function installAndroidBackBridge(): void {
  window.__DEEP_STUDENT_HANDLE_BACK__ = handleAndroidBack;
}
