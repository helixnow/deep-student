/**
 * Chat 导航握手 —— navigate-to-session / CHAT_NEW_SESSION 与 ChatV2Page 挂载时序解耦。
 *
 * 旧方案在 ChatAppWindow / openChatSession / legacyNavigationMap 三处按
 * [0, 400, 1200]ms 三连发 navigate-to-session，赌 ChatV2Page 在窗口期内完成
 * 冷启动（loadSessions 末尾会把当前会话重置为启动 draft，早到的导航会被覆盖）。
 * 三连发有 1.2s 的硬上限，且晚到的重发会把用户手动切换的会话再拽回去。
 *
 * 新方案（握手）：
 * - 页面未就绪（未挂载或初始加载未完成）时，导航意图挂起在这里（只保留最新一条），
 *   同时仍派发标准事件让 WorkbenchEventBridge 打开/聚焦 Chat 壳；
 * - ChatV2Page 初始加载完成后调用 markChatPageReady()，消费挂起意图；
 * - 就绪后请求直接走原有 CustomEvent 链路（navigate-to-session / CHAT_NEW_SESSION），
 *   ModernSidebar 高亮同步、WorkbenchEventBridge 等既有监听者不受影响；
 * - 用户手动切会话（或页面直接消费了一次导航事件）时调用 invalidate 作废挂起意图。
 *
 * 本模块保持零依赖（legacyNavigationMap 亦引用，需维持其轻量约定）。
 */

export type PendingChatNavigation =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new-session' };

let pending: PendingChatNavigation | null = null;
let readyCount = 0;

function dispatchNavigation(nav: PendingChatNavigation): void {
  if (typeof window === 'undefined') return;
  if (nav.kind === 'session') {
    window.dispatchEvent(new CustomEvent('navigate-to-session', {
      detail: { sessionId: nav.sessionId },
    }));
  } else {
    window.dispatchEvent(new CustomEvent('CHAT_NEW_SESSION'));
  }
}

/** ChatV2Page 是否已挂载且完成初始加载（可安全消费导航事件）。 */
export function isChatPageReady(): boolean {
  return readyCount > 0;
}

/**
 * 请求切换到指定会话。
 * 未就绪时挂起，后写覆盖（最新意图生效）；标准事件始终派发一次，让壳层可以
 * 打开/聚焦 Chat。加载中的 ChatV2Page 会忽略这次早到事件，待 ready 后重放。
 */
export function requestChatSessionNavigation(sessionId: string): void {
  if (!isChatPageReady()) {
    pending = { kind: 'session', sessionId };
  }
  dispatchNavigation({ kind: 'session', sessionId });
}

/**
 * 请求新建会话（CHAT_NEW_SESSION）。
 * 未就绪时事件仍然照发 —— 壳层监听者（legacy App 视图切换 / WorkbenchEventBridge
 * 开窗）依赖它打开聊天页面；加载中的 ChatV2Page 忽略早到事件，ready 后再消费
 * 挂起意图，避免会话创建被初始 loadSessions 覆盖。
 */
export function requestChatNewSession(): void {
  if (!isChatPageReady()) {
    pending = { kind: 'new-session' };
  }
  dispatchNavigation({ kind: 'new-session' });
}

/** 用户手动切会话 / 页面已直接消费导航事件：作废挂起的导航意图。 */
export function invalidatePendingChatNavigation(): void {
  pending = null;
}

/**
 * ChatV2Page 初始加载完成后调用：进入就绪态并消费挂起意图（重放为标准事件）。
 * 返回解除函数（页面卸载时调用），幂等。
 */
export function markChatPageReady(): () => void {
  readyCount += 1;
  const nav = pending;
  pending = null;
  if (nav) dispatchNavigation(nav);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    readyCount = Math.max(0, readyCount - 1);
  };
}

/** 测试辅助：查看当前挂起意图。 */
export function peekPendingChatNavigation(): PendingChatNavigation | null {
  return pending;
}

/** 测试辅助：重置模块状态。 */
export function resetChatNavigationHandshakeForTest(): void {
  pending = null;
  readyCount = 0;
}
