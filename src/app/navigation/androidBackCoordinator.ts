/**
 * Android 系统返回键全局协调器（A-5 P0 修复）
 *
 * 链路：
 *   MainActivity.OnBackPressedCallback
 *     → webView.evaluateJavascript('window.__DEEP_STUDENT_HANDLE_BACK__()')
 *     → handleAndroidBack()（本模块）
 *     → 按优先级分发：显式 overlay handler 栈 → Radix 浮层 Escape 兜底
 *       → 显式 view/navigation handler → 返回 false 时 native 执行
 *       moveTaskToBack（应用退到后台，不杀进程）
 *
 * Radix 兜底的插入位置（2026-07 移动端审计 残留#2）：
 * 未显式注册 handler 的 Radix 浮层（shad/Sheet、shad/Select 下拉等）语义上属
 * overlay 层，兜底探测必须先于 view（页内导航）与 navigation（应用级历史）
 * handler 执行，否则「浮层还开着，返回键却先切走了视图」。显式注册的 overlay
 * handler 仍然最先执行（栈语义不变）；探测只在真的存在 data-state="open" 的
 * Radix 浮层时消费事件，无浮层时行为与旧实现完全一致。
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
  // 显式 handler：高优先级在前，同优先级后注册在前。
  // Radix 浮层 Escape 兜底夹在 overlay 档与更低优先级档之间执行（见文件头注释）：
  // 显式 overlay handler（含 NotionDialog/AppMenu 等自绘弹层）保持最先，
  // 未显式接入的 Radix 浮层其次，view / navigation handler 只有在没有任何
  // 打开的浮层时才会拿到事件，保证「先关浮层再退页面」。
  const sorted = [...handlers].sort((a, b) => (b.priority - a.priority) || (b.seq - a.seq));
  let radixProbeDone = false;
  const probeRadixOverlay = (): boolean => {
    radixProbeDone = true;
    if (dismissTopOverlayViaEscape()) {
      debugLog.log('[AndroidBack] dismissed Radix overlay via Escape');
      return true;
    }
    return false;
  };

  for (const { handler, priority } of sorted) {
    if (!radixProbeDone && priority < BACK_PRIORITY.overlay && probeRadixOverlay()) {
      return true;
    }
    try {
      if (handler()) {
        debugLog.log('[AndroidBack] consumed by registered handler');
        return true;
      }
    } catch (err) {
      debugLog.error('[AndroidBack] handler threw:', err);
    }
  }

  // 全部 handler 都是 overlay 档（或没有 handler）时，兜底探测在循环后补跑
  if (!radixProbeDone && probeRadixOverlay()) {
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
