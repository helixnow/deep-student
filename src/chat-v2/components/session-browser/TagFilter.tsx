/**
 * 标签过滤组件 - 用于会话浏览页面的标签筛选
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag, X, Plus, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/shad/Badge';
import { NotionButton } from '@/components/ui/NotionButton';

interface TagInfo {
  tag: string;
  count: number;
}

interface TagFilterProps {
  allTags: TagInfo[];
  selectedTags: Set<string>;
  onToggleTag: (tag: string) => void;
  onClear: () => void;
  /** 会话卡片上的标签（只读展示） */
  sessionTags?: string[];
  /** 添加手动标签 */
  onAddTag?: (tag: string) => void;
  /** 删除标签 */
  onRemoveTag?: (tag: string) => void;
  className?: string;
}

/** 标签过滤面板（工具栏弹出） */
export const TagFilterPanel: React.FC<TagFilterProps> = ({
  allTags,
  selectedTags,
  onToggleTag,
  onClear,
  className,
}) => {
  const { t } = useTranslation(['chatV2']);
  const [expanded, setExpanded] = useState(false);

  if (allTags.length === 0) return null;

  const displayTags = expanded ? allTags : allTags.slice(0, 12);

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Tag className="w-3.5 h-3.5" />
          <span>{t('tags.filterTitle')}</span>
        </div>
        {selectedTags.size > 0 && (
          <NotionButton variant="ghost" size="sm" onClick={onClear} className="h-6 px-1.5 text-[10px]">
            {t('tags.clearFilter')}
          </NotionButton>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {displayTags.map(({ tag, count }) => {
          const isSelected = selectedTags.has(tag);
          return (
            <button
              key={tag}
              onClick={() => onToggleTag(tag)}
              className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border transition-colors',
                isSelected
                  ? 'bg-primary/10 border-primary/50 text-primary'
                  : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/50'
              )}
            >
              <span>{tag}</span>
              <span className="opacity-50">{count}</span>
            </button>
          );
        })}
      </div>
      {allTags.length > 12 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-muted-foreground"
        >
          <ChevronDown className={cn('w-3 h-3 transition-transform', expanded && 'rotate-180')} />
          {expanded ? t('tags.showLess') : t('tags.showMore', { count: allTags.length - 12 })}
        </button>
      )}
    </div>
  );
};

/** 会话卡片上的标签展示 */
export const SessionTagBadges: React.FC<{
  tags: string[];
  maxDisplay?: number;
  onRemove?: (tag: string) => void;
}> = ({ tags, maxDisplay = 3, onRemove }) => {
  if (!tags || tags.length === 0) return null;

  const displayed = tags.slice(0, maxDisplay);
  const overflow = tags.length - maxDisplay;

  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {displayed.map((tag) => (
        <Badge
          key={tag}
          variant="secondary"
          className="h-4 px-1.5 py-0 text-[10px] font-normal bg-muted/40 text-muted-foreground border-0 gap-0.5"
        >
          {tag}
          {onRemove && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemove(tag);
              }}
              className="ml-0.5 opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          )}
        </Badge>
      ))}
      {overflow > 0 && (
        <Badge variant="secondary" className="h-4 px-1 py-0 text-[10px] font-normal bg-muted/40 text-muted-foreground/50 border-0">
          +{overflow}
        </Badge>
      )}
    </div>
  );
};

/** 手动添加标签输入 */
export const AddTagInput: React.FC<{
  onAdd: (tag: string) => void;
}> = ({ onAdd }) => {
  const { t } = useTranslation(['chatV2']);
  const [value, setValue] = useState('');
  const [showInput, setShowInput] = useState(false);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed) {
      onAdd(trimmed);
      setValue('');
      setShowInput(false);
    }
  };

  if (!showInput) {
    return (
      <button
        onClick={() => setShowInput(true)}
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/30 transition-colors"
      >
        <Plus className="w-3 h-3" />
      </button>
    );
  }

  return (
    <input
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') handleSubmit();
        if (e.key === 'Escape') setShowInput(false);
      }}
      onBlur={handleSubmit}
      autoFocus
      placeholder={t('tags.addPlaceholder')}
      className="h-5 w-20 px-1.5 text-[10px] bg-muted/30 border-0 rounded focus:outline-none focus:ring-1 focus:ring-primary/30"
    />
  );
};

export default TagFilterPanel;
