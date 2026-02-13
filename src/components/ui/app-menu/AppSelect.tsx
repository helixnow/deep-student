/**
 * AppSelect - 基于 AppMenu 样式的下拉选择框组件
 * 提供 Select 语义，同时保持与 AppMenu 一致的视觉风格
 */

import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuGroup,
  AppMenuSeparator,
} from './AppMenu';

export interface AppSelectOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
  description?: string;
  disabled?: boolean;
}

export interface AppSelectGroup {
  label?: string;
  options: AppSelectOption[];
}

export interface AppSelectProps {
  /** 当前选中值 */
  value?: string;
  /** 值变化回调 */
  onValueChange?: (value: string) => void;
  /** 选项列表（简单模式） */
  options?: AppSelectOption[];
  /** 分组选项（分组模式） */
  groups?: AppSelectGroup[];
  /** 占位文本 */
  placeholder?: string;
  /** 是否禁用 */
  disabled?: boolean;
  /** 触发器类名 */
  className?: string;
  /** 触发器样式变体 */
  variant?: 'default' | 'outline' | 'ghost';
  /** 内容宽度 */
  width?: number;
  /** 对齐方式 */
  align?: 'start' | 'center' | 'end';
  /** 触发器尺寸 */
  size?: 'sm' | 'default' | 'lg';
  /** 触发器前置图标（固定显示，不随选项变化） */
  triggerIcon?: React.ReactNode;
  /** 下拉菜单展开/收起回调 */
  onOpenChange?: (open: boolean) => void;
}

/**
 * AppSelect 组件
 * 
 * @example
 * // 简单用法
 * <AppSelect
 *   value={mode}
 *   onValueChange={setMode}
 *   placeholder="选择模式"
 *   options={[
 *     { value: 'basic', label: '基础筛选' },
 *     { value: 'advanced', label: '高级筛选' },
 *   ]}
 * />
 * 
 * @example
 * // 带图标和描述
 * <AppSelect
 *   value={theme}
 *   onValueChange={setTheme}
 *   options={[
 *     { value: 'light', label: '浅色', icon: <Sun /> },
 *     { value: 'dark', label: '深色', icon: <Moon /> },
 *   ]}
 * />
 * 
 * @example
 * // 分组模式
 * <AppSelect
 *   value={font}
 *   onValueChange={setFont}
 *   groups={[
 *     { label: '系统字体', options: [{ value: 'system', label: '系统默认' }] },
 *     { label: '自定义字体', options: [{ value: 'mono', label: '等宽' }] },
 *   ]}
 * />
 */
export function AppSelect({
  value,
  onValueChange,
  options = [],
  groups,
  placeholder,
  disabled = false,
  className,
  variant = 'outline',
  width = 200,
  align = 'start',
  size = 'default',
  triggerIcon,
  onOpenChange,
}: AppSelectProps) {
  const { t } = useTranslation('app_menu');

  const resolvedPlaceholder = placeholder || t('app_menu.select_app');

  // 获取当前选中项的标签
  const selectedLabel = useMemo(() => {
    // 从 options 中查找
    const fromOptions = options.find((opt) => opt.value === value);
    if (fromOptions) return fromOptions.label;

    // 从 groups 中查找
    if (groups) {
      for (const group of groups) {
        const found = group.options.find((opt) => opt.value === value);
        if (found) return found.label;
      }
    }

    return null;
  }, [value, options, groups]);

  // 获取当前选中项的图标
  const selectedIcon = useMemo(() => {
    const fromOptions = options.find((opt) => opt.value === value);
    if (fromOptions?.icon) return fromOptions.icon;

    if (groups) {
      for (const group of groups) {
        const found = group.options.find((opt) => opt.value === value);
        if (found?.icon) return found.icon;
      }
    }

    return null;
  }, [value, options, groups]);

  const handleSelect = useCallback(
    (optionValue: string) => {
      onValueChange?.(optionValue);
    },
    [onValueChange]
  );

  // 尺寸样式
  const sizeClasses = {
    sm: 'h-7 px-2 text-xs',
    default: 'h-9 px-3 text-sm',
    lg: 'h-11 px-4 text-base',
  };

  // 变体样式
  const variantClasses = {
    default: 'bg-primary text-primary-foreground hover:bg-primary/90',
    outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
    ghost: 'hover:bg-accent hover:text-accent-foreground',
  };

  // 渲染选项
  const renderOption = (option: AppSelectOption) => (
    <AppMenuItem
      key={option.value}
      icon={option.icon}
      disabled={option.disabled}
      checked={value === option.value}
      onClick={() => handleSelect(option.value)}
    >
      <span className="flex-1">{option.label}</span>
      {option.description && (
        <span className="text-xs text-muted-foreground ml-2">{option.description}</span>
      )}
    </AppMenuItem>
  );

  // 检测是否通过 className 自定义了宽度
  const hasCustomWidth = className?.includes('max-w-') || className?.includes('w-') || className?.includes('flex-1');

  return (
    <AppMenu onOpenChange={onOpenChange}>
      <AppMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-label={t('app_menu.select_app')}
          className={cn(
            'inline-flex items-center justify-between gap-2 rounded-md font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:pointer-events-none disabled:opacity-50',
            sizeClasses[size],
            variantClasses[variant],
            className
          )}
          style={hasCustomWidth ? undefined : { minWidth: width }}
        >
          <span className="flex items-center gap-2 truncate">
            {/* 优先显示 triggerIcon，否则显示选中项的图标 */}
            {(triggerIcon || selectedIcon) && (
              <span className="shrink-0">{triggerIcon || selectedIcon}</span>
            )}
            <span className={cn('truncate', !selectedLabel && 'text-muted-foreground')}>
              {selectedLabel || resolvedPlaceholder}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </AppMenuTrigger>

      <AppMenuContent align={align} width={width} maxHeight={360}>
        {/* 分组模式 */}
        {groups ? (
          groups.map((group, groupIndex) => (
            <React.Fragment key={group.label || groupIndex}>
              {groupIndex > 0 && <AppMenuSeparator />}
              <AppMenuGroup label={group.label}>
                {group.options.map(renderOption)}
              </AppMenuGroup>
            </React.Fragment>
          ))
        ) : (
          /* 简单模式 */
          options.map(renderOption)
        )}
      </AppMenuContent>
    </AppMenu>
  );
}

export default AppSelect;
