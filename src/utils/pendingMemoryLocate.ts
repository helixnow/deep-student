/**
 * 用户记忆定位的"延迟导航"缓冲区。
 *
 * 背景：
 * - 从聊天来源面板或知识库导航到 MemoryView 时，MemoryView 可能尚未挂载。
 * - 需要一个短生命周期缓冲区在导航发起方和 MemoryView 之间传递 memoryId。
 *
 * 方案（与 pendingSettingsTab.ts 一致）：
 * - 写入一个短生命周期的 window 变量作为缓冲
 * - MemoryView 挂载时消费该值并打开对应记忆
 * - 写入时同时派发事件，使"已挂载"的 MemoryView 也能即时响应新的定位请求
 *
 * 消费约定：
 * - 消费方应先 peek（不删除），确认自身已就绪（如 config 已加载）后再 consume。
 *   直接 consume 会在未就绪时把定位 ID 丢弃，导致定位永久失效。
 */
declare global {
  interface Window {
    __dsPendingMemoryLocate?: string;
  }
}

/** MemoryView 已挂载时监听此事件即可响应新的定位请求 */
export const PENDING_MEMORY_LOCATE_EVENT = 'ds:pending-memory-locate';

export function setPendingMemoryLocate(memoryId: string): void {
  if (typeof memoryId !== 'string') return;
  const trimmed = memoryId.trim();
  if (!trimmed) return;
  window.__dsPendingMemoryLocate = trimmed;
  window.dispatchEvent(new CustomEvent(PENDING_MEMORY_LOCATE_EVENT, { detail: { memoryId: trimmed } }));
}

/** 只读查看当前待定位 ID，不删除缓冲区（供消费方在就绪前探测） */
export function peekPendingMemoryLocate(): string | null {
  const id = window.__dsPendingMemoryLocate;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

export function consumePendingMemoryLocate(): string | null {
  const id = window.__dsPendingMemoryLocate;
  delete window.__dsPendingMemoryLocate;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}
