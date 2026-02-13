/**
 * 结构选择器组件
 *
 * 布局结构选择器
 * 支持思维导图、逻辑图、组织结构图三种分类
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { useMindMapStore } from '../../store';
import { PresetRegistry } from '../../registry';
import { ensureInitialized } from '../../init';
import type { PresetCategory, IPreset } from '../../registry/types';
import { PresetIcon } from './PresetIcons';
import {
  LayoutGrid,
  GitBranch,
  Users,
  ChevronDown,
  Check,
  Lock,
} from 'lucide-react';

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
  mindmap: <LayoutGrid className="w-4 h-4" />,
  logic: <GitBranch className="w-4 h-4" />,
  orgchart: <Users className="w-4 h-4" />,
  custom: <LayoutGrid className="w-4 h-4" />,
};

const categoryIds: PresetCategory[] = ['mindmap', 'logic', 'orgchart'];

// ============================================================================
// 预设项组件
// ============================================================================

const PresetItem: React.FC<PresetItemProps> = ({ preset, isActive, onClick }) => {
  const { t } = useTranslation('mindmap');
  const resolvedName = t(preset.name);
  return (
    <NotionButton variant="ghost"
      className={cn(
        'relative w-16 h-12 rounded-lg border-2 transition-all duration-200',
        'flex items-center justify-center',
        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
        isActive
          ? 'border-primary bg-primary/10 shadow-sm'
          : 'border-border hover:border-primary/50',
        !isActive && 'hover:bg-accent',
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
        <div className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-primary rounded-full flex items-center justify-center shadow-sm">
          <Check className="w-3 h-3 text-primary-foreground" strokeWidth={3} />
        </div>
      )}

      {/* 锁定标记 */}
      {preset.locked && (
        <div className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-muted-foreground rounded-full flex items-center justify-center shadow-sm">
          <Lock className="w-2.5 h-2.5 text-muted" />
        </div>
      )}
    </NotionButton>
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
    <div className="mb-4 last:mb-0">
      {/* 分类标题 */}
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-muted-foreground">{category.icon}</span>
        <h4 className="text-sm font-medium text-muted-foreground">
          {category.name}
        </h4>
      </div>

      {/* 预设网格 */}
      <div className="grid grid-cols-4 gap-2">
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
  const [internalOpen, setInternalOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  
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
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, setIsOpen]);

  // 处理键盘事件
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

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
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-foreground">
            {t('selectStructure')}
          </h3>
          {activePreset && (
            <span className="text-xs text-primary bg-primary/10 px-2 py-0.5 rounded-full">
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
      <div className="space-y-1">
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
      <div className="mt-4 pt-3 border-t border-border">
        <p className="text-xs text-muted-foreground text-center">
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
    <div className={cn('relative', className)}>
      {/* 触发按钮 */}
      {trigger ? (
        <div onClick={() => setIsOpen(!isOpen)}>{trigger}</div>
      ) : (
        <NotionButton variant="ghost"
          ref={triggerRef}
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-lg',
            'bg-white dark:bg-gray-800',
            'border border-gray-200 dark:border-gray-700',
            'hover:bg-gray-50 dark:hover:bg-gray-750',
            'hover:border-gray-300 dark:hover:border-gray-600',
            'transition-all duration-200',
            'text-sm font-medium text-gray-700 dark:text-gray-200',
            'focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-1',
            isOpen && 'bg-gray-50 dark:bg-gray-750 border-gray-300 dark:border-gray-600'
          )}
          aria-expanded={isOpen}
          aria-haspopup="true"
        >
          <LayoutGrid className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          <span>{t('toolbar.structure')}</span>
          <ChevronDown
            className={cn(
              'w-4 h-4 text-gray-400 transition-transform duration-200',
              isOpen && 'rotate-180'
            )}
          />
        </NotionButton>
      )}

      {/* 弹出面板 */}
      {isOpen && (
        <>
          {/* 背景遮罩（移动端） */}
          <div
            className="fixed inset-0 z-40 bg-black/10 dark:bg-black/20 md:hidden"
            onClick={() => setIsOpen(false)}
          />

          {/* 面板内容 */}
          <div
            ref={panelRef}
            className={cn(
              'absolute z-50',
              getPlacementStyles(),
              'w-[320px] p-4 rounded-xl shadow-lg',
              'bg-popover border border-border text-popover-foreground',
              'animate-in fade-in-0 zoom-in-95 duration-200',
              // 移动端全宽
              'max-md:fixed max-md:left-4 max-md:right-4 max-md:top-auto max-md:bottom-4 max-md:w-auto'
            )}
            role="dialog"
            aria-label={t('structure.selectorLabel')}
          >
            {panelContent}
          </div>
        </>
      )}
    </div>
  );
};

export default StructureSelector;
