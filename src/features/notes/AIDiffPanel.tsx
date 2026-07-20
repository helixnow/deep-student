import React, { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, Robot } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { isMacOS } from '@/utils/platform';
import type { AIEditState, CanvasEditOperation, DiffLine } from './hooks/useAIEditState';

interface AIDiffPanelProps {
  state: AIEditState;
  onAccept: () => void;
  onReject: () => void;
  isApplying?: boolean;
  className?: string;
  /**
   * 宿主可在其他面板（如查找替换）拥有 Esc 语义时暂停本面板的
   * 全局快捷键，避免两个 Esc 监听互相抢占。按钮操作不受影响。
   */
  suspendShortcuts?: boolean;
}

function DiffLineView({ line }: { line: DiffLine }) {
  const bgClass = {
    unchanged: '',
    added: 'bg-[hsl(var(--success)/0.12)]',
    removed: 'bg-[hsl(var(--destructive)/0.10)]',
  }[line.type];

  const prefixChar = {
    unchanged: ' ',
    added: '+',
    removed: '-',
  }[line.type];

  const prefixClass = {
    unchanged: 'text-muted-foreground',
    added: 'text-[hsl(var(--success))]',
    removed: 'text-[hsl(var(--destructive))]',
  }[line.type];

  return (
    <div className={cn('flex font-mono text-xs leading-5', bgClass)}>
      <span className={cn('w-8 text-right pr-2 select-none text-muted-foreground/60')}>
        {line.lineNumber.old || line.lineNumber.new || ''}
      </span>
      <span className={cn('w-4 text-center select-none', prefixClass)}>
        {prefixChar}
      </span>
      <span className="flex-1 whitespace-pre-wrap break-all pr-2">
        {line.content || '\u00A0'}
      </span>
    </div>
  );
}

type DiffHunk = {
  kind: 'context' | 'change';
  lines: DiffLine[];
  /** diffLines 中的起始下标（渲染 key 用，行内容可能重复） */
  startIndex: number;
};

/** 把整份行级 diff 切成「上下文段 / 变更段」交替的 hunk 序列，供视觉分组 */
export function groupDiffHunks(lines: readonly DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const kind: DiffHunk['kind'] = line.type === 'unchanged' ? 'context' : 'change';
    const last = hunks[hunks.length - 1];
    if (last && last.kind === kind) {
      last.lines.push(line);
    } else {
      hunks.push({ kind, lines: [line], startIndex: index });
    }
  }
  return hunks;
}

/**
 * AI 编辑建议 diff 面板。
 *
 * 内联呈现（非全屏遮罩）：作为编辑器上方的有界卡片区参与布局，
 * 编辑器正文保持可见、可滚动；Accept/Reject 操作条固定在 diff 区顶部。
 */
export function AIDiffPanel({
  state,
  onAccept,
  onReject,
  isApplying = false,
  className,
  suspendShortcuts = false,
}: AIDiffPanelProps) {
  const { t } = useTranslation('notes');
  const { request, diffLines } = state;

  const operationLabels: Record<CanvasEditOperation, string> = {
    append: t('aiDiff.operation_append'),
    replace: t('aiDiff.operation_replace'),
    set: t('aiDiff.operation_set'),
  };

  const acceptShortcutLabel = isMacOS() ? '⌘↵' : 'Ctrl+Enter';

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Accept 应用中锁定快捷键，防止重复触发；已被其他面板消费的事件不再处理
    if (isApplying || e.defaultPrevented) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onAccept();
      return;
    }
    if (e.key === 'Escape') {
      // Esc 优先级：查找替换等面板打开时让位（宿主经 suspendShortcuts 声明）
      if (suspendShortcuts) return;
      e.preventDefault();
      onReject();
    }
  }, [isApplying, suspendShortcuts, onAccept, onReject]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!request) return null;

  const hasChanges = diffLines.some(line => line.type !== 'unchanged');
  const addedCount = diffLines.filter(line => line.type === 'added').length;
  const removedCount = diffLines.filter(line => line.type === 'removed').length;

  return (
    <section
      aria-label={t('aiDiff.title')}
      className={cn(
        'notes-ai-diff-inline relative z-20 flex max-h-[min(45vh,420px)] flex-shrink-0 flex-col',
        'border-b border-border bg-background ui-drop-in',
        className
      )}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-[var(--notes-content-max-w)] flex-col px-5 py-2 sm:px-12">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-shell-control,12px)] border border-border bg-card shadow-[0_1px_3px_hsl(var(--shadow-base)/0.08)]">
          {/* 操作条：贴住 diff 区顶部，不随 diff 内容滚动 */}
          <div className="flex flex-shrink-0 items-center gap-3 border-b border-border/60 bg-muted/40 px-3 py-2">
            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary/10">
              <Robot size={14} className="text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-medium leading-tight">{t('aiDiff.title')}</h3>
              <p className="truncate text-xs text-muted-foreground">
                {operationLabels[request.operation]}
                {hasChanges && (
                  <span className="ml-2 tabular-nums">
                    <span className="text-[hsl(var(--success))]">+{addedCount}</span>
                    {' / '}
                    <span className="text-[hsl(var(--destructive))]">-{removedCount}</span>
                  </span>
                )}
              </p>
            </div>
            <div className="hidden items-center text-xs text-muted-foreground sm:flex">
              <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[10px]">{acceptShortcutLabel}</kbd>
              <span className="mx-1">{t('aiDiff.accept')}</span>
              <span className="mx-0.5">·</span>
              <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[10px]">Esc</kbd>
              <span className="ml-1">{t('aiDiff.reject')}</span>
            </div>
            <div className="flex flex-shrink-0 items-center gap-1.5">
              <NotionButton
                variant="outline"
                size="sm"
                onClick={onReject}
                disabled={isApplying}
                className="h-7 ui-press transition-colors duration-150 ease-[var(--dropdown-ease,cubic-bezier(0.22,1,0.36,1))] hover:border-[hsl(var(--destructive)/0.4)] hover:text-[hsl(var(--destructive))] motion-reduce:transition-none"
              >
                <X size={13} className="mr-1" />
                {t('aiDiff.reject')}
              </NotionButton>
              <NotionButton
                size="sm"
                onClick={onAccept}
                disabled={isApplying}
                aria-busy={isApplying}
                className="h-7 ui-press transition-colors duration-150 ease-[var(--dropdown-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none"
              >
                <Check size={13} className="mr-1" />
                {t('aiDiff.accept')}
              </NotionButton>
            </div>
          </div>

          <CustomScrollArea className="min-h-0 flex-1" viewportClassName="py-1">
            {diffLines.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                {t('aiDiff.no_changes')}
              </div>
            ) : (
              <div className="flex flex-col px-1">
                {groupDiffHunks(diffLines).map((hunk) => (
                  <div
                    key={hunk.startIndex}
                    className={cn(
                      hunk.kind === 'change' &&
                        'my-0.5 overflow-hidden rounded-[var(--notes-radius-row,6px)] border-l-2 border-[hsl(var(--primary)/0.35)]',
                    )}
                  >
                    {hunk.lines.map((line, offset) => (
                      <DiffLineView key={hunk.startIndex + offset} line={line} />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </CustomScrollArea>
        </div>
      </div>
    </section>
  );
}

export default AIDiffPanel;
