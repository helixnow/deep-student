import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListBullets, Kanban, CalendarCheck } from '@phosphor-icons/react';
import type { NoteLearningView } from '@/features/notes/noteLearningProps';
import './NotesLearningViewTabs.css';

export type NotesLearningFinderView = Exclude<NoteLearningView, 'tree'>;
const STORAGE_KEY = 'learningHub.notesLearningView';
/** 外部（如首页「今日学习」）请求切换视图 */
export const NOTES_LEARNING_VIEW_EVENT = 'learningHub:notes-learning-view';
const VIEWS: Array<{ key: NotesLearningFinderView; icon: React.ElementType }> = [
  { key: 'list', icon: ListBullets },
  { key: 'status', icon: Kanban },
  { key: 'review', icon: CalendarCheck },
];

/** 记住上次选择的视图（per-viewer 偏好，读写失败时回退「全部」） */
export function useNotesLearningView(): [NotesLearningFinderView, (view: NotesLearningFinderView) => void] {
  const [view, setView] = useState<NotesLearningFinderView>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === 'status' || stored === 'review' ? stored : 'list';
    } catch { return 'list'; }
  });
  const update = useCallback((next: NotesLearningFinderView) => {
    setView(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* 偏好写入失败不影响切换 */ }
  }, []);
  useEffect(() => {
    const onRequest = (event: Event) => {
      const next = (event as CustomEvent<{ view?: string }>).detail?.view;
      if (next === 'list' || next === 'status' || next === 'review') update(next);
    };
    window.addEventListener(NOTES_LEARNING_VIEW_EVENT, onRequest);
    return () => window.removeEventListener(NOTES_LEARNING_VIEW_EVENT, onRequest);
  }, [update]);
  return [view, update];
}

/** Notion 式数据库视图标签条：Finder 智能文件夹顶部，切换同一入口下的不同投影 */
export function FinderViewTabs<T extends string>({ views, value, onChange, ariaLabel }: {
  views: Array<{ key: T; icon: React.ElementType; label: string }>;
  value: T;
  onChange: (view: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="nlvt" role="tablist" aria-label={ariaLabel}>
      {views.map(({ key, icon: Icon, label }) => (
        <button key={key} type="button" role="tab" aria-selected={value === key} className="nlvt-tab"
          onClick={() => onChange(key)}>
          <Icon size={14} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

/** 仅在 Finder「笔记」智能文件夹出现 */
export function NotesLearningViewTabs({ value, onChange }: { value: NotesLearningFinderView; onChange: (view: NotesLearningFinderView) => void }) {
  const { t } = useTranslation('notes');
  return (
    <FinderViewTabs
      views={VIEWS.map(({ key, icon }) => ({
        key,
        icon,
        label: key === 'list' ? t('learning.views.all', { defaultValue: '全部' }) : t(`learning.views.${key}`),
      }))}
      value={value}
      onChange={onChange}
      ariaLabel={t('learning.views_label')}
    />
  );
}
