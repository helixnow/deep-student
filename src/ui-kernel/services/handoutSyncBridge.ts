/**
 * 精读讲义 -> 思维导图反向同步请求桥（C7 §2.3）。
 *
 * `notes` 与 `mindmap` 互不 import：笔记侧只发起平台事件，导图侧挂载监听并回传结果。
 * 事件通过 `@/events/registry` 派发，移动端 WebView 与桌面窗口行为一致。
 */
import { addTypedEventListener, dispatchTypedEvent } from '@/events/registry';

export const HANDOUT_SYNC_TO_MINDMAP_EVENT = 'ds:handout-sync-to-mindmap';

/** 等待导图侧应答的上限；超时按「原导图未打开」处理。 */
export const HANDOUT_SYNC_RESPONSE_TIMEOUT_MS = 4000;

export type HandoutSyncFailureReason = 'mindmap-not-open' | 'empty-handout' | 'timeout';

export interface HandoutSyncSummary {
  ok: boolean;
  /** 文本 / 备注发生变化、按出处节点原地同步的节点数 */
  updated: number;
  /** 讲义里新增、导图里尚不存在的节点数 */
  added: number;
  reason?: HandoutSyncFailureReason;
}

export interface HandoutSyncRequest {
  noteId: string;
  noteTitle?: string;
  /** 讲义出处胶囊指向的导图 resourceId */
  mindmapId: string;
  markdown: string;
}

export interface HandoutSyncRequestDetail extends HandoutSyncRequest {
  respond: (summary: HandoutSyncSummary) => void;
}

/** 导图侧挂载：返回撤销函数。 */
export function addHandoutSyncRequestListener(
  handler: (detail: HandoutSyncRequestDetail) => void,
): () => void {
  return addTypedEventListener<HandoutSyncRequestDetail>(HANDOUT_SYNC_TO_MINDMAP_EVENT, handler);
}

/**
 * 笔记侧发起同步并等待导图应答。
 * 事件 detail 携带一次性 `respond` 回调；超时或重复应答只结算一次。
 */
export function requestHandoutSyncToMindmap(
  request: HandoutSyncRequest,
  timeoutMs = HANDOUT_SYNC_RESPONSE_TIMEOUT_MS,
): Promise<HandoutSyncSummary> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (summary: HandoutSyncSummary) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(summary);
    };
    const timer = setTimeout(
      () => finish({ ok: false, updated: 0, added: 0, reason: 'timeout' }),
      timeoutMs,
    );
    dispatchTypedEvent(HANDOUT_SYNC_TO_MINDMAP_EVENT, { ...request, respond: finish });
  });
}
