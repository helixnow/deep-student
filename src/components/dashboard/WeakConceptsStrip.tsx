import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Target } from '@phosphor-icons/react';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { cn } from '@/lib/utils';

export interface MasteryState { conceptKey: string; score: number; total: number; wrongCount: number }
interface MasteryOverview { conceptCount: number; weakCount: number; avgScore: number; weakest: MasteryState[] }

/** 最薄弱的若干知识点；读取失败或无数据时为空数组，加载中为 null。 */
export function useWeakConcepts(limit = 8, enabled = true): MasteryState[] | null {
  const [weak, setWeak] = useState<MasteryState[] | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    invoke<MasteryOverview>('mastery_get_overview', { limit })
      // item:<id> 是无标签题目的兜底键，对学习者无意义
      .then((overview) => { if (!cancelled) setWeak(overview.weakest.filter((s) => !s.conceptKey.startsWith('item:'))); })
      .catch(() => { if (!cancelled) setWeak([]); });
    return () => { cancelled = true; };
  }, [limit, enabled]);
  return weak;
}

interface WeakConceptsStripProps {
  /** 由调用方提供时不再自行读取（对话首页与「今日待复习」共用一次读取） */
  concepts?: MasteryState[] | null;
  limit?: number;
  className?: string;
}

/**
 * 薄弱知识点（来自练习 / 复习的掌握度）：点一下新开对话「讲 + 练」，并请 AI 把练习题写进题目集——
 * 只有在题目集里作答才会回写掌握度，薄弱点 → 讲解 → 练习 → 掌握度回升才能闭环。
 */
export const WeakConceptsStrip: React.FC<WeakConceptsStripProps> = ({ concepts, limit = 8, className }) => {
  const { t } = useTranslation('data');
  const fetched = useWeakConcepts(limit, concepts === undefined);
  const weak = (concepts === undefined ? fetched : concepts)?.slice(0, limit);

  if (!weak || weak.length === 0) return null;

  const practice = (concept: string) => {
    dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, {
      content: t('today_center.weak_prompt', {
        defaultValue: '帮我针对薄弱知识点「{{concept}}」复习：先用三句话讲清核心概念；再出 3 道由浅入深的练习题，用题库工具写进题目集「薄弱点练习」，每道题的第一个知识点标签写「{{concept}}」，我会在题目集里作答，这样掌握度才会更新；最后告诉我最容易错在哪里。',
        concept,
      }),
      autoSend: false,
      newSession: true,
    });
  };

  return (
    <div className={cn('mt-3 flex flex-wrap items-center gap-1.5', className)}>
      <span className="mr-1 inline-flex items-center gap-1 text-[12px] text-muted-foreground">
        <Target size={13} aria-hidden="true" />{t('today_center.weak_title', { defaultValue: '薄弱知识点' })}
      </span>
      {weak.map((state) => (
        <button key={state.conceptKey} type="button" onClick={() => practice(state.conceptKey)}
          title={t('today_center.weak_hint', { defaultValue: '在对话中讲解并练习', total: state.total })}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[12px] text-foreground transition-colors hover:bg-muted/60 [@media(pointer:coarse)]:min-h-11">
          <span className="max-w-[10em] truncate">{state.conceptKey}</span>
          <span className={state.score < 0.4 ? 'text-[color:hsl(var(--destructive))]' : 'text-[color:hsl(var(--warning,38_92%_45%))]'}>
            {Math.round(state.score * 100)}%
          </span>
        </button>
      ))}
    </div>
  );
};
