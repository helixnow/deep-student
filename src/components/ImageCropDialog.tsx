import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  NotionDialog,
  NotionDialogHeader,
  NotionDialogTitle,
  NotionDialogDescription,
  NotionDialogBody,
  NotionDialogFooter,
} from '@/components/ui/NotionDialog';
import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  Crop,
  ChevronLeft,
  ChevronRight,
  Loader2,
  ImageIcon,
  Trash2,
} from 'lucide-react';

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
  const { t } = useTranslation();

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

      showGlobalNotification('success', t('question_bank.crop_success', '图片裁剪成功'));

      setCropRect(null);
      onImageAdded?.();
    } catch (e: any) {
      console.error('[ImageCropDialog] Crop failed:', e);
      showGlobalNotification('error', t('question_bank.crop_failed', '裁剪失败: ') + (e?.message || String(e)));
    } finally {
      setCropping(false);
    }
  }, [cropRect, sourceImages, currentPage, questionId, t, onImageAdded]);

  const currentImage = sourceImages[currentPage];
  const hasMultiplePages = sourceImages.length > 1;

  return (
    <NotionDialog
      open={open}
      onOpenChange={onOpenChange}
      maxWidth="max-w-4xl"
      className="!max-h-[90vh]"
    >
      <NotionDialogHeader>
        <NotionDialogTitle className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4" />
          {t('question_bank.source_images', '原始导入图片')}
        </NotionDialogTitle>
        <NotionDialogDescription>
          {t('question_bank.crop_hint', '在图片上拖拽选取区域，点击"裁剪并添加"将选区添加为题目配图')}
        </NotionDialogDescription>
      </NotionDialogHeader>

      <NotionDialogBody nativeScroll>
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : sourceImages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <ImageIcon className="h-10 w-10 mb-2 opacity-40" />
            <p className="text-sm">
              {t('question_bank.no_source_images', '该题目集没有原始导入图片')}
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
                  <ChevronLeft className="h-4 w-4" />
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
                  <ChevronRight className="h-4 w-4" />
                </NotionButton>
              </div>
            )}

            {/* Image with crop overlay */}
            {currentImage && (
              <div
                ref={imageContainerRef}
                className="relative select-none cursor-crosshair border border-border/50 rounded-lg overflow-hidden bg-muted/30"
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
      </NotionDialogBody>

      <NotionDialogFooter>
        <div className="flex items-center justify-between w-full">
          <div className="text-xs text-muted-foreground">
            {cropRect ? (
              <span className="text-blue-500 font-medium">
                {t('question_bank.crop_selected', '已选择裁剪区域')}
              </span>
            ) : sourceImages.length > 0 ? (
              t('question_bank.drag_to_crop', '拖拽选取裁剪区域')
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {cropRect && (
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={() => setCropRect(null)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                {t('question_bank.clear_selection', '清除')}
              </NotionButton>
            )}
            <NotionButton
              variant="primary"
              size="sm"
              disabled={!cropRect || cropping}
              onClick={handleCrop}
            >
              {cropping ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Crop className="h-3.5 w-3.5 mr-1" />
              )}
              {t('question_bank.crop_and_add', '裁剪并添加')}
            </NotionButton>
          </div>
        </div>
      </NotionDialogFooter>
    </NotionDialog>
  );
}
