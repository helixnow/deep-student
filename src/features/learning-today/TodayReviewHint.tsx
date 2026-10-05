/**
 * 对话首页（空会话）输入框旁的「今日待复习」：学习者打开应用落在这里，
 * 不必绕到统计页 / 闪卡页才知道今天该复习什么。三条复习线与首页「今日学习」同口径；
 * 有作答记录后第二行给出薄弱知识点（一键讲练）与本周周报。
 * 还没有任何卡片、错题和作答记录的新用户，显示一行「三步走通」引导（可关）。
 */
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Books, Cards, Notebook, WarningDiamond, X } from '@phosphor-icons/react';
import { WeakConceptsStrip, useWeakConcepts } from '@/components/dashboard/WeakConceptsStrip';
import { WeeklyReportActions } from '@/components/dashboard/WeeklyReportActions';
import { getTodayLearningSnapshot, refreshTodayLearning, subscribeTodayLearning } from './todayLearningStore';
import { openResourceLibrary, openTodayReviewTarget } from './openTodayReview';

const WEAK_CONCEPTS_ON_HOME = 3;
const STARTER_DISMISSED_KEY = 'learningToday.starterDismissed';

function readStarterDismissed(): boolean {
  try {
    return localStorage.getItem(STARTER_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export const TodayReviewHint: React.FC = () => {
  const { t } = useTranslation('data');
  const today = useSyncExternalStore(subscribeTodayLearning, getTodayLearningSnapshot, getTodayLearningSnapshot);
  const weak = useWeakConcepts(WEAK_CONCEPTS_ON_HOME);
  const [starterDismissed, setStarterDismissed] = useState(readStarterDismissed);
  useEffect(() => { void refreshTodayLearning(); }, []);

  const items = [
    { key: 'cards', count: today.cards, icon: <Cards size={14} aria-hidden="true" />, label: t('today_center.cards_due', { defaultValue: '到期卡片' }), onClick: () => openTodayReviewTarget('cards') },
    { key: 'mistakes', count: today.mistakes, icon: <WarningDiamond size={14} aria-hidden="true" />, label: t('today_center.mistakes_due', { defaultValue: '错题复习' }), onClick: () => openTodayReviewTarget('mistakes') },
    { key: 'notes', count: today.notes, icon: <Notebook size={14} aria-hidden="true" />, label: t('today_center.notes_due', { defaultValue: '待复习笔记' }), onClick: () => openTodayReviewTarget('notes') },
  ].filter((item) => item.count > 0);
  const hasWeak = Boolean(weak && weak.length > 0);
  // 只有两项总数都确实读到且为 0 才算新用户：读取失败（缺省）时不打扰
  const isNewLearner = today.cardsTotal === 0 && today.plansTotal === 0 && items.length === 0 && weak !== null && !hasWeak;
  const showStarter = isNewLearner && !starterDismissed;

  if (showStarter) {
    const dismiss = () => {
      setStarterDismissed(true);
      try { localStorage.setItem(STARTER_DISMISSED_KEY, '1'); } catch { /* 偏好写入失败只影响下次是否再显示 */ }
    };
    return (
      <div className="mt-3 flex flex-wrap items-center justify-center gap-x-1 gap-y-1 text-xs text-muted-foreground" data-testid="today-starter">
        <span className="font-medium text-foreground">{t('today_center.starter_title', { defaultValue: '第一次用？三步走通' })}</span>
        <span>{t('today_center.starter_steps', { defaultValue: '导入资料 → 在资料菜单里选「用这份资料制卡」→ 每天回这里复习' })}</span>
        <button
          type="button"
          onClick={openResourceLibrary}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-foreground transition-colors hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]"
        >
          <Books size={14} aria-hidden="true" />
          {t('today_center.starter_action', { defaultValue: '打开资源库' })}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('today_center.starter_dismiss', { defaultValue: '不再显示' })}
          title={t('today_center.starter_dismiss', { defaultValue: '不再显示' })}
          className="inline-flex items-center rounded-full p-1 transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground [@media(pointer:coarse)]:min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:min-w-[var(--touch-target-size)] [@media(pointer:coarse)]:justify-center"
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    );
  }

  // 有卡片或复习计划（做过题）就留着周报入口：没到期、薄弱点又只有无标签题时也能看本周周报
  const hasHistory = (today.cardsTotal ?? 0) > 0 || (today.plansTotal ?? 0) > 0;
  if (items.length === 0 && !hasWeak && !hasHistory) return null;

  return (
    <div className="mt-3 flex flex-col items-center gap-1" data-testid="today-review-hint">
      {items.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1 text-xs text-muted-foreground">
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
      )}
      <div className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1">
        <WeakConceptsStrip concepts={weak} limit={WEAK_CONCEPTS_ON_HOME} className="mt-0 justify-center" />
        <WeeklyReportActions compact />
      </div>
    </div>
  );
};
