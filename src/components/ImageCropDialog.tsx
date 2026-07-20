import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  Crop,
  CaretLeft,
  CaretRight,
  CircleNotch,
  ImageIcon,
  Trash,
  ArrowLeft,
} from '@phosphor-icons/react';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

// ============================================================================
// Types
// ============================================================================

interface SourceImageInfo {
  blobHash: string;
  dataUrl: string;
  pageIndex: number;
}

interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageCropDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  examId: string;
  questionId: string;
  onImageAdded?: () => void;
  /**
   * @deprecated 组件现恒以内联裁剪工具渲染（模块规范禁模态），该 prop 仅为兼容保留、不再参与逻辑。
   */
  inline?: boolean;
}

// ============================================================================
// ImageCropDialog
// ============================================================================

export function ImageCropDialog({
  open,
  onOpenChange,
  examId,
  questionId,
  onImageAdded,
}: ImageCropDialogProps) {
  const { t } = useTranslation('common');

  const [sourceImages, setSourceImages] = useState<SourceImageInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [cropping, setCropping] = useState(false);

  // Crop selection state
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // Load source images when dialog opens
  useEffect(() => {
    if (!open || !examId) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const images = await invoke<SourceImageInfo[]>('qbank_get_source_images', {
          examId,
        });
        if (!cancelled) {
          setSourceImages(images);
          setCurrentPage(0);
          setCropRect(null);
        }
      } catch (e) {
        console.error('[ImageCropDialog] Failed to load source images:', e);
        if (!cancelled) {
          setSourceImages([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [open, examId]);

  // Get relative coordinates within the displayed image
  const getRelativeCoords = useCallback((clientX: number, clientY: number) => {
    const img = imageRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return { x, y };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const coords = getRelativeCoords(e.clientX, e.clientY);
    if (!coords) return;
    e.preventDefault();
    setIsDragging(true);
    setDragStart(coords);
    setCropRect(null);
  }, [getRelativeCoords]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging || !dragStart) return;
    const coords = getRelativeCoords(e.clientX, e.clientY);
    if (!coords) return;

    const x = Math.min(dragStart.x, coords.x);
    const y = Math.min(dragStart.y, coords.y);
    const width = Math.abs(coords.x - dragStart.x);
    const height = Math.abs(coords.y - dragStart.y);

    setCropRect({ x, y, width, height });
  }, [isDragging, dragStart, getRelativeCoords]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    // If the crop rect is too small, clear it (functional update avoids stale closure)
    setCropRect(prev => {
      if (prev && (prev.width < 0.01 || prev.height < 0.01)) return null;
      return prev;
    });
  }, []);

  // Touch support
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const coords = getRelativeCoords(touch.clientX, touch.clientY);
    if (!coords) return;
    e.preventDefault();
    setIsDragging(true);
    setDragStart(coords);
    setCropRect(null);
  }, [getRelativeCoords]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging || !dragStart || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const coords = getRelativeCoords(touch.clientX, touch.clientY);
    if (!coords) return;

    const x = Math.min(dragStart.x, coords.x);
    const y = Math.min(dragStart.y, coords.y);
    const width = Math.abs(coords.x - dragStart.x);
    const height = Math.abs(coords.y - dragStart.y);

    setCropRect({ x, y, width, height });
  }, [isDragging, dragStart, getRelativeCoords]);

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
    setCropRect(prev => {
      if (prev && (prev.width < 0.01 || prev.height < 0.01)) return null;
      return prev;
    });
  }, []);

  // Submit crop
  const handleCrop = useCallback(async () => {
    if (!cropRect || !sourceImages[currentPage]) return;

    setCropping(true);
    try {
      await invoke('qbank_crop_source_image', {
        request: {
          question_id: questionId,
          blob_hash: sourceImages[currentPage].blobHash,
          crop_x: cropRect.x,
          crop_y: cropRect.y,
          crop_width: cropRect.width,
          crop_height: cropRect.height,
        },
      });

      showGlobalNotification('success', t('question_bank.crop_success'));

      setCropRect(null);
      onImageAdded?.();
    } catch (e: any) {
      console.error('[ImageCropDialog] Crop failed:', e);
      showGlobalNotification(
        'error',
        t('question_bank.crop_failed', { error: e?.message || String(e) }),
      );
    } finally {
      setCropping(false);
    }
  }, [cropRect, sourceImages, currentPage, questionId, t, onImageAdded]);

  const currentImage = sourceImages[currentPage];
  const hasMultiplePages = sourceImages.length > 1;

  // 内联裁剪工具：Android 返回键 = 取消关闭
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => {
      onOpenChange(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [open, onOpenChange]);

  // 裁剪主体（Dialog 与 inline 工具共用）
  const cropBody = (
    <>
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <CircleNotch size={24} className="animate-spin text-muted-foreground" />
          </div>
        ) : sourceImages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <ImageIcon size={40} className="mb-2 opacity-40" />
            <p className="text-sm">
              {t('question_bank.no_source_images')}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Page navigation */}
            {hasMultiplePages && (
              <div className="flex items-center justify-center gap-3">
                <NotionButton
                  variant="ghost"
                  size="sm"
                  iconOnly
                  disabled={currentPage === 0}
                  onClick={() => { setCurrentPage(p => p - 1); setCropRect(null); }}
                >
                  <CaretLeft size={16} />
                </NotionButton>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {currentPage + 1} / {sourceImages.length}
                </span>
                <NotionButton
                  variant="ghost"
                  size="sm"
                  iconOnly
                  disabled={currentPage === sourceImages.length - 1}
                  onClick={() => { setCurrentPage(p => p + 1); setCropRect(null); }}
                >
                  <CaretRight size={16} />
                </NotionButton>
              </div>
            )}

            {/* Image with crop overlay */}
            {currentImage && (
              <div
                ref={imageContainerRef}
                className="relative select-none cursor-crosshair border border-border/50 rounded-lg overflow-hidden bg-muted/30"
                // 触屏拖选时禁用浏览器默认滚动/缩放手势（passive 监听下 preventDefault 不可靠）
                style={{ touchAction: 'none' }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
              >
                <img
                  ref={imageRef}
                  src={currentImage.dataUrl}
                  alt={`Page ${currentImage.pageIndex + 1}`}
                  className="w-full h-auto pointer-events-none"
                  draggable={false}
/>

                {/* Crop overlay */}
                {cropRect && (
                  <>
                    {/* Dimmed areas */}
                    <div
                      className="absolute inset-0 bg-black/40 pointer-events-none"
                      style={{
                        clipPath: `polygon(
                          0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
                          ${cropRect.x * 100}% ${cropRect.y * 100}%,
                          ${cropRect.x * 100}% ${(cropRect.y + cropRect.height) * 100}%,
                          ${(cropRect.x + cropRect.width) * 100}% ${(cropRect.y + cropRect.height) * 100}%,
                          ${(cropRect.x + cropRect.width) * 100}% ${cropRect.y * 100}%,
                          ${cropRect.x * 100}% ${cropRect.y * 100}%
                        )`,
                      }}
/>
                    {/* Selection border */}
                    <div
                      className="absolute border-2 border-blue-500 pointer-events-none"
                      style={{
                        left: `${cropRect.x * 100}%`,
                        top: `${cropRect.y * 100}%`,
                        width: `${cropRect.width * 100}%`,
                        height: `${cropRect.height * 100}%`,
                      }}
/>
                    {/* Size label */}
                    {imageRef.current && (
                      <div
                        className="absolute text-[10px] bg-blue-500 text-white px-1.5 py-0.5 rounded pointer-events-none"
                        style={{
                          left: `${cropRect.x * 100}%`,
                          top: `${cropRect.y * 100}%`,
                          transform: 'translateY(-100%)',
                        }}
                      >
                        {Math.round(cropRect.width * (imageRef.current.naturalWidth || 0))}
                        ×
                        {Math.round(cropRect.height * (imageRef.current.naturalHeight || 0))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
    </>
  );

  // ==================== 全屏内联裁剪工具（全端统一，禁模态） ====================
  if (!open) return null;
  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-background"
      role="dialog"
      aria-label={t('question_bank.source_images')}
    >
        {/* 顶栏：取消 + 标题 + 确认 */}
        <div className="flex h-12 flex-shrink-0 items-center gap-1.5 border-b border-border/60 px-2">
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => onOpenChange(false)}
            aria-label={t('cancel')}
            className="!h-11 !w-11 text-muted-foreground"
          >
            <ArrowLeft size={20} />
          </NotionButton>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ImageIcon size={16} className="flex-shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium text-foreground">
              {t('question_bank.source_images')}
            </span>
          </div>
          <NotionButton
            variant="primary"
            size="sm"
            disabled={!cropRect || cropping}
            onClick={handleCrop}
            className="!h-9 flex-shrink-0 px-3"
          >
            {cropping ? (
              <CircleNotch size={14} className="mr-1 animate-spin" />
            ) : (
              <Crop size={14} className="mr-1" />
            )}
            {t('question_bank.crop_and_add')}
          </NotionButton>
        </div>

        {/* 提示条：拖选提示 / 已选中 + 清除 */}
        <div className="flex min-h-[36px] flex-shrink-0 items-center justify-between gap-2 border-b border-border/40 px-4 py-1.5">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {cropRect ? (
              <span className="font-medium text-blue-500">
                {t('question_bank.crop_selected')}
              </span>
            ) : sourceImages.length > 0 ? (
              t('question_bank.drag_to_crop')
            ) : (
              t('question_bank.crop_hint')
            )}
          </span>
          {cropRect && (
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setCropRect(null)}
              className="!h-8 flex-shrink-0 px-2 text-xs"
            >
              <Trash size={14} className="mr-1" />
              {t('question_bank.clear_selection')}
            </NotionButton>
          )}
        </div>

        {/* 图片区：全高滚动（safe-area 兼容） */}
        <div
          className="min-h-0 flex-1 overflow-y-auto px-3 pt-3"
          style={{
            paddingBottom:
              'calc(var(--mobile-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 12px)',
          }}
        >
          {cropBody}
        </div>
      </div>
  );
}
