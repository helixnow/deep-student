import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { ThreadContentShell } from './ThreadContentShell';

export interface ThreadEmptySuggestion {
  id: string;
  text: string;
}

export interface ThreadEmptyStateShellProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title: React.ReactNode;
  /** 品牌/图标区，渲染在标题上方（如无会话空态的 Chat 图标） */
  brandIcon?: React.ReactNode;
  /** 标题下方的一句描述文案 */
  description?: React.ReactNode;
  /**
   * 建议 chips。三态：
   * - `undefined`（缺省）：无 children 时渲染内置默认建议（chatV2:messageList.empty.suggestion*）
   * - `null` / `[]`：不渲染建议
   * - 数组：渲染传入的建议
   * 内置默认让桌面空态（MessageList 桌面分支不传 children）也能拿到建议 chips，
   * 移动端由 MessageList 以 children 传入自己的 chips（children 存在时默认建议不渲染）。
   */
  suggestions?: ThreadEmptySuggestion[] | null;
  /** 点击建议的回调；缺省行为为派发 CHAT_V2_SET_INPUT 填入输入框（不自动发送） */
  onSuggestionSelect?: (suggestion: ThreadEmptySuggestion) => void;
  /** CTA 区（按钮组），渲染在建议 chips 之后 */
  actions?: React.ReactNode;
  /** 底部辅助提示（如快捷键 hint），最弱视觉层级 */
  hint?: React.ReactNode;
  titleClassName?: string;
  contentClassName?: string;
}

const DEFAULT_SUGGESTION_KEYS = ['suggestion1', 'suggestion2', 'suggestion5'] as const;

const defaultSuggestionSelect = (suggestion: ThreadEmptySuggestion) => {
  window.dispatchEvent(new CustomEvent('CHAT_V2_SET_INPUT', {
    detail: { content: suggestion.text, autoSend: false },
  }));
};

/**
 * Shared empty-state shell for thread-aligned chat landing states.
 *
 * 统一空态内容模型（2026-07 设计基座）：品牌图标 → 标题 → 描述 → 建议 chips → CTA → hint。
 * ChatV2Page 无会话空态与 MessageList 空会话空态共用此结构，桌面与移动一致。
 * 所有插槽均可选，向后兼容旧的 title + children 用法。
 */
export const ThreadEmptyStateShell: React.FC<ThreadEmptyStateShellProps> = ({
  title,
  brandIcon,
  description,
  suggestions,
  onSuggestionSelect,
  actions,
  hint,
  className,
  titleClassName,
  contentClassName,
  children,
  ...props
}) => {
  const { t } = useTranslation('chatV2');

  // toArray 会剔除 null/undefined/boolean 空节点（如 `{isMobile && ...}` 的 false），
  // 只有真正渲染内容时才视为「已有自定义建议区」
  const hasChildren = React.Children.toArray(children).length > 0;
  const resolvedSuggestions: ThreadEmptySuggestion[] = suggestions === undefined
    ? (hasChildren
        ? []
        : DEFAULT_SUGGESTION_KEYS.map((key) => ({
            id: key,
            text: t(`messageList.empty.${key}`),
          })))
    : (suggestions ?? []);
  const handleSuggestionSelect = onSuggestionSelect ?? defaultSuggestionSelect;

  return (
    <ThreadContentShell className={cn('flex min-h-full items-center', className)}>
      <section
        data-slot="thread-empty-state"
        className={cn('flex w-full flex-col items-center justify-center gap-4 text-center', contentClassName)}
        {...props}
      >
        {brandIcon ? (
          <div
            aria-hidden="true"
            data-slot="thread-empty-brand"
            className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-shell-panel)] border border-border/60 bg-card text-primary shadow-[var(--shadow-shell-soft)]"
          >
            {brandIcon}
          </div>
        ) : null}
        <h2
          data-slot="thread-empty-primary-action"
          className={cn('text-balance text-xl font-medium text-foreground', titleClassName)}
        >
          {title}
        </h2>
        {description ? (
          <p
            data-slot="thread-empty-description"
            className="mx-auto -mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground"
          >
            {description}
          </p>
        ) : null}
        {resolvedSuggestions.length > 0 ? (
          <div className="flex w-full max-w-md flex-col gap-2" data-slot="thread-empty-suggestions">
            {resolvedSuggestions.map((suggestion) => (
              // eslint-disable-next-line ds-components/no-native-button -- 空态建议 chip：整行可点、文本左对齐两行截断，共享按钮组件的居中单行排版不适配
              <button
                key={suggestion.id}
                type="button"
                onClick={() => handleSuggestionSelect(suggestion)}
                className={cn(
                  'min-h-11 w-full rounded-[var(--chat-radius-lg,16px)] border border-[color:var(--composer-panel-border,hsl(var(--border)))]',
                  'bg-[color:var(--surface-root,hsl(var(--background)))] px-4 py-2.5 text-left',
                  'text-ui leading-relaxed text-muted-foreground',
                  'transition-colors duration-[var(--chat-motion-fast,150ms)] hover:text-foreground',
                  'active:bg-[var(--interactive-hover)]',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30'
                )}
              >
                <span className="line-clamp-2">{suggestion.text}</span>
              </button>
            ))}
          </div>
        ) : null}
        {children}
        {actions ? (
          <div
            data-slot="thread-empty-actions"
            className="flex flex-wrap items-center justify-center gap-2"
          >
            {actions}
          </div>
        ) : null}
        {hint ? (
          <p data-slot="thread-empty-hint" className="text-xs text-muted-foreground/60">
            {hint}
          </p>
        ) : null}
      </section>
    </ThreadContentShell>
  );
};
