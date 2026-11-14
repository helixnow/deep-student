import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cards, FolderOpen, Gear, LockSimple } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/utils/cn';
import type { StudySpace } from '@/shared/study-space/types';
import { formatSpaceCountdown, stripEmojiText } from '@/shared/study-space/spaceCountdown';
import {
  launchSpaceFlashcardReview,
  openSpaceFolderInHub,
} from './studySpaceActions';

export interface StudySpaceBadgeStripProps {
  space: StudySpace;
  onEditSpace?: () => void;
  onOpenFolder?: () => void;
  onReviewDeck?: () => void;
  className?: string;
}

export const StudySpaceBadgeStrip: React.FC<StudySpaceBadgeStripProps> = ({
  space,
  onEditSpace,
  onOpenFolder,
  onReviewDeck,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const [reviewBusy, setReviewBusy] = useState(false);

  const countdown = formatSpaceCountdown(space.examDate, { t });
  const retentionPercent = Math.round(space.targetRetention * 100);
  const cleanName = stripEmojiText(space.name) || space.spaceId;

  const handleOpenFolder = useCallback(() => {
    if (onOpenFolder) {
      onOpenFolder();
      return;
    }
    void openSpaceFolderInHub(space.rootFolderId, cleanName);
  }, [cleanName, onOpenFolder, space.rootFolderId]);

  const handleReviewDeck = useCallback(async () => {
    if (reviewBusy) return;
    if (onReviewDeck) {
      onReviewDeck();
      return;
    }
    setReviewBusy(true);
    try {
      await launchSpaceFlashcardReview(space);
    } finally {
      setReviewBusy(false);
    }
  }, [onReviewDeck, reviewBusy, space]);

  const openHubLabel = (() => {
    const val = t('studySpace.fields.openInHub');
    return val && val !== 'studySpace.fields.openInHub' ? val : 'Open in Library';
  })();

  const reviewLabel = (() => {
    const val = t('studySpace.actions.reviewDeck');
    return val && val !== 'studySpace.actions.reviewDeck' ? val : 'Review Space Cards';
  })();

  const editLabel = (() => {
    const val = t('studySpace.editSpace');
    return val && val !== 'studySpace.editSpace' ? val : 'Edit Study Space';
  })();

  const kbScopedLabel = (() => {
    const val = t('studySpace.badges.kbAutoScoped');
    return val && val !== 'studySpace.badges.kbAutoScoped' ? val : 'Scoped to Space KB';
  })();

  const budgetLabel = (() => {
    const val = t('studySpace.badges.budgetMinutes', {
      minutes: space.dailyBudgetMinutes,
    });
    return val && !val.includes('budgetMinutes') && !val.includes('{{')
      ? val
      : `${space.dailyBudgetMinutes}m`;
  })();

  return (
    <div
      data-testid="study-space-badge-strip"
      className={cn(
        'flex min-h-7 flex-wrap items-center justify-between gap-1.5 rounded-[var(--radius-shell-control)] border border-border/35 bg-[var(--surface-elevated)] px-2.5 py-1 text-xs',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand-primary)]"
          style={space.color ? { backgroundColor: space.color } : undefined}
        />
        <span className="truncate font-medium text-foreground" title={cleanName}>
          {cleanName}
        </span>

        {space.rootFolderId ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
            title={kbScopedLabel}
          >
            <LockSimple size={11} className="shrink-0" />
            <span className="hidden sm:inline">{kbScopedLabel}</span>
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {countdown ? (
          <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-foreground">
            <span
              aria-hidden="true"
              className={cn('h-1.5 w-1.5 shrink-0 rounded-full', countdown.dotColorClass)}
            />
            <span>{countdown.label}</span>
          </span>
        ) : null}

        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {budgetLabel}
        </span>

        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {retentionPercent}%
        </span>

        <div className="flex items-center gap-0.5 border-l border-border/35 pl-1">
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            type="button"
            onClick={handleOpenFolder}
            aria-label={openHubLabel}
            title={openHubLabel}
            className="!h-6 !w-6 [@media(pointer:coarse)]:!min-h-9 [@media(pointer:coarse)]:!min-w-9 text-muted-foreground hover:text-foreground"
          >
            <FolderOpen size={13} />
          </DsButton>

          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            type="button"
            disabled={reviewBusy}
            onClick={() => void handleReviewDeck()}
            aria-label={reviewLabel}
            title={reviewLabel}
            className="!h-6 !w-6 [@media(pointer:coarse)]:!min-h-9 [@media(pointer:coarse)]:!min-w-9 text-muted-foreground hover:text-foreground"
          >
            <Cards size={13} />
          </DsButton>

          {onEditSpace ? (
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              type="button"
              onClick={onEditSpace}
              aria-label={editLabel}
              title={editLabel}
              className="!h-6 !w-6 [@media(pointer:coarse)]:!min-h-9 [@media(pointer:coarse)]:!min-w-9 text-muted-foreground hover:text-foreground"
            >
              <Gear size={13} />
            </DsButton>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default StudySpaceBadgeStrip;
