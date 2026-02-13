/**
 * Chat V2 - ModelMentionPopover 模型 @mention 自动完成弹窗
 *
 * 在输入框上方显示模型候选列表，支持：
 * 1. 模糊搜索过滤
 * 2. 键盘导航（↑↓ 选择，Enter 确认，Esc 取消）
 * 3. 鼠标点击选择
 * 4. 暗色/亮色模式
 * 5. i18n 国际化
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/config/zIndex';
import type { ModelInfo } from '../../utils/parseModelMentions';

// ============================================================================
// 类型定义
// ============================================================================

export interface ModelMentionPopoverProps {
  /** 是否显示弹窗 */
  open: boolean;
  /** 模型建议列表 */
  suggestions: ModelInfo[];
  /** 当前选中的索引 */
  selectedIndex: number;
  /** 当前搜索查询（@后的文本） */
  query: string;
  /** 选择模型回调 */
  onSelect: (model: ModelInfo) => void;
  /** 设置选中索引 */
  onSelectedIndexChange: (index: number) => void;
  /** 关闭弹窗回调 */
  onClose: () => void;
  /** 锚点元素 ref（用于定位） */
  anchorRef?: React.RefObject<HTMLElement>;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * ModelMentionPopover - 模型 @mention 自动完成弹窗
 */
export const ModelMentionPopover: React.FC<ModelMentionPopoverProps> = ({
  open,
  suggestions,
  selectedIndex,
  query,
  onSelect,
  onSelectedIndexChange,
  onClose,
  anchorRef,
  className,
}) => {
  const { t } = useTranslation(['chatV2']);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  // 重置 itemRefs 数组长度，避免旧引用残留
  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, suggestions.length);
  }, [suggestions.length]);

  // 确保选中项可见
  useEffect(() => {
    if (!open || suggestions.length === 0) return;

    const selectedItem = itemRefs.current[selectedIndex];
    if (selectedItem && listRef.current) {
      selectedItem.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [selectedIndex, open, suggestions.length]);

  // 生成当前选中项的 ID（用于 aria-activedescendant）
  const activeDescendantId = suggestions[selectedIndex]
    ? `model-option-${suggestions[selectedIndex].id}`
    : undefined;

  // 无匹配结果且有查询时显示提示
  const showNoResults = open && suggestions.length === 0 && query.length > 0;

  if (!open) {
    return null;
  }

  // 无匹配结果提示
  if (showNoResults) {
    return (
      <div
        className={cn(
          'absolute w-72 rounded-2xl border border-border/50 bg-popover/80 backdrop-blur-xl backdrop-saturate-150 shadow-2xl',
          'animate-in fade-in-0 slide-in-from-bottom-2 duration-200 ease-out',
          'bottom-full mb-3 left-0',
          className
        )}
        style={{ zIndex: Z_INDEX.inputBarPopover }}
        role="listbox"
        aria-label={t('chatV2:modelMention.suggestions')}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
          <Sparkles size={14} className="text-primary" />
          <span className="text-xs font-medium text-foreground/80">
            {t('chatV2:modelMention.selectModel')}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            @{query}
          </span>
        </div>
        <div className="px-3 py-4 text-center text-sm text-muted-foreground">
          {t('chatV2:modelMention.noResults')}
        </div>
      </div>
    );
  }

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        // 基础样式
        'absolute w-72 rounded-2xl border border-border/50 bg-popover/80 backdrop-blur-xl backdrop-saturate-150 shadow-2xl',
        // 动画
        'animate-in fade-in-0 slide-in-from-bottom-2 duration-200 ease-out',
        // 定位：在输入框上方
        'bottom-full mb-3 left-0',
        className
      )}
      style={{ zIndex: Z_INDEX.inputBarPopover }}
      role="listbox"
      aria-label={t('chatV2:modelMention.suggestions')}
      aria-activedescendant={activeDescendantId}
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <Sparkles size={14} className="text-primary" />
        <span className="text-xs font-medium text-foreground/80">
          {t('chatV2:modelMention.selectModel')}
        </span>
        {query && (
          <span className="ml-auto text-xs text-muted-foreground">
            @{query}
          </span>
        )}
      </div>

      {/* 模型列表 */}
      {/* 🔧 max-h-48 (192px) → max-h-72 (288px) 以显示更多模型 */}
      <div
        ref={listRef}
        className="max-h-72 overflow-y-auto p-1"
      >
        {suggestions.map((model, index) => (
          <div
            key={model.id}
            id={`model-option-${model.id}`}
            ref={(el) => {
              itemRefs.current[index] = el;
            }}
            role="option"
            aria-selected={index === selectedIndex}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors',
              'text-sm',
              index === selectedIndex
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-accent/50 text-foreground'
            )}
            onClick={() => onSelect(model)}
            onMouseEnter={() => onSelectedIndexChange(index)}
          >
            {/* 模型图标 */}
            <div
              className={cn(
                'w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
                'bg-primary/10 text-primary'
              )}
            >
              <Sparkles size={14} />
            </div>

            {/* 模型信息 */}
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{model.name}</div>
              <div className="text-xs text-muted-foreground truncate">
                {model.model || model.id}
              </div>
            </div>

            {/* 选中标记 */}
            {index === selectedIndex && (
              <Check size={16} className="text-primary shrink-0" />
            )}
          </div>
        ))}
      </div>

      {/* 底部提示 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border/50 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-0.5">
            <kbd className="px-1 py-0.5 rounded bg-muted text-[10px]">↑</kbd>
            <kbd className="px-1 py-0.5 rounded bg-muted text-[10px]">↓</kbd>
            <span className="ml-0.5">{t('chatV2:modelMention.navigate')}</span>
          </span>
          <span className="inline-flex items-center gap-0.5">
            <kbd className="px-1 py-0.5 rounded bg-muted text-[10px]">↵</kbd>
            <span className="ml-0.5">{t('chatV2:modelMention.confirm')}</span>
          </span>
          <span className="inline-flex items-center gap-0.5">
            <kbd className="px-1 py-0.5 rounded bg-muted text-[10px]">Esc</kbd>
            <span className="ml-0.5">{t('chatV2:modelMention.dismiss')}</span>
          </span>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 工具函数 - 供外部调用键盘处理
// ============================================================================

/**
 * 检查是否应该由 ModelMentionPopover 处理键盘事件
 *
 * @param e - 键盘事件
 * @param isOpen - 弹窗是否打开
 * @returns 是否应该处理
 */
export function shouldHandleModelMentionKey(
  e: React.KeyboardEvent,
  isOpen: boolean
): boolean {
  if (!isOpen) return false;
  return ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key);
}

export default ModelMentionPopover;
