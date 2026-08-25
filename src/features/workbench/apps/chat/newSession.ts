/**
 * 新会话入口（P7）— 供 Dock / P11 消费。
 *
 * 先经现有链路创建会话（createSessionWithDefaults：后端建会话 + store 预置 +
 * 默认技能激活 + 分组固定资源注入），再打开 Chat 单例并切到该会话。
 */
import { workbenchBus } from '../../core/workbenchBus';
import type { LaunchReason } from '../../core/types';
import { createSessionWithDefaults } from '@/features/chat/core/session/createSessionWithDefaults';
import { requestChatSessionNavigation } from '@/features/chat/navigation/pendingChatNavigation';
import { CHAT_APP_TYPE_ID, CHAT_SESSION_APP_TYPE_ID, registerChatApp } from './register';

export interface LaunchNewChatSessionOptions {
  /** 会话归属分组（默认技能 / 固定资源随分组注入） */
  groupId?: string | null;
  /** launch 来源，默认 'dock' */
  reason?: LaunchReason;
}

export interface LaunchNewChatSessionResult {
  sessionId: string;
  /** workbench 未启用（legacy 降级路径）时为 null */
  windowId: string | null;
}

/** 聚焦 Chat 单例并切换到指定会话；冷启动/冻结恢复窗口由导航握手覆盖。 */
export function openChatSession(sessionId: string, reason: LaunchReason = 'api'): string | null {
  registerChatApp();
  const windowId = workbenchBus.launch({
    typeId: CHAT_APP_TYPE_ID,
    instanceKey: sessionId,
    reason,
  });
  // ChatV2Page 已就绪 → 立即派发 navigate-to-session；
  // 未就绪（窗口刚开、页面冷启动中）→ 挂起，初始加载完成后消费。
  requestChatSessionNavigation(sessionId);
  return windowId;
}

/**
 * 会话右键「在新窗口打开」：为指定会话开一个 chat-session multi 实例窗口。
 *
 * 与 openChatSession（切换 Chat 单例的当前会话）不同，本入口不动全局
 * currentSessionId —— 新窗口用 ChatSessionSurface 按 instanceKey 渲染目标会话，
 * 与主窗并存互不干扰；同一会话重复打开时聚焦已有窗口。
 *
 * workbench 未启用（legacy 模式）时返回 null 且不做任何事——
 * 入口（会话右键菜单项）应按 workbenchBus.isEnabled() 隐藏，这里仅防御。
 */
export function openChatSessionInNewWindow(
  sessionId: string,
  reason: LaunchReason = 'api',
): string | null {
  if (!workbenchBus.isEnabled()) return null;
  registerChatApp();
  return workbenchBus.launch({
    typeId: CHAT_SESSION_APP_TYPE_ID,
    instanceKey: sessionId,
    reason,
  });
}

export async function launchNewChatSession(
  options: LaunchNewChatSessionOptions = {},
): Promise<LaunchNewChatSessionResult> {
  registerChatApp();

  const session = await createSessionWithDefaults({
    mode: 'chat',
    title: null,
    groupId: options.groupId ?? null,
  });

  // 会话列表（legacy 侧栏 / files 型浏览器）刷新信号，与现有链路一致
  window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));

  const windowId = openChatSession(session.id, options.reason ?? 'dock');

  return { sessionId: session.id, windowId };
}
