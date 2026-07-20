import type { PdfFocusEventDetail } from '@/features/learning-hub/apps/views/usePdfFocusListener';
import type { ActivationResult } from '../../core/types';

/** ACK 超时（ms）：超过即回执失败并把请求标记为 stale，禁止事后兑现 */
export const PDF_FOCUS_ACK_TIMEOUT_MS = 1500;

/**
 * Dispatch a PDF page request and wait until the mounted viewer applies it.
 *
 * ACR 4.0（A7）竞态修复：一旦以失败收场（超时 / 监听方卸载显式回失败），
 * 请求即被标记 stale——viewer 侧兑现 pendingFocus 前必须检查 `isStale()`，
 * 保证「回执说失败就真的不会再发生」，LLM 重试不会造成双跳。
 */
export async function requestPdfPageFocus(
  resourceId: string,
  page: number,
): Promise<ActivationResult> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { handled: false, code: 'ACTION_UNAVAILABLE', hint: 'PDF 预览表面未挂载' };
  }
  let stale = false;
  const acknowledged = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (handled: boolean) => {
      if (settled) return;
      settled = true;
      // 失败回执后请求作废；成功回执意味着已兑现，无需（也不会）再兑现
      if (!handled) stale = true;
      window.clearTimeout(timeout);
      resolve(handled);
    };
    const timeout = window.setTimeout(() => finish(false), PDF_FOCUS_ACK_TIMEOUT_MS);
    const detail: PdfFocusEventDetail = {
      sourceId: resourceId,
      pageNumber: page,
      path: resourceId.startsWith('/') ? resourceId : `/${resourceId}`,
      acknowledge: finish,
      isStale: () => stale,
    };
    document.dispatchEvent(new CustomEvent('pdf-ref:focus', { detail }));
  });
  return acknowledged
    ? { handled: true, acknowledged: true }
    : {
        handled: false,
        code: 'ACTION_UNAVAILABLE',
        hint: 'PDF Viewer 未确认页码跳转',
      };
}
