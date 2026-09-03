/**
 * 结构选择器组件
 *
 * 布局结构选择器
 * 支持思维导图、逻辑图、组织结构图三种分类
 */

import React, { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
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
  const isMindMapActive = useMindMapIsActive();
  const resolvedName = t(preset.name);
  return (
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
      title={resolvedName}
      aria-pressed={isActive}
      aria-label={resolvedName}
    >
      {/* 预设图标 */}
      <PresetIcon
        category={preset.category}
        direction={preset.layoutDirection}
        className={cn(
          'transition-colors',
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
  // 视口钳位：面板锚定触发按钮时的水平修正量（px）
  const [clampOffset, setClampOffset] = useState(0);
  const clampOffsetRef = useRef(0);

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

  // 处理键盘事件（仅面板打开时挂监听，避免常驻全局 keydown）
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsOpen(false);
      triggerRef.current?.querySelector<HTMLElement>('button')?.focus();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, setIsOpen]);

  useEffect(() => {
    if (!isOpen || isInline || !isMindMapActive) return;
    return registerBackHandler(() => {
      setIsOpen(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isInline, isMindMapActive, isOpen, setIsOpen]);

  // 视口钳位：锚定面板贴近窗口边缘时向内平移，防止右缘/左缘被裁切
  // 用独立的 translate 属性修正，避免与 ui-zoom-fade-in 的 transform 动画互相覆盖
  useLayoutEffect(() => {
    if (!isOpen || isInline) {
      clampOffsetRef.current = 0;
      setClampOffset(0);
      return;
    }
    const measure = () => {
      const el = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const margin = 8;
      // 先扣掉上一次修正量，还原面板的自然锚定位置再重新计算
      const naturalLeft = rect.left - clampOffsetRef.current;
      const naturalRight = rect.right - clampOffsetRef.current;
      let next = 0;
      if (naturalRight > window.innerWidth - margin) {
        next = window.innerWidth - margin - naturalRight;
      }
      if (naturalLeft + next < margin) {
        next = margin - naturalLeft;
      }
      if (next !== clampOffsetRef.current) {
        clampOffsetRef.current = next;
        setClampOffset(next);
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [isOpen, isInline]);

  // 计算面板位置样式
  const getPlacementStyles = () => {
    switch (placement) {
      case 'bottom-left':
        return 'top-full left-0 mt-2';
      case 'top-left':
        return 'bottom-full left-0 mb-2';
      case 'top-right':
        return 'bottom-full right-0 mb-2';
      case 'inline':
        return ''; // inline 模式不需要定位
      case 'bottom-right':
      default:
        return 'top-full right-0 mt-2';
    }
  };

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

      {/* 底部提示 */}
      <div className="mm-panel-hint">
        <p>
          {t('structure.hint')}
        </p>
      </div>
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
            'transition-colors duration-100',
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
              'w-4 h-4 text-[var(--mm-text-muted)] transition-transform duration-150',
              isOpen && 'rotate-180'
            )}
          />
        </DsButton>
      )}

      {/* 弹出面板（桌面锚定 popover；窄屏由外壳的 inline 子屏承载，不再走底部 sheet + 遮罩） */}
      <UiPresence
        open={isOpen}
        inClass="ui-zoom-fade-in"
        outClass="ui-zoom-fade-out"
        exitMs={150}
        className={cn(
          'absolute z-50',
          getPlacementStyles(),
          'mm-settings-popover mm-structure-popover',
        )}
        style={clampOffset !== 0 ? { translate: `${clampOffset}px 0` } : undefined}
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
      </UiPresence>
    </div>
  );
};

export default StructureSelector;
