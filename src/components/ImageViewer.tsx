import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, ZoomOut, RotateCw, Home, ChevronLeft, ChevronRight } from 'lucide-react';
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
}

export const ImageViewer: React.FC<ImageViewerProps> = ({
  images,
  currentIndex,
  isOpen,
  onClose,
  onNext,
  onPrev
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
          onClose();
          break;
        case 'ArrowLeft':
          onPrev?.();
          break;
        case 'ArrowRight':
          onNext?.();
          break;
        case '+':
        case '=':
          setScale(prev => Math.min(prev * 1.2, 5));
          break;
        case '-':
          setScale(prev => Math.max(prev / 1.2, 0.1));
          break;
        case 'r':
        case 'R':
          setRotation(prev => (prev + 90) % 360);
          break;
        case '0':
          setScale(1);
          setRotation(0);
          setPosition({ x: 0, y: 0 });
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
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setScale(prev => Math.max(0.1, Math.min(5, prev * delta)));
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

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
  const overlayClassName = `modern-image-viewer-overlay ${isBlurEnabled ? 'blur-enabled' : 'blur-disabled'}`;
  const containerClassName = `modern-image-viewer-container ${isBlurEnabled ? 'blur-enabled' : 'blur-disabled'}`;
  const blurToggleTitle = isBlurEnabled
    ? t('common:imageViewer.toggleBlurOff', 'Disable background blur')
    : t('common:imageViewer.toggleBlurOn', 'Enable background blur');

  const overlay = (
    <div className={overlayClassName}>
      <div 
        className={containerClassName} 
        ref={focusTrapRef}
        style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw' }}
      >
        {/* 图片容器 - 使用 calc 计算高度，根据是否有缩略图栏和底部工具栏调整 */}
        <div 
          ref={zoomContainerRef}
          className="flex items-center justify-center overflow-hidden bg-[hsl(var(--card) / 0.5)]"
          style={{ height: images.length > 1 ? 'calc(100vh - 40px - 88px)' : 'calc(100vh - 40px)', overflow: 'hidden' }}
          onMouseDown={handleMouseDown}
        >
          <img
            src={currentImage}
            alt={t('common:imageViewer.image_alt', { index: currentIndex + 1 })}
            className="max-w-[90%] max-h-[90%] object-contain user-select-none"
            style={{
              transform: `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotation}deg)`,
              cursor: isDragging ? 'grabbing' : 'grab'
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

        {/* 导航按钮 */}
        {images.length > 1 && (
          <>
            <button
              onClick={() => goTo(internalIndex - 1)}
              className="modern-viewer-icon-button absolute left-4 top-1/2 -translate-y-1/2 rounded-full p-3 z-10"
              disabled={internalIndex === 0}
              title={t('common:imageViewer.previous')}
            >
              <ChevronLeft size={24} />
            </button>
            <button
              onClick={() => goTo(internalIndex + 1)}
              className="modern-viewer-icon-button absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-3 z-10"
              disabled={internalIndex === images.length - 1}
              title={t('common:imageViewer.next_title')}
            >
              <ChevronRight size={24} />
            </button>
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
                      // 直接跳到指定索引
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
        <div className="modern-viewer-toolbar flex items-center justify-center gap-1 px-3 py-1 backdrop-blur-md" style={{ height: '40px', flexShrink: 0 }}>
          <span className="text-foreground font-medium text-xs mr-1">
            {currentIndex + 1} / {images.length}
          </span>
          <div className="w-px h-4 bg-[hsl(var(--border)/0.45)] mx-1" />
          <button
            onClick={() => setScale(prev => Math.max(prev / 1.2, 0.1))}
            className="modern-viewer-icon-button rounded-md p-1"
            title={t('common:imageViewer.zoom_out')}
          >
            <ZoomOut size={16} />
          </button>
          <span className="px-1.5 py-0.5 rounded text-xs font-medium min-w-[44px] text-center border border-[hsl(var(--border)/0.45)] bg-[hsl(var(--card)/0.55)] text-[hsl(var(--foreground))]">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setScale(prev => Math.min(prev * 1.2, 5))}
            className="modern-viewer-icon-button rounded-md p-1"
            title={t('common:imageViewer.zoom_in')}
          >
            <ZoomIn size={16} />
          </button>
          <div className="w-px h-4 bg-[hsl(var(--border)/0.45)] mx-1" />
          <button
            onClick={() => setRotation(prev => (prev + 90) % 360)}
            className="modern-viewer-icon-button rounded-md p-1"
            title={t('common:imageViewer.rotate_title')}
          >
            <RotateCw size={16} />
          </button>
          <button
            onClick={() => {
              setScale(1);
              setRotation(0);
              setPosition({ x: 0, y: 0 });
            }}
            className="modern-viewer-icon-button rounded-md p-1"
            title={t('common:imageViewer.reset_title')}
          >
            <Home size={16} />
          </button>
          <div className="w-px h-4 bg-[hsl(var(--border)/0.45)] mx-1" />
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{t('common:imageViewer.blurLabel', 'Blur')}</span>
            <Switch
              checked={isBlurEnabled}
              onCheckedChange={(checked) => setIsBlurEnabled(Boolean(checked))}
              aria-label={blurToggleTitle}
            />
          </div>
          <div className="w-px h-4 bg-[hsl(var(--border)/0.45)] mx-1" />
          <button
            onClick={onClose}
            className="modern-viewer-icon-button modern-viewer-icon-button--danger rounded-md p-1"
            title={t('common:imageViewer.close')}
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}; 
