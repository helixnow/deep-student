import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Clock,
  Star,
  WarningCircle,
  CircleNotch,
  Trash,
  Crosshair,
  Eye,
  EyeSlash,
  Keyboard,
  Flame,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { DsButton } from '@/components/ui/DsButton';
import { AppSelect } from '@/components/ui/app-menu';
import { formatTime } from '@/utils/formatUtils';
import { PracticeShortcutHints } from '@/components/practice/PracticeShortcutHints';
import type { PracticeShortcutOptions } from '@/components/practice/usePracticeShortcuts';
import type { PracticeMode, QuestionBankStats } from '@/api/questionBankApi';
import { MODE_ICON, MODE_I18N_KEY } from './questionBankEditorConfig';

export interface QuestionSettingsDrawerProps {
  onClose: () => void;
  stats?: QuestionBankStats;
  practiceMode: PracticeMode;
  onModeChange?: (mode: PracticeMode) => void;
  selectedTag: string;
  onTagChange: (tag: string) => void;
  tagOptions: Array<{ value: string; label: string }>;
  showTimer: boolean;
  isTimerRunning: boolean;
  timerDisplay: number;
  remainingTime: number | null;
  allowTimerControl: boolean;
  onToggleTimer: () => void;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  canDelete: boolean;
  deleteConfirmOpen: boolean;
  isDeleting: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  focusMode: boolean;
  onFocusModeChange: (next: boolean) => void;
  hideAnswerMode: boolean;
  onHideAnswerModeChange: (next: boolean) => void;
  isSmallScreen: boolean;
  shortcutOptions: PracticeShortcutOptions;
  streakCount: number;
}

export const QuestionSettingsDrawer: React.FC<QuestionSettingsDrawerProps> = ({
  onClose,
  stats,
  practiceMode,
  onModeChange,
  selectedTag,
  onTagChange,
  tagOptions,
  showTimer,
  isTimerRunning,
  timerDisplay,
  remainingTime,
  allowTimerControl,
  onToggleTimer,
  isFavorite,
  onToggleFavorite,
  canDelete,
  deleteConfirmOpen,
  isDeleting,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  focusMode,
  onFocusModeChange,
  hideAnswerMode,
  onHideAnswerModeChange,
  isSmallScreen,
  shortcutOptions,
  streakCount,
}) => {
  const { t } = useTranslation('practice');

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-border/50">
        <h3 className="font-medium">{t('editor.settings')}</h3>
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          onClick={onClose}
          aria-label={t('common:close')}
        >
          <X size={16} />
        </DsButton>
      </div>
      <CustomScrollArea className="flex-1" viewportClassName="p-4 space-y-6">
        {/* 学习统计 */}
        {stats && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">{t('editor.studyStats')}</h4>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md bg-muted p-2">
                <div className="text-xs text-muted-foreground">{t('editor.totalQuestions')}</div>
                <div className="text-lg font-semibold">{stats.total}</div>
              </div>
              <div className="rounded-md bg-success/10 p-2">
                <div className="text-xs text-success">{t('editor.mastered')}</div>
                <div className="text-lg font-semibold text-success">{stats.mastered}</div>
              </div>
              <div className="rounded-md bg-warning/10 p-2">
                <div className="text-xs text-warning">{t('editor.needsReview')}</div>
                <div className="text-lg font-semibold text-warning">{stats.review}</div>
              </div>
              <div className="rounded-md bg-primary/10 p-2">
                <div className="text-xs text-primary">{t('editor.correctRate')}</div>
                <div className="text-lg font-semibold text-primary">{Math.round(stats.correctRate * 100)}%</div>
              </div>
            </div>
          </div>
        )}

        {/* 练习模式（宿主不接管模式切换时不显示，如跨题目集的错题重做） */}
        {onModeChange && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">{t('editor.practiceMode')}</h4>
            <AppSelect
              value={practiceMode}
              onValueChange={(v) => onModeChange(v as PracticeMode)}
              options={Object.keys(MODE_ICON).map(key => ({
                value: key,
                label: t(`editor.modeShort.${MODE_I18N_KEY[key as PracticeMode]}`),
                description: t(`modes.${MODE_I18N_KEY[key as PracticeMode]}.desc`),
              }))}
              variant="outline"
            />
            {/* 当前模式说明 */}
            <p className="text-xs text-muted-foreground px-1">
              {t(`modes.${MODE_I18N_KEY[practiceMode]}.desc`)}
            </p>

            {practiceMode === 'by_tag' && tagOptions.length > 0 && (
              <AppSelect
                value={selectedTag}
                onValueChange={onTagChange}
                placeholder={t('editor.selectTag')}
                options={tagOptions}
                variant="outline"
              />
            )}
          </div>
        )}

        {/* 计时器控制 */}
        {showTimer && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">{t('editor.timer')}</h4>
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
              <div className="flex items-center gap-2">
                <Clock className={cn('w-5 h-5', isTimerRunning ? 'text-primary' : 'text-muted-foreground')} />
                <div className="flex flex-col">
                  <span className="text-xl font-mono tabular-nums">{formatTime(timerDisplay)}</span>
                  {remainingTime != null && (
                    <span className="text-xs text-muted-foreground">
                      {t('timed.remaining')}
                    </span>
                  )}
                </div>
              </div>
              {allowTimerControl && (
                <DsButton variant="ghost" size="sm" onClick={onToggleTimer}>
                  {isTimerRunning ? t('editor.pause') : t('editor.resume')}
                </DsButton>
              )}
            </div>
          </div>
        )}

        {/* 当前题目操作（收藏按钮已由题目顶栏统一承载，避免抽屉内重复与只读态空点） */}
        {canDelete && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">{t('editor.currentQuestion')}</h4>
            <div className="space-y-2">
              {canDelete && (
              deleteConfirmOpen ? (
                /* 内联删除确认：替代模态对话框 */
                <div className="ui-rise-in rounded-md border border-destructive/30 bg-destructive/5 p-2.5 space-y-2">
                  <p className="text-xs text-destructive flex items-start gap-1.5">
                    <WarningCircle size={14} className="flex-shrink-0 mt-0.5" />
                    {t('exam_sheet:questionBank.confirmDeleteSingle')}
                  </p>
                  <div className="flex gap-2">
                    <DsButton
                      variant="ghost"
                      size="sm"
                      className="flex-1 !h-7 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]"
                      disabled={isDeleting}
                      onClick={onCancelDelete}
                    >
                      {t('common:cancel')}
                    </DsButton>
                    <DsButton
                      variant="ghost"
                      size="sm"
                      className="flex-1 !h-7 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)] bg-destructive/10 text-destructive hover:bg-destructive/[0.15]"
                      disabled={isDeleting}
                      onClick={onConfirmDelete}
                    >
                      {isDeleting ? (
                        <CircleNotch size={14} className="animate-spin" />
                      ) : (
                        <Trash size={14} />
                      )}
                      {t('common:delete')}
                    </DsButton>
                  </div>
                </div>
              ) : (
                <DsButton
                  variant="outline"
                  className="w-full justify-start gap-2 text-destructive hover:bg-destructive/10"
                  onClick={onRequestDelete}
                >
                  <Trash size={16} />
                  {t('common:delete')}
                </DsButton>
              )
              )}
            </div>
          </div>
        )}

        {/* 显示设置 */}
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-muted-foreground">{t('editor.displaySettings')}</h4>
          <DsButton
            variant={focusMode ? 'default' : 'outline'}
            className="w-full justify-start gap-2"
            onClick={() => onFocusModeChange(!focusMode)}
          >
            <Crosshair size={16} />
            {t('editor.focusMode')}
            {focusMode && <span className="ml-auto text-xs opacity-70">{t('editor.enabled')}</span>}
          </DsButton>
          <p className="text-xs text-muted-foreground">
            {t('editor.focusModeDesc')}
          </p>
          <DsButton
            variant={hideAnswerMode ? 'default' : 'outline'}
            className="w-full justify-start gap-2"
            onClick={() => onHideAnswerModeChange(!hideAnswerMode)}
          >
            {hideAnswerMode ? <EyeSlash size={16} /> : <Eye size={16} />}
            {t('editor.hideAnswerMode')}
            {hideAnswerMode && <span className="ml-auto text-xs opacity-70">{t('editor.enabled')}</span>}
          </DsButton>
          <p className="text-xs text-muted-foreground">
            {t('editor.hideAnswerModeDesc')}
          </p>
        </div>

        {/* 快捷键提示 */}
        {!isSmallScreen && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <Keyboard size={16} />
              {t('editor.shortcuts')}
            </h4>
            <PracticeShortcutHints {...shortcutOptions} />
          </div>
        )}

        {/* 连对统计 */}
        {streakCount > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground">{t('editor.currentStreak')}</h4>
            <div className="flex items-center gap-2 p-2 rounded-md bg-warning/10">
              <Flame size={16} className="text-warning" />
              <span className="text-base font-semibold text-warning">{streakCount}</span>
              <span className="text-sm text-muted-foreground">{t('editor.questionsUnit')}</span>
            </div>
          </div>
        )}
      </CustomScrollArea>
    </div>
  );
};
