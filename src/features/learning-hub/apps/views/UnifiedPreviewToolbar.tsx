/**
 * 统一预览工具栏组件
 * 
 * 根据不同的预览类型显示对应的控制项：
 * - docx/xlsx: 缩放控制 + 字号控制
 * - pptx/image: 仅缩放控制
 * - text/其他: 不显示工具栏
 * 
 * 交互特性：
 * - 缩放加减沿 ZOOM_LADDER 阶梯跳档（常见 PDF 工具栏习惯）
 * - 缩放百分比本身是下拉菜单触发器，可直接选择预设档位
 * - 按钮 title 内联显示键盘快捷键（Ctrl/⌘ +、−、0）
 * - 重置按钮仅在偏离默认值（100%）时可用
 */

import React from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlassPlus, MagnifyingGlassMinus, ArrowCounterClockwise, Minus, Plus, TextT, CaretLeft, CaretRight, CaretUp } from '@phosphor-icons/react';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuLabel,
  AppMenuSeparator,
} from '@/components/ui/app-menu';
import { isMacOS } from '@/utils/platform';
import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_PRESETS,
  stepZoom,
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

/** 浮点比例是否等于某档位（容忍 toFixed 舍入误差） */
const isSameScale = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

/** 平台修饰键展示符号（macOS 用 ⌘，其余用 Ctrl） */
const MOD_KEY_LABEL = isMacOS() ? '⌘' : 'Ctrl';

/** 拼接“动作名 (快捷键)”形式的 title/aria-label */
const withShortcut = (label: string, keys: string): string =>
  `${label} (${MOD_KEY_LABEL}${keys})`;

// ============================================================================
// 组件实现
// ============================================================================

/**
 * 统一预览工具栏组件
 * 
 * 提供缩放和字号控制功能，放置在预览区域底部
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

  // 缩放控制：沿阶梯跳到上一档
  const handleZoomOut = () => {
    onZoomChange(stepZoom(zoomScale, -1));
  };

  // 缩放控制：沿阶梯跳到下一档
  const handleZoomIn = () => {
    onZoomChange(stepZoom(zoomScale, 1));
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

  const zoomIsDefault = isSameScale(zoomScale, 1);
  const fontIsDefault = isSameScale(fontScale, 1);
  const zoomPercentText = formatPercent(zoomScale);

  return (
    <div
      className={`modern-viewer-toolbar modern-viewer-toolbar--glass [@media(pointer:coarse)]:[&_button]:min-h-11 [@media(pointer:coarse)]:[&_button]:min-w-11 ${className}`}
      role="toolbar"
      aria-label={t('learningHub:officePreview.toolbarLabel')}
    >
      {/* 缩放控制区域 */}
      <div className="modern-viewer-toolbar-group" role="group" aria-label={t('learningHub:previewToolbar.zoomMenu')}>
        <DsButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button" onClick={handleZoomOut} disabled={zoomScale <= ZOOM_MIN} title={withShortcut(t('learningHub:previewToolbar.zoomOut'), ' −')} aria-label={t('learningHub:previewToolbar.zoomOut')}>
          <MagnifyingGlassMinus size={16} />
        </DsButton>

        {/* 缩放百分比 = 预设档位菜单触发器 */}
        <AppMenu mode="dropdown">
          <AppMenuTrigger
            className="modern-viewer-zoom-trigger"
            title={t('learningHub:previewToolbar.zoomMenu')}
            aria-label={t('learningHub:previewToolbar.currentZoom', { value: zoomPercentText })}
          >
            <span aria-live="polite">{zoomPercentText}</span>
            <CaretUp size={10} className="modern-viewer-zoom-trigger-caret" aria-hidden="true" />
          </AppMenuTrigger>
          <AppMenuContent align="center" width={168}>
            <AppMenuLabel>{t('learningHub:previewToolbar.zoomMenu')}</AppMenuLabel>
            {ZOOM_PRESETS.map((preset) => (
              <AppMenuItem
                key={preset}
                checked={isSameScale(zoomScale, preset)}
                shortcut={preset === 1 ? `${MOD_KEY_LABEL} 0` : undefined}
                aria-label={t('learningHub:previewToolbar.zoomTo', { value: formatPercent(preset) })}
                onClick={() => onZoomChange(preset)}
              >
                <span className="tabular-nums">{formatPercent(preset)}</span>
              </AppMenuItem>
            ))}
            <AppMenuSeparator />
            <AppMenuItem disabled={zoomIsDefault} onClick={onZoomReset}>
              {t('learningHub:previewToolbar.resetDefault')}
            </AppMenuItem>
          </AppMenuContent>
        </AppMenu>

        <DsButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button" onClick={handleZoomIn} disabled={zoomScale >= ZOOM_MAX} title={withShortcut(t('learningHub:previewToolbar.zoomIn'), ' +')} aria-label={t('learningHub:previewToolbar.zoomIn')}>
          <MagnifyingGlassPlus size={16} />
        </DsButton>

        {/* 📱 <md 隐藏独立重置按钮：同一操作已收纳在缩放档位菜单的「恢复默认缩放」，
            窄屏（375-430px）上省出 ~44px，让 docx/xlsx 的缩放+字号双分组不再溢出 */}
        <DsButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button max-md:hidden" onClick={onZoomReset} disabled={zoomIsDefault} title={withShortcut(t('learningHub:previewToolbar.resetZoom'), ' 0')} aria-label={t('learningHub:previewToolbar.resetZoom')}>
          <ArrowCounterClockwise size={14} />
        </DsButton>
      </div>

      {/* 幻灯片页码控制区域（仅 pptx） */}
      {previewType === 'pptx' && slideNav && slideNav.total > 0 && (
        <>
          <div className="modern-viewer-divider" />

          <div className="modern-viewer-toolbar-group" role="group" aria-label={t('learningHub:previewToolbar.slideNavGroup')}>
            <DsButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button" onClick={() => slideNav.navigateTo(Math.max(0, slideNav.current - 1))} disabled={slideNav.current === 0} title={t('learningHub:previewToolbar.prevSlide')} aria-label={t('learningHub:previewToolbar.prevSlide')}>
              <CaretLeft size={16} />
            </DsButton>

            {/* 📱 <md 用紧凑的「n / N」页码（完整中文文案在 375px 宽下会把工具栏挤出可视区） */}
            <span
              className="modern-viewer-zoom-readout"
              aria-live="polite"
              aria-label={t('learningHub:docPreview.slideNav', { current: slideNav.current + 1, total: slideNav.total })}
            >
              <span className="max-md:hidden">
                {t('learningHub:docPreview.slideNav', { current: slideNav.current + 1, total: slideNav.total })}
              </span>
              <span className="tabular-nums md:hidden" aria-hidden="true">
                {slideNav.current + 1} / {slideNav.total}
              </span>
            </span>

            <DsButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button" onClick={() => slideNav.navigateTo(Math.min(slideNav.total - 1, slideNav.current + 1))} disabled={slideNav.current === slideNav.total - 1} title={t('learningHub:previewToolbar.nextSlide')} aria-label={t('learningHub:previewToolbar.nextSlide')}>
              <CaretRight size={16} />
            </DsButton>
          </div>
        </>
      )}

      {/* 字号控制区域（仅 docx/xlsx） */}
      {showFontControl && (
        <>
          <div className="modern-viewer-divider" />

          <div className="modern-viewer-toolbar-group" role="group" aria-label={t('learningHub:previewToolbar.fontGroup')}>
            <TextT size={14} className="text-muted-foreground" aria-hidden="true" />

            <DsButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button" onClick={handleFontDecrease} disabled={fontScale <= FONT_MIN} title={t('learningHub:previewToolbar.fontDecrease')} aria-label={t('learningHub:previewToolbar.fontDecrease')}>
              <Minus size={14} />
            </DsButton>

            <span
              className="modern-viewer-zoom-readout"
              title={t('learningHub:previewToolbar.currentFont', { value: formatPercent(fontScale) })}
              aria-label={t('learningHub:previewToolbar.currentFont', { value: formatPercent(fontScale) })}
              aria-live="polite"
            >
              {formatPercent(fontScale)}
            </span>

            <DsButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button" onClick={handleFontIncrease} disabled={fontScale >= FONT_MAX} title={t('learningHub:previewToolbar.fontIncrease')} aria-label={t('learningHub:previewToolbar.fontIncrease')}>
              <Plus size={14} />
            </DsButton>

            {/* 📱 <md 隐藏字号重置：0.1 步进从任意档位都能精确回到 100%（读数即时可见），
                窄屏优先保证增减按钮 ≥44px 触控目标且不横向溢出 */}
            {onFontReset && (
              <DsButton variant="ghost" size="icon" iconOnly className="modern-viewer-icon-button max-md:hidden" onClick={onFontReset} disabled={fontIsDefault} title={t('learningHub:previewToolbar.resetFont')} aria-label={t('learningHub:previewToolbar.resetFont')}>
                <ArrowCounterClockwise size={14} />
              </DsButton>
            )}
          </div>
        </>
      )}
    </div>
  );
});

UnifiedPreviewToolbar.displayName = 'UnifiedPreviewToolbar';

export default UnifiedPreviewToolbar;
