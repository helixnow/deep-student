import { useState, useEffect, useRef, useCallback } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { createPortal } from 'react-dom';
import { X, ZoomIn, ZoomOut, RotateCw, Home, ChevronLeft, ChevronRight, Type, Crop, Check, RotateCcw, Download } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
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
    } catch {}
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

    // 使用原生事件监听器，确保丝滑拖拽
    const handleGlobalMouseMove = (e: MouseEvent) => {
      setPosition({
        x: e.clientX - startPos.x,
        y: e.clientY - startPos.y
      });
    };

    const handleGlobalMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
      dragCleanupRef.current = null;
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);
    // 保存清理函数供卸载时使用
    dragCleanupRef.current = () => {
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
        const ratio = dist / touchStateRef.current.lastTouchDist;
        setScale(prev => Math.max(0.1, Math.min(5, prev * ratio)));
        touchStateRef.current.lastTouchDist = dist;
      } else if (e.touches.length === 1 && touchStateRef.current.isTouching) {
        const dx = e.touches[0].clientX - touchStateRef.current.lastTouchCenter.x;
        const dy = e.touches[0].clientY - touchStateRef.current.lastTouchCenter.y;
        setPosition(prev => ({ x: prev.x + dx, y: prev.y + dy }));
        touchStateRef.current.lastTouchCenter = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    };

    const onTouchEnd = () => {
      touchStateRef.current.isTouching = false;
    };

    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd);
    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
    };
  }, [isCropMode]);

  // FIX BUG-5: Crop drag — use document-level listeners for robust tracking
  const cropCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => { cropCleanupRef.current?.(); };
  }, []);

  const handleCropMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isCropMode || !cropContainerRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const containerRect = cropContainerRef.current.getBoundingClientRect();
    const x = e.clientX - containerRect.left;
    const y = e.clientY - containerRect.top;
    setCropRect({ startX: x, startY: y, endX: x, endY: y });
    setIsCropping(true);

    const handleGlobalCropMove = (ev: MouseEvent) => {
      const rect = cropContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = Math.max(0, Math.min(ev.clientX - rect.left, rect.width));
      const my = Math.max(0, Math.min(ev.clientY - rect.top, rect.height));
      setCropRect(prev => prev ? { ...prev, endX: mx, endY: my } : null);
    };

    const handleGlobalCropUp = () => {
      setIsCropping(false);
      document.removeEventListener('mousemove', handleGlobalCropMove);
      document.removeEventListener('mouseup', handleGlobalCropUp);
      cropCleanupRef.current = null;
    };

    document.addEventListener('mousemove', handleGlobalCropMove);
    document.addEventListener('mouseup', handleGlobalCropUp);
    cropCleanupRef.current = () => {
      document.removeEventListener('mousemove', handleGlobalCropMove);
      document.removeEventListener('mouseup', handleGlobalCropUp);
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
    ? t('common:imageViewer.toggleBlurOff', 'Disable background blur')
    : t('common:imageViewer.toggleBlurOn', 'Enable background blur');

  // Calculate main area height
  const toolbarH = 36;
  const thumbH = images.length > 1 ? 88 : 0;
  const mainHeight = `calc(100vh - ${toolbarH}px - ${thumbH}px)`;

  const overlay = (
    <div className={overlayClassName}>
      <div 
        className={containerClassName} 
        ref={focusTrapRef}
        style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw' }}
      >
        {/* 主体区域：图片 + OCR 面板 */}
        <div className="flex flex-1 min-h-0" style={{ height: mainHeight }}>
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
                className="absolute inset-0 z-20 cursor-crosshair"
                onMouseDown={handleCropMouseDown}
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
                  <span>{t('common:imageViewer.crop_hint', '拖拽选择裁剪区域')}</span>
                  {cropRect && !isCropping && Math.abs(cropRect.endX - cropRect.startX) > 5 && (
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      className="!h-6 !px-2 text-white hover:bg-white/20"
                      onClick={(e) => { e.stopPropagation(); executeCrop(); }}
                    >
                      <Check size={14} className="mr-1" />
                      {t('common:imageViewer.crop_confirm', '确认裁剪')}
                    </NotionButton>
                  )}
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    className="!h-6 !px-2 text-white hover:bg-white/20"
                    onClick={(e) => { e.stopPropagation(); setIsCropMode(false); setCropRect(null); }}
                  >
                    <X size={14} className="mr-1" />
                    {t('common:actions.cancel', '取消')}
                  </NotionButton>
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
            <div className="w-[320px] flex-shrink-0 flex flex-col border-l border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card)/0.95)] backdrop-blur-md">
              <div className="flex items-center justify-between px-3 py-2 border-b border-[hsl(var(--border)/0.4)]">
                <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Type size={14} />
                  <span>{t('common:imageViewer.ocr_text', 'OCR 文字')}</span>
                </div>
                <NotionButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  className="!w-6 !h-6"
                  onClick={() => setShowOcrPanel(false)}
                  aria-label="close panel"
                >
                  <X size={14} />
                </NotionButton>
              </div>
              <CustomScrollArea className="flex-1" viewportClassName="p-3">
                {hasOcrText ? (
                  <pre className="text-sm text-foreground/90 whitespace-pre-wrap break-words font-[inherit] leading-relaxed select-text">
                    {currentOcrText}
                  </pre>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground text-sm gap-2">
                    <Type size={24} className="opacity-30" />
                    <span>{t('common:imageViewer.no_ocr_text', '暂无 OCR 文字')}</span>
                  </div>
                )}
              </CustomScrollArea>
            </div>
          )}
        </div>

        {/* 导航按钮 */}
        {images.length > 1 && !isCropMode && (
          <>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => goTo(internalIndex - 1)} className="modern-viewer-icon-button absolute left-4 top-1/2 -translate-y-1/2 !rounded-full !p-3 z-10" disabled={internalIndex === 0} title={t('common:imageViewer.previous')} aria-label="prev">
              <ChevronLeft size={24} />
            </NotionButton>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => goTo(internalIndex + 1)} className="modern-viewer-icon-button absolute right-4 top-1/2 -translate-y-1/2 !rounded-full !p-3 z-10" disabled={internalIndex === images.length - 1} title={t('common:imageViewer.next_title')} aria-label="next">
              <ChevronRight size={24} />
            </NotionButton>
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
            {images.map((image, index) => (
              <div
                key={index}
                className={`w-16 h-16 rounded-lg overflow-hidden cursor-pointer transition-all duration-200 border-2 ${
                  index === currentIndex 
                    ? 'border-[hsl(var(--primary))] opacity-100 scale-105' 
                    : 'border-[hsl(var(--border) / 0.4)] opacity-60 hover:opacity-80'
                }`}
                onClick={() => {
                  try {
                    if (index !== currentIndex && typeof onNext === 'function' && typeof onPrev === 'function') {
                      const delta = index - currentIndex;
                      if (delta > 0) {
                        for (let i = 0; i < delta; i++) onNext();
                      } else if (delta < 0) {
                        for (let i = 0; i < Math.abs(delta); i++) onPrev();
                      }
                    }
                  } catch (e: unknown) {
                    debugLog.error('[ImageViewer] thumbnail navigation failed', e);
                  }
                }}
              >
                <img src={image} alt={t('common:imageViewer.thumbnail_alt', { index: index + 1 })} className="w-full h-full object-cover" />
              </div>
            ))}
          </CustomScrollArea>
        )}

        {/* 底部工具栏 */}
        <div className="modern-viewer-toolbar">
          <span className="modern-viewer-zoom-readout">
            {currentIndex + 1} / {images.length}
          </span>
          <div className="modern-viewer-divider" />
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setScale(prev => Math.max(prev / 1.2, 0.1))} className="modern-viewer-icon-button" title={t('common:imageViewer.zoom_out')} aria-label="zoom out">
            <ZoomOut size={16} />
          </NotionButton>
          <span className="modern-viewer-zoom-readout">
            {Math.round(scale * 100)}%
          </span>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setScale(prev => Math.min(prev * 1.2, 5))} className="modern-viewer-icon-button" title={t('common:imageViewer.zoom_in')} aria-label="zoom in">
            <ZoomIn size={16} />
          </NotionButton>
          <div className="modern-viewer-divider" />
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setRotation(prev => (prev - 90 + 360) % 360)} className="modern-viewer-icon-button" title={t('common:imageViewer.rotate_ccw', '逆时针旋转')} aria-label="rotate ccw">
            <RotateCcw size={16} />
          </NotionButton>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setRotation(prev => (prev + 90) % 360)} className="modern-viewer-icon-button" title={t('common:imageViewer.rotate_title')} aria-label="rotate">
            <RotateCw size={16} />
          </NotionButton>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => { setScale(1); setRotation(0); setPosition({ x: 0, y: 0 }); }} className="modern-viewer-icon-button" title={t('common:imageViewer.reset_title')} aria-label="reset">
            <Home size={16} />
          </NotionButton>
          <div className="modern-viewer-divider" />
          {/* 裁剪 */}
          <NotionButton
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
            title={t('common:imageViewer.crop', '裁剪')}
            aria-label="crop"
          >
            <Crop size={16} />
          </NotionButton>
          {/* OCR 文字面板切换 */}
          {ocrTexts && (
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => setShowOcrPanel(prev => !prev)}
              className={`modern-viewer-icon-button ${showOcrPanel ? 'modern-viewer-icon-button--primary !bg-[hsl(var(--primary)/0.15)]' : ''}`}
              title={t('common:imageViewer.ocr_text', 'OCR 文字')}
              aria-label="ocr text"
            >
              <Type size={16} />
            </NotionButton>
          )}
          {/* 下载 */}
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleDownload} className="modern-viewer-icon-button" title={t('common:imageViewer.download', '下载')} aria-label="download">
            <Download size={16} />
          </NotionButton>
          <div className="modern-viewer-divider" />
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{t('common:imageViewer.blurLabel', 'Blur')}</span>
            <Switch
              checked={isBlurEnabled}
              onCheckedChange={(checked) => setIsBlurEnabled(Boolean(checked))}
              aria-label={blurToggleTitle}
            />
          </div>
          <div className="modern-viewer-divider" />
          <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} className="modern-viewer-icon-button modern-viewer-icon-button--danger" title={t('common:imageViewer.close')} aria-label="close">
            <X size={16} />
          </NotionButton>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}; 
