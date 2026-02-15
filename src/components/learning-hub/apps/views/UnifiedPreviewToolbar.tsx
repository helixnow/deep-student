/**
 * 统一预览工具栏组件
 * 
 * 根据不同的预览类型显示对应的控制项：
 * - docx/xlsx: 缩放控制 + 字号控制
 * - pptx/image: 仅缩放控制
 * - text/其他: 不显示工具栏
 */

import React from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { ZoomIn, ZoomOut, RefreshCw, Minus, Plus, Type, ChevronLeft, ChevronRight } from 'lucide-react';
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

/** 幻灯片导航信息 */
export interface SlideNavInfo {
  current: number;
  total: number;
  navigateTo: (index: number) => void;
}

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
  /** 幻灯片导航信息（仅 pptx 使用） */
  slideNav?: SlideNavInfo | null;
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
  slideNav,
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
      className={`modern-viewer-toolbar ${className}`}
    >
      {/* 缩放控制区域 */}
      <NotionButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button" onClick={handleZoomOut} disabled={zoomScale <= ZOOM_MIN} title={t('learningHub:previewToolbar.zoomOut')} aria-label={t('learningHub:previewToolbar.zoomOut')}>
        <ZoomOut size={16} />
      </NotionButton>

      <span
        className="modern-viewer-zoom-readout"
        title={t('learningHub:previewToolbar.currentZoom', { value: formatPercent(zoomScale) })}
      >
        {formatPercent(zoomScale)}
      </span>

      <NotionButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button" onClick={handleZoomIn} disabled={zoomScale >= ZOOM_MAX} title={t('learningHub:previewToolbar.zoomIn')} aria-label={t('learningHub:previewToolbar.zoomIn')}>
        <ZoomIn size={16} />
      </NotionButton>

      <NotionButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button" onClick={onZoomReset} title={t('learningHub:previewToolbar.resetZoom')} aria-label={t('learningHub:previewToolbar.resetZoom')}>
        <RefreshCw size={14} />
      </NotionButton>

      {/* 幻灯片页码控制区域（仅 pptx） */}
      {previewType === 'pptx' && slideNav && slideNav.total > 0 && (
        <>
          <div className="modern-viewer-divider" />

          <NotionButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button" onClick={() => slideNav.navigateTo(Math.max(0, slideNav.current - 1))} disabled={slideNav.current === 0} title={t('learningHub:previewToolbar.prevSlide', '上一页')} aria-label={t('learningHub:previewToolbar.prevSlide', '上一页')}>
            <ChevronLeft size={16} />
          </NotionButton>

          <span className="modern-viewer-zoom-readout">
            {t('learningHub:docPreview.slideNav', { current: slideNav.current + 1, total: slideNav.total })}
          </span>

          <NotionButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button" onClick={() => slideNav.navigateTo(Math.min(slideNav.total - 1, slideNav.current + 1))} disabled={slideNav.current === slideNav.total - 1} title={t('learningHub:previewToolbar.nextSlide', '下一页')} aria-label={t('learningHub:previewToolbar.nextSlide', '下一页')}>
            <ChevronRight size={16} />
          </NotionButton>
        </>
      )}

      {/* 字号控制区域（仅 docx/xlsx） */}
      {showFontControl && (
        <>
          <div className="modern-viewer-divider" />

          <Type size={14} className="text-muted-foreground" />

          <NotionButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button" onClick={handleFontDecrease} disabled={fontScale <= FONT_MIN} title={t('learningHub:previewToolbar.fontDecrease')} aria-label={t('learningHub:previewToolbar.fontDecrease')}>
            <Minus size={14} />
          </NotionButton>

          <span
            className="modern-viewer-zoom-readout"
            title={t('learningHub:previewToolbar.currentFont', { value: formatPercent(fontScale) })}
          >
            {formatPercent(fontScale)}
          </span>

          <NotionButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button" onClick={handleFontIncrease} disabled={fontScale >= FONT_MAX} title={t('learningHub:previewToolbar.fontIncrease')} aria-label={t('learningHub:previewToolbar.fontIncrease')}>
            <Plus size={14} />
          </NotionButton>

          {onFontReset && (
            <NotionButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button" onClick={onFontReset} title={t('learningHub:previewToolbar.resetFont')} aria-label={t('learningHub:previewToolbar.resetFont')}>
              <RefreshCw size={14} />
            </NotionButton>
          )}
        </>
      )}
    </div>
  );
});

UnifiedPreviewToolbar.displayName = 'UnifiedPreviewToolbar';

export default UnifiedPreviewToolbar;
