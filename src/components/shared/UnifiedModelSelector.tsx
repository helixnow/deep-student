/**
 * 通用模型选择器组件
 *
 * 复用 Chat V2 的模型选择器 UI，支持多种使用场景：
 * - compact: 紧凑按钮样式，适用于工具栏（作文批改、翻译等）
 * - full: 全宽选择器样式，适用于设置页面的模型分配
 */

import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CaretDown, MagnifyingGlass, Prohibit, Star, Cube } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { ModelCapabilityIcons } from '@/components/shared/ModelCapabilityIcons';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/shad/Popover';
import { sortUnifiedModelInfosForSelector } from '@/utils/modelSorting';

// ============================================================================
// 类型
// ============================================================================

export interface UnifiedModelInfo {
  id: string;
  name: string;
  model?: string;
  vendorId?: string;
  vendorName?: string;
  providerType?: string;
  vendorSortOrder?: number;
  is_default?: boolean;
  isMultimodal?: boolean;
  isReasoning?: boolean;
  supportsTools?: boolean;
  isImageGeneration?: boolean;
  /** 模型是否已禁用（仍在列表中但不可选择，用于显示已分配但被禁用的模型） */
  isDisabled?: boolean;
  disabledLabel?: string;
  disabledReason?: string;
  disabledTone?: 'warning' | 'destructive';
  /** 是否收藏（收藏的模型在列表中优先显示） */
  isFavorite?: boolean;
}

interface UnifiedModelSelectorProps {
  /** 模型列表 */
  models: UnifiedModelInfo[];
  /** 当前选中的模型 ID（空字符串表示未选择） */
  value: string;
  /** 选中模型回调 */
  onChange: (modelId: string) => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 触发器类名 */
  className?: string;
  /** 触发器图标（仅 compact 模式有效） */
  triggerIcon?: React.ReactNode;
  /** 占位符文本 */
  placeholder?: string;
  /**
   * 显示变体
   * - compact: 紧凑按钮样式（默认），适用于工具栏
   * - full: 全宽选择器样式，适用于设置页面
   */
  variant?: 'compact' | 'full';
  /** 是否允许空选择（显示"无"选项） */
  allowEmpty?: boolean;
  /** 空选项的标签文本 */
  emptyLabel?: string;
  /** 是否显示搜索框（默认 true） */
  showSearch?: boolean;
  /** 弹出框对齐方式 */
  align?: 'start' | 'center' | 'end';
  /** 弹出框展开方向（默认 bottom） */
  side?: 'top' | 'bottom';
  /** 弹出框宽度类名 */
  popoverClassName?: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 提取供应商名称 */
function extractProviderName(name: string): string {
  // 格式: "SiliconFlow - deepseek-ai/DeepSeek-V3.2-Exp" -> "SiliconFlow"
  const dashIndex = name.indexOf(' - ');
  if (dashIndex > 0) {
    return name.substring(0, dashIndex);
  }
  // 格式: "provider/model" -> "provider"
  const slashIndex = name.indexOf('/');
  if (slashIndex > 0) {
    return name.substring(0, slashIndex);
  }
  return name;
}

/** 提取模型名称（去除供应商前缀） */
function extractModelName(name: string, model?: string): string {
  if (model) return model;
  // 格式: "SiliconFlow - deepseek-ai/DeepSeek-V3.2-Exp" -> "deepseek-ai/DeepSeek-V3.2-Exp"
  const dashIndex = name.indexOf(' - ');
  if (dashIndex > 0) {
    return name.substring(dashIndex + 3);
  }
  return name;
}

// ============================================================================
// 内部常量
// ============================================================================

const EMPTY_VALUE = '__none__';

const sanitizeGroupTestId = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';

// ============================================================================
// 组件
// ============================================================================

export const UnifiedModelSelector: React.FC<UnifiedModelSelectorProps> = ({
  models,
  value,
  onChange,
  disabled = false,
  className,
  triggerIcon,
  placeholder,
  variant = 'compact',
  allowEmpty = false,
  emptyLabel,
  showSearch = true,
  align = 'start',
  side = 'bottom',
  popoverClassName,
}) => {
  const { t } = useTranslation(['chat_host', 'common', 'settings']);
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // 当前选中的模型
  const selectedModel = useMemo(
    () => models.find((m) => m.id === value),
    [models, value]
  );

  // 是否选择了"无"
  const isEmptySelected = !value || value === EMPTY_VALUE;

  // 搜索过滤
  const normalizedModels = useMemo(
    () =>
      models.map((m, sourceIndex) => ({
        ...m,
        searchable: `${m.name ?? ''} ${m.model ?? ''} ${m.vendorName ?? ''} ${m.providerType ?? ''}`.toLowerCase(),
        providerName: m.vendorName ?? extractProviderName(m.name),
        modelName: extractModelName(m.name, m.model),
        sourceIndex,
      })),
    [models]
  );

  const filteredModels = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    const result = keyword
      ? normalizedModels.filter((m) => m.searchable.includes(keyword))
      : normalizedModels;
    return sortUnifiedModelInfosForSelector(result);
  }, [normalizedModels, searchTerm]);

  type NormalizedModelOption = (typeof normalizedModels)[number];
  const groupedFilteredModels = useMemo(() => {
    const groups: Array<{ key: string; name: string; models: NormalizedModelOption[] }> = [];
    const groupMap = new Map<string, NormalizedModelOption[]>();

    for (const model of filteredModels) {
      const groupKey =
        model.vendorId ||
        model.vendorName ||
        model.providerName ||
        model.providerType ||
        '__unknown__';
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, []);
        groups.push({
          key: groupKey,
          name: model.vendorName || model.providerName || model.providerType || t('chat_host:model_panel.unknown_vendor', 'Unknown vendor'),
          models: groupMap.get(groupKey)!,
        });
      }
      groupMap.get(groupKey)!.push(model);
    }

    return groups;
  }, [filteredModels, t]);

  // 选中模型
  const handleSelectModel = useCallback(
    (modelId: string) => {
      if (disabled) return;
      // 如果选择的是空值，传回空字符串
      onChange(modelId === EMPTY_VALUE ? '' : modelId);
      setOpen(false);
      setSearchTerm('');
    },
    [disabled, onChange]
  );

  const hasModels = filteredModels.length > 0 || allowEmpty;
  const defaultEmptyLabel = emptyLabel || t('settings:select_options.none', '无');

  // 渲染空选项
  const renderEmptyOption = () => {
    if (!allowEmpty) return null;

    return (
      <NotionButton variant="ghost" size="sm" onClick={() => handleSelectModel(EMPTY_VALUE)} disabled={disabled} className={cn('!w-full !justify-between !px-2 !py-1.5 !h-auto !text-left group', isEmptySelected ? 'bg-primary/5 text-primary' : 'text-foreground hover:bg-[var(--interactive-hover)]', disabled && 'opacity-60 cursor-not-allowed')}>
        <div className="flex items-center gap-2">
           <div className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground group-hover:text-foreground">
             <Prohibit size={14} />
           </div>
           <span className="text-sm">{defaultEmptyLabel}</span>
        </div>
        {isEmptySelected && <Check size={14} className="text-primary" />}
      </NotionButton>
    );
  };

  // 渲染模型选项
  const renderModelOption = (option: typeof normalizedModels[0]) => {
    const isSelected = option.id === value;
    const isOptionDisabled = option.isDisabled || disabled;
    const disabledToneClass = option.disabledTone === 'warning'
      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : 'bg-destructive/10 text-destructive';
    const disabledReasonClass = option.disabledTone === 'warning'
      ? 'text-amber-700/80 dark:text-amber-300/80'
      : 'text-destructive/80';

    return (
      <NotionButton variant="ghost" size="sm" key={option.id} onClick={() => !option.isDisabled && handleSelectModel(option.id)} disabled={isOptionDisabled} className={cn('!w-full !justify-between !px-2 !py-1.5 !h-auto !text-left group', isSelected ? 'bg-primary/5' : 'hover:bg-[var(--interactive-hover)]', isOptionDisabled && 'opacity-50 cursor-not-allowed')}>
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {/* 供应商图标 */}
          <div className="flex-shrink-0">
             <ProviderIcon
              modelId={option.model || option.name}
              size={16}
              showTooltip={false}
              className="opacity-80 group-hover:opacity-100 transition-opacity"
/>
          </div>
          
          <div className="flex flex-col min-w-0 flex-1">
             {/* 第一行：模型名称 + 收藏/禁用状态 */}
             <div className="flex items-center gap-1.5">
               <span className={cn(
                 "text-sm font-medium truncate",
                 isSelected ? "text-primary" : "text-foreground"
               )}>
                 {option.modelName}
               </span>
               {option.isFavorite && <Star size={12} className="text-amber-500 fill-amber-500 flex-shrink-0" />}
               {option.isDisabled && (
                 <span className={cn('text-[10px] px-1 rounded flex-shrink-0', disabledToneClass)}>
                   {option.disabledLabel || t('common:disabled', 'Disabled')}
                 </span>
               )}
             </div>
             
             {/* 第二行：供应商 + 标签 */}
             <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
               <span className="truncate max-w-[80px]">{option.providerName}</span>
               
               {/* 能力图标：保留 tooltip/aria-label，避免长文字挤占模型名。 */}
               {(option.isMultimodal || option.isReasoning || option.supportsTools || option.isImageGeneration) && (
                 <>
                   <span className="w-0.5 h-0.5 rounded-full bg-muted-foreground/40" />
                   <ModelCapabilityIcons
                     isMultimodal={option.isMultimodal}
                     isReasoning={option.isReasoning}
                     supportsTools={option.supportsTools}
                     isImageGeneration={option.isImageGeneration}
                     size="xs"
                     className="gap-1"
/>
                 </>
               )}
               
               {option.is_default && (
                  <>
                    <span className="w-0.5 h-0.5 rounded-full bg-muted-foreground/40" />
                   <span className="text-green-600/80 dark:text-green-400/80">{t('common:default', 'Default')}</span>
                  </>
               )}
             </div>
             {option.isDisabled && option.disabledReason && (
               <div className={cn('mt-1 text-[10px] leading-4', disabledReasonClass)}>
                 {option.disabledReason}
               </div>
             )}
          </div>
        </div>

        {isSelected && <Check size={14} className="text-primary flex-shrink-0 ml-2" />}
      </NotionButton>
    );
  };

  // 触发器显示文本
  const triggerDisplayText = useMemo(() => {
    if (isEmptySelected) {
      if (allowEmpty) return defaultEmptyLabel;
      return placeholder || t('chat_host:model_panel.select', '选择模型');
    }
    if (!selectedModel) return placeholder || t('chat_host:model_panel.select', '选择模型');

    // full 模式显示更详细的信息
    if (variant === 'full') {
      const modelName = extractModelName(selectedModel.name, selectedModel.model);
      const providerName = selectedModel.vendorName ?? extractProviderName(selectedModel.name);
      return (
        <span className="flex items-center gap-2">
           <ProviderIcon modelId={selectedModel.model || selectedModel.name} size={14} className="opacity-70" showTooltip={false} />
           <span className="font-medium text-foreground">{modelName}</span>
           <span className="text-muted-foreground text-xs opacity-60">· {providerName}</span>
        </span>
      );
    }

    return extractModelName(selectedModel.name, selectedModel.model);
  }, [selectedModel, placeholder, t, isEmptySelected, allowEmpty, defaultEmptyLabel, variant]);

  // 渲染触发器
  const renderTrigger = () => {
    if (variant === 'full') {
      // 全宽选择器样式（类似 SelectTrigger）
      return (
        <NotionButton variant="default" size="sm" disabled={disabled} className={cn('!h-9 !w-full !justify-between !px-3 !py-2 border border-input bg-transparent text-sm shadow-sm hover:bg-[var(--interactive-hover)] disabled:cursor-not-allowed disabled:opacity-50', className)}>
          <span className="flex-1 min-w-0 pr-2 text-left text-sm truncate">
            {isEmptySelected && !allowEmpty ? (
              <span className="text-muted-foreground">{triggerDisplayText}</span>
            ) : (
              triggerDisplayText
            )}
          </span>
          <CaretDown size={14} className="shrink-0 opacity-40" />
        </NotionButton>
      );
    }

    // 紧凑按钮样式（默认）
    return (
      <NotionButton
        variant="ghost"
        size="sm"
        disabled={disabled}
        className={cn(
          'h-8 px-2 gap-1.5 font-medium text-muted-foreground justify-start',
          className
        )}
      >
        {triggerIcon}
        <span className="truncate max-w-[200px]">{triggerDisplayText}</span>
        <CaretDown size={14} className="shrink-0 opacity-50" />
      </NotionButton>
    );
  };

  const popoverWidthClass = variant === 'full'
    ? 'w-[var(--radix-popover-trigger-width)] min-w-[200px] max-w-[min(400px,calc(100vw-48px))]'
    : 'w-[calc(100vw-24px)] sm:w-[320px] max-w-[360px]';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {renderTrigger()}
      </PopoverTrigger>
      <PopoverContent
        className={cn('p-1.5 overflow-hidden', popoverWidthClass, popoverClassName)}
        align={align}
        side={side}
        collisionPadding={16}
        sideOffset={4}
      >
        {/* 搜索框 */}
        {showSearch && (
          <div className="relative mb-1.5 px-0.5 pt-0.5">
            <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={t('chat_host:model_panel.search_placeholder', '搜索...')}
              className="h-7 text-xs pl-8 border-transparent bg-muted/30 focus-visible:bg-transparent focus-visible:border-primary/20"
              disabled={disabled}
/>
          </div>
        )}

        {/* 模型列表 */}
        <div className={showSearch ? 'h-[240px]' : 'h-[280px]'}>
          <CustomScrollArea
            className="h-full"
            viewportClassName="space-y-0.5"
            trackOffsetTop={2}
            trackOffsetBottom={2}
          >
             {/* 空选项 */}
             {allowEmpty && !searchTerm && renderEmptyOption()}

             {/* 模型选项 */}
             {hasModels ? (
               groupedFilteredModels.map((group) => (
                 <div
                   key={group.key}
                   data-testid={`model-selector-vendor-group-${sanitizeGroupTestId(group.key)}`}
                   className="space-y-0.5 border-t border-border/30 pt-1.5 first:border-t-0 first:pt-0"
                 >
                   <div
                     data-testid="model-selector-vendor-group-header"
                     className="sticky top-0 z-[1] mx-0.5 mb-1 flex items-center justify-between rounded-md bg-popover/95 px-2 py-1 text-[10px] font-semibold text-muted-foreground shadow-[0_1px_0_hsl(var(--border)/0.35)] backdrop-blur-sm"
                   >
                     <span className="min-w-0 truncate">{group.name}</span>
                     <span className="ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                       {group.models.length}
                     </span>
                   </div>
                   <div className="space-y-0.5 pl-1">
                     {group.models.map(renderModelOption)}
                   </div>
                 </div>
               ))
             ) : (
               <div className="px-2 py-8 text-xs text-muted-foreground text-center flex flex-col items-center gap-2">
                 <Cube size={32} className="text-muted-foreground/20" />
                 {searchTerm
                   ? t('chat_host:model_panel.no_matches', '无匹配结果')
                   : t('chat_host:model_panel.empty', '暂无可用模型')}
               </div>
             )}
          </CustomScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default UnifiedModelSelector;
