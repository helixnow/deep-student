import React from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch, GitDiff, WarningCircle } from '@phosphor-icons/react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/utils/cn';
import { DiffHunksView } from '../AIDiffPanel';
import type { DiffLine } from '../hooks/useAIEditState';
import type {
  ConflictDiffStats,
  ConflictRemoteStatus,
  NoteConflictAction,
} from '../hooks/useNoteConflict';

export interface NotesConflictBannerProps {
  conflictAction: NoteConflictAction | null;
  conflictDiffOpen: boolean;
  onToggleDiffOpen: () => void;
  conflictDiffRegionId: string;
  conflictDiffLines: DiffLine[] | null;
  conflictDiffStats: ConflictDiffStats | null;
  conflictRemoteStatus: ConflictRemoteStatus;
  onRetryFetchRemote: () => void;
  onResolve: (mode: 'mine' | 'remote', action: NoteConflictAction) => void;
}

export const NotesConflictBanner: React.FC<NotesConflictBannerProps> = ({
  conflictAction,
  conflictDiffOpen,
  onToggleDiffOpen,
  conflictDiffRegionId,
  conflictDiffLines,
  conflictDiffStats,
  conflictRemoteStatus,
  onRetryFetchRemote,
  onResolve,
}) => {
  const { t } = useTranslation(['notes']);

  if (!conflictAction) return null;

  return (
    <>
      <div
        className="notes-conflict-banner flex-shrink-0 flex-wrap"
        role="alert"
      >
        <WarningCircle
          size={16}
          weight="fill"
          className="shrink-0 text-[hsl(var(--warning,38_70%_45%))]"
          aria-hidden
        />
        <span className="min-w-[160px] font-medium text-foreground/90">
          {t('notes:editor.conflict_refreshed')}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <DsButton
            variant="ghost"
            size="sm"
            className={cn(
              'h-6 px-2 text-xs [@media(pointer:coarse)]:!min-h-11',
              conflictDiffOpen
                ? 'bg-[var(--interactive-hover)] text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={onToggleDiffOpen}
            aria-expanded={conflictDiffOpen}
            aria-controls={conflictDiffRegionId}
          >
            <GitDiff size={13} className="mr-1" aria-hidden />
            {conflictDiffOpen
              ? t('notes:editorV2.conflict_compare_hide', 'Hide comparison')
              : t('notes:editorV2.conflict_compare', 'Compare')}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs [@media(pointer:coarse)]:!min-h-11"
            onClick={() => onResolve('mine', conflictAction)}
          >
            {t('notes:editor.conflict_restore_mine')}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:!min-h-11"
            onClick={() => onResolve('remote', conflictAction)}
          >
            {t('notes:editor.conflict_keep_remote', 'Keep remote')}
          </DsButton>
        </div>
      </div>

      {/* 冲突「对比」：编辑器上方内联展开的只读 diff 区（grid-rows 0fr→1fr），
          非浮层、随文档流参与布局；reduced-motion 下瞬时切换 */}
      <div
        id={conflictDiffRegionId}
        className={cn(
          'grid flex-shrink-0 transition-[grid-template-rows] duration-200 ease-[var(--dropdown-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none',
          conflictDiffOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
        aria-hidden={!conflictDiffOpen}
        // inert：收起时阻止内部按钮被 Tab 聚焦（React 18 类型未收录该属性，需绕过）
        {...(!conflictDiffOpen
          ? ({ inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement>)
          : {})}
      >
        <div
          className={cn(
            'min-h-0 overflow-hidden bg-background',
            // 收起（0fr）时内容高度为 0 但边框仍占 1px，会在横幅下多出一道线；仅展开时描边
            conflictDiffOpen && 'border-b border-border',
          )}
        >
          <div className="notes-column py-2">
            <section
              aria-label={t('notes:editorV2.conflict_diff_title', 'My version vs remote version')}
              className="flex max-h-[min(40vh,360px)] flex-col overflow-hidden rounded-[var(--radius-shell-control,12px)] border border-border bg-card shadow-[0_1px_3px_hsl(var(--shadow-base)/0.08)]"
            >
              <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-1.5">
                <GitDiff size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 truncate text-xs font-medium">
                  {t('notes:editorV2.conflict_diff_title', 'My version vs remote version')}
                </span>
                {conflictDiffStats && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    <span className="text-[hsl(var(--success))]">+{conflictDiffStats.added}</span>
                    {' / '}
                    <span className="text-[hsl(var(--destructive))]">-{conflictDiffStats.removed}</span>
                  </span>
                )}
                <span className="ml-auto hidden shrink-0 text-[11px] text-muted-foreground/80 sm:inline">
                  {t('notes:editorV2.conflict_diff_legend', '+ mine · − remote')}
                </span>
              </div>

              {conflictDiffLines ? (
                conflictDiffStats && (conflictDiffStats.added > 0 || conflictDiffStats.removed > 0) ? (
                  <CustomScrollArea className="min-h-0 flex-1" viewportClassName="py-1">
                    <DiffHunksView lines={conflictDiffLines} />
                  </CustomScrollArea>
                ) : (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    {t('notes:editorV2.conflict_diff_identical', 'Both versions are identical')}
                  </div>
                )
              ) : conflictRemoteStatus === 'error' ? (
                <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                  <span>{t('notes:editorV2.conflict_diff_load_failed', 'Could not load the remote version')}</span>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs [@media(pointer:coarse)]:!min-h-11"
                    onClick={onRetryFetchRemote}
                  >
                    {t('notes:editorV2.conflict_diff_retry', 'Retry')}
                  </DsButton>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                  <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
                  <span>{t('notes:editorV2.conflict_diff_loading', 'Loading remote version…')}</span>
                </div>
              )}

              <div className="flex flex-shrink-0 items-center justify-end gap-1.5 border-t border-border/60 bg-muted/20 px-3 py-2">
                <DsButton
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() => onResolve('remote', conflictAction)}
                >
                  {t('notes:editor.conflict_keep_remote', 'Keep remote')}
                </DsButton>
                <DsButton
                  size="sm"
                  className="h-7"
                  onClick={() => onResolve('mine', conflictAction)}
                >
                  {t('notes:editor.conflict_restore_mine')}
                </DsButton>
              </div>
            </section>
          </div>
        </div>
      </div>
    </>
  );
};
