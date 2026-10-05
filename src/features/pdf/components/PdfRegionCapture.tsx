/**
 * PDF 框选提问：在页面上拖出一个框，裁出那块画面（公式、图表、扫描页都行），
 * 作为图片附件交给当前会话的输入框，与粘贴图片走同一条上传流程。
 *
 * 一次性模式：框完一张就退出；Esc / Android 返回 / 「取消」退出。
 * 覆盖层盖在页面视口上方、不随内容滚动；滚轮转发给视口，框选模式下照样能翻页。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { BACK_PRIORITY, registerVisibilityGuardedBackHandler } from '@/app/navigation/androidBackCoordinator';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { isKeyEventFromOtherModal } from '@/utils/modalKeyGuard';
import { captureBaseName, capturePdfRegion, rectFromPoints, type ScreenRect } from '../regionCapture';

export interface PdfRegionCaptureProps {
  /** 阅读器根元素（.ds-pdf-viewer，position: relative），覆盖层的定位容器 */
  containerRef: React.RefObject<HTMLElement | null>;
  /** 页面滚动视口：覆盖层与它对齐，截图在它里面找页面 */
  viewportRef: React.RefObject<HTMLElement | null>;
  /** 人类可读的文件名（截图命名与来源说明） */
  documentTitle?: string;
  /** 触屏：提示文案改成「用手指拖」 */
  isTouch: boolean;
  onExit: () => void;
}

type Point = { x: number; y: number };

export const PdfRegionCapture: React.FC<PdfRegionCaptureProps> = ({
  containerRef,
  viewportRef,
  documentTitle,
  isTouch,
  onExit,
}) => {
  const { t } = useTranslation(['pdf', 'common']);
  const layerRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<ScreenRect | null>(null);
  const dragRef = useRef<{ pointerId: number; start: Point } | null>(null);
  const [dragBox, setDragBox] = useState<ScreenRect | null>(null);
  const [busy, setBusy] = useState(false);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

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
      onExitRef.current();
    },
    options: true,
  }], []);

  useEffect(() => registerVisibilityGuardedBackHandler(containerRef, () => {
    onExitRef.current();
    return true;
  }, BACK_PRIORITY.overlay), [containerRef]);

  const toLayerBox = useCallback((selection: ScreenRect): ScreenRect | null => {
    const layer = layerRef.current?.getBoundingClientRect();
    if (!layer) return null;
    return { ...selection, left: selection.left - layer.left, top: selection.top - layer.top };
  }, []);

  const finish = useCallback(async (selection: ScreenRect) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setBusy(true);
    try {
      const outcome = await capturePdfRegion(viewport, selection);
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
      const name = captureBaseName(documentTitle, t('pdf:capture.untitled'));
      const file = new File(
        [outcome.blob],
        `${t('pdf:capture.file_name', { name, page: outcome.page })}.png`,
        { type: 'image/png' },
      );
      // 动态 import：聊天会话链路不静态打进 PDF 侧 chunk（同划词「引用到聊天」）
      const { sendImageToChat } = await import('@/features/chat/context/imageToChat');
      const sent = await sendImageToChat(file, t('pdf:capture.source', { name, page: outcome.page }));
      if (sent) onExitRef.current();
    } catch {
      showGlobalNotification('error', t('pdf:capture.failed'));
    } finally {
      setBusy(false);
    }
  }, [documentTitle, t, viewportRef]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (busy || event.button !== 0) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 不支持指针捕获的环境：拖出覆盖层时会提前结束，不影响主流程
    }
    const start = { x: event.clientX, y: event.clientY };
    dragRef.current = { pointerId: event.pointerId, start };
    setDragBox(toLayerBox(rectFromPoints(start, start)));
  }, [busy, toLayerBox]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDragBox(toLayerBox(rectFromPoints(drag.start, { x: event.clientX, y: event.clientY })));
  }, [toLayerBox]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragBox(null);
    void finish(rectFromPoints(drag.start, { x: event.clientX, y: event.clientY }));
  }, [finish]);

  const handlePointerCancel = useCallback(() => {
    dragRef.current = null;
    setDragBox(null);
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    // Ctrl / ⌘ + 滚轮（含触控板捏合）留给阅读器缩放，不转发成滚动
    if (event.ctrlKey || event.metaKey) return;
    viewportRef.current?.scrollBy({ left: event.deltaX, top: event.deltaY });
  }, [viewportRef]);

  const hint = busy
    ? t('pdf:capture.working')
    : isTouch ? t('pdf:capture.hint_touch') : t('pdf:capture.hint');

  return (
    <div
      ref={layerRef}
      className="ds-pdf__capture-layer"
      style={frame ? { left: frame.left, top: frame.top, width: frame.width, height: frame.height } : { inset: 0 }}
      data-testid="pdf-region-capture"
      data-busy={busy ? 'true' : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onWheel={handleWheel}
    >
      <div
        className="ds-pdf__capture-hint"
        role="status"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span>{hint}</span>
        <DsButton variant="ghost" size="sm" onClick={() => onExitRef.current()}>
          {t('common:cancel')}
        </DsButton>
      </div>
      {dragBox ? (
        <div
          className="ds-pdf__capture-rect"
          style={{ left: dragBox.left, top: dragBox.top, width: dragBox.width, height: dragBox.height }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
};

export default PdfRegionCapture;
