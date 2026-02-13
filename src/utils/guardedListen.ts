/**
 * 从 _legacy/chat-core/dev/guardedListen.ts 迁移
 * 用于 Tauri 事件监听的守护包装器
 */

type Unlisten = () => void | Promise<void>;

function isDev(): boolean {
  try { return Boolean((import.meta as any)?.env?.DEV); } catch { return false; }
}

function isLegacy(): boolean {
  try {
    const env = (import.meta as any)?.env as any;
    const v = (env && (env.DSTU_STREAM_RUNTIME || env.VITE_DSTU_STREAM_RUNTIME)) ?? (globalThis as any).DSTU_STREAM_RUNTIME;
    return String(v || '').trim().toLowerCase() === 'legacy';
  } catch { return false; }
}

// 判定：是否为"统一聊天事件名"（新通道）
function isUnifiedChatEventName(name: string): boolean {
  const n = String(name || '');
  return n.startsWith('chat_stream_') || n.startsWith('summary_stream_');
}

// 白名单：允许在 dev + new 下直接放行的非聊天事件
function isWhitelistedNonChat(name: string): boolean {
  const n = String(name || '');
  return (
    n.startsWith('tauri://') ||
    n.startsWith('tauri://file-') ||
    n.startsWith('file-drop') ||
    n.startsWith('window_') ||
    n.startsWith('anki_') ||
    n.startsWith('irec_') ||
    n.startsWith('mistake_') ||
    n.startsWith('unified_chat_save_') ||
    n === 'stream_error'
  );
}

export async function guardedListen<T = any>(
  event: string,
  handler: (event: { event: string; id: number; payload: T }) => void
): Promise<Unlisten> {
  const dev = isDev();
  const legacy = isLegacy();
  const isUnifiedChat = isUnifiedChatEventName(event);
  const isWhite = isWhitelistedNonChat(event);

  if (dev && !legacy) {
    if (!isUnifiedChat && !isWhite) {
      console.error('[DSTU][guardedListen] Blocked non-unified channel event:', event);
      throw new Error(`[DEV ASSERT] Non-unified channel event blocked: ${event}`);
    }
  }

  const mod: any = await import('@tauri-apps/api/event');
  return mod.listen(event, handler);
}

export default { guardedListen };
