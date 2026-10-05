/**
 * 对话首页（空会话）输入框下方的「今日待复习」一行：学习者打开应用落在这里，
 * 不必绕到统计页 / 闪卡页才知道今天该复习什么。三条复习线与首页「今日学习」同口径，
 * 全部为 0 时不渲染。
 */
import React, { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Cards, Notebook, WarningDiamond } from '@phosphor-icons/react';
import { getTodayLearningSnapshot, refreshTodayLearning, subscribeTodayLearning } from './todayLearningStore';
import { openTodayReviewTarget } from './openTodayReview';

export const TodayReviewHint: React.FC = () => {
  const { t } = useTranslation('data');
  const today = useSyncExternalStore(subscribeTodayLearning, getTodayLearningSnapshot, getTodayLearningSnapshot);
  useEffect(() => { void refreshTodayLearning(); }, []);

  const items = [
    { key: 'cards', count: today.cards, icon: <Cards size={14} aria-hidden="true" />, label: t('today_center.cards_due', { defaultValue: '到期卡片' }), onClick: () => openTodayReviewTarget('cards') },
    { key: 'mistakes', count: today.mistakes, icon: <WarningDiamond size={14} aria-hidden="true" />, label: t('today_center.mistakes_due', { defaultValue: '错题复习' }), onClick: () => openTodayReviewTarget('mistakes') },
    { key: 'notes', count: today.notes, icon: <Notebook size={14} aria-hidden="true" />, label: t('today_center.notes_due', { defaultValue: '待复习笔记' }), onClick: () => openTodayReviewTarget('notes') },
  ].filter((item) => item.count > 0);
  if (items.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-1 gap-y-1 text-xs text-muted-foreground" data-testid="today-review-hint">
      <span className="mr-1">{t('today_center.hint_title', { defaultValue: '今日待复习' })}</span>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={item.onClick}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]"
        >
          {item.icon}
          <span>{item.label}</span>
          <span className="tabular-nums font-medium text-foreground">{item.count}</span>
        </button>
      ))}
    </div>
  );
};
