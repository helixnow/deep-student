import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Target } from '@phosphor-icons/react';
import { sendSelectionToChatInput } from '@/features/pdf/selectionStudyActions';

interface MasteryState { conceptKey: string; score: number; total: number; wrongCount: number }
interface MasteryOverview { conceptCount: number; weakCount: number; avgScore: number; weakest: MasteryState[] }

/**
 * 薄弱知识点（来自练习 / 复习的掌握度）：学习者终于能看见自己的薄弱点，
 * 点一下即在对话里「讲 + 练」——薄弱点 → 讲解 → 练习 → 掌握度回升，闭环。
 */
export const WeakConceptsStrip: React.FC = () => {
  const { t } = useTranslation('data');
  const [weak, setWeak] = useState<MasteryState[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<MasteryOverview>('mastery_get_overview', { limit: 8 })
      // item:<id> 是无标签题目的兜底键，对学习者无意义
      .then((overview) => { if (!cancelled) setWeak(overview.weakest.filter((s) => !s.conceptKey.startsWith('item:'))); })
      .catch(() => { if (!cancelled) setWeak([]); });
    return () => { cancelled = true; };
  }, []);

  if (!weak || weak.length === 0) return null;

  const practice = (concept: string) => {
    sendSelectionToChatInput({
      text: t('today_center.weak_prompt', {
        defaultValue: '帮我针对薄弱知识点「{{concept}}」复习：先用三句话讲清核心概念，再出 3 道由浅入深的练习题，最后告诉我最容易错在哪里。',
        concept,
      }),
    });
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
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
