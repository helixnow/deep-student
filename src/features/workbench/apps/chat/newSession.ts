/**
 * 新会话入口（P7）— 供 Dock / P11 消费。
 *
 * 先经现有链路创建会话（createSessionWithDefaults：后端建会话 + store 预置 +
 * 默认技能激活 + 分组固定资源注入），再 launch 一个 chat 窗口（instanceKey=sessionId）。
 */
import { workbenchBus } from '../../core/workbenchBus';
import type { LaunchReason } from '../../core/types';
import { createSessionWithDefaults } from '@/features/chat/core/session/createSessionWithDefaults';
import { CHAT_APP_TYPE_ID, registerChatApp } from './register';

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

  const windowId = workbenchBus.launch({
    typeId: CHAT_APP_TYPE_ID,
    instanceKey: session.id,
    reason: options.reason ?? 'dock',
  });

  return { sessionId: session.id, windowId };
}
