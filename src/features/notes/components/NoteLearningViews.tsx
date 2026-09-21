import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  learningPropsFromMetadata, localCalendarDate, MASTERY_STATES, readNoteLearningProps,
  selectLearningViewNotes, type LearningViewNote, type NoteLearningView,
} from '../noteLearningProps';

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
      label: state === 'unset' ? t('learning.unset_group') : t(`learning.mastery.${state}`),
      notes: selected.filter((note) => (readNoteLearningProps(learningPropsFromMetadata(note.metadata)).mastery ?? 'unset') === state),
    }))
    : [{ label: view === 'review' ? t('learning.review_range') : t('learning.views.list'), notes: selected }];
  return (
    <div className="h-full space-y-3 overflow-y-auto p-3 text-xs" aria-label={t('learning.views_label')}>
      {groups.map((group) => (
        <section key={group.label}>
          <h3 className="mb-1 font-medium text-muted-foreground">{group.label} · {group.notes.length}</h3>
          {group.notes.length === 0 && <p className="py-2 text-muted-foreground">{t('learning.empty')}</p>}
          <ul className="space-y-1">
            {group.notes.map((note) => {
              const props = readNoteLearningProps(learningPropsFromMetadata(note.metadata));
              return <li key={note.id}>
                <button type="button" className="w-full rounded px-2 py-2 text-left hover:bg-muted aria-[current=true]:bg-muted"
                  aria-current={note.id === activeId ? 'true' : undefined} onClick={() => onOpen(note)}>
                  <span className="block break-words font-medium">{note.name}</span>
                  {(props.course || props.chapter) && <span className="block text-muted-foreground">{[props.course, props.chapter].filter(Boolean).join(' / ')}</span>}
                  <span className="block text-muted-foreground">{props.mastery ? t(`learning.mastery.${props.mastery}`) : t('learning.mastery_unset')}</span>
                  {props.reviewDate && <span className="block text-muted-foreground">{props.reviewDate}{props.reviewDate < today ? ` · ${t('learning.overdue')}` : props.reviewDate === today ? ` · ${t('learning.today')}` : ''}</span>}
                </button>
              </li>;
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
