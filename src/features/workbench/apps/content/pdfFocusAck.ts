import type { PdfFocusEventDetail } from '@/features/learning-hub/apps/views/usePdfFocusListener';
import type { ActivationResult } from '../../core/types';

/** Dispatch a PDF page request and wait until the mounted viewer applies it. */
export async function requestPdfPageFocus(
  resourceId: string,
  page: number,
): Promise<ActivationResult> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { handled: false, code: 'ACTION_UNAVAILABLE', hint: 'PDF 预览表面未挂载' };
  }
  const acknowledged = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (handled: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(handled);
    };
    const timeout = window.setTimeout(() => finish(false), 1500);
    const detail: PdfFocusEventDetail = {
      sourceId: resourceId,
      pageNumber: page,
      path: resourceId.startsWith('/') ? resourceId : `/${resourceId}`,
      acknowledge: finish,
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
