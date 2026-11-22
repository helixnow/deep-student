import type { CurrentView } from '@/types/navigation';

/**
 * 跨学习页经 PREFILL_CHAT_INPUT 跳入 chat-v2 时记录的来源视图，
 * 供聊天页展示「返回刚才的学习」一键返回胶囊。
 */
let chatHandoffReturnView: CurrentView | null = null;
const chatHandoffReturnListeners = new Set<() => void>();

function notifyChatHandoffReturnListeners(): void {
  chatHandoffReturnListeners.forEach((listener) => listener());
}

export function setChatHandoffReturnView(view: CurrentView | null): void {
  const next = view && view !== 'chat-v2' ? view : null;
  if (chatHandoffReturnView === next) return;
  chatHandoffReturnView = next;
  notifyChatHandoffReturnListeners();
}

export function clearChatHandoffReturnView(): void {
  setChatHandoffReturnView(null);
}

export function getChatHandoffReturnView(): CurrentView | null {
  return chatHandoffReturnView;
}

export function subscribeChatHandoffReturnView(listener: () => void): () => void {
  chatHandoffReturnListeners.add(listener);
  return () => {
    chatHandoffReturnListeners.delete(listener);
  };
}
