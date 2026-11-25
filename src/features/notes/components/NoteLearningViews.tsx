import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, FileText, Trash } from '@phosphor-icons/react';
import { AppMenu, AppMenuContent, AppMenuItem, AppMenuTrigger } from '@/components/ui/app-menu/AppMenu';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  learningPropsFromMetadata, localCalendarDate, MASTERY_STATES, readNoteLearningProps,
  selectLearningViewNotes, type LearningViewNote, type NoteLearningView,
} from '../noteLearningProps';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { moveNoteToTrash } from '../moveNoteToTrash';
import { NOTE_REVIEW_INTERVALS, rescheduleNoteReview } from '../noteReviewSchedule';
import { NoteGlyph } from './NoteGlyph';
import './NoteLearningViews.css';

/** 「近期复习」行尾：复习完成后选下次时间（或标记掌握），不用再打开属性面板手改日期。 */
function ReviewDoneMenu({ noteId }: { noteId: string }) {
  const { t } = useTranslation('notes');
  const [busy, setBusy] = useState(false);
  const choose = (days: number | null) => {
    if (busy) return;
    setBusy(true);
    rescheduleNoteReview(noteId, days)
      .then((nextDate) => showGlobalNotification('success', nextDate
        ? t('learning.review_done.scheduled', { date: nextDate })
        : t('learning.review_done.cleared')))
      .catch((error: unknown) => showGlobalNotification('error', t('learning.review_done.failed', {
        error: error instanceof Error ? error.message : String(error),
      })))
      .finally(() => setBusy(false));
  };
  return (
    <AppMenu>
      <AppMenuTrigger asChild>
        <DsButton variant="ghost" size="sm" disabled={busy} className="nlv-review-done" title={t('learning.review_done.menu')}>
          <CheckCircle size={14} aria-hidden="true" />
          <span className="nlv-review-done-label">{t('learning.review_done.label')}</span>
        </DsButton>
      </AppMenuTrigger>
      <AppMenuContent align="end" width={180}>
        {NOTE_REVIEW_INTERVALS.map((days) => (
          <AppMenuItem key={days} onClick={() => choose(days)}>{t(`learning.review_done.d${days}`)}</AppMenuItem>
        ))}
        <AppMenuItem onClick={() => choose(null)}>{t('learning.review_done.mastered')}</AppMenuItem>
      </AppMenuContent>
    </AppMenu>
  );
}

/** The host owns loading, filtering and DSTU subscriptions. This component never copies note data. */
export function NoteLearningViews<T extends LearningViewNote>({ notes, view, onOpen, onMoveToTrash, activeId, now = new Date() }: {
  notes: readonly T[];
  view: NoteLearningView;
  onOpen: (note: T) => void;
  onMoveToTrash?: (note: T) => void | Promise<void>;
  activeId?: string | null;
  now?: Date;
}) {
  const { t } = useTranslation('notes');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const selected = selectLearningViewNotes(notes, view, now);
  const today = localCalendarDate(now);
  const groups = view === 'status'
    ? [...MASTERY_STATES, 'unset' as const].map((state) => ({
      key: state,
      label: state === 'unset' ? t('learning.unset_group') : t(`learning.mastery.${state}`),
      notes: selected.filter((note) => (readNoteLearningProps(learningPropsFromMetadata(note.metadata)).mastery ?? 'unset') === state),
    }))
    : [{ key: view, label: view === 'review' ? t('learning.review_range') : t('learning.views.list'), notes: selected }];

  const handleTrashNote = async (note: T) => {
    if (deletingId === note.id) return;
    setDeletingId(note.id);
    try {
      if (onMoveToTrash) {
        await onMoveToTrash(note);
      } else {
        await moveNoteToTrash({ noteId: note.id, noteTitle: note.name });
      }
    } finally {
      setDeletingId((current) => (current === note.id ? null : current));
    }
  };

  return (
    <div className="nlv" aria-label={t('learning.views_label')}>
      {groups.map((group) => (
        <section key={group.key} className="nlv-group" data-mastery={view === 'status' ? group.key : undefined}>
          <h3 className="nlv-group-label">
            {view === 'status' && <i className="nlv-dot" aria-hidden="true" />}
            {group.label} · {group.notes.length}
          </h3>
          {group.notes.length === 0 && <p className="nlv-empty">
            {t(view === 'review' ? 'learning.review_empty' : view === 'status' ? 'learning.group_empty' : 'learning.empty')}
          </p>}
          <ul className="nlv-list">
            {group.notes.map((note) => {
              const props = readNoteLearningProps(learningPropsFromMetadata(note.metadata));
              const due = props.reviewDate ? (props.reviewDate < today ? 'overdue' : props.reviewDate === today ? 'today' : 'later') : undefined;
              const subtitle = [props.course, props.chapter].filter(Boolean).join(' / ');
              return <li key={note.id} className="nlv-item">
                <button
                  type="button"
                  className="nlv-row"
                  title={note.name}
                  aria-current={note.id === activeId ? 'true' : undefined}
                  onClick={() => onOpen(note)}
                  onKeyDown={(event) => {
                    if (isComposingKeyEvent(event)) return;
                    const isDeleteKey = event.key === 'Delete' && !event.ctrlKey && !event.metaKey && !event.altKey;
                    const isBackspaceKey = event.key === 'Backspace' && !event.ctrlKey && !event.altKey;
                    if (!isDeleteKey && !isBackspaceKey) return;
                    const targetEl = event.target as HTMLElement | null;
                    if (targetEl?.closest('input, textarea, [contenteditable="true"]')) return;
                    event.preventDefault();
                    event.stopPropagation();
                    void handleTrashNote(note);
                  }}
                >
                  <span className="nlv-row-icon"><NoteGlyph noteId={note.id} size={16} fallback={<FileText size={16} aria-hidden="true" />} /></span>
                  <span className="nlv-row-body">
                    <span className="nlv-row-title">{note.name}</span>
                    {subtitle && <span className="nlv-row-sub" title={subtitle}>{subtitle}</span>}
                  </span>
                  <span className="nlv-row-chips">
                    {view !== 'status' && props.mastery && <span className="nlv-chip" data-mastery={props.mastery}>{t(`learning.mastery.${props.mastery}`)}</span>}
                    {props.reviewDate && <span className="nlv-chip" data-due={due}>
                      {props.reviewDate}{due === 'overdue' ? ` · ${t('learning.overdue')}` : due === 'today' ? ` · ${t('learning.today')}` : ''}
                    </span>}
                  </span>
                </button>
                {view === 'review' && <ReviewDoneMenu noteId={note.id} />}
                <button
                  type="button"
                  className="nlv-trash-btn"
                  aria-label={t('actions.move_to_trash', { defaultValue: '移至回收站' })}
                  title={t('actions.move_to_trash_item', { title: note.name || t('common.untitled', '未命名'), defaultValue: `移至回收站：${note.name || '未命名'}` })}
                  disabled={deletingId === note.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleTrashNote(note);
                  }}
                >
                  <Trash size={14} aria-hidden="true" />
                </button>
              </li>;
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
