/**
 * A45-5（docs/dev/acr/ACR-4.5.md）— Chat 消息列表程序化滚动注册表
 *
 * 背景：workbench chat 的 scrollToMessage 旧实现靠 querySelector 找
 * role="log" 的子节点，虚拟化长会话（>80 条）时目标行未渲染、DOM 里根本
 * 不存在，定位必然失败（chat/register.ts 已知遗留）。
 *
 * 方案：MessageList 挂载期把「按 messageId 程序化滚动」的 handle 注册到
 * 这里（key = sessionId），内部按渲染模式分派——虚拟化模式走
 * @tanstack/react-virtual 的 scrollToIndex，直渲模式先补齐尾部窗口再按
 * DOM 定位；滚动后等目标行真实挂载才报成功。消费方（workbench
 * chat/register.ts）只依赖本注册表，不感知列表内部实现。
 *
 * 本模块保持零 React 依赖（纯 Map 注册表），workbench 侧可安全动态 import。
 */

/** 定位结果状态 */
export type ChatMessageScrollStatus =
  /** 已滚动且目标行已挂载 */
  | 'scrolled'
  /** messageId 不在该会话的 messageOrder 中 */
  | 'message_not_found'
  /** 视口/虚拟化未就绪，或等待挂载超时 */
  | 'view_not_ready';

export interface ChatMessageScrollResult {
  status: ChatMessageScrollStatus;
  /** status === 'scrolled' 时的目标消息行元素（供 flash/选中演出使用） */
  element?: HTMLElement | null;
}

export interface ChatMessageListScrollHandle {
  /** 滚动到指定消息并等待目标行挂载；对不可达情况诚实返回失败状态 */
  scrollToMessage: (messageId: string) => Promise<ChatMessageScrollResult>;
}

const handles = new Map<string, ChatMessageListScrollHandle>();

/**
 * 注册会话的滚动 handle；返回注销函数。
 * 仅当注册表仍指向本次注册时移除，防止晚到的卸载清理误删新挂载的 handle
 * （与 contentAgentSurfaces 同一防御模式）。
 */
export function registerChatMessageListScrollHandle(
  sessionId: string,
  handle: ChatMessageListScrollHandle,
): () => void {
  handles.set(sessionId, handle);
  return () => {
    if (handles.get(sessionId) === handle) {
      handles.delete(sessionId);
    }
  };
}

export function getChatMessageListScrollHandle(
  sessionId: string,
): ChatMessageListScrollHandle | null {
  return handles.get(sessionId) ?? null;
}
