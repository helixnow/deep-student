/**
 * Chat V2 - SkillSlashPopover 技能斜杠命令内联补全
 *
 * 输入期（而非发送期）为消息开头的 `/skill-id` 令牌提供内联补全：
 * - 锚定在输入栏上方内联展开（非模态、非抽屉），与 ModelMentionPopover 同一视觉语言
 * - 键盘导航：↑↓ 选择，Tab/Enter 补全，Esc 关闭
 * - 匹配语义与 `skills/slashCommands.ts` 的 parseLeadingSkillCommands 保持一致：
 *   只在「输入开头连续斜杠令牌区」内触发，正文中的 `/path/like/this` 不会弹出
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lightning, Check } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/config/zIndex';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { skillRegistry, subscribeToSkillRegistry } from '../../skills/registry';
import { isSkillDisabled, SKILL_ENABLED_CHANGED_EVENT } from '../../skills/skillEnableStorage';

// ============================================================================
// 类型定义
// ============================================================================

export interface SkillSlashSuggestion {
  id: string;
  name: string;
  description?: string;
  argumentHint?: string;
  /** 当前会话是否已激活该技能 */
  isActive: boolean;
}

export interface UseSkillSlashCommandsOptions {
  /** 当前输入框内容 */
  inputValue: string;
  /** 当前光标位置 */
  caretPos: number;
  /** 是否启用（流式冻结等场景下关闭） */
  enabled: boolean;
  /** 已激活技能 ID（展示「已激活」标记） */
  activeSkillIds?: string[];
}

export interface SkillSlashApplyResult {
  /** 补全后的完整输入值 */
  value: string;
  /** 补全后的光标位置 */
  caret: number;
}

export interface UseSkillSlashCommandsReturn {
  /** popover 是否应该展示 */
  open: boolean;
  /** 当前部分令牌（不含斜杠） */
  query: string;
  /** 候选技能 */
  suggestions: SkillSlashSuggestion[];
  /** 键盘选中索引 */
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  moveSelectionUp: () => void;
  moveSelectionDown: () => void;
  /** Esc 关闭（query 变化后自动恢复） */
  dismiss: () => void;
  /** 应用选中项，返回新输入值与光标位置；无选中项返回 null */
  applySelection: (index?: number) => SkillSlashApplyResult | null;
}

// ============================================================================
// 检测逻辑
// ============================================================================

/**
 * 输入开头「连续斜杠令牌区」内的当前部分令牌。
 * group1 = 之前的完整令牌前缀（含空白），group2 = 当前部分令牌正文
 */
const LEADING_SLASH_CONTEXT_RE = /^(\s*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*\s+)*)\/([A-Za-z0-9_-]*)$/;

const MAX_SUGGESTIONS = 8;

interface SlashContext {
  /** 当前令牌 `/` 的起始位置 */
  tokenStart: number;
  /** 当前部分令牌正文（不含 `/`） */
  query: string;
}

function detectSlashContext(inputValue: string, caretPos: number): SlashContext | null {
  if (caretPos < 1 || caretPos > inputValue.length) return null;
  const before = inputValue.slice(0, caretPos);
  const match = LEADING_SLASH_CONTEXT_RE.exec(before);
  if (!match) return null;
  return { tokenStart: match[1].length, query: match[2] };
}

function readInvocableSkills(): Array<{ id: string; name: string; description?: string; argumentHint?: string }> {
  return skillRegistry
    .getAll()
    .filter((skill) => skill.userInvocable !== false && !isSkillDisabled(skill.id))
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      argumentHint: skill.argumentHint,
    }));
}

// ============================================================================
// Hook 实现
// ============================================================================

export function useSkillSlashCommands({
  inputValue,
  caretPos,
  enabled,
  activeSkillIds,
}: UseSkillSlashCommandsOptions): UseSkillSlashCommandsReturn {
  const [skills, setSkills] = useState(readInvocableSkills);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);

  // registry 更新 / 用户启停技能时刷新候选源
  useEffect(() => {
    const refresh = () => setSkills(readInvocableSkills());
    const unsubscribe = subscribeToSkillRegistry(refresh);
    window.addEventListener(SKILL_ENABLED_CHANGED_EVENT, refresh);
    return () => {
      unsubscribe();
      window.removeEventListener(SKILL_ENABLED_CHANGED_EVENT, refresh);
    };
  }, []);

  const context = useMemo(
    () => (enabled ? detectSlashContext(inputValue, caretPos) : null),
    [enabled, inputValue, caretPos]
  );

  const suggestions = useMemo<SkillSlashSuggestion[]>(() => {
    if (!context) return [];
    const query = context.query.toLowerCase();
    const activeSet = new Set(activeSkillIds ?? []);

    const ranked = skills
      .map((skill) => {
        const id = skill.id.toLowerCase();
        const name = skill.name.toLowerCase();
        let rank = -1;
        if (query.length === 0) {
          rank = 2;
        } else if (id.startsWith(query)) {
          rank = 0;
        } else if (name.startsWith(query)) {
          rank = 1;
        } else if (id.includes(query) || name.includes(query)) {
          rank = 2;
        }
        return { skill, rank };
      })
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.skill.id.localeCompare(b.skill.id))
      .slice(0, MAX_SUGGESTIONS);

    return ranked.map(({ skill }) => ({
      ...skill,
      isActive: activeSet.has(skill.id),
    }));
  }, [context, skills, activeSkillIds]);

  // query 变化时恢复被 Esc 关闭的 popover，并复位选中索引
  const query = context?.query ?? '';
  useEffect(() => {
    setSelectedIndex(0);
    setDismissedQuery((prev) => (prev !== null && prev !== query ? null : prev));
  }, [query]);

  const open = !!context && suggestions.length > 0 && dismissedQuery !== query;

  const moveSelectionUp = useCallback(() => {
    setSelectedIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
  }, [suggestions.length]);

  const moveSelectionDown = useCallback(() => {
    setSelectedIndex((prev) => (prev >= suggestions.length - 1 ? 0 : prev + 1));
  }, [suggestions.length]);

  const dismiss = useCallback(() => {
    setDismissedQuery(query);
  }, [query]);

  const applySelection = useCallback(
    (index?: number): SkillSlashApplyResult | null => {
      if (!context) return null;
      const skill = suggestions[index ?? selectedIndex];
      if (!skill) return null;
      const completed = `/${skill.id} `;
      const value =
        inputValue.slice(0, context.tokenStart) + completed + inputValue.slice(caretPos);
      return { value, caret: context.tokenStart + completed.length };
    },
    [context, suggestions, selectedIndex, inputValue, caretPos]
  );

  return {
    open,
    query,
    suggestions,
    selectedIndex,
    setSelectedIndex,
    moveSelectionUp,
    moveSelectionDown,
    dismiss,
    applySelection,
  };
}

/**
 * 键盘事件是否应交给 SkillSlashPopover 处理
 */
export function shouldHandleSkillSlashKey(e: React.KeyboardEvent, isOpen: boolean): boolean {
  if (!isOpen) return false;
  return ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key);
}

// ============================================================================
// 组件实现
// ============================================================================

export interface SkillSlashPopoverProps {
  open: boolean;
  query: string;
  suggestions: SkillSlashSuggestion[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onSelectedIndexChange: (index: number) => void;
  className?: string;
}

export const SkillSlashPopover: React.FC<SkillSlashPopoverProps> = ({
  open,
  query,
  suggestions,
  selectedIndex,
  onSelect,
  onSelectedIndexChange,
  className,
}) => {
  const { t } = useTranslation(['chatV2']);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const closeTimeoutRef = useRef<number | null>(null);
  const [shouldRender, setShouldRender] = useState(open);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, suggestions.length);
  }, [suggestions.length]);

  // 与 ModelMentionPopover 相同的退场节奏（--dropdown-close-dur）
  useEffect(() => {
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    if (open) {
      setShouldRender(true);
      setIsClosing(false);
      return;
    }
    if (!shouldRender) return;
    setIsClosing(true);
    const closeMs = parseFloat(
      window.getComputedStyle(document.documentElement).getPropertyValue('--dropdown-close-dur')
    ) || 150;
    closeTimeoutRef.current = window.setTimeout(() => {
      setShouldRender(false);
      setIsClosing(false);
      closeTimeoutRef.current = null;
    }, closeMs);
    return () => {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
    };
  }, [open, shouldRender]);

  // 选中项保持可见
  useEffect(() => {
    if (!open || suggestions.length === 0) return;
    const selectedItem = itemRefs.current[selectedIndex];
    if (selectedItem && listRef.current) {
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex, open, suggestions.length]);

  if (!shouldRender || suggestions.length === 0) {
    return null;
  }

  const activeDescendantId = suggestions[selectedIndex]
    ? `skill-slash-option-${suggestions[selectedIndex].id}`
    : undefined;

  return (
    <div
      data-testid="skill-slash-popover"
      className={cn(
        't-dropdown',
        isClosing && 'is-closing',
        open && 'is-open',
        // ★ H2 修复：与 ModelMentionPopover 对齐——窄屏时收窄到视口内（固定 w-80 会在小屏溢出）
        'absolute w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-border/50 bg-popover/80 backdrop-blur-xl backdrop-saturate-150 shadow-lg ring-1 ring-border/40',
        'bottom-full mb-3 left-0',
        className
      )}
      style={{ zIndex: Z_INDEX.inputBarPopover }}
      data-origin="bottom-left"
      data-wb-blur-surface
      role="listbox"
      aria-label={t('chatV2:inputBar.slashCommand.title')}
      aria-activedescendant={activeDescendantId}
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <Lightning size={14} weight="bold" className="text-primary" />
        <span className="text-xs font-medium text-foreground/80">
          {t('chatV2:inputBar.slashCommand.title')}
        </span>
        {query && (
          <span className="ml-auto font-mono text-xs text-muted-foreground">/{query}</span>
        )}
      </div>

      {/* 技能列表 */}
      <CustomScrollArea
        viewportRef={listRef}
        fullHeight={false}
        className="max-h-72"
        viewportClassName="max-h-72 p-1"
      >
        {suggestions.map((skill, index) => (
          <div
            key={skill.id}
            id={`skill-slash-option-${skill.id}`}
            ref={(el) => {
              itemRefs.current[index] = el;
            }}
            role="option"
            aria-selected={index === selectedIndex}
            className={cn(
              'flex items-start gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors text-sm',
              index === selectedIndex
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-[var(--interactive-hover)] text-foreground'
            )}
            // pointerdown 早于 textarea blur，保证点击补全时不丢焦点上下文
            onPointerDown={(e) => {
              e.preventDefault();
              onSelect(index);
            }}
            onMouseEnter={() => onSelectedIndexChange(index)}
          >
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Lightning size={14} weight="bold" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium">{skill.name}</span>
                <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                  /{skill.id}
                </span>
                {skill.argumentHint && (
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground/70">
                    {skill.argumentHint}
                  </span>
                )}
                {skill.isActive && (
                  <span className="ml-auto shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-2xs leading-none text-primary">
                    {t('chatV2:inputBar.slashCommand.active')}
                  </span>
                )}
              </div>
              {skill.description && (
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {skill.description}
                </div>
              )}
            </div>
            {index === selectedIndex && (
              <Check size={16} weight="bold" className="mt-0.5 shrink-0 text-primary" />
            )}
          </div>
        ))}
      </CustomScrollArea>

      {/* 底部按键提示 */}
      <div className="flex items-center gap-2 border-t border-border/50 px-3 py-1.5 text-2xs text-muted-foreground">
        <span className="inline-flex items-center gap-0.5">
          <kbd className="rounded bg-muted px-1 py-0.5 text-2xs">↑</kbd>
          <kbd className="rounded bg-muted px-1 py-0.5 text-2xs">↓</kbd>
          <span className="ml-0.5">{t('chatV2:modelMention.navigate')}</span>
        </span>
        <span className="inline-flex items-center gap-0.5">
          <kbd className="rounded bg-muted px-1 py-0.5 text-2xs">Tab</kbd>
          <kbd className="rounded bg-muted px-1 py-0.5 text-2xs">↵</kbd>
          <span className="ml-0.5">{t('chatV2:modelMention.confirm')}</span>
        </span>
        <span className="inline-flex items-center gap-0.5">
          <kbd className="rounded bg-muted px-1 py-0.5 text-2xs">Esc</kbd>
          <span className="ml-0.5">{t('chatV2:modelMention.dismiss')}</span>
        </span>
      </div>
    </div>
  );
};

export default SkillSlashPopover;
