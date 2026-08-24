/**
 * 标签过滤组件 - 用于会话浏览页面的标签筛选
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag, X, Plus, CaretDown } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { DsButton } from '@/components/ui/DsButton';

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
          <Tag size={14} />
          <span>{t('tags.filterTitle')}</span>
        </div>
        {selectedTags.size > 0 && (
          <DsButton variant="ghost" size="sm" onClick={onClear} className="h-6 px-1.5 text-2xs [@media(pointer:coarse)]:!h-11">
            {t('tags.clearFilter')}
          </DsButton>
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
                // min-h-7 桌面紧凑；coarse 指针下抬到 44px 触控目标
                'inline-flex items-center gap-1 px-2 py-1 min-h-7 rounded-full text-[11px] border transition-colors [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3',
                isSelected
                  ? 'bg-primary/10 border-primary/50 text-primary'
                  : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-[var(--interactive-hover)]'
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
          // min-h 保证触屏可点（coarse 下达到 44px 触控目标）
          className="flex items-center gap-1 min-h-7 text-2xs text-muted-foreground/60 hover:text-muted-foreground [@media(pointer:coarse)]:min-h-11"
        >
          <CaretDown size={12} className={cn('transition-transform', expanded && 'rotate-180')} />
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
          className="h-4 px-1.5 py-0 text-2xs font-normal bg-muted/40 text-muted-foreground border-0 gap-0.5"
        >
          {tag}
          {onRemove && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemove(tag);
              }}
              aria-label={tag}
              // 触屏无 hover：pointer-coarse 下常显；伪元素扩大命中区（视觉仍为 10px 图标）
              // coarse 下 -inset-[17px]：10px 图标 + 2×17px = 44px 触控目标
              className="ml-0.5 relative opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity [@media(pointer:coarse)]:opacity-60 after:absolute after:-inset-2 after:content-[''] [@media(pointer:coarse)]:after:-inset-[17px]"
            >
              <X size={10} />
            </button>
          )}
        </Badge>
      ))}
      {overflow > 0 && (
        <Badge variant="secondary" className="h-4 px-1 py-0 text-2xs font-normal bg-muted/40 text-muted-foreground/50 border-0">
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
        aria-label={t('tags.addPlaceholder')}
      // 伪元素扩大触控命中区（视觉保持紧凑）
      // coarse 下 -inset-[14px]：16px 按钮（12px 图标 + py-0.5）+ 2×14px = 44px 触控目标
      className="relative inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-2xs text-muted-foreground/50 hover:text-muted-foreground hover:bg-[var(--interactive-hover)] transition-colors after:absolute after:-inset-2 after:content-[''] [@media(pointer:coarse)]:after:-inset-[14px]"
      >
        <Plus size={12} />
      </button>
    );
  }

  return (
    <Input
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        // IME 安全：中文输入法组合期间的 Enter/Escape 只作用于候选词
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') handleSubmit();
        if (e.key === 'Escape') {
          // 取消输入：清空草稿，避免下次打开残留旧值
          setValue('');
          setShowInput(false);
        }
      }}
      onBlur={handleSubmit}
      autoFocus
      placeholder={t('tags.addPlaceholder')}
      // 📱 16px 输入契约：2xs（10px）在 coarse 指针下会触发 iOS 聚焦放大且难以点按，
      // 放大字号并加宽输入框（桌面视觉不变）；min-h-11 抬到 44px 触控目标（min-height 压过 h-7）
      className="h-7 w-24 text-2xs [@media(pointer:coarse)]:text-[16px] [@media(pointer:coarse)]:w-32 [@media(pointer:coarse)]:min-h-11"
    />
  );
};

export default TagFilterPanel;
