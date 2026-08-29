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
 * - scrollToMessage：走 MessageList 注册的程序化滚动 handle（A45-5，
 *                docs/dev/acr/ACR-4.5.md）——虚拟化长会话（>80 条）内部经
 *                virtualizer.scrollToIndex 定位，直渲会话先补齐尾部窗口；
 *                目标行挂载后 agentFlash 演出。旧的 role="log" 子节点 DOM
 *                定位已移除（虚拟化下目标行未渲染必然失败的已知遗留）。
 *
 * 注意：本模块保持轻量（会被 P11 registerAll 在 workbench 启动时同步 import），
 * chat 核心（sessionManager）一律动态 import，重 UI 走 React.lazy。
 */
import React from 'react';
import { AppIconImage } from '../../icons/appIcons';
import { appRegistry } from '../../core/appRegistry';
import type { ActivationContext, ActivationResult, AppDefinition } from '../../core/types';
import type { ChatStore } from '@/features/chat/core/types';
import type { StoreApi } from 'zustand';
import { createChatAgentManifest } from './agentManifest';

export const CHAT_APP_TYPE_ID = 'chat';
export const CHAT_SESSION_APP_TYPE_ID = 'chat-session';

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
 * A45-5（docs/dev/acr/ACR-4.5.md）：滚动到指定消息。
 *
 * 走 features/chat 的 messageListScrollRegistry —— MessageList 在挂载期按
 * sessionId 注册程序化滚动 handle：
 * - 虚拟化长会话（>80 条）：virtualizer.scrollToIndex 定位，行挂载后精确对齐；
 * - 直渲会话：尾部窗口未补齐时先展开再等目标行挂载。
 * handle 未注册（窗口冷启动）时按短重试等待；仍不可达则结构化诚实失败，
 * 不再有「虚拟化必失败」的遗留。定位成功后对目标行做 agentFlash 演出。
 */
async function scrollToMessage(
  sessionId: string,
  payload: unknown,
): Promise<ActivationResult> {
  const messageId =
    payload && typeof payload === 'object'
      ? (payload as { messageId?: unknown }).messageId
      : payload;
  if (typeof messageId !== 'string' || !messageId) {
    return {
      handled: false,
      code: 'INVALID_ARGS',
      hint: 'scrollToMessage 需要 payload.messageId',
    };
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return {
      handled: false,
      code: 'WINDOW_NOT_FOUND',
      hint: 'Chat 视图未就绪，无法定位消息',
    };
  }

  const { getChatMessageListScrollHandle } = await import(
    '@/features/chat/components/messageListScrollRegistry'
  );
  const wait = (ms: number) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

  // 首轮立即尝试；后续重试等待窗口冷启动期 MessageList 完成挂载注册
  const delays = [0, 250, 800, 1500];
  let failure: ActivationResult = {
    handled: false,
    code: 'WINDOW_NOT_FOUND',
    hint: 'Chat 消息列表未挂载，无法定位消息',
  };
  for (const delay of delays) {
    if (delay > 0) await wait(delay);
    const handle = getChatMessageListScrollHandle(sessionId);
    if (!handle) {
      failure = {
        handled: false,
        code: 'WINDOW_NOT_FOUND',
        hint: 'Chat 消息列表未挂载，无法定位消息',
      };
      continue;
    }
    const outcome = await handle.scrollToMessage(messageId);
    if (outcome.status === 'scrolled') {
      // 定位演出：目标行 flash（scroll:false —— handle 已完成视口内对齐）；
      // 演出失败不影响定位回执
      try {
        const { agentFlash } = await import('../../agent/visuals/agentFlash');
        const root = document.querySelector(
          `[data-wb-chat-session="${escapeAttrValue(sessionId)}"]`,
        );
        agentFlash('chat', messageId, { scroll: false, scope: root ?? undefined });
      } catch {
        console.warn('[workbench:chat] scrollToMessage flash skipped');
      }
      return { handled: true, acknowledged: true };
    }
    failure = outcome.status === 'message_not_found'
      ? {
          handled: false,
          code: 'MESSAGE_NOT_FOUND',
          hint: '该消息不在目标会话的消息列表中（可能属于其他会话或已被删除）',
        }
      : {
          handled: false,
          code: 'VIEW_NOT_READY',
          hint: 'Chat 消息列表未就绪或目标消息行未能挂载，请稍后重试',
        };
  }
  console.warn(
    `[workbench:chat] scrollToMessage failed (${failure.code}): ${sessionId}/${messageId}`,
  );
  return failure;
}

function extractPayloadSessionId(payload: unknown): string | null {
  const value = payload && typeof payload === 'object'
    ? (payload as { sessionId?: unknown }).sessionId
    : undefined;
  return typeof value === 'string' && value ? value : null;
}

/** 会话已确定后的动作分发（chat 单例与 chat-session multi 实例共用） */
async function dispatchChatAction(
  sessionId: string,
  ctx: ActivationContext,
): Promise<ActivationResult> {
  let delivered = false;
  switch (ctx.action) {
    case 'setInput':
      delivered = await setInput(sessionId, ctx.payload);
      break;
    case 'focusInput':
      delivered = await focusSessionInput(sessionId);
      break;
    case 'scrollToMessage':
      // A45-5：直接透传结构化回执（成功带 acknowledged，失败带 code/hint）
      return scrollToMessage(sessionId, ctx.payload);
    default:
      console.warn(`[workbench:chat] unknown activation action: ${ctx.action}`);
      return { handled: false, code: 'UNKNOWN_ACTION', hint: `Chat 不支持指令 ${ctx.action}` };
  }
  return delivered
    ? { handled: true, acknowledged: true }
    : { handled: false, code: 'DELIVERY_FAILED', hint: 'Chat 指令未投递到目标会话' };
}

export async function handleChatActivation(ctx: ActivationContext): Promise<ActivationResult> {
  const payloadSessionId = extractPayloadSessionId(ctx.payload);
  const manager = await getSessionManager();
  const sessionId = payloadSessionId ?? manager.getCurrentSessionId() ?? ctx.instanceKey;
  if (!sessionId) {
    console.warn('[workbench:chat] activation ignored: no active session');
    return { handled: false, code: 'SESSION_ID_REQUIRED', hint: 'Chat 当前没有活动会话' };
  }
  return dispatchChatAction(sessionId, ctx);
}

/**
 * chat-session multi 实例窗的激活：会话身份就是 instanceKey
 * （不回落全局 currentSessionId，保证多窗隔离）；payload.sessionId 仅作显式覆盖。
 */
export async function handleChatSessionActivation(
  ctx: ActivationContext,
): Promise<ActivationResult> {
  const sessionId = extractPayloadSessionId(ctx.payload) ?? ctx.instanceKey;
  if (!sessionId) {
    console.warn('[workbench:chat-session] activation ignored: no session instance');
    return { handled: false, code: 'SESSION_ID_REQUIRED', hint: '该窗口未绑定会话' };
  }
  return dispatchChatAction(sessionId, ctx);
}

// ============================================================================
// AppDefinition
// ============================================================================

export const chatAppDefinition: AppDefinition = {
  typeId: CHAT_APP_TYPE_ID,
  nameKey: 'apps.chat.name',
  icon: React.createElement(AppIconImage, { typeId: 'chat', className: 'h-8 w-8' }),
  instanceMode: 'single',
  memoryWeight: 2,
  defaultFrame: { w: 1080, h: 720 },
  minSize: { w: 640, h: 460 },
  // O16：先导轻壳（骨架屏 + 二段 lazy）——重 chunk 加载期显示消息气泡骨架
  // 而非 WindowBody 的通用转圈；chat 核心代码仍不进 workbench 首包。
  render: React.lazy(() => import('./ChatWindowFrame')),
  onActivation: handleChatActivation,
  agentManifest: createChatAgentManifest(handleChatActivation),
};

/**
 * chat-session — 单会话 multi 实例窗口（会话右键「在新窗口打开」）。
 *
 * ChatSessionSurface 本就为多窗设计（store 按 sessionId 隔离、adapter
 * 引用计数），这里补上正式的应用外壳：instanceKey = sessionId，
 * 同一会话重复打开时 workbenchBus 按 instanceKey 去重聚焦已有窗口。
 * showInLauncher: false —— 没有会话上下文无法独立启动，入口只在会话列表。
 */
export const chatSessionAppDefinition: AppDefinition = {
  typeId: CHAT_SESSION_APP_TYPE_ID,
  nameKey: 'apps.chatSession.name',
  icon: React.createElement(AppIconImage, { typeId: 'chat', className: 'h-8 w-8' }),
  showInLauncher: false,
  instanceMode: 'multi',
  memoryWeight: 2,
  defaultFrame: { w: 860, h: 640 },
  minSize: { w: 480, h: 400 },
  render: React.lazy(() => import('./ChatSessionWindowFrame')),
  onActivation: handleChatSessionActivation,
};

let registered = false;

/** 幂等注册；模块被 import 时自动执行一次（P11 registerAll 直接 import 本模块即可） */
export function registerChatApp(): void {
  if (registered) return;
  registered = true;
  appRegistry.register(chatAppDefinition);
  appRegistry.register(chatSessionAppDefinition);
}

registerChatApp();
