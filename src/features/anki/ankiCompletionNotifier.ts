/**
 * ★ 4.2 制卡完成全局通知器
 *
 * 应用级监听 anki_generation_event 中的 DocumentProcessingCompleted，
 * 在应用处于后台时发系统通知（遵循统一通知策略），让用户离开应用
 * 也能知道批量制卡已完成。
 *
 * 不在前台重复打扰：前台时 TaskDashboard 轮询/聊天流本身就有可视反馈。
 */
import i18n from '@/i18n';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { sendSystemNotification } from '@/utils/systemNotification';

interface DocumentSessionLite {
  documentId: string;
  documentName: string;
  totalCards: number;
  failedTasks: number;
}

/** 同一 document 只通知一次 */
const notified = new Set<string>();

function extractCompletedDocumentId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, any>;
  // 外部标签格式 { DocumentProcessingCompleted: { document_id } }
  if (obj.DocumentProcessingCompleted) {
    return obj.DocumentProcessingCompleted.document_id ?? null;
  }
  // 兼容 { type, data } 格式
  if (obj.type === 'DocumentProcessingCompleted') {
    return obj.data?.document_id ?? null;
  }
  return null;
}

async function notifyCompletion(documentId: string): Promise<void> {
  if (notified.has(documentId)) return;
  notified.add(documentId);

  let name = '';
  let cardCount = 0;
  let failedTasks = 0;
  try {
    const sessions = await invoke<DocumentSessionLite[]>('list_document_sessions', { limit: 50 });
    const session = sessions.find((s) => s.documentId === documentId);
    if (session) {
      name = session.documentName ?? '';
      cardCount = session.totalCards ?? 0;
      failedTasks = session.failedTasks ?? 0;
    }
  } catch {
    // 查询失败仍发兜底通知
  }

  // 临时分段会话（generateAnkiCardsForSegment 的降级路径）不通知
  if (name.startsWith('segment_')) return;

  const title = failedTasks > 0
    ? i18n.t('anki:completionNotify.titleWithFailed', { failed: failedTasks })
    : i18n.t('anki:completionNotify.title');
  const body = name
    ? i18n.t('anki:completionNotify.body', { name, count: cardCount })
    : i18n.t('anki:completionNotify.bodyFallback');

  // 默认策略：仅应用后台时发系统通知
  await sendSystemNotification(title, body);
}

/**
 * 初始化全局制卡完成通知。返回清理函数。
 */
export function initAnkiCompletionNotifier(): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;

  listen('anki_generation_event', (event) => {
    const documentId = extractCompletedDocumentId(event.payload);
    if (documentId) {
      void notifyCompletion(documentId);
    }
  }).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  }).catch((e) => {
    console.warn('[AnkiNotifier] Failed to listen anki_generation_event:', e);
  });

  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}
