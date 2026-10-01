import React from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from '@phosphor-icons/react';
import {
  learningPropsFromMetadata, localCalendarDate, MASTERY_STATES, readNoteLearningProps,
  selectLearningViewNotes, type LearningViewNote, type NoteLearningView,
} from '../noteLearningProps';
import { NoteGlyph } from './NoteGlyph';
import './NoteLearningViews.css';

/** The host owns loading, filtering and DSTU subscriptions. This component never copies note data. */
export function NoteLearningViews<T extends LearningViewNote>({ notes, view, onOpen, activeId, now = new Date() }: {
  notes: readonly T[];
  view: NoteLearningView;
  onOpen: (note: T) => void;
  activeId?: string | null;
  now?: Date;
}) {
  const { t } = useTranslation('notes');
  const selected = selectLearningViewNotes(notes, view, now);
  const today = localCalendarDate(now);
  const groups = view === 'status'
    ? [...MASTERY_STATES, 'unset' as const].map((state) => ({
      key: state,
      label: state === 'unset' ? t('learning.unset_group') : t(`learning.mastery.${state}`),
      notes: selected.filter((note) => (readNoteLearningProps(learningPropsFromMetadata(note.metadata)).mastery ?? 'unset') === state),
    }))
    : [{ key: view, label: view === 'review' ? t('learning.review_range') : t('learning.views.list'), notes: selected }];
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
              return <li key={note.id}>
                <button type="button" className="nlv-row" aria-current={note.id === activeId ? 'true' : undefined} onClick={() => onOpen(note)}>
                  <span className="nlv-row-icon"><NoteGlyph noteId={note.id} size={16} fallback={<FileText size={16} aria-hidden="true" />} /></span>
                  <span className="nlv-row-body">
                    <span className="nlv-row-title">{note.name}</span>
                    {subtitle && <span className="nlv-row-sub">{subtitle}</span>}
                  </span>
                  <span className="nlv-row-chips">
                    {view !== 'status' && props.mastery && <span className="nlv-chip" data-mastery={props.mastery}>{t(`learning.mastery.${props.mastery}`)}</span>}
                    {props.reviewDate && <span className="nlv-chip" data-due={due}>
                      {props.reviewDate}{due === 'overdue' ? ` · ${t('learning.overdue')}` : due === 'today' ? ` · ${t('learning.today')}` : ''}
                    </span>}
                  </span>
                </button>
              </li>;
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
