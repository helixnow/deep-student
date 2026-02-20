/**
 * Chat V2 - ModelMentionAutoComplete 模型自动完成组件
 *
 * 显示 @模型 的自动完成下拉列表。
 *
 * 功能：
 * 1. 显示匹配的模型建议
 * 2. 支持键盘导航（上/下/Enter/Escape）
 * 3. 支持鼠标点击选择
 * 4. 支持暗色/亮色主题
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { Bot, Sparkles } from 'lucide-react';
import type { ModelInfo } from '../../utils/parseModelMentions';

// ============================================================================
// Props 定义
// ============================================================================

export interface ModelMentionAutoCompleteProps {
  /** 是否显示 */
  show: boolean;
  /** 当前搜索查询 */
  query: string;
  /** 模型建议列表 */
  suggestions: ModelInfo[];
  /** 当前选中的索引 */
  selectedIndex: number;
  /** 选择模型回调 */
  onSelect: (model: ModelInfo) => void;
  /** 设置选中索引 */
  onSelectedIndexChange: (index: number) => void;
  /** 关闭下拉 */
  onClose: () => void;
  /** 自定义类名 */
  className?: string;
  /** 相对于输入框的位置（可选） */
  position?: 'above' | 'below';
  /** 锚点元素（用于定位，可选） */
  anchorRect?: DOMRect | null;
}

// ============================================================================
// 子组件：单个模型建议项
// ============================================================================

interface ModelSuggestionItemProps {
  model: ModelInfo;
  isSelected: boolean;
  query: string;
  onClick: () => void;
  onMouseEnter: () => void;
}

const ModelSuggestionItem: React.FC<ModelSuggestionItemProps> = ({
  model,
  isSelected,
  query,
  onClick,
  onMouseEnter,
}) => {
  const itemRef = useRef<HTMLDivElement>(null);

  // 选中时滚动到可见
  useEffect(() => {
    if (isSelected && itemRef.current) {
      itemRef.current.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [isSelected]);

  // 高亮匹配的文本
  const highlightMatch = (text: string): React.ReactNode => {
    if (!query) return text;

    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const index = lowerText.indexOf(lowerQuery);

    if (index === -1) return text;

    return (
      <>
        {text.slice(0, index)}
        <span className="font-semibold text-primary">
          {text.slice(index, index + query.length)}
        </span>
        {text.slice(index + query.length)}
      </>
    );
  };

  return (
    <div
      ref={itemRef}
      role="option"
      aria-selected={isSelected}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        'flex items-center gap-3 px-3 py-2 cursor-pointer',
        'transition-colors duration-100',
        isSelected
          ? 'bg-primary/10 dark:bg-primary/20'
          : 'hover:bg-muted/50 dark:hover:bg-muted/30'
      )}
    >
      {/* 模型图标 */}
      <div
        className={cn(
          'flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center',
          isSelected
            ? 'bg-primary/20 text-primary'
            : 'bg-muted text-muted-foreground'
        )}
      >
        <Bot className="w-4 h-4" />
      </div>

      {/* 模型信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'text-sm font-medium truncate',
              isSelected ? 'text-primary' : 'text-foreground'
            )}
          >
            {highlightMatch(model.name)}
          </span>
          {model.provider && (
            <span className="text-xs text-muted-foreground">
              {model.provider}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          @{highlightMatch(model.id)}
        </div>
      </div>

      {/* 多变体提示图标 */}
      {isSelected && (
        <Sparkles className="w-4 h-4 text-primary flex-shrink-0" />
      )}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * ModelMentionAutoComplete 模型自动完成组件
 */
export const ModelMentionAutoComplete: React.FC<
  ModelMentionAutoCompleteProps
> = ({
  show,
  query,
  suggestions,
  selectedIndex,
  onSelect,
  onSelectedIndexChange,
  onClose,
  className,
  position = 'above',
}) => {
  const { t } = useTranslation('chatV2');
  const containerRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!show) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [show, onClose]);

  // 处理模型选择
  const handleSelect = useCallback(
    (model: ModelInfo) => {
      onSelect(model);
    },
    [onSelect]
  );

  // 处理鼠标悬停
  const handleMouseEnter = useCallback(
    (index: number) => {
      onSelectedIndexChange(index);
    },
    [onSelectedIndexChange]
  );

  if (!show || suggestions.length === 0) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label={t('modelMention.suggestions')}
      className={cn(
        // 定位
        'absolute left-0 right-0 z-50',
        position === 'above' ? 'bottom-full mb-2' : 'top-full mt-2',
        // 样式
        'bg-popover dark:bg-popover',
        'border border-border dark:border-border',
        'rounded-lg shadow-lg ring-1 ring-border/40 dark:shadow-xl',
        'overflow-hidden',
        // 动画
        'animate-in fade-in-0 zoom-in-95',
        position === 'above' ? 'slide-in-from-bottom-2' : 'slide-in-from-top-2',
        className
      )}
    >
      {/* 头部提示 */}
      <div className="px-3 py-2 border-b border-border/50 bg-muted/30 dark:bg-muted/10">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>@</span>
          <span>{t('modelMention.selectModel')}</span>
          <span className="ml-auto text-xs">
            {suggestions.length > 1
              ? t('modelMention.multiVariantHint')
              : t('modelMention.singleModelHint')}
          </span>
        </div>
      </div>

      {/* 模型列表 */}
      <div className="max-h-[240px] overflow-y-auto">
        {suggestions.map((model, index) => (
          <ModelSuggestionItem
            key={model.id}
            model={model}
            isSelected={index === selectedIndex}
            query={query}
            onClick={() => handleSelect(model)}
            onMouseEnter={() => handleMouseEnter(index)}
          />
        ))}
      </div>

      {/* 底部快捷键提示 */}
      <div className="px-3 py-1.5 border-t border-border/50 bg-muted/30 dark:bg-muted/10">
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono text-[10px]">
              ↑↓
            </kbd>
            {t('modelMention.navigate')}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono text-[10px]">
              Enter
            </kbd>
            {t('modelMention.confirm')}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono text-[10px]">
              Esc
            </kbd>
            {t('modelMention.dismiss')}
          </span>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 导出
// ============================================================================

export default ModelMentionAutoComplete;
