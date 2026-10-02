/**
 * 聊天侧「打开 PDF 并跳到某页」的跳页请求。
 *
 * - 右侧面板的 PDF 实例带专属 focusScopeId：学习资源页里保活隐藏的同一份 PDF
 *   也监听 pdf-ref:focus，不指定目标时它会先抢走请求（右侧面板停在第 1 页）。
 * - 带回执重发直到被处理：面板首次打开要先加载 chunk 与 PDF，常超过 800ms，
 *   固定 0/250/800ms 三连发会全部落在监听挂上之前。
 */

export const CHAT_PANEL_PDF_FOCUS_SCOPE = 'chat-attachment-panel';

const RETRY_DELAYS_MS = [0, 250, 800, 1600, 3000, 5000];

export interface ChatPdfFocusTarget {
  sourceId: string;
  pageNumber: number;
  quote?: string;
  /** 只让指定实例响应（右侧面板传 CHAT_PANEL_PDF_FOCUS_SCOPE；学习资源页标签不传） */
  targetScopeId?: string;
}

export function requestPdfFocusUntilHandled(target: ChatPdfFocusTarget): void {
  const { sourceId, pageNumber, quote, targetScopeId } = target;
  const path = sourceId.startsWith('/') ? sourceId : `/${sourceId}`;
  let handled = false;
  for (const delay of RETRY_DELAYS_MS) {
    window.setTimeout(() => {
      if (handled) return;
      document.dispatchEvent(
        new CustomEvent('pdf-ref:focus', {
          detail: {
            sourceId,
            pageNumber,
            quote,
            path,
            targetScopeId,
            acknowledge: (ok: boolean) => {
              if (ok) handled = true;
            },
          },
        }),
      );
    }, delay);
  }
}
