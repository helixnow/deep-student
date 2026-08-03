import { useState, useEffect, useRef, useCallback } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { createPortal } from 'react-dom';
import { X, MagnifyingGlassPlus, MagnifyingGlassMinus, ArrowClockwise, House, CaretLeft, CaretRight, TextT, Crop, Check, ArrowCounterClockwise, Download } from '@phosphor-icons/react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useTranslation } from 'react-i18next';
import { debugLog } from '../debug-panel/debugMasterSwitch';
import { Switch } from './ui/shad/Switch';
import { CustomScrollArea } from './custom-scroll-area';

interface ImageViewerProps {
  images: string[];
  currentIndex: number;
  isOpen: boolean;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  /** OCR text for each image (indexed by image index) */
  ocrTexts?: string[];
  /** Callback when user crops an image, receives data URL of cropped image */
  onCrop?: (croppedDataUrl: string, originalIndex: number) => void;
}

export const ImageViewer: React.FC<ImageViewerProps> = ({
  images,
  currentIndex,
  isOpen,
  onClose,
  onNext,
  onPrev,
  ocrTexts,
  onCrop,
}) => {
  const [internalIndex, setInternalIndex] = useState(currentIndex);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isBlurEnabled, setIsBlurEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      const stored = window.localStorage.getItem('imageViewer.blurEnabled');
      if (stored === null) return true;
      return stored !== 'false';
    } catch {
      return true;
    }
  });
  const { t } = useTranslation(['common']);

  // OCR text panel state
  const [showOcrPanel, setShowOcrPanel] = useState(false);

  // Crop mode state
  const [isCropMode, setIsCropMode] = useState(false);
  const [cropRect, setCropRect] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  const [isCropping, setIsCropping] = useState(false);
  const cropContainerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Touch gesture state
  const touchStateRef = useRef<{
    lastTouchDist: number;
    lastTouchCenter: { x: number; y: number };
    isTouching: boolean;
  }>({ lastTouchDist: 0, lastTouchCenter: { x: 0, y: 0 }, isTouching: false });

  // Ref mirror for isCropMode — needed by native event handlers (wheel) that
  // are registered once and can't see React state updates.
  const isCropModeRef = useRef(false);
  isCropModeRef.current = isCropMode;

  // 捏合缩放锚点补偿需要在原生事件回调里读取最新 scale/position
  const scaleStateRef = useRef(scale);
  scaleStateRef.current = scale;
  const positionStateRef = useRef(position);
  positionStateRef.current = position;
  
  // 焦点陷阱
  const focusTrapRef = useFocusTrap(isOpen);
  
  useEffect(() => {
    if (isOpen) {
      debugLog.log('ImageViewer opened with images:', images, 'currentIndex:', currentIndex);
    }
  }, [isOpen, images, currentIndex]);

  // 重置状态当图片改变时
  useEffect(() => {
    setInternalIndex(currentIndex);
    setScale(1);
    setRotation(0);
    setPosition({ x: 0, y: 0 });
    // FIX BUG-1: 切换图片时退出裁剪模式
    setIsCropMode(false);
    setCropRect(null);
  }, [currentIndex]);

  // 键盘事件处理
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 输入框中不拦截快捷键
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        // Escape 仍然可以关闭查看器
        if (e.key === 'Escape') {
          onClose();
        }
        return;
      }

      switch (e.key) {
        case 'Escape':
          // FIX BUG-2: 裁剪模式下先退出裁剪，再按才关闭查看器
          if (isCropModeRef.current) {
            setIsCropMode(false);
            setCropRect(null);
          } else {
            onClose();
          }
          break;
        case 'ArrowLeft':
          if (!isCropModeRef.current) onPrev?.();
          break;
        case 'ArrowRight':
          if (!isCropModeRef.current) onNext?.();
          break;
        // FIX BUG-3: 裁剪模式下禁用缩放/旋转/重置快捷键
        case '+':
        case '=':
          if (!isCropModeRef.current) setScale(prev => Math.min(prev * 1.2, 5));
          break;
        case '-':
          if (!isCropModeRef.current) setScale(prev => Math.max(prev / 1.2, 0.1));
          break;
        case 'r':
        case 'R':
          if (!isCropModeRef.current) setRotation(prev => (prev + 90) % 360);
          break;
        case '0':
          if (!isCropModeRef.current) {
            setScale(1);
            setRotation(0);
            setPosition({ x: 0, y: 0 });
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, onNext, onPrev]);

  // Android 系统返回键：裁剪模式先退出裁剪，再按才关闭查看器（对齐 Escape 语义）
  useEffect(() => {
    if (!isOpen) return;
    return registerBackHandler(() => {
      if (isCropModeRef.current) {
        setIsCropMode(false);
        setCropRect(null);
        return true;
      }
      onClose();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isOpen, onClose]);

  // 锁定页面滚动，避免滚动造成的视觉偏移
  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem('imageViewer.blurEnabled', isBlurEnabled ? 'true' : 'false');
    } catch {
      // localStorage 不可用时静默忽略
    }
  }, [isBlurEnabled]);

  // 滚轮缩放容器 ref（使用原生事件以支持 { passive: false }）
  const zoomContainerRef = useRef<HTMLDivElement>(null);

  // 🔒 审计修复: 使用 ref 追踪 document 级事件监听器，确保组件卸载时清理
  // 原代码在 mousedown 中添加监听器，但仅在 mouseup 中清理。如果组件在拖拽中卸载，监听器泄漏。
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      // 组件卸载时清理残留的拖拽监听器
      dragCleanupRef.current?.();
    };
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    
    const startPos = {
      x: e.clientX - position.x,
      y: e.clientY - position.y
    };
    setDragStart(startPos);

    // 使用原生事件监听器，确保丝滑拖拽；
    // WebView2 高刷鼠标（125Hz+）下 per-event setState 会逐帧触发 layout，
    // mousemove 只缓存最新坐标，rAF 每帧消费一次（pendingPoint 模式）
    let rafId = 0;
    let pendingPoint: { x: number; y: number } | null = null;

    const processFrame = () => {
      rafId = 0;
      const point = pendingPoint;
      pendingPoint = null;
      if (!point) return;
      setPosition({
        x: point.x - startPos.x,
        y: point.y - startPos.y
      });
    };

    const handleGlobalMouseMove = (e: MouseEvent) => {
      pendingPoint = { x: e.clientX, y: e.clientY };
      if (rafId === 0) {
        rafId = requestAnimationFrame(processFrame);
      }
    };

    const handleGlobalMouseUp = () => {
      setIsDragging(false);
      // 冲刷最后一个点，保证松手位置不丢
      if (rafId !== 0) cancelAnimationFrame(rafId);
      processFrame();
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
      dragCleanupRef.current = null;
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);
    // 保存清理函数供卸载时使用
    dragCleanupRef.current = () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      pendingPoint = null;
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  };

  // 滚轮缩放：使用原生 addEventListener + { passive: false }
  // React 17+ 将 wheel 事件注册为 passive，导致 e.preventDefault() 无效
  useEffect(() => {
    const container = zoomContainerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // FIX BUG-4: 裁剪模式下禁止滚轮缩放
      if (isCropModeRef.current) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setScale(prev => Math.max(0.1, Math.min(5, prev * delta)));
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  // Touch gesture support (pinch-to-zoom & single-finger drag)
  useEffect(() => {
    const container = zoomContainerRef.current;
    if (!container || isCropMode) return;

    const getTouchDist = (t1: Touch, t2: Touch) =>
      Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    const getTouchCenter = (t1: Touch, t2: Touch) => ({
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2,
    });

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dist = getTouchDist(e.touches[0], e.touches[1]);
        const center = getTouchCenter(e.touches[0], e.touches[1]);
        touchStateRef.current = { lastTouchDist: dist, lastTouchCenter: center, isTouching: true };
      } else if (e.touches.length === 1) {
        touchStateRef.current.isTouching = true;
        touchStateRef.current.lastTouchCenter = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dist = getTouchDist(e.touches[0], e.touches[1]);
        if (touchStateRef.current.lastTouchDist <= 0) return;
        const ratio = dist / touchStateRef.current.lastTouchDist;
        touchStateRef.current.lastTouchDist = dist;
        // ★ 以双指中心为锚点：缩放后补偿 position，让捏合中心下的图像点不动。
        // transform 为 translate(p) scale(s)（transform-origin 在图片中心 C0+p），
        // 保持锚点 F 不动 ⇒ p' = p + (1 - s'/s)·(F - C0 - p)
        const center = getTouchCenter(e.touches[0], e.touches[1]);
        touchStateRef.current.lastTouchCenter = center;
        const prev = scaleStateRef.current;
        const next = Math.max(0.1, Math.min(5, prev * ratio));
        if (next !== prev) {
          const rect = container.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const k = next / prev;
          const pos = positionStateRef.current;
          setScale(next);
          setPosition({
            x: pos.x + (1 - k) * (center.x - cx - pos.x),
            y: pos.y + (1 - k) * (center.y - cy - pos.y),
          });
        }
      } else if (e.touches.length === 1 && touchStateRef.current.isTouching) {
        const dx = e.touches[0].clientX - touchStateRef.current.lastTouchCenter.x;
        const dy = e.touches[0].clientY - touchStateRef.current.lastTouchCenter.y;
        setPosition(prev => ({ x: prev.x + dx, y: prev.y + dy }));
        touchStateRef.current.lastTouchCenter = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        // 捏合抬起一指后无缝转入单指拖拽：重设锚点并清掉过期的捏合距离
        touchStateRef.current.lastTouchDist = 0;
        touchStateRef.current.lastTouchCenter = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        touchStateRef.current.isTouching = true;
      } else {
        touchStateRef.current.lastTouchDist = 0;
        touchStateRef.current.isTouching = false;
      }
    };

    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd);
    container.addEventListener('touchcancel', onTouchEnd);
    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [isCropMode]);

  // FIX BUG-5: Crop drag — use document-level listeners for robust tracking
  const cropCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => { cropCleanupRef.current?.(); };
  }, []);

  // ★ 触屏适配：改用 Pointer Events + setPointerCapture，鼠标与手指共用一条路径
  // （旧实现只绑 mousemove/mouseup，触屏完全无法框选）；
  // 覆盖层加 touch-action: none，框选期间浏览器不再接管滚动手势。
  const handleCropPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isCropMode || !cropContainerRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = cropContainerRef.current;
    const pointerId = e.pointerId;
    const containerRect = el.getBoundingClientRect();
    const x = e.clientX - containerRect.left;
    const y = e.clientY - containerRect.top;
    setCropRect({ startX: x, startY: y, endX: x, endY: y });
    setIsCropping(true);
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // pointer capture 不可用时退化为元素内跟踪
    }

    // 同图片拖拽：pointermove 只缓存坐标，rAF 合并 getBoundingClientRect + setState
    let rafId = 0;
    let pendingPoint: { x: number; y: number } | null = null;

    const processFrame = () => {
      rafId = 0;
      const point = pendingPoint;
      pendingPoint = null;
      if (!point) return;
      const rect = cropContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = Math.max(0, Math.min(point.x - rect.left, rect.width));
      const my = Math.max(0, Math.min(point.y - rect.top, rect.height));
      setCropRect(prev => prev ? { ...prev, endX: mx, endY: my } : null);
    };

    const handleCropMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      pendingPoint = { x: ev.clientX, y: ev.clientY };
      if (rafId === 0) {
        rafId = requestAnimationFrame(processFrame);
      }
    };

    const handleCropUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      setIsCropping(false);
      // 冲刷最后一个点，保证裁剪框终点与松手位置一致
      if (rafId !== 0) cancelAnimationFrame(rafId);
      processFrame();
      el.removeEventListener('pointermove', handleCropMove);
      el.removeEventListener('pointerup', handleCropUp);
      el.removeEventListener('pointercancel', handleCropUp);
      cropCleanupRef.current = null;
    };

    el.addEventListener('pointermove', handleCropMove);
    el.addEventListener('pointerup', handleCropUp);
    el.addEventListener('pointercancel', handleCropUp);
    cropCleanupRef.current = () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      pendingPoint = null;
      el.removeEventListener('pointermove', handleCropMove);
      el.removeEventListener('pointerup', handleCropUp);
      el.removeEventListener('pointercancel', handleCropUp);
    };
  }, [isCropMode]);

  // Execute crop: draw selected region onto canvas
  const executeCrop = useCallback(() => {
    if (!cropRect || !imgRef.current) return;
    const img = imgRef.current;
    const containerRect = cropContainerRef.current?.getBoundingClientRect();
    if (!containerRect) return;

    const sx = Math.min(cropRect.startX, cropRect.endX);
    const sy = Math.min(cropRect.startY, cropRect.endY);
    const sw = Math.abs(cropRect.endX - cropRect.startX);
    const sh = Math.abs(cropRect.endY - cropRect.startY);

    if (sw < 5 || sh < 5) return;

    // Map from display coords to natural image coords
    const imgDisplayRect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / imgDisplayRect.width;
    const scaleY = img.naturalHeight / imgDisplayRect.height;
    const offsetX = imgDisplayRect.left - containerRect.left;
    const offsetY = imgDisplayRect.top - containerRect.top;

    const natX = Math.max(0, (sx - offsetX) * scaleX);
    const natY = Math.max(0, (sy - offsetY) * scaleY);
    const natW = Math.min(img.naturalWidth - natX, sw * scaleX);
    const natH = Math.min(img.naturalHeight - natY, sh * scaleY);

    // ★ 2026-06-12（代理 3 审阅 I3）：选区完全落在图片外（letterbox 边缘）时
    // natW/natH 为负，赋给 canvas 尺寸会抛 IndexSizeError，这里直接放弃本次裁剪。
    if (natW <= 0 || natH <= 0) return;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(natW);
    canvas.height = Math.round(natH);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, Math.round(natX), Math.round(natY), Math.round(natW), Math.round(natH), 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/png');
    onCrop?.(dataUrl, internalIndex);

    // Exit crop mode
    setIsCropMode(false);
    setCropRect(null);
  }, [cropRect, internalIndex, onCrop]);

  // Download current image
  const handleDownload = useCallback(() => {
    const currentImage = images[internalIndex] ?? '';
    if (!currentImage) return;
    const a = document.createElement('a');
    a.href = currentImage;
    a.download = `image-${internalIndex + 1}.png`;
    a.click();
  }, [images, internalIndex]);

  if (!isOpen || images.length === 0) return null;

  const goTo = (index: number) => {
    const clamped = Math.max(0, Math.min(images.length - 1, index));
    if (clamped === internalIndex) return;
    setInternalIndex(clamped);
    const delta = clamped - currentIndex;
    try {
      if (delta > 0 && onNext) {
        for (let i = 0; i < delta; i++) onNext();
      } else if (delta < 0 && onPrev) {
        for (let i = 0; i < Math.abs(delta); i++) onPrev();
      }
    } catch (e: unknown) {
      debugLog.error('[ImageViewer] goTo failed', e);
    }
  };

  const currentImage = images[internalIndex] ?? images[currentIndex] ?? '';
  const currentOcrText = ocrTexts?.[internalIndex] ?? '';
  const hasOcrText = !!currentOcrText.trim();
  const overlayClassName = `modern-image-viewer-overlay ${isBlurEnabled ? 'blur-enabled' : 'blur-disabled'}`;
  const containerClassName = `modern-image-viewer-container ${isBlurEnabled ? 'blur-enabled' : 'blur-disabled'}`;
  const blurToggleTitle = isBlurEnabled
    ? t('common:imageViewer.toggleBlurOff')
    : t('common:imageViewer.toggleBlurOn');

  // 主体高度交给 flex（flex-1 + min-h-0）分配；不再用 100vh/工具栏常量拼 calc
  // —— 内联 100vh 会压死 CSS 类里的 100dvh 兜底，且 36px 常量与触屏 44px 工具栏不符
  const overlay = (
    <div className={overlayClassName}>
      <div
        className={containerClassName}
        ref={focusTrapRef}
        style={{ display: 'flex', flexDirection: 'column' }}
      >
        {/* 主体区域：图片 + OCR 面板（<768 上下堆叠，避免侧栏挤掉图片） */}
        <div className="flex flex-1 min-h-0 max-md:flex-col">
          {/* 图片容器 */}
          <div
            ref={zoomContainerRef}
            className="flex-1 flex items-center justify-center overflow-hidden bg-[hsl(var(--card)/0.5)] relative"
            onMouseDown={isCropMode ? undefined : handleMouseDown}
          >
            {/* 裁剪模式覆层 */}
            {isCropMode && (
              <div
                ref={cropContainerRef}
                className="absolute inset-0 z-20 cursor-crosshair touch-none"
                onPointerDown={handleCropPointerDown}
              >
                {/* 半透明蒙层 */}
                <div className="absolute inset-0 bg-black/40" />
                {/* 裁剪选框 */}
                {cropRect && (
                  <div
                    className="absolute border-2 border-white border-dashed bg-white/10"
                    style={{
                      left: Math.min(cropRect.startX, cropRect.endX),
                      top: Math.min(cropRect.startY, cropRect.endY),
                      width: Math.abs(cropRect.endX - cropRect.startX),
                      height: Math.abs(cropRect.endY - cropRect.startY),
                    }}
/>
                )}
                {/* 裁剪模式提示 & 操作 */}
                <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/70 text-white text-xs backdrop-blur-sm z-30">
                  <span>{t('common:imageViewer.crop_hint')}</span>
                  {cropRect && !isCropping && Math.abs(cropRect.endX - cropRect.startX) > 5 && (
                    <DsButton
                      variant="ghost"
                      size="sm"
                      className="!h-6 !px-2 text-white hover:bg-[var(--overlay-control-hover)]"
                      onClick={(e) => { e.stopPropagation(); executeCrop(); }}
                    >
                      <Check size={14} className="mr-1" />
                      {t('common:imageViewer.crop_confirm')}
                    </DsButton>
                  )}
                  <DsButton
                    variant="ghost"
                    size="sm"
                    className="!h-6 !px-2 text-white hover:bg-[var(--overlay-control-hover)]"
                    onClick={(e) => { e.stopPropagation(); setIsCropMode(false); setCropRect(null); }}
                  >
                    <X size={14} className="mr-1" />
                    {t('common:actions.cancel')}
                  </DsButton>
                </div>
              </div>
            )}

            <img
              ref={imgRef}
              src={currentImage}
              alt={t('common:imageViewer.image_alt', { index: currentIndex + 1 })}
              className="max-w-[90%] max-h-[90%] object-contain user-select-none"
              style={{
                transform: isCropMode
                  ? undefined
                  : `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotation}deg)`,
                cursor: isCropMode ? 'crosshair' : isDragging ? 'grabbing' : 'grab',
              }}
              draggable={false}
              onLoad={(e) => {
                const imgEl = e.target as HTMLImageElement;
                debugLog.log('[ImageViewer] image loaded', {
                  index: internalIndex,
                  naturalWidth: imgEl.naturalWidth,
                  naturalHeight: imgEl.naturalHeight,
                  rendered: imgEl.clientWidth > 0 && imgEl.clientHeight > 0,
                });
              }}
              onError={() => {
                debugLog.error('[ImageViewer] image load failed', {
                  index: internalIndex,
                  srcLength: currentImage?.length,
                  srcPrefix: currentImage?.substring(0, 100),
                });
              }}
/>
          </div>

          {/* OCR 文字面板 */}
          {showOcrPanel && (
            <div className="w-[320px] flex-shrink-0 flex flex-col border-l border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card)/0.95)] backdrop-blur-md max-md:w-full max-md:h-2/5 max-md:min-h-0 max-md:border-l-0 max-md:border-t">
              <div className="flex items-center justify-between px-3 py-2 border-b border-[hsl(var(--border)/0.4)]">
                <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <TextT size={14} />
                  <span>{t('common:imageViewer.ocr_text')}</span>
                </div>
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  className="!w-6 !h-6"
                  onClick={() => setShowOcrPanel(false)}
                  aria-label="close panel"
                >
                  <X size={14} />
                </DsButton>
              </div>
              <CustomScrollArea className="flex-1" viewportClassName="p-3">
                {hasOcrText ? (
                  <pre className="text-sm text-foreground/90 whitespace-pre-wrap break-words font-[inherit] leading-relaxed select-text">
                    {currentOcrText}
                  </pre>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground text-sm gap-2">
                    <TextT size={24} className="opacity-30" />
                    <span>{t('common:imageViewer.no_ocr_text')}</span>
                  </div>
                )}
              </CustomScrollArea>
            </div>
          )}
        </div>

        {/* 导航按钮 */}
        {images.length > 1 && !isCropMode && (
          <>
            <DsButton variant="ghost" size="icon" iconOnly onClick={() => goTo(internalIndex - 1)} className="modern-viewer-icon-button absolute left-4 top-1/2 -translate-y-1/2 !rounded-full !p-3 z-10" disabled={internalIndex === 0} title={t('common:imageViewer.previous')} aria-label={t('a11y.prev')}>
              <CaretLeft size={24} />
            </DsButton>
            <DsButton variant="ghost" size="icon" iconOnly onClick={() => goTo(internalIndex + 1)} className="modern-viewer-icon-button absolute right-4 top-1/2 -translate-y-1/2 !rounded-full !p-3 z-10" disabled={internalIndex === images.length - 1} title={t('common:imageViewer.next_title')} aria-label={t('a11y.next')}>
              <CaretRight size={24} />
            </DsButton>
          </>
        )}

        {/* 缩略图栏 - 固定高度 */}
        {images.length > 1 && (
          <CustomScrollArea
            className="bg-[hsl(var(--card) / 0.6)] backdrop-blur-md border-t border-[hsl(var(--border) / 0.45)]"
            style={{ height: '88px', flexShrink: 0 }}
            viewportClassName="flex gap-2 justify-center p-4"
            orientation="horizontal"
            hideTrackWhenIdle={false}
          >
            {/* ★ I3：高亮与点击统一走 internalIndex/goTo，未接 onNext/onPrev 时缩略图也能切换 */}
            {images.map((image, index) => (
              <div
                key={index}
                className={`w-16 h-16 rounded-lg overflow-hidden cursor-pointer transition-all duration-200 border-2 ${
                  index === internalIndex 
                    ? 'border-[hsl(var(--primary))] opacity-100 scale-105' 
                    : 'border-[hsl(var(--border) / 0.4)] opacity-60 hover:opacity-80'
                }`}
                onClick={() => goTo(index)}
              >
                <img src={image} alt={t('common:imageViewer.thumbnail_alt', { index: index + 1 })} className="w-full h-full object-cover" />
              </div>
            ))}
          </CustomScrollArea>
        )}

        {/* 底部工具栏 */}
        <div className="modern-viewer-toolbar">
          <span className="modern-viewer-zoom-readout">
            {internalIndex + 1} / {images.length}
          </span>
          <div className="modern-viewer-divider" />
          <DsButton variant="ghost" size="icon" iconOnly onClick={() => setScale(prev => Math.max(prev / 1.2, 0.1))} className="modern-viewer-icon-button" title={t('common:imageViewer.zoom_out')} aria-label="zoom out">
            <MagnifyingGlassMinus size={16} />
          </DsButton>
          <span className="modern-viewer-zoom-readout">
            {Math.round(scale * 100)}%
          </span>
          <DsButton variant="ghost" size="icon" iconOnly onClick={() => setScale(prev => Math.min(prev * 1.2, 5))} className="modern-viewer-icon-button" title={t('common:imageViewer.zoom_in')} aria-label="zoom in">
            <MagnifyingGlassPlus size={16} />
          </DsButton>
          <div className="modern-viewer-divider" />
          <DsButton variant="ghost" size="icon" iconOnly onClick={() => setRotation(prev => (prev - 90 + 360) % 360)} className="modern-viewer-icon-button" title={t('common:imageViewer.rotate_ccw')} aria-label="rotate ccw">
            <ArrowCounterClockwise size={16} />
          </DsButton>
          <DsButton variant="ghost" size="icon" iconOnly onClick={() => setRotation(prev => (prev + 90) % 360)} className="modern-viewer-icon-button" title={t('common:imageViewer.rotate_title')} aria-label="rotate">
            <ArrowClockwise size={16} />
          </DsButton>
          <DsButton variant="ghost" size="icon" iconOnly onClick={() => { setScale(1); setRotation(0); setPosition({ x: 0, y: 0 }); }} className="modern-viewer-icon-button" title={t('common:imageViewer.reset_title')} aria-label="reset">
            <House size={16} />
          </DsButton>
          <div className="modern-viewer-divider" />
          {/* 裁剪 */}
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => {
              if (isCropMode) {
                setIsCropMode(false);
                setCropRect(null);
              } else {
                setIsCropMode(true);
                setScale(1);
                setRotation(0);
                setPosition({ x: 0, y: 0 });
              }
            }}
            className={`modern-viewer-icon-button ${isCropMode ? 'modern-viewer-icon-button--primary !bg-[hsl(var(--primary)/0.15)]' : ''}`}
            title={t('common:imageViewer.crop')}
            aria-label="crop"
          >
            <Crop size={16} />
          </DsButton>
          {/* OCR 文字面板切换 */}
          {ocrTexts && (
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => setShowOcrPanel(prev => !prev)}
              className={`modern-viewer-icon-button ${showOcrPanel ? 'modern-viewer-icon-button--primary !bg-[hsl(var(--primary)/0.15)]' : ''}`}
              title={t('common:imageViewer.ocr_text')}
              aria-label="ocr text"
            >
              <TextT size={16} />
            </DsButton>
          )}
          {/* 下载 */}
          <DsButton variant="ghost" size="icon" iconOnly onClick={handleDownload} className="modern-viewer-icon-button" title={t('common:imageViewer.download')} aria-label="download">
            <Download size={16} />
          </DsButton>
          <div className="modern-viewer-divider" />
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{t('common:imageViewer.blurLabel')}</span>
            <Switch
              checked={isBlurEnabled}
              onCheckedChange={(checked) => setIsBlurEnabled(Boolean(checked))}
              aria-label={blurToggleTitle}
/>
          </div>
          <div className="modern-viewer-divider" />
          <DsButton variant="ghost" size="icon" iconOnly onClick={onClose} className="modern-viewer-icon-button modern-viewer-icon-button--danger" title={t('common:imageViewer.close')} aria-label={t('a11y.close')}>
            <X size={16} />
          </DsButton>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}; 
