/**
 * PDF 框选工具层：在页面上拖出一个框，裁出那块画面（公式、图表、三线表、扫描页都行），支持 4 种模式：
 * 1. `ask`（默认）：作为图片附件交给当前会话输入框，框完即退出（与粘贴图片走同一条上传流程）；
 * 2. `pin`：将框选出的架构图/公式/表格钉在阅读器角落悬浮对照（Sioyek Portal 风格）；
 * 3. `latex`：自动 OCR + 模型整理为标准 `$$ ... $$` LaTeX 公式代码，就地可编辑、一键复制或送入对话；
 * 4. `table`：自动 OCR + 模型整理为 GitHub-Flavored Markdown 表格，就地可编辑、一键复制或送入对话；
 * 5. `excerpt`：框出的画面（页码 + 归一化坐标锚点）以拖拽胶囊交给导图 / 笔记，或转交遮挡制卡；
 * 6. `occlusion`：框完直接打开图片遮挡制卡（`ds:open-image-occlusion-builder` 事件，不直接依赖闪卡模块）。
 *
 * 「划选即入图」开启时，任何模式下框选成功都会把区域摘录送入自动摘录总线（400ms 去重）。
 *
 * 覆盖层盖在页面视口上方、不随内容滚动；滚轮转发给视口，框选模式下照样能翻页。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DotsSixVertical } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { BACK_PRIORITY, registerVisibilityGuardedBackHandler } from '@/app/navigation/androidBackCoordinator';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { cn } from '@/utils/cn';
import { isKeyEventFromOtherModal } from '@/utils/modalKeyGuard';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import { dispatchTypedEvent } from '@/events/registry';
import type { NormalizedRect } from '@/ui-kernel/contracts/interop';
import type { RegionCaptureMode } from '../pdfRegionExtract';
import { captureBaseName, capturePdfRegion, rectFromPoints, type ScreenRect } from '../regionCapture';
import { sendSelectionToChatInput } from '../selectionStudyActions';
import {
  buildExcerptDragLabel,
  buildPdfExcerptPayload,
  buildPdfSemanticAnchor,
  composeDualTrackExcerptText,
  computeNormalizedSelectionBounds,
  decodeCapturedRegion,
  pdfAutoExcerptKey,
  rotateNormalizedRect,
  setCompactDragImage,
  sharedPdfExcerptGuard,
  startDualTrackPdfExcerptDrag,
} from '../interop/pdfInteropBridge';
import {
  extractLatexFromRecognizedText,
  extractNativeRegionTextFromViewport,
  recognizeRegionWithVisionFallback,
  type PdfRegionVisionRecognizer,
} from '../interop/pdfDualTrackRegionExtractor';

export const OPEN_IMAGE_OCCLUSION_BUILDER_EVENT = 'ds:open-image-occlusion-builder';

export interface PinRegionPayload {
  blob: Blob;
  page: number;
  title: string;
}

export interface PdfRegionCaptureProps {
  /** 阅读器根元素（.ds-pdf-viewer，position: relative），覆盖层的定位容器 */
  containerRef: React.RefObject<HTMLElement | null>;
  /** 页面滚动视口：覆盖层与它对齐，截图在它里面找页面 */
  viewportRef: React.RefObject<HTMLElement | null>;
  /** 人类可读的文件名（截图命名与来源说明） */
  documentTitle?: string;
  /** 触屏：提示文案改成「用手指拖」 */
  isTouch: boolean;
  /** 初始模式（默认 `'ask'`） */
  initialMode?: RegionCaptureMode;
  /** 钉在角落悬浮对照回调（传入时启用 `pin` 模式） */
  onPinRegion?: (payload: PinRegionPayload) => void;
  onExit: () => void;
  /** 跨插件摘录锚点资源 id；提供时启用 `excerpt` 模式并允许「划选即入图」 */
  interopResourceId?: string;
  /** 锚点别名资源 id（VFS resourceId） */
  interopAliasResourceId?: string;
  /** 「划选即入图」：框选成功即送入自动摘录总线 */
  autoExcerptActive?: boolean;
  /** 可选注入的异步视觉/OCR 识别器（扫描页自动回退与手动「识别文字/公式」共用） */
  visionRecognizer?: PdfRegionVisionRecognizer;
  /** 视觉识别超时毫秒数（超时后静默降级为仅原图，不阻断拖拽） */
  visionTimeoutMs?: number;
  /** 页码、缩放或旋转变化时取消旧屏幕坐标上的框选与异步结果。 */
  viewStateKey?: string;
}

type CaptureMode = RegionCaptureMode | 'excerpt' | 'occlusion';

interface RegionExcerptState {
  page: number;
  blob: Blob;
  dataUrl: string;
  rect?: NormalizedRect;
  extractedText: string;
  latex?: string;
  track: 'native-text' | 'vision-ocr' | 'image-only';
  recognizing: boolean;
}

type Point = { x: number; y: number };

interface ExtractionCardState {
  mode: 'latex' | 'table';
  page: number;
  blob: Blob;
  text: string;
  failed: boolean;
}

export const PdfRegionCapture: React.FC<PdfRegionCaptureProps> = ({
  containerRef,
  viewportRef,
  documentTitle,
  isTouch,
  initialMode = 'ask',
  onPinRegion,
  onExit,
  interopResourceId,
  interopAliasResourceId,
  autoExcerptActive = false,
  visionRecognizer,
  visionTimeoutMs,
  viewStateKey,
}) => {
  const { t } = useTranslation(['pdf', 'common']);
  const layerRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<ScreenRect | null>(null);
  const dragRef = useRef<{ pointerId: number; start: Point } | null>(null);
  const [dragBox, setDragBox] = useState<ScreenRect | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<CaptureMode>(initialMode);
  const [extractionCard, setExtractionCard] = useState<ExtractionCardState | null>(null);
  const [excerptCard, setExcerptCard] = useState<RegionExcerptState | null>(null);
  const captureSeqRef = useRef(0);
  const hasCard = Boolean(extractionCard || excerptCard);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const operationRef = useRef(0);
  const mountedRef = useRef(true);
  const visionAbortRef = useRef<AbortController | null>(null);
  const releasePointer = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag) {
      try { layerRef.current?.releasePointerCapture(drag.pointerId); } catch { /* 指针可能已被浏览器释放。 */ }
    }
  }, []);
  const cancelCapture = useCallback(() => {
    releasePointer();
    operationRef.current += 1;
    captureSeqRef.current += 1;
    visionAbortRef.current?.abort();
    setDragBox(null);
    setBusy(false);
    setExtractionCard(null);
    setExcerptCard(null);
  }, [releasePointer]);
  const exitCapture = useCallback(() => {
    cancelCapture();
    onExitRef.current();
  }, [cancelCapture]);
  useEffect(() => {
    mountedRef.current = true;
    cancelCapture();
    return () => {
      mountedRef.current = false;
      releasePointer();
      visionAbortRef.current?.abort();
      operationRef.current += 1;
      captureSeqRef.current += 1;
    };
  }, [interopResourceId, viewStateKey, cancelCapture, releasePointer]);

  // 覆盖层跟着页面视口的位置与尺寸（侧栏开合、窗口缩放都会变）
  useLayoutEffect(() => {
    const container = containerRef.current;
    const viewport = viewportRef.current;
    if (!container || !viewport) return;
    const measure = () => {
      const outer = container.getBoundingClientRect();
      const inner = viewport.getBoundingClientRect();
      setFrame({ left: inner.left - outer.left, top: inner.top - outer.top, width: inner.width, height: inner.height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [containerRef, viewportRef]);

  // 捕获阶段接 Esc：框选模式下 Esc 只用来退出框选，不再落到阅读器 / 外层的 Esc 处理
  useEventRegistry([{
    target: 'window',
    type: 'keydown',
    listener: (event) => {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.key !== 'Escape' || isKeyEventFromOtherModal(keyEvent, layerRef.current)) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      exitCapture();
    },
    options: true,
  }], [exitCapture]);

  useEffect(() => registerVisibilityGuardedBackHandler(containerRef, () => {
    exitCapture();
    return true;
  }, BACK_PRIORITY.overlay), [containerRef, exitCapture]);

  const toLayerBox = useCallback((selection: ScreenRect): ScreenRect | null => {
    const layer = layerRef.current?.getBoundingClientRect();
    if (!layer) return null;
    return { ...selection, left: selection.left - layer.left, top: selection.top - layer.top };
  }, []);

  const sendCapturedBlobToChat = useCallback(
    async (blob: Blob, page: number, prefillPrompt?: string): Promise<boolean> => {
      const name = captureBaseName(documentTitle, t('pdf:capture.untitled'));
      const file = new File(
        [blob],
        `${t('pdf:capture.file_name', { name, page })}.png`,
        { type: 'image/png' },
      );
      // 动态 import：聊天会话链路不静态打进 PDF 侧 chunk（同划词「引用到聊天」）
      const { sendImageToChat } = await import('@/features/chat/context/imageToChat');
      const sent = await sendImageToChat(file, t('pdf:capture.source', { name, page }));
      if (sent && prefillPrompt) {
        sendSelectionToChatInput({
          text: prefillPrompt,
          sourceName: documentTitle || name,
          page,
        });
      }
      return sent;
    },
    [documentTitle, t],
  );

  /** 选框相对目标页包裹层的归一化坐标（coordVersion 2）；越出页面的部分夹到页内 */
  const normalizeSelectionOnPage = useCallback((selection: ScreenRect, page: number): NormalizedRect | undefined => {
    const pageEl = viewportRef.current?.querySelector<HTMLElement>(`[data-page-number="${page}"]`);
    if (!pageEl) return undefined;
    const rect = computeNormalizedSelectionBounds([selection], pageEl.getBoundingClientRect());
    return rect && rotateNormalizedRect(rect, -Number(pageEl.getAttribute('data-page-rotation') ?? 0));
  }, [viewportRef]);

  const buildRegionAnchor = useCallback((page: number, rect?: NormalizedRect, quote?: string) => (
    interopResourceId
      ? buildPdfSemanticAnchor({
        resourceId: interopResourceId,
        aliasResourceId: interopAliasResourceId,
        page,
        rect,
        quote,
        documentTitle,
      })
      : null
  ), [documentTitle, interopAliasResourceId, interopResourceId]);

  const openOcclusionBuilder = useCallback(async (
    blob: Blob,
    page: number,
    rect?: NormalizedRect,
  ) => {
    const operation = operationRef.current;
    const decoded = await decodeCapturedRegion(blob, Number.POSITIVE_INFINITY);
    if (!mountedRef.current || operation !== operationRef.current) return;
    const anchor = buildRegionAnchor(page, rect);
    dispatchTypedEvent(OPEN_IMAGE_OCCLUSION_BUILDER_EVENT, {
      imageBlob: blob,
      // 尺寸属于原始 blob，不可搭配拖拽预览的 1200px 缩略图。
      imageDataUrl: decoded.dataUrl,
      naturalWidth: decoded.width,
      naturalHeight: decoded.height,
      sourceAnchor: anchor ?? undefined,
      sourceTitle: documentTitle,
    });
    onExitRef.current();
  }, [buildRegionAnchor, documentTitle]);

  const finish = useCallback(async (selection: ScreenRect) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const operation = ++operationRef.current;
    visionAbortRef.current?.abort();
    const visionController = new AbortController();
    visionAbortRef.current = visionController;
    const isCurrent = () => mountedRef.current && operation === operationRef.current;
    setBusy(true);
    try {
      const outcome = await capturePdfRegion(viewport, selection);
      if (!isCurrent()) return;
      // 误触 / 没框到页面：留在框选模式里再框一次
      if (outcome.kind === 'too-small') return;
      if (outcome.kind === 'not-rendered') {
        showGlobalNotification('info', t('pdf:capture.not_rendered'));
        return;
      }
      if (outcome.kind === 'failed') {
        showGlobalNotification('error', t('pdf:capture.failed'));
        return;
      }

      const normRect = normalizeSelectionOnPage(selection, outcome.page);
      // 预先解码：拖拽胶囊的 dragstart 是同步的，必须在框选完成时就备好图片
      const needsDualTrack = mode === 'excerpt' || (autoExcerptActive && Boolean(interopResourceId));
      const track1 = needsDualTrack
        ? extractNativeRegionTextFromViewport(viewport, outcome.page, selection)
        : null;
      const preview = needsDualTrack ? await decodeCapturedRegion(outcome.blob, 1200) : null;
      if (!isCurrent()) return;
      const seq = ++captureSeqRef.current;

      const scannedVisionPromise =
        needsDualTrack && preview && track1 && track1.spanCount === 0
          ? recognizeRegionWithVisionFallback({
              blob: outcome.blob,
              imageDataUrl: preview.dataUrl,
              page: outcome.page,
              rectNorm: normRect,
              nativeText: '',
              recognizer: visionRecognizer,
              timeoutMs: visionTimeoutMs,
              signal: visionController.signal,
            })
          : null;

      if (preview && track1 && autoExcerptActive && interopResourceId) {
        if (track1.spanCount > 0) {
          const composed = composeDualTrackExcerptText(track1.extractedText, track1.latex);
          const anchor = buildRegionAnchor(outcome.page, normRect, composed || undefined);
          const key = pdfAutoExcerptKey(interopResourceId, outcome.page, composed, normRect);
          if (anchor && sharedPdfExcerptGuard.shouldEmitAuto(key)) {
            getAppKernel().dnd.emitAutoExcerpt(buildPdfExcerptPayload({
              excerptKind: 'region-image',
              text: composed || (documentTitle ?? ''),
              latex: track1.latex,
              imageDataUrl: preview.dataUrl,
              anchor,
              documentTitle,
            }));
          }
        } else if (scannedVisionPromise) {
          const resourceIdSnapshot = interopResourceId;
          const previewUrlSnapshot = preview.dataUrl;
          const pageSnapshot = outcome.page;
          void scannedVisionPromise.then((vision) => {
            if (!isCurrent()) return;
            const composed = composeDualTrackExcerptText(vision.text, vision.latex);
            const anchor = buildRegionAnchor(pageSnapshot, normRect, composed || undefined);
            const key = pdfAutoExcerptKey(resourceIdSnapshot, pageSnapshot, composed, normRect);
            if (anchor && sharedPdfExcerptGuard.shouldEmitAuto(key)) {
              getAppKernel().dnd.emitAutoExcerpt(buildPdfExcerptPayload({
                excerptKind: 'region-image',
                text: composed || (documentTitle ?? ''),
                latex: vision.latex,
                imageDataUrl: previewUrlSnapshot,
                anchor,
                documentTitle,
              }));
            }
          });
        }
      }

      if (mode === 'occlusion') {
        await openOcclusionBuilder(outcome.blob, outcome.page, normRect);
        return;
      }

      if (mode === 'excerpt') {
        const hasNativeSpans = Boolean(track1 && track1.spanCount > 0);
        setExcerptCard({
          page: outcome.page,
          blob: outcome.blob,
          dataUrl: preview?.dataUrl ?? '',
          rect: normRect,
          extractedText: composeDualTrackExcerptText(track1?.extractedText, track1?.latex),
          latex: track1?.latex,
          track: hasNativeSpans ? 'native-text' : 'image-only',
          recognizing: Boolean(scannedVisionPromise),
        });

        if (scannedVisionPromise) {
          void scannedVisionPromise.then((vision) => {
            if (!mountedRef.current || captureSeqRef.current !== seq) return;
            setExcerptCard((prev) => {
              if (!prev) return null;
              if (vision.status !== 'ok') {
                return { ...prev, recognizing: false };
              }
              const nextComposed = composeDualTrackExcerptText(vision.text, vision.latex);
              return {
                ...prev,
                extractedText: prev.extractedText.trim() ? prev.extractedText : nextComposed,
                latex: prev.latex ?? vision.latex,
                track: 'vision-ocr',
                recognizing: false,
              };
            });
          });
        }
        return;
      }

      if (mode === 'pin' && onPinRegion) {
        const name = captureBaseName(documentTitle, t('pdf:capture.untitled'));
        onPinRegion({
          blob: outcome.blob,
          page: outcome.page,
          title: t('pdf:pinned.card_title', { name, page: outcome.page }),
        });
        showGlobalNotification('success', t('pdf:pinned.pinned_toast', { page: outcome.page }));
        onExitRef.current();
        return;
      }

      if (mode === 'latex' || mode === 'table') {
        try {
          const { extractStructuredFromRegion } = await import('../pdfRegionExtract');
          const extracted = await extractStructuredFromRegion(outcome.blob, mode);
          if (!isCurrent()) return;
          setExtractionCard({
            mode,
            page: outcome.page,
            blob: outcome.blob,
            text: extracted.content,
            failed: false,
          });
        } catch {
          if (!isCurrent()) return;
          setExtractionCard({
            mode,
            page: outcome.page,
            blob: outcome.blob,
            text: '',
            failed: true,
          });
        }
        return;
      }

      const sent = await sendCapturedBlobToChat(outcome.blob, outcome.page);
      if (sent) onExitRef.current();
    } catch {
      if (isCurrent()) showGlobalNotification('error', t('pdf:capture.failed'));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }, [
    autoExcerptActive,
    buildRegionAnchor,
    documentTitle,
    interopResourceId,
    mode,
    normalizeSelectionOnPage,
    onPinRegion,
    openOcclusionBuilder,
    sendCapturedBlobToChat,
    t,
    viewportRef,
    visionRecognizer,
    visionTimeoutMs,
  ]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (busy || hasCard || dragRef.current || event.button !== 0) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 不支持指针捕获时由 window 上的监听兜底收尾。
    }
    const start = { x: event.clientX, y: event.clientY };
    dragRef.current = { pointerId: event.pointerId, start };
    setDragBox(toLayerBox(rectFromPoints(start, start)));
  }, [busy, hasCard, toLayerBox]);

  const handlePointerMove = useCallback((event: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDragBox(toLayerBox(rectFromPoints(drag.start, { x: event.clientX, y: event.clientY })));
  }, [toLayerBox]);

  const handlePointerUp = useCallback((event: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    releasePointer();
    setDragBox(null);
    void finish(rectFromPoints(drag.start, { x: event.clientX, y: event.clientY }));
  }, [finish, releasePointer]);

  const handlePointerCancel = useCallback(() => {
    releasePointer();
    setDragBox(null);
  }, [releasePointer]);

  useEffect(() => {
    // 捕获不受支持或被浏览器提前释放时，仍可在容器外收尾。
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('blur', handlePointerCancel);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('blur', handlePointerCancel);
    };
  }, [handlePointerMove, handlePointerUp, handlePointerCancel]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    // Ctrl / ⌘ + 滚轮（含触控板捏合）留给阅读器缩放，不转发成滚动
    if (event.ctrlKey || event.metaKey) return;
    viewportRef.current?.scrollBy({ left: event.deltaX, top: event.deltaY });
  }, [viewportRef]);

  const handleCopyExtracted = useCallback(async () => {
    if (!extractionCard?.text.trim()) return;
    const ok = await copyTextToClipboard(extractionCard.text);
    if (ok) {
      showGlobalNotification('success', t('pdf:selection.copied'));
      onExitRef.current();
    } else {
      showGlobalNotification('error', t('pdf:selection.copy_failed'));
    }
  }, [extractionCard, t]);

  const handleFallbackAskInChat = useCallback(async () => {
    if (!extractionCard) return;
    const promptKey =
      extractionCard.mode === 'latex'
        ? 'pdf:capture.prompt_extract_latex'
        : 'pdf:capture.prompt_extract_table';
    const sent = await sendCapturedBlobToChat(
      extractionCard.blob,
      extractionCard.page,
      t(promptKey),
    );
    if (sent) onExitRef.current();
  }, [extractionCard, sendCapturedBlobToChat, t]);

  const endOwnedDragRef = useRef<(() => void) | null>(null);

  const handleRecognizeExcerptRegion = useCallback(async () => {
    if (!excerptCard || excerptCard.recognizing) return;
    const seq = ++captureSeqRef.current;
    visionAbortRef.current?.abort();
    const visionController = new AbortController();
    visionAbortRef.current = visionController;
    const snapshot = excerptCard;
    setExcerptCard((prev) => (prev ? { ...prev, recognizing: true } : null));

    const outcome = await recognizeRegionWithVisionFallback({
      blob: snapshot.blob,
      imageDataUrl: snapshot.dataUrl,
      page: snapshot.page,
      rectNorm: snapshot.rect,
      nativeText: snapshot.extractedText,
      preferFormula: true,
      recognizer: visionRecognizer,
      timeoutMs: visionTimeoutMs,
      signal: visionController.signal,
    });

    if (!mountedRef.current || captureSeqRef.current !== seq) return;
    setExcerptCard((prev) => {
      if (!prev) return null;
      if (outcome.status !== 'ok') {
        return { ...prev, recognizing: false };
      }
      if (prev.extractedText !== snapshot.extractedText || prev.latex !== snapshot.latex) {
        return { ...prev, recognizing: false };
      }
      return {
        ...prev,
        extractedText: composeDualTrackExcerptText(outcome.text, outcome.latex),
        latex: outcome.latex ?? prev.latex,
        track: 'vision-ocr',
        recognizing: false,
      };
    });
  }, [excerptCard, visionRecognizer, visionTimeoutMs]);
  const handleRegionDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>) => {
    if (!excerptCard) {
      event.preventDefault();
      return;
    }
    const composedText = composeDualTrackExcerptText(excerptCard.extractedText, excerptCard.latex);
    const effectiveText = composedText || (documentTitle ?? '');
    const anchor = buildRegionAnchor(excerptCard.page, excerptCard.rect, composedText || undefined);
    if (!anchor) {
      event.preventDefault();
      return;
    }
    endOwnedDragRef.current = sharedPdfExcerptGuard.beginDrag();
    const payload = startDualTrackPdfExcerptDrag(event.nativeEvent, buildPdfExcerptPayload({
      excerptKind: 'region-image',
      text: effectiveText,
      latex: excerptCard.latex,
      ...(excerptCard.dataUrl ? { imageDataUrl: excerptCard.dataUrl } : {}),
      anchor,
      documentTitle,
    }));
    if (!payload) {
      endOwnedDragRef.current?.();
      endOwnedDragRef.current = null;
      event.preventDefault();
      return;
    }
    setCompactDragImage(
      event.dataTransfer,
      buildExcerptDragLabel(`P.${excerptCard.page}`, composedText || (documentTitle ?? '')),
    );
  }, [buildRegionAnchor, documentTitle, excerptCard]);

  const handleRegionDragEnd = useCallback(() => {
    endOwnedDragRef.current?.();
    endOwnedDragRef.current = null;
  }, []);

  useEffect(() => handleRegionDragEnd, [handleRegionDragEnd, interopResourceId]);

  const hint = busy
    ? mode === 'latex' || mode === 'table'
      ? t('pdf:capture.extracting')
      : t('pdf:capture.working')
    : mode === 'pin'
      ? t('pdf:capture.hint_pin')
      : mode === 'latex'
        ? t('pdf:capture.hint_latex')
        : mode === 'table'
          ? t('pdf:capture.hint_table')
          : mode === 'excerpt'
            ? t('pdf:interop.drag_region')
            : mode === 'occlusion'
              ? t('pdf:interop.create_occlusion_card')
              : isTouch
            ? t('pdf:capture.hint_touch')
            : t('pdf:capture.hint');

  const availableModes: Array<{ id: CaptureMode; label: string }> = [
    { id: 'ask', label: t('pdf:capture.mode_ask') },
    ...(onPinRegion ? [{ id: 'pin' as const, label: t('pdf:capture.mode_pin') }] : []),
    { id: 'latex', label: t('pdf:capture.mode_latex') },
    { id: 'table', label: t('pdf:capture.mode_table') },
    ...(interopResourceId ? [{ id: 'excerpt' as const, label: t('pdf:interop.drag_region') }] : []),
    { id: 'occlusion', label: t('pdf:interop.create_occlusion_card') },
  ];

  return (
    <div
      ref={layerRef}
      className="ds-pdf__capture-layer"
      style={{
        ...(frame ? { left: frame.left, top: frame.top, width: frame.width, height: frame.height } : { inset: 0 }),
        userSelect: hasCard ? 'auto' : 'none',
        touchAction: hasCard ? 'auto' : 'none',
      }}
      data-testid="pdf-region-capture"
      data-busy={busy ? 'true' : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      onWheel={handleWheel}
    >
      <div
        className="ds-pdf__capture-hud ui-rise-in"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div
          className="ds-pdf__capture-modes"
          role="radiogroup"
          aria-label={t('pdf:toolbar.capture_ask')}
        >
          {availableModes.map((item) => (
            <DsButton
              key={item.id}
              variant="ghost"
              size="sm"
              role="radio"
              aria-checked={mode === item.id}
              disabled={busy}
              className={cn(
                'ds-pdf__capture-mode-btn',
                mode === item.id && 'ds-pdf__capture-mode-btn--active',
              )}
              onClick={() => {
                cancelCapture();
                setMode(item.id);
              }}
            >
              {item.label}
            </DsButton>
          ))}
        </div>

        <div className="ds-pdf__capture-hint" role="status">
          <span>{hint}</span>
          <DsButton variant="ghost" size="sm" onClick={exitCapture}>
            {t('common:cancel')}
          </DsButton>
        </div>
      </div>

      {dragBox ? (
        <div
          className="ds-pdf__capture-rect"
          style={{ left: dragBox.left, top: dragBox.top, width: dragBox.width, height: dragBox.height }}
          aria-hidden="true"
        />
      ) : null}

      {extractionCard ? (
        <div
          className="ds-pdf__capture-result ui-rise-in"
          role="dialog"
          aria-label={
            extractionCard.mode === 'latex'
              ? t('pdf:capture.result_latex_title')
              : t('pdf:capture.result_table_title')
          }
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="ds-pdf__capture-result-header">
            <span className="ds-pdf__capture-result-title">
              {extractionCard.mode === 'latex'
                ? t('pdf:capture.result_latex_title')
                : t('pdf:capture.result_table_title')}
            </span>
            <span className="ds-pdf__capture-result-meta font-mono tabular-nums">
              P.{extractionCard.page}
            </span>
          </div>

          {extractionCard.failed ? (
            <p className="ds-pdf__capture-result-empty">
              {t('pdf:capture.extract_fallback_hint')}
            </p>
          ) : (
            <textarea
              className="ds-pdf__capture-result-textarea font-mono tabular-nums"
              rows={extractionCard.mode === 'table' ? 7 : 5}
              value={extractionCard.text}
              onChange={(e) =>
                setExtractionCard((prev) =>
                  prev ? { ...prev, text: e.target.value } : null,
                )
              }
            />
          )}

          <div className="ds-pdf__capture-result-actions">
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => setExtractionCard(null)}
            >
              {t('pdf:capture.reselect')}
            </DsButton>
            {onPinRegion && (
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => {
                  const name = captureBaseName(documentTitle, t('pdf:capture.untitled'));
                  onPinRegion({
                    blob: extractionCard.blob,
                    page: extractionCard.page,
                    title: t('pdf:pinned.card_title', { name, page: extractionCard.page }),
                  });
                  showGlobalNotification(
                    'success',
                    t('pdf:pinned.pinned_toast', { page: extractionCard.page }),
                  );
                  onExitRef.current();
                }}
              >
                {t('pdf:capture.mode_pin')}
              </DsButton>
            )}
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => void handleFallbackAskInChat()}
            >
              {t('pdf:capture.ask_in_chat')}
            </DsButton>
            {!extractionCard.failed && (
              <DsButton
                variant="ghost"
                size="sm"
                className="border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)] text-[color:var(--button-primary-foreground)] hover:bg-[color:var(--button-primary-hover)] active:bg-[color:var(--button-primary-active)]"
                onClick={() => void handleCopyExtracted()}
              >
                {t('pdf:capture.copy_result')}
              </DsButton>
            )}
          </div>
        </div>
      ) : null}

      {excerptCard ? (
        <div
          className="ds-pdf__capture-result ui-rise-in"
          role="dialog"
          aria-label={t('pdf:interop.drag_region')}
          data-testid="pdf-region-excerpt-card"
          data-track={excerptCard.track}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="ds-pdf__capture-result-header">
            <div className="flex min-w-0 items-center gap-2">
              <span className="ds-pdf__capture-result-title">{t('pdf:interop.drag_region')}</span>
              <span
                className="inline-flex items-center gap-1 rounded-full border border-border/35 px-2 py-0.5 text-[11px] text-muted-foreground"
                data-testid="pdf-region-track-badge"
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    excerptCard.recognizing
                      ? 'bg-warning'
                      : excerptCard.track === 'image-only'
                        ? 'bg-muted-foreground'
                        : 'bg-primary',
                  )}
                  aria-hidden="true"
                />
                <span>
                  {excerptCard.recognizing
                    ? t('pdf:interop.recognizing_region')
                    : excerptCard.track === 'vision-ocr'
                      ? t('pdf:interop.track_vision_badge')
                      : excerptCard.track === 'native-text'
                        ? t('pdf:interop.track_native_badge')
                        : t('pdf:interop.track_image_only_badge')}
                </span>
              </span>
            </div>
            <span className="ds-pdf__capture-result-meta font-mono tabular-nums">P.{excerptCard.page}</span>
          </div>
          {excerptCard.dataUrl ? (
            <img
              src={excerptCard.dataUrl}
              alt=""
              draggable={false}
              className="max-h-40 w-full rounded-md border border-border/35 object-contain"
            />
          ) : null}
          <textarea
            className={cn(
              'ds-pdf__capture-result-textarea',
              excerptCard.latex && 'font-mono tabular-nums',
            )}
            rows={3}
            data-testid="pdf-region-excerpt-text"
            placeholder={t('pdf:interop.extracted_text_placeholder')}
            value={excerptCard.extractedText}
            onChange={(event) => {
              const nextValue = event.target.value;
              setExcerptCard((prev) =>
                prev
                  ? {
                      ...prev,
                      extractedText: nextValue,
                      latex: extractLatexFromRecognizedText(nextValue),
                    }
                  : null,
              );
            }}
          />
          <div className="ds-pdf__capture-result-actions">
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => {
                cancelCapture();
              }}
            >
              {t('pdf:capture.reselect')}
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              disabled={excerptCard.recognizing}
              data-testid="pdf-region-recognize-btn"
              onClick={() => void handleRecognizeExcerptRegion()}
            >
              {t('pdf:interop.recognize_region')}
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              data-testid="pdf-region-occlusion-btn"
              onClick={() =>
                void openOcclusionBuilder(
                  excerptCard.blob,
                  excerptCard.page,
                  excerptCard.rect,
                )
              }
            >
              {t('pdf:interop.create_occlusion_card')}
            </DsButton>
            <button
              type="button"
              draggable
              onDragStart={handleRegionDragStart}
              onDragEnd={handleRegionDragEnd}
              data-testid="pdf-region-drag-chip"
              title={t('pdf:interop.drag_region')}
              aria-label={t('pdf:interop.drag_region')}
              className={cn(
                'inline-flex h-7 select-none items-center gap-1 rounded-full border border-border/35 bg-card/95 px-2.5',
                'cursor-grab text-xs text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing',
              )}
            >
              <DotsSixVertical size={14} aria-hidden="true" />
              <span>{t('pdf:interop.drag_region')}</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default PdfRegionCapture;
