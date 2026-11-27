/**
 * 结构选择器组件
 *
 * 布局结构选择器
 * 支持思维导图、逻辑图、组织结构图三种分类
 */

import React, { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/config/zIndex';
import { DsButton } from '@/components/ui/DsButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { UiPresence } from '@/components/ui/UiPresence';
import {
  BACK_PRIORITY,
  registerBackHandler,
} from '@/app/navigation/androidBackCoordinator';
import { useMindMapStore } from '../../store';
import { useMindMapIsActive } from '../../MindMapActiveContext';
import { PresetRegistry } from '../../registry';
import { ensureInitialized } from '../../init';
import type { PresetCategory, IPreset } from '../../registry/types';
import { PresetIcon } from './PresetIcons';
import {
  SquaresFour,
  GitBranch,
  Users,
  CaretDown,
  Check,
  Lock,
} from '@phosphor-icons/react';

// ============================================================================
// 类型定义
// ============================================================================

interface CategoryConfig {
  id: PresetCategory;
  name: string;
  icon: React.ReactNode;
}

interface PresetItemProps {
  preset: IPreset;
  isActive: boolean;
  onClick: () => void;
}

interface StructureSelectorProps {
  className?: string;
  /** 触发按钮的自定义渲染 */
  trigger?: React.ReactNode;
  /** 面板弹出位置，'inline' 表示直接内联显示面板内容 */
  placement?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right' | 'inline';
  /** 选择预设后的回调 */
  onSelect?: () => void;
  /** 受控模式：面板开关状态 */
  open?: boolean;
  /** 受控模式：面板开关状态变化回调 */
  onOpenChange?: (open: boolean) => void;
}

// ============================================================================
// 分类图标配置（名称由 i18n 动态提供）
// ============================================================================

const categoryIcons: Record<PresetCategory, React.ReactNode> = {
  mindmap: <SquaresFour className="w-4 h-4" />,
  logic: <GitBranch className="w-4 h-4" />,
  orgchart: <Users className="w-4 h-4" />,
  custom: <SquaresFour className="w-4 h-4" />,
};

const categoryIds: PresetCategory[] = ['mindmap', 'logic', 'orgchart'];

// ============================================================================
// 预设项组件
// ============================================================================

const PresetItem: React.FC<PresetItemProps> = ({ preset, isActive, onClick }) => {
  const { t } = useTranslation('mindmap');
  const resolvedName = t(preset.name);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex w-full">
          <DsButton variant="ghost"
            className={cn(
              'mm-structure-preset',
              'flex items-center justify-center',
              isActive
                ? 'is-active'
                : '',
              preset.locked && 'opacity-60 cursor-not-allowed'
            )}
            onClick={onClick}
            disabled={preset.locked}
            aria-pressed={isActive}
            aria-label={resolvedName}
          >
            {/* 预设图标 */}
            <PresetIcon
              category={preset.category}
              direction={preset.layoutDirection}
              className={cn(
                'transition-colors motion-reduce:transition-none',
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground'
              )}
            />

            {/* 选中标记 */}
            {isActive && (
              <div className="mm-structure-check">
                <Check className="w-3 h-3" strokeWidth={2.5} />
              </div>
            )}

            {/* 锁定标记 */}
            {preset.locked && (
              <div className="absolute -top-1 -right-1 w-4 h-4 bg-muted-foreground rounded-full flex items-center justify-center">
                <Lock className="w-2.5 h-2.5 text-muted" />
              </div>
            )}
          </DsButton>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{resolvedName}</TooltipContent>
    </Tooltip>
  );
};

// ============================================================================
// 分类区块组件
// ============================================================================

const CategorySection: React.FC<{
  category: CategoryConfig;
  presets: IPreset[];
  activePreset: IPreset | null;
  onPresetSelect: (preset: IPreset) => void;
}> = ({ category, presets, activePreset, onPresetSelect }) => {
  if (presets.length === 0) return null;

  return (
    <div className="mm-structure-section">
      {/* 分类标题 */}
      <div className="mm-panel-section-label">
        <span className="text-muted-foreground">{category.icon}</span>
        <h4>
          {category.name}
        </h4>
      </div>

      {/* 预设网格 */}
      <div className="mm-structure-grid">
        {presets.map((preset) => (
          <PresetItem
            key={preset.id}
            preset={preset}
            isActive={activePreset?.id === preset.id}
            onClick={() => onPresetSelect(preset)}
          />
        ))}
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const StructureSelector: React.FC<StructureSelectorProps> = ({
  className,
  trigger,
  placement = 'bottom-right',
  onSelect,
  open: controlledOpen,
  onOpenChange,
}) => {
  const { t } = useTranslation('mindmap');
  const isMindMapActive = useMindMapIsActive();
  const [internalOpen, setInternalOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  // Portal fixed 锚点定位（防止 <= 520px 工具栏横向滚动容器裁切弹出面板）
  const [popoverPos, setPopoverPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);

  // 受控/非受控模式
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;
  const setIsOpen = useCallback((next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  }, [isControlled, onOpenChange]);

  // inline 模式下始终显示面板
  const isInline = placement === 'inline';

  // 构建分类配置（使用 i18n）
  const categories: CategoryConfig[] = useMemo(() => 
    categoryIds.map((id) => ({
      id,
      name: t(`structure.${id}`),
      icon: categoryIcons[id],
    })),
    [t]
  );

  // 确保模块已初始化
  useEffect(() => {
    ensureInitialized();
  }, []);

  // 从 store 获取状态
  const layoutId = useMindMapStore((s) => s.layoutId);
  const layoutDirection = useMindMapStore((s) => s.layoutDirection);
  const applyPreset = useMindMapStore((s) => s.applyPreset);

  // 获取所有预设（在组件挂载时获取，确保初始化已完成）
  const allPresets = useMemo(() => {
    ensureInitialized();
    return PresetRegistry.getAll();
  }, []);

  // 获取所有分类的预设
  const getPresetsForCategory = useCallback((categoryId: PresetCategory): IPreset[] => {
    return allPresets.filter((p) => p.category === categoryId);
  }, [allPresets]);

  // 查找当前激活的预设
  const findActivePreset = useCallback((): IPreset | null => {
    return (
      allPresets.find(
        (p) => p.layoutId === layoutId && p.layoutDirection === layoutDirection
      ) || null
    );
  }, [allPresets, layoutId, layoutDirection]);

  const activePreset = findActivePreset();

  // 处理预设选择
  const handlePresetSelect = useCallback(
    (preset: IPreset) => {
      if (!preset.locked) {
        applyPreset(preset.id);
        if (!isInline) {
          setIsOpen(false);
        }
        onSelect?.();
      }
    },
    [applyPreset, isInline, onSelect, setIsOpen]
  );

  // 处理点击外部关闭
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, setIsOpen]);

  // 处理键盘事件（capture 阶段优先消费 Escape，避免透传触发外层演示/背诵退出）
  useEffect(() => {
    if (!isOpen || isInline) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      setIsOpen(false);
      triggerRef.current?.querySelector<HTMLElement>('button')?.focus();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isInline, isOpen, setIsOpen]);

  useEffect(() => {
    if (!isOpen || isInline || !isMindMapActive) return;
    return registerBackHandler(() => {
      setIsOpen(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isInline, isMindMapActive, isOpen, setIsOpen]);

  // Portal fixed 锚点定位与视口钳位：resize 与祖先滚动时实时重算，杜绝窄屏工具栏裁切
  useLayoutEffect(() => {
    if (!isOpen || isInline) return;
    const measure = () => {
      const triggerEl = triggerRef.current;
      if (!triggerEl) return;
      const rect = triggerEl.getBoundingClientRect();
      const margin = 8;
      const gap = 8;
      const panelWidth = panelRef.current?.offsetWidth || 296;
      const panelHeight = panelRef.current?.offsetHeight || 0;
      const isLeftAligned = placement === 'bottom-left' || placement === 'top-left';
      const isTopAligned = placement === 'top-left' || placement === 'top-right';

      const rawLeft = isLeftAligned ? rect.left : rect.right - panelWidth;
      const maxLeft = Math.max(margin, window.innerWidth - margin - panelWidth);
      const left = Math.min(Math.max(rawLeft, margin), maxLeft);

      let top: number;
      let maxHeight: number;
      if (isTopAligned) {
        maxHeight = Math.max(160, Math.min(680, Math.floor(rect.top - gap - margin)));
        const effectiveHeight = panelHeight > 0 ? Math.min(panelHeight, maxHeight) : maxHeight;
        top = Math.max(margin, rect.top - gap - effectiveHeight);
      } else {
        const rawTop = rect.bottom + gap;
        maxHeight = Math.max(160, Math.min(680, Math.floor(window.innerHeight - rawTop - margin)));
        top = Math.min(Math.max(margin, rawTop), Math.max(margin, window.innerHeight - margin - 160));
      }

      setPopoverPos((prev) =>
        prev && prev.left === left && prev.top === top && prev.maxHeight === maxHeight
          ? prev
          : { left, top, maxHeight },
      );
    };

    const handleScroll = (event: Event) => {
      if (panelRef.current && event.target instanceof Node && panelRef.current.contains(event.target)) {
        return;
      }
      measure();
    };

    measure();
    const frameId = requestAnimationFrame(measure);
    window.addEventListener('resize', measure, { passive: true });
    window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen, isInline, placement]);

  // 面板内容（共用）
  const panelContent = (
    <>
      {/* 标题栏 - inline 模式下隐藏 */}
      {!isInline && (
        <div className="mm-panel-heading">
          <h3>
            {t('selectStructure')}
          </h3>
          {activePreset && (
            <span className="mm-panel-current">
              {t(activePreset.name)}
            </span>
          )}
        </div>
      )}

      {/* 当前选中 - inline 模式显示 */}
      {isInline && activePreset && (
        <div className="mb-3 text-xs text-[var(--mm-text-secondary)]">
          {t('structure.current')} <span className="text-[var(--mm-primary)] font-medium">{t(activePreset.name)}</span>
        </div>
      )}

      {/* 分类列表 */}
      <div>
        {categories.map((category) => (
          <CategorySection
            key={category.id}
            category={category}
            presets={getPresetsForCategory(category.id)}
            activePreset={activePreset}
            onPresetSelect={handlePresetSelect}
          />
        ))}
      </div>

      {/* 底部「选择不同结构可改变导图的布局方式」只是复述标题，已去掉 */}
    </>
  );

  // inline 模式：直接渲染面板内容
  if (isInline) {
    return (
      <div className={cn('p-2', className)}>
        {panelContent}
      </div>
    );
  }

  return (
    <div ref={triggerRef} className={cn('relative', className)}>
      {/* 触发按钮 */}
      {trigger ? (
        <div onClick={() => setIsOpen(!isOpen)}>{trigger}</div>
      ) : (
        <DsButton variant="ghost"
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            'flex items-center gap-2 px-2 h-7 rounded',
            // 触控目标：视觉保持 28px（工具栏空间受限），触屏用透明伪元素把命中区扩到 ≥44px（28 + 2×8）
            "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2 [@media(pointer:coarse)]:after:content-['']",
            'bg-transparent border border-transparent',
            'hover:bg-[var(--mm-bg-hover)]',
            'transition-colors duration-100 motion-reduce:transition-none',
            'text-sm text-[var(--mm-text-secondary)]',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--mm-primary)]',
            isOpen && 'bg-[var(--mm-bg-hover)] text-[var(--mm-text)]'
          )}
          aria-expanded={isOpen}
          aria-haspopup="true"
        >
          <SquaresFour className="w-4 h-4 text-[var(--mm-text-muted)]" />
          <span>{t('toolbar.structure')}</span>
          <CaretDown
            className={cn(
              'w-4 h-4 text-[var(--mm-text-muted)] transition-transform duration-150 motion-reduce:transition-none',
              isOpen && 'rotate-180'
            )}
          />
        </DsButton>
      )}

      {/* 弹出面板（Portal + fixed 锚点定位，彻底免受 <= 520px 工具栏 overflow-x 裁切） */}
      {typeof document !== 'undefined' &&
        createPortal(
          <UiPresence
            open={isOpen}
            inClass="ui-zoom-fade-in"
            outClass="ui-zoom-fade-out"
            exitMs={150}
            className="mindmap-container fixed mm-settings-popover mm-structure-popover"
            style={{
              zIndex: Z_INDEX.popover,
              left: popoverPos?.left ?? 0,
              top: popoverPos?.top ?? 0,
              maxHeight: popoverPos ? `min(680px, ${popoverPos.maxHeight}px)` : undefined,
              visibility: popoverPos ? 'visible' : 'hidden',
            }}
            data-testid="mm-structure-popover"
          >
            <CustomScrollArea
              ref={panelRef}
              className="h-full w-full"
              viewportClassName="mm-settings-popover-viewport p-2"
              role="dialog"
              aria-label={t('structure.selectorLabel')}
              fullHeight={false}
            >
              {panelContent}
            </CustomScrollArea>
          </UiPresence>,
          document.body,
        )}
    </div>
  );
};

export default StructureSelector;
