/**
 * 统一预览工具栏组件
 * 
 * 根据不同的预览类型显示对应的控制项：
 * - docx/xlsx: 缩放控制 + 字号控制
 * - pptx/image: 仅缩放控制
 * - text/其他: 不显示工具栏
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { ZoomIn, ZoomOut, RefreshCw, Minus, Plus, Type } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  FONT_MIN,
  FONT_MAX,
  FONT_STEP,
  clampNumber,
} from './previewUtils';

// ============================================================================
// 类型定义
// ============================================================================

/** 支持工具栏的预览类型 */
export type ToolbarPreviewType = 'docx' | 'xlsx' | 'pptx' | 'image' | 'text' | 'other';

/** 工具栏 Props 类型 */
export interface UnifiedPreviewToolbarProps {
  /** 预览类型 */
  previewType: ToolbarPreviewType;
  /** 当前缩放比例 */
  zoomScale: number;
  /** 当前字号比例（仅 docx/xlsx 使用） */
  fontScale?: number;
  /** 缩放变更回调 */
  onZoomChange: (scale: number) => void;
  /** 字号变更回调（仅 docx/xlsx 使用） */
  onFontChange?: (scale: number) => void;
  /** 缩放重置回调 */
  onZoomReset: () => void;
  /** 字号重置回调（仅 docx/xlsx 使用） */
  onFontReset?: () => void;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 判断预览类型是否需要显示工具栏
 */
const shouldShowToolbar = (type: ToolbarPreviewType): boolean => {
  return ['docx', 'xlsx', 'pptx', 'image'].includes(type);
};

/**
 * 判断预览类型是否支持字号控制
 */
const supportsFontControl = (type: ToolbarPreviewType): boolean => {
  return ['docx', 'xlsx'].includes(type);
};

/**
 * 格式化百分比显示
 */
const formatPercent = (value: number): string => {
  return `${Math.round(value * 100)}%`;
};

// ============================================================================
// 组件实现
// ============================================================================

/**
 * 统一预览工具栏组件
 * 
 * 提供缩放和字号控制功能，放置在预览区域顶部
 * 使用 React.memo 优化，避免不必要的重渲染
 */
export const UnifiedPreviewToolbar: React.FC<UnifiedPreviewToolbarProps> = React.memo(({
  previewType,
  zoomScale,
  fontScale = 1,
  onZoomChange,
  onFontChange,
  onZoomReset,
  onFontReset,
  className = '',
}) => {
  const { t } = useTranslation(['learningHub']);

  // 不需要工具栏的类型直接返回 null
  if (!shouldShowToolbar(previewType)) {
    return null;
  }

  // 缩放控制：减小
  const handleZoomOut = () => {
    const newScale = clampNumber(zoomScale - ZOOM_STEP, ZOOM_MIN, ZOOM_MAX);
    onZoomChange(Number(newScale.toFixed(2)));
  };

  // 缩放控制：增大
  const handleZoomIn = () => {
    const newScale = clampNumber(zoomScale + ZOOM_STEP, ZOOM_MIN, ZOOM_MAX);
    onZoomChange(Number(newScale.toFixed(2)));
  };

  // 字号控制：减小
  const handleFontDecrease = () => {
    if (!onFontChange) return;
    const newScale = clampNumber(fontScale - FONT_STEP, FONT_MIN, FONT_MAX);
    onFontChange(Number(newScale.toFixed(2)));
  };

  // 字号控制：增大
  const handleFontIncrease = () => {
    if (!onFontChange) return;
    const newScale = clampNumber(fontScale + FONT_STEP, FONT_MIN, FONT_MAX);
    onFontChange(Number(newScale.toFixed(2)));
  };

  // 是否显示字号控制
  const showFontControl = supportsFontControl(previewType) && onFontChange;

  return (
    <div
      className={`
        flex items-center justify-center gap-0.5
        h-9 px-2
        bg-muted/50 border-t
        ${className}
      `}
    >
      {/* 缩放控制区域 */}
      <div className="flex items-center gap-0.5">
        {/* 缩小按钮 */}
        <NotionButton
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleZoomOut}
          disabled={zoomScale <= ZOOM_MIN}
          title={t('learningHub:previewToolbar.zoomOut')}
          aria-label={t('learningHub:previewToolbar.zoomOut')}
        >
          <ZoomOut className="h-4 w-4" />
        </NotionButton>

        {/* 缩放比例显示 */}
        <span
          className="min-w-[3.5rem] text-center text-xs text-muted-foreground tabular-nums"
          title={t('learningHub:previewToolbar.currentZoom', { value: formatPercent(zoomScale) })}
        >
          {formatPercent(zoomScale)}
        </span>

        {/* 放大按钮 */}
        <NotionButton
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleZoomIn}
          disabled={zoomScale >= ZOOM_MAX}
          title={t('learningHub:previewToolbar.zoomIn')}
          aria-label={t('learningHub:previewToolbar.zoomIn')}
        >
          <ZoomIn className="h-4 w-4" />
        </NotionButton>

        {/* 重置缩放按钮 */}
        <NotionButton
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onZoomReset}
          title={t('learningHub:previewToolbar.resetZoom')}
          aria-label={t('learningHub:previewToolbar.resetZoom')}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </NotionButton>
      </div>

      {/* 字号控制区域（仅 docx/xlsx） */}
      {showFontControl && (
        <>
          {/* 分隔线 */}
          <div className="h-5 w-px bg-border mx-1" />

          <div className="flex items-center gap-0.5">
            {/* 字号图标 */}
            <Type className="h-3.5 w-3.5 text-muted-foreground mr-0.5" />

            {/* 减小字号按钮 */}
            <NotionButton
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleFontDecrease}
              disabled={fontScale <= FONT_MIN}
              title={t('learningHub:previewToolbar.fontDecrease')}
              aria-label={t('learningHub:previewToolbar.fontDecrease')}
            >
              <Minus className="h-3.5 w-3.5" />
            </NotionButton>

            {/* 字号比例显示 */}
            <span
              className="min-w-[3rem] text-center text-xs text-muted-foreground tabular-nums"
              title={t('learningHub:previewToolbar.currentFont', { value: formatPercent(fontScale) })}
            >
              {formatPercent(fontScale)}
            </span>

            {/* 增大字号按钮 */}
            <NotionButton
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleFontIncrease}
              disabled={fontScale >= FONT_MAX}
              title={t('learningHub:previewToolbar.fontIncrease')}
              aria-label={t('learningHub:previewToolbar.fontIncrease')}
            >
              <Plus className="h-3.5 w-3.5" />
            </NotionButton>

            {/* 重置字号按钮 */}
            {onFontReset && (
              <NotionButton
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onFontReset}
                title={t('learningHub:previewToolbar.resetFont')}
                aria-label={t('learningHub:previewToolbar.resetFont')}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </NotionButton>
            )}
          </div>
        </>
      )}
    </div>
  );
});

UnifiedPreviewToolbar.displayName = 'UnifiedPreviewToolbar';

export default UnifiedPreviewToolbar;
