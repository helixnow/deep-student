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
 */
declare global {
  interface Window {
    __dsPendingMemoryLocate?: string;
  }
}

export function setPendingMemoryLocate(memoryId: string): void {
  if (typeof memoryId !== 'string') return;
  const trimmed = memoryId.trim();
  if (!trimmed) return;
  window.__dsPendingMemoryLocate = trimmed;
}

export function consumePendingMemoryLocate(): string | null {
  const id = window.__dsPendingMemoryLocate;
  delete window.__dsPendingMemoryLocate;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}
