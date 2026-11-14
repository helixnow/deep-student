import { useCallback, useEffect, useRef, useState } from 'react';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import type { NormalizedRect, PdfSemanticAnchor } from '@/ui-kernel/contracts/interop';
import { ANCHOR_PULSE_DURATION_MS, clampRevealPage, rotateNormalizedRect, waitForPdfPageElement, waitForPdfTask } from './pdfInteropBridge';

interface PdfRevealOptions {
  documentKey: unknown;
  resourceIds: readonly string[];
  containerRef: React.RefObject<HTMLElement | null>;
  viewportRef: React.RefObject<HTMLElement | null>;
  numPages: number;
  onNavigate: (page: number) => void;
}

/** 每个挂载的阅读器独立注册；回调只读取当前文档与最新导航参数。 */
export function usePdfAnchorReveal(options: PdfRevealOptions) {
  const latest = useRef(options);
  latest.current = options;
  const [overlay, setOverlay] = useState<{ page: number; rect: NormalizedRect; key: number } | null>(null);
  const pending = useRef<{ anchor: PdfSemanticAnchor; pulse: boolean } | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const rafRef = useRef<number | null>(null);
  const seq = useRef(0);
  const idsKey = JSON.stringify(options.resourceIds);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);
  const matches = useCallback((anchor: PdfSemanticAnchor) => {
    const { resourceIds } = latest.current;
    return resourceIds.includes(anchor.resourceId)
      || Boolean(anchor.aliasResourceId && resourceIds.includes(anchor.aliasResourceId));
  }, []);
  const apply = useCallback((anchor: PdfSemanticAnchor, pulse: boolean): boolean => {
      if (!matches(anchor)) return false;
      cancel();
      const key = ++seq.current;
      setOverlay(null);
      if (latest.current.numPages <= 0) {
        pending.current = { anchor, pulse };
        return true;
      }
      pending.current = null;
      const page = clampRevealPage(anchor.page, latest.current.numPages);
      latest.current.onNavigate(page);
      if (!pulse) return true;
      const controller = new AbortController();
      controllerRef.current = controller;
      const { signal } = controller;
      const documentKey = latest.current.documentKey;
      const isCurrent = () => !signal.aborted && latest.current.documentKey === documentKey && matches(anchor) && key === seq.current;
      void waitForPdfPageElement(latest.current.viewportRef.current, page, { isCurrent, signal }).then((pageEl) => {
        if (!pageEl || !isCurrent()) return;
        const rect = anchor.rect && rotateNormalizedRect(anchor.rect, 0);
        if (rect) {
          setOverlay({ page, rect, key });
          void waitForPdfTask(ANCHOR_PULSE_DURATION_MS, signal).then(() => {
            if (isCurrent()) setOverlay(null);
          });
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            if (isCurrent()) pageEl.querySelector('.ds-pdf__anchor-pulse')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
          });
        } else if (anchor.quote) {
          void import('../quoteFlash').then(({ flashQuoteOnPage }) => {
            const root = latest.current.viewportRef.current;
            if (isCurrent() && root) void flashQuoteOnPage(root, page, anchor.quote!, 3000, signal);
          });
        }
      });
      return true;
  }, [cancel, matches]);

  useEffect(() => {
    pending.current = null;
    setOverlay(null);
    return cancel;
  }, [options.documentKey, cancel]);

  useEffect(() => {
    const documentKey = options.documentKey;
    let disposed = false;
    const canHandle = (anchor: PdfSemanticAnchor) => !disposed && latest.current.documentKey === documentKey && matches(anchor);
    const unregister = getAppKernel().anchors.registerAnchorRevealHandler('pdf', {
      canHandle: (anchor) => {
        if (!canHandle(anchor)) return false;
        return latest.current.containerRef.current?.contains(document.activeElement) ? 'exact-focused' : 'exact-mounted';
      },
      reveal: (anchor, ctx) => !ctx.signal?.aborted && canHandle(anchor) && apply(anchor, ctx.pulse),
    });
    return () => {
      disposed = true;
      unregister();
    };
    // Registration identity changes only with the document / its aliases.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.documentKey, idsKey, apply, matches]);

  useEffect(() => {
    const request = pending.current;
    if (options.numPages > 0 && request) apply(request.anchor, request.pulse);
  }, [options.numPages, idsKey, apply]);
  return overlay;
}
