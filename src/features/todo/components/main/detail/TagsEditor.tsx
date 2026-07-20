/**
 * TagsEditor — 详情面板标签编辑（自动补全 + 彩色标签点 + 键盘导航）
 *
 * - Enter / 逗号提交；Esc 先收建议、再取消输入（不冒泡触发面板级关闭）
 * - 空输入时 Backspace 删除最后一个标签
 * - 自动补全：基于已有标签（父组件从 store 只读汇总），↑/↓ 高亮、Enter 选中；
 *   无匹配时首行提供「创建 tag」内联流；建议行 onMouseDown preventDefault
 *   避免先触发 blur 提交半成品
 * - 重复标签去重（含前导 # 与首尾空白归一，大小写不敏感）
 * - pill 增删 150ms scale + fade 动效（prefers-reduced-motion 退化为瞬时）
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Plus, X } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';
import { tweenFast } from '@/styles/motion-springs';
import { tagDotColor } from './tagColor';

const MAX_SUGGESTIONS = 6;

export const TagsEditor: React.FC<{
  tags: string[];
  onChange: (next: string[]) => void;
  /** 全部已有标签（按使用频次降序），父组件从 store 只读汇总 */
  suggestions?: string[];
}> = ({ tags, onChange, suggestions = [] }) => {
  const { t } = useTranslation(['todo']);
  const prefersReducedMotion = useReducedMotion();
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = React.useId();

  const normalizedDraft = draft.trim().replace(/^#/, '');

  // 大小写不敏感去重集合（保留原大小写展示）
  const lowerTags = useMemo(() => new Set(tags.map((x) => x.toLowerCase())), [tags]);

  const matched = useMemo(() => {
    const q = normalizedDraft.toLowerCase();
    return suggestions
      .filter((s) => !lowerTags.has(s.toLowerCase()))
      .filter((s) => (q ? s.toLowerCase().includes(q) : true))
      .slice(0, MAX_SUGGESTIONS);
  }, [suggestions, lowerTags, normalizedDraft]);

  // 「创建新标签」行：有输入且与任何建议都不完全同名时出现
  const canCreate =
    normalizedDraft.length > 0 &&
    !lowerTags.has(normalizedDraft.toLowerCase()) &&
    !matched.some((s) => s.toLowerCase() === normalizedDraft.toLowerCase());

  // 选项序：匹配建议在前，「创建」行殿后
  const optionCount = matched.length + (canCreate ? 1 : 0);
  const showSuggestions = focused && optionCount > 0;

  const addTag = useCallback(
    (raw: string) => {
      const trimmed = raw.trim().replace(/^#/, '');
      setDraft('');
      setHighlightIndex(-1);
      if (!trimmed || lowerTags.has(trimmed.toLowerCase())) return;
      onChange([...tags, trimmed]);
    },
    [tags, lowerTags, onChange],
  );

  const commitDraft = useCallback(() => {
    if (!normalizedDraft) return;
    addTag(normalizedDraft);
  }, [normalizedDraft, addTag]);

  const removeTag = useCallback(
    (tag: string) => onChange(tags.filter((x) => x !== tag)),
    [tags, onChange],
  );

  const pickOption = useCallback(
    (index: number) => {
      if (index >= 0 && index < matched.length) {
        addTag(matched[index]);
      } else if (canCreate) {
        addTag(normalizedDraft);
      }
      inputRef.current?.focus();
    },
    [matched, canCreate, normalizedDraft, addTag],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showSuggestions && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setHighlightIndex((prev) => {
        const next = prev + delta;
        if (next < -1) return optionCount - 1;
        if (next >= optionCount) return -1;
        return next;
      });
      return;
    }
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (showSuggestions && highlightIndex >= 0) {
        pickOption(highlightIndex);
      } else {
        commitDraft();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (showSuggestions && highlightIndex >= 0) {
        // 第一层 Esc：只取消高亮，不动输入
        e.preventDefault();
        e.stopPropagation();
        setHighlightIndex(-1);
        return;
      }
      if (draft) {
        // 有半成品输入时 Esc 只取消输入，不冒泡触发面板级关闭
        e.preventDefault();
        e.stopPropagation();
        setDraft('');
        setHighlightIndex(-1);
        return;
      }
      if (showSuggestions) {
        // 空输入但建议展开时：Esc 先收建议（失焦），第二次才轮到面板级关闭
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.blur();
        return;
      }
      return;
    }
    if (e.key === 'Backspace' && !draft && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  return (
    <div className="relative flex flex-1 flex-wrap items-center gap-1.5">
      <AnimatePresence initial={false}>
        {tags.map((tag) => (
          <motion.span
            key={tag}
            layout={prefersReducedMotion ? false : 'position'}
            initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={prefersReducedMotion ? undefined : { opacity: 0, scale: 0.85 }}
            transition={prefersReducedMotion ? { duration: 0 } : tweenFast}
            className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--surface-muted)] px-2 py-0.5 text-xs text-foreground/80"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
              style={{ backgroundColor: tagDotColor(tag) }}
            />
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              aria-label={t('todo:tags.remove', { tag })}
              className="rounded-full text-muted-foreground transition-colors duration-150 hover:text-foreground focus:outline-none [@media(pointer:coarse)]:p-2 [@media(pointer:coarse)]:-m-2"
            >
              <X size={11} />
            </button>
          </motion.span>
        ))}
      </AnimatePresence>

      <Input
        ref={inputRef}
        value={draft}
        role="combobox"
        aria-expanded={showSuggestions}
        aria-controls={showSuggestions ? listboxId : undefined}
        aria-activedescendant={
          showSuggestions && highlightIndex >= 0 ? `${listboxId}-${highlightIndex}` : undefined
        }
        aria-autocomplete="list"
        onChange={(e) => {
          setDraft(e.target.value);
          setHighlightIndex(-1);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setHighlightIndex(-1);
          commitDraft();
        }}
        placeholder={t('todo:tags.addPlaceholder')}
        className="h-6 w-28 min-w-0 flex-shrink-0 border-0 bg-transparent px-1 text-xs focus-visible:ring-0 placeholder:text-muted-foreground/50"
      />

      {/* 内联建议 popover：绝对定位不推挤布局；mousedown preventDefault 保住输入焦点 */}
      <AnimatePresence>
        {showSuggestions && (
          <motion.ul
            id={listboxId}
            role="listbox"
            aria-label={t('todo:tags.suggestionsLabel')}
            initial={prefersReducedMotion ? false : { opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={prefersReducedMotion ? undefined : { opacity: 0, y: -3 }}
            transition={prefersReducedMotion ? { duration: 0 } : tweenFast}
            className="absolute left-0 top-full z-20 mt-1 min-w-[10rem] max-w-full overflow-hidden rounded-[var(--radius-shell-control)] border border-[color:var(--border-default)] bg-popover py-1 shadow-md"
          >
            {matched.map((s, i) => (
              <li key={s} role="presentation">
                <button
                  type="button"
                  id={`${listboxId}-${i}`}
                  role="option"
                  aria-selected={highlightIndex === i}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlightIndex(i)}
                  onClick={() => pickOption(i)}
                  className={cn(
                    'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-foreground transition-colors duration-100',
                    highlightIndex === i && 'bg-[color:var(--interactive-hover)]',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: tagDotColor(s) }}
                  />
                  <span className="min-w-0 flex-1 truncate">{s}</span>
                </button>
              </li>
            ))}
            {canCreate && (
              <li role="presentation">
                <button
                  type="button"
                  id={`${listboxId}-${matched.length}`}
                  role="option"
                  aria-selected={highlightIndex === matched.length}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlightIndex(matched.length)}
                  onClick={() => pickOption(matched.length)}
                  className={cn(
                    'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors duration-100',
                    highlightIndex === matched.length &&
                      'bg-[color:var(--interactive-hover)] text-foreground',
                  )}
                >
                  <Plus size={12} className="flex-shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {t('todo:tags.createNew', { tag: normalizedDraft })}
                  </span>
                </button>
              </li>
            )}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
};

export default TagsEditor;
