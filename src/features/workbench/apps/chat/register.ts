/**
 * Chat 应用注册（P7）
 *
 * typeId='chat'，single；会话切换由窗口内的 ChatV2Page + ModernSidebar 管理。
 * onActivation 支持三个一次性指令（映射现有 CHAT_V2_* 事件逻辑）：
 * - setInput   ：直接写目标会话 store 的 setInputValue（legacy 的 CHAT_V2_SET_INPUT
 *                经 ChatV2Page 的 currentSessionId 中转；workbench 模式下该页不挂载，
 *                这里改为按 instanceKey 精确写入目标 store，天然多窗隔离）；
 * - focusInput ：派发 CHAT_V2_FOCUS_INPUT（InputBarUI 已按 detail.sessionId 过滤，
 *                与 useSessionLifecycle.requestChatInputFocus 同款 rAF+timeout 双保险）；
 * - scrollToMessage：窗口内 DOM 定位（data-wb-chat-session 作用域 + role="log" 子节点
 *                与 messageOrder 一一对应时 scrollIntoView；虚拟化长会话为已知限制）。
 *
 * 注意：本模块保持轻量（会被 P11 registerAll 在 workbench 启动时同步 import），
 * chat 核心（sessionManager）一律动态 import，重 UI 走 React.lazy。
 */
import React from 'react';
import { ChatCircleDots } from '@phosphor-icons/react';
import { appRegistry } from '../../core/appRegistry';
import type { ActivationContext, ActivationResult, AppDefinition } from '../../core/types';
import type { ChatStore } from '@/features/chat/core/types';
import type { StoreApi } from 'zustand';

export const CHAT_APP_TYPE_ID = 'chat';

// ============================================================================
// onActivation 动作实现
// ============================================================================

type SessionManagerLike = {
  get: (sessionId: string) => StoreApi<ChatStore> | undefined;
  getCurrentSessionId: () => string | null;
};

async function getSessionManager(): Promise<SessionManagerLike> {
  const mod = await import('@/features/chat/core/session/sessionManager');
  return mod.sessionManager;
}

/**
 * 会话 store 就绪重试：activate 带 fallbackLaunch 时窗口刚创建，
 * store 由 surface 挂载时才建立，这里用短重试等待其出现。
 */
async function withSessionStore(
  sessionId: string,
  fn: (store: StoreApi<ChatStore>) => void,
  delays: number[] = [0, 120, 400, 1000],
): Promise<boolean> {
  const manager = await getSessionManager();
  return new Promise<boolean>((resolve, reject) => {
    const attempt = (index: number) => {
      if (typeof window === 'undefined') {
        resolve(false);
        return;
      }
      const store = manager.get(sessionId);
      if (store) {
        try {
          fn(store);
          resolve(true);
        } catch (error) {
          reject(error);
        }
        return;
      }
      if (index >= delays.length) {
        console.warn(`[workbench:chat] session store not ready, action dropped: ${sessionId}`);
        resolve(false);
        return;
      }
      window.setTimeout(() => attempt(index + 1), delays[index]);
    };
    attempt(0);
  });
}

function findSessionInput(sessionId: string): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null;
  const root = document.querySelector(
    `[data-wb-chat-session="${escapeAttrValue(sessionId)}"]`,
  );
  return root?.querySelector<HTMLTextAreaElement>(
    'textarea[data-testid="input-bar-v2-textarea"]',
  ) ?? null;
}

/**
 * Wait for the actual composer, then confirm DOM focus before reporting success.
 * WindowBody readiness only proves that the app shell committed; ChatContainer may
 * still be rendering its cold-start skeleton while the adapter loads.
 */
async function focusSessionInput(
  sessionId: string,
  delays: number[] = [0, 120, 400, 1000],
): Promise<boolean> {
  const storeReady = await withSessionStore(sessionId, () => {});
  if (!storeReady || typeof window === 'undefined') return false;

  return new Promise<boolean>((resolve) => {
    const attempt = (index: number) => {
      if (typeof window === 'undefined' || typeof document === 'undefined') {
        resolve(false);
        return;
      }

      const input = findSessionInput(sessionId);
      if (input?.isConnected) {
        window.dispatchEvent(
          new CustomEvent('CHAT_V2_FOCUS_INPUT', { detail: { sessionId } }),
        );
        try {
          input.focus({ preventScroll: true });
        } catch {
          input.focus();
        }
        if (document.activeElement === input) {
          resolve(true);
          return;
        }
      }

      if (index >= delays.length) {
        console.warn(`[workbench:chat] input not ready, focus action dropped: ${sessionId}`);
        resolve(false);
        return;
      }
      window.setTimeout(() => attempt(index + 1), delays[index]);
    };
    attempt(0);
  });
}

async function setInput(sessionId: string, payload: unknown): Promise<boolean> {
  const content =
    typeof payload === 'string'
      ? payload
      : payload && typeof payload === 'object'
        ? (payload as { content?: unknown }).content
        : undefined;
  if (typeof content !== 'string') return false;

  const shouldFocus =
    !!payload && typeof payload === 'object' && (payload as { focus?: unknown }).focus === true;

  const delivered = await withSessionStore(sessionId, (store) => {
    store.getState().setInputValue(content);
  });
  if (!delivered) return false;
  return shouldFocus ? await focusSessionInput(sessionId) : true;
}

function escapeAttrValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * 滚动到指定消息（best-effort）：
 * MessageItem 没有 message id DOM 锚点（chat 文件不可改），
 * 直接渲染模式下 div[role="log"] 的子节点与 messageOrder 一一对应，按索引定位；
 * 虚拟化模式（>80 条）或渐进渲染首帧窗口期无法精确定位，记录为遗留。
 */
async function scrollToMessage(sessionId: string, payload: unknown): Promise<boolean> {
  const messageId =
    payload && typeof payload === 'object'
      ? (payload as { messageId?: unknown }).messageId
      : payload;
  if (typeof messageId !== 'string' || !messageId) return false;

  const manager = await getSessionManager();
  return await new Promise<boolean>((resolve) => {
    const delays = [0, 250, 800];
    const attempt = (index: number) => {
      if (typeof window === 'undefined' || typeof document === 'undefined') {
        resolve(false);
        return;
      }
      const store = manager.get(sessionId);
      const order = store?.getState().messageOrder ?? [];
      const targetIndex = order.indexOf(messageId);
      const root = document.querySelector(
        `[data-wb-chat-session="${escapeAttrValue(sessionId)}"]`,
      );
      const log = root?.querySelector<HTMLElement>('[role="log"]');

      if (store && targetIndex >= 0 && log && log.children.length === order.length) {
        const el = log.children[targetIndex] as HTMLElement | undefined;
        if (el) {
          // Keep message navigation inside this window's message viewport. A plain
          // scrollIntoView can also scroll the OS/workbench window host itself.
          const viewport = log.closest<HTMLElement>(
            '[data-overlayscrollbars-viewport], .scroll-area--native',
          );
          if (viewport) {
            const viewportRect = viewport.getBoundingClientRect();
            const messageRect = el.getBoundingClientRect();
            const target = viewport.scrollTop + messageRect.top - viewportRect.top;
            viewport.scrollTo({
              top: Math.max(0, Math.min(target, viewport.scrollHeight - viewport.clientHeight)),
              behavior: 'smooth',
            });
          } else {
            el.scrollIntoView({ block: 'start', behavior: 'smooth' });
          }
          resolve(true);
          return;
        }
      }

      if (index < delays.length) {
        window.setTimeout(() => attempt(index + 1), delays[index]);
      } else {
        console.warn(
          `[workbench:chat] scrollToMessage best-effort failed (virtualized or not mounted): ${sessionId}/${messageId}`,
        );
        resolve(false);
      }
    };
    attempt(0);
  });
}

export async function handleChatActivation(ctx: ActivationContext): Promise<ActivationResult> {
  const payloadSessionId = ctx.payload && typeof ctx.payload === 'object'
    ? (ctx.payload as { sessionId?: unknown }).sessionId
    : undefined;
  const manager = await getSessionManager();
  const sessionId = typeof payloadSessionId === 'string' && payloadSessionId
    ? payloadSessionId
    : manager.getCurrentSessionId() ?? ctx.instanceKey;
  if (!sessionId) {
    console.warn('[workbench:chat] activation ignored: no active session');
    return { handled: false, code: 'SESSION_ID_REQUIRED', hint: 'Chat 当前没有活动会话' };
  }
  let delivered = false;
  switch (ctx.action) {
    case 'setInput':
      delivered = await setInput(sessionId, ctx.payload);
      break;
    case 'focusInput':
      delivered = await focusSessionInput(sessionId);
      break;
    case 'scrollToMessage':
      delivered = await scrollToMessage(sessionId, ctx.payload);
      break;
    default:
      console.warn(`[workbench:chat] unknown activation action: ${ctx.action}`);
      return { handled: false, code: 'UNKNOWN_ACTION', hint: `Chat 不支持指令 ${ctx.action}` };
  }
  return delivered
    ? { handled: true }
    : { handled: false, code: 'DELIVERY_FAILED', hint: 'Chat 指令未投递到目标会话' };
}

// ============================================================================
// AppDefinition
// ============================================================================

export const chatAppDefinition: AppDefinition = {
  typeId: CHAT_APP_TYPE_ID,
  nameKey: 'apps.chat.name',
  icon: React.createElement(ChatCircleDots, { size: 22, weight: 'duotone' }),
  instanceMode: 'single',
  memoryWeight: 2,
  defaultFrame: { w: 1080, h: 720 },
  minSize: { w: 640, h: 460 },
  // O16：先导轻壳（骨架屏 + 二段 lazy）——重 chunk 加载期显示消息气泡骨架
  // 而非 WindowBody 的通用转圈；chat 核心代码仍不进 workbench 首包。
  render: React.lazy(() => import('./ChatWindowFrame')),
  onActivation: handleChatActivation,
};

let registered = false;

/** 幂等注册；模块被 import 时自动执行一次（P11 registerAll 直接 import 本模块即可） */
export function registerChatApp(): void {
  if (registered) return;
  registered = true;
  appRegistry.register(chatAppDefinition);
}

registerChatApp();
