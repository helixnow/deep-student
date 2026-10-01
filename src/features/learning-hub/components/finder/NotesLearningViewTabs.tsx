import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListBullets, Kanban, CalendarCheck } from '@phosphor-icons/react';
import type { NoteLearningView } from '@/features/notes/noteLearningProps';
import './NotesLearningViewTabs.css';

export type NotesLearningFinderView = Exclude<NoteLearningView, 'tree'>;
const STORAGE_KEY = 'learningHub.notesLearningView';
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
  return [view, update];
}

/** Notion 式数据库视图标签：仅在 Finder「笔记」智能文件夹出现，切换同一份列表的投影 */
export function NotesLearningViewTabs({ value, onChange }: { value: NotesLearningFinderView; onChange: (view: NotesLearningFinderView) => void }) {
  const { t } = useTranslation('notes');
  return (
    <div className="nlvt" role="tablist" aria-label={t('learning.views_label')}>
      {VIEWS.map(({ key, icon: Icon }) => (
        <button key={key} type="button" role="tab" aria-selected={value === key} className="nlvt-tab"
          onClick={() => onChange(key)}>
          <Icon size={14} aria-hidden="true" />
          <span>{key === 'list' ? t('learning.views.all', { defaultValue: '全部' }) : t(`learning.views.${key}`)}</span>
        </button>
      ))}
    </div>
  );
}
