import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretDown,
  Check,
  CircleNotch,
  WarningCircle,
  Note,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { DsButton } from '@/components/ui/DsButton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import type { Question } from '@/api/questionBankApi';

export type NoteSaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface QuestionUserNoteSectionProps {
  isEditingNote: boolean;
  noteText: string;
  noteSaveState: NoteSaveState;
  savedUserNote?: string;
  canUpdateNote: boolean;
  onStartEdit: () => void;
  onChangeNoteText: (value: string) => void;
  onBlurNote: () => void;
  onSaveNote: () => void;
}

export const QuestionUserNoteSection: React.FC<QuestionUserNoteSectionProps> = ({
  isEditingNote,
  noteText,
  noteSaveState,
  savedUserNote,
  canUpdateNote,
  onStartEdit,
  onChangeNoteText,
  onBlurNote,
  onSaveNote,
}) => {
  const { t } = useTranslation('practice');

  return (
    <div>
      {isEditingNote ? (
        <div className="ui-rise-in space-y-2 rounded-xl border border-border/45 bg-foreground/[0.015] p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
              <Note size={14} className="text-warning" />
              {t('editor.myNotes')}
              {/* 自动保存指示 */}
              {noteSaveState === 'saving' && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground font-normal">
                  <CircleNotch size={12} className="animate-spin" />
                  {t('editor.noteSaving')}
                </span>
              )}
              {noteSaveState === 'saved' && (
                <span className="ui-rise-in flex items-center gap-1 text-xs text-success font-normal">
                  <Check size={12} />
                  {t('editor.noteSaved')}
                </span>
              )}
              {noteSaveState === 'error' && (
                <span className="flex items-center gap-1 text-xs text-destructive font-normal">
                  <WarningCircle size={12} />
                  {t('editor.noteSaveFailed')}
                </span>
              )}
            </span>
            <DsButton
              variant="primary"
              size="sm"
              onClick={onSaveNote}
              disabled={!canUpdateNote || noteSaveState === 'saving'}
              className="!h-9 sm:!h-7 !px-2.5 text-xs [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]"
            >
              {t('editor.noteDone')}
            </DsButton>
          </div>
          <Textarea
            value={noteText}
            onChange={(e) => onChangeNoteText(e.target.value)}
            onBlur={onBlurNote}
            placeholder={t('editor.notePlaceholder')}
            rows={3}
            autoFocus
            className="resize-none rounded-lg border border-border/50 bg-background p-2.5 text-sm transition-colors focus-visible:border-primary/45 focus-visible:ring-0 [@media(pointer:coarse)]:text-lg"
          />
          <p className="text-xs text-muted-foreground/60">
            {t('editor.noteAutoSaveHint')}
          </p>
        </div>
      ) : savedUserNote ? (
        <DsButton
          variant="ghost"
          size="sm"
          onClick={onStartEdit}
          disabled={!canUpdateNote}
          className="w-full !justify-start !h-auto min-h-9 !rounded-lg !px-3 !py-2 bg-foreground/[0.025] hover:bg-foreground/[0.045] text-left"
        >
          <div className="space-y-1 w-full">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Note size={14} className="text-warning" />
              <span className="font-medium text-foreground/85">{t('editor.myNotes')}</span>
            </div>
            <p className="text-sm text-muted-foreground line-clamp-2 text-left w-full">
              {savedUserNote}
            </p>
          </div>
        </DsButton>
      ) : (
        <DsButton
          variant="ghost"
          size="sm"
          onClick={onStartEdit}
          disabled={!canUpdateNote}
          className="!h-9 sm:!h-7 !px-2 !py-1 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)] text-xs text-muted-foreground hover:text-foreground gap-1.5"
        >
          <Note size={14} />
          <span>+ {t('editor.myNotes')}</span>
        </DsButton>
      )}
    </div>
  );
};

export interface QuestionJumperPopoverProps {
  questions: Question[];
  currentIndex: number;
  totalQuestions: number;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  filteredQuestionIndices: number[] | null;
  onJumpToIndex: (idx: number) => void;
  triggerClassName?: string;
}

export const QuestionJumperPopover: React.FC<QuestionJumperPopoverProps> = ({
  questions,
  currentIndex,
  totalQuestions,
  searchQuery,
  onSearchQueryChange,
  filteredQuestionIndices,
  onJumpToIndex,
  triggerClassName,
}) => {
  const { t } = useTranslation('practice');

  return (
    <Popover>
      <PopoverTrigger asChild>
        <DsButton
          variant="ghost"
          size="sm"
          aria-label={t('editor.jumpToQuestion')}
          data-testid="qbank-editor-question-jumper"
          className={cn(
            '!px-3 !py-1.5 font-mono text-xs tabular-nums hover:bg-foreground/[0.04]',
            triggerClassName,
          )}
        >
          <span className="font-medium text-foreground">{currentIndex + 1}</span>
          <span className="text-muted-foreground">/ {totalQuestions}</span>
          <CaretDown size={14} className="text-muted-foreground" />
        </DsButton>
      </PopoverTrigger>
      <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] p-3.5" align="center" side="top" sideOffset={8}>
        {/* 搜索框 */}
        <div className="relative mb-3">
          <MagnifyingGlass size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            placeholder={t('editor.searchPlaceholder')}
            className="h-9 sm:h-8 pl-8 text-sm [@media(pointer:coarse)]:text-lg"
          />
        </div>
        <div className="text-xs text-muted-foreground mb-2">
          {filteredQuestionIndices
            ? t('editor.foundCount', { count: filteredQuestionIndices.length })
            : t('editor.jumpToQuestion')}
        </div>
        <CustomScrollArea
          className="max-h-48"
          viewportClassName="grid grid-cols-6 sm:grid-cols-8 gap-1.5"
          fullHeight={false}
          onWheel={(event) => event.stopPropagation()}
        >
          {(filteredQuestionIndices || questions.map((_, idx) => idx)).map((idx) => {
            const q = questions[idx];
            const status = q.status || 'new';
            return (
              <DsButton
                key={q.id}
                variant="ghost"
                size="icon"
                iconOnly
                onClick={() => {
                  onJumpToIndex(idx);
                  onSearchQueryChange('');
                }}
                className={cn(
                  '!w-full !h-9 sm:!w-7 sm:!h-7 [@media(pointer:coarse)]:!w-full [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)] !rounded-lg border font-mono text-xs tabular-nums [content-visibility:auto] [contain-intrinsic-size:auto_28px]',
                  idx === currentIndex && 'border-primary bg-primary text-primary-foreground font-semibold',
                  idx !== currentIndex && status === 'mastered' && 'border-success/35 bg-success/[0.08] text-success hover:bg-success/15',
                  idx !== currentIndex && status === 'review' && 'border-warning/35 bg-warning/[0.08] text-warning hover:bg-warning/15',
                  idx !== currentIndex && status === 'new' && 'border-border/45 bg-foreground/[0.02] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
                  idx !== currentIndex && status === 'in_progress' && 'border-primary/35 bg-primary/[0.08] text-primary hover:bg-primary/15',
                )}
              >
                {idx + 1}
              </DsButton>
            );
          })}
        </CustomScrollArea>
        <div className="flex items-center gap-3 mt-3 pt-2 border-t border-border/35 text-2xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-success" /> {t('editor.legendMastered')}</span>
          <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-warning" /> {t('editor.legendReview')}</span>
          <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/35" /> {t('editor.legendNew')}</span>
        </div>
      </PopoverContent>
    </Popover>
  );
};
