/**
 * 匹配题作答组件：点选连线配对
 *
 * - 先点左列再点右列自动结对（也支持先右后左）
 * - 已配对项以同色编号徽标标识，点击任一侧可拆开
 * - 提交后逐对揭示正误，并列出漏配的标准配对
 * - 触控目标 ≥ 44px，窄容器下两列自适应
 *
 * 2026-07 题库题型扩展
 */

import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Check, X, LinkSimple, ArrowRight } from '@phosphor-icons/react';
import { LatexText } from '@/components/LatexText';
import type { MatchingStructuredData, MatchingPair } from './structured';
import { isPairCorrect } from './structured';

export interface MatchingAnswerProps {
  data: MatchingStructuredData;
  pairs: MatchingPair[];
  onChange: (pairs: MatchingPair[]) => void;
  /** 已提交：禁用交互并进入揭示态 */
  submitted?: boolean;
  className?: string;
}

/** 配对配色（按结对顺序循环取色，双侧同色 = 视觉连线） */
const PAIR_TONES = [
  'border-sky-400/70 bg-sky-500/[0.08] text-sky-600 dark:text-sky-400',
  'border-amber-400/70 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400',
  'border-violet-400/70 bg-violet-500/[0.08] text-violet-600 dark:text-violet-400',
  'border-teal-400/70 bg-teal-500/[0.08] text-teal-600 dark:text-teal-400',
  'border-rose-400/70 bg-rose-500/[0.08] text-rose-600 dark:text-rose-400',
  'border-indigo-400/70 bg-indigo-500/[0.08] text-indigo-600 dark:text-indigo-400',
];

const PAIR_BADGE_TONES = [
  'bg-sky-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-teal-500',
  'bg-rose-500',
  'bg-indigo-500',
];

export const MatchingAnswer: React.FC<MatchingAnswerProps> = ({
  data,
  pairs,
  onChange,
  submitted = false,
  className,
}) => {
  const { t } = useTranslation('practice');
  const [pendingLeft, setPendingLeft] = useState<string | null>(null);
  const [pendingRight, setPendingRight] = useState<string | null>(null);

  // 题目切换（题面条目变化）时清空半选状态。
  // 用 keys 签名而非 data 引用：收藏/提交回写会替换题目对象让 data 换引用，
  // 但题面未变时不应清掉用户的半选。
  const itemsSignature = useMemo(
    () => [
      data.left.map((item) => item.key).join('\u0000'),
      data.right.map((item) => item.key).join('\u0000'),
    ].join('\u0001'),
    [data]
  );
  useEffect(() => {
    setPendingLeft(null);
    setPendingRight(null);
  }, [itemsSignature]);

  const pairIndexByLeft = useMemo(() => {
    const map = new Map<string, number>();
    pairs.forEach((pair, index) => map.set(pair.left, index));
    return map;
  }, [pairs]);

  const pairIndexByRight = useMemo(() => {
    const map = new Map<string, number>();
    pairs.forEach((pair, index) => map.set(pair.right, index));
    return map;
  }, [pairs]);

  const removePairAt = useCallback((index: number) => {
    onChange(pairs.filter((_, i) => i !== index));
  }, [pairs, onChange]);

  const addPair = useCallback((left: string, right: string) => {
    // 结对前先拆掉双方已有配对，保证一对一
    const next = pairs.filter((p) => p.left !== left && p.right !== right);
    next.push({ left, right });
    onChange(next);
    setPendingLeft(null);
    setPendingRight(null);
  }, [pairs, onChange]);

  const handleLeftClick = useCallback((key: string) => {
    if (submitted) return;
    const pairedIndex = pairIndexByLeft.get(key);
    if (pairedIndex !== undefined) {
      // 已配对：点击拆开
      removePairAt(pairedIndex);
      return;
    }
    if (pendingRight) {
      addPair(key, pendingRight);
      return;
    }
    setPendingLeft((prev) => (prev === key ? null : key));
  }, [submitted, pairIndexByLeft, pendingRight, removePairAt, addPair]);

  const handleRightClick = useCallback((key: string) => {
    if (submitted) return;
    const pairedIndex = pairIndexByRight.get(key);
    if (pairedIndex !== undefined) {
      removePairAt(pairedIndex);
      return;
    }
    if (pendingLeft) {
      addPair(pendingLeft, key);
      return;
    }
    setPendingRight((prev) => (prev === key ? null : key));
  }, [submitted, pairIndexByRight, pendingLeft, removePairAt, addPair]);

  const contentByKey = useMemo(() => {
    const map = new Map<string, string>();
    data.left.forEach((item) => map.set(`L:${item.key}`, item.content));
    data.right.forEach((item) => map.set(`R:${item.key}`, item.content));
    return map;
  }, [data]);

  /** 提交后漏配的标准配对（用户没配上，或配错了的项对应的正确答案） */
  const missedCorrectPairs = useMemo(() => {
    if (!submitted) return [];
    return data.pairs.filter(
      (correct) => !pairs.some((p) => p.left === correct.left && p.right === correct.right)
    );
  }, [submitted, data.pairs, pairs]);

  const renderItem = (
    side: 'left' | 'right',
    item: { key: string; content: string },
  ) => {
    const pairedIndex = side === 'left'
      ? pairIndexByLeft.get(item.key)
      : pairIndexByRight.get(item.key);
    const isPaired = pairedIndex !== undefined;
    const isPending = side === 'left' ? pendingLeft === item.key : pendingRight === item.key;
    const pair = isPaired ? pairs[pairedIndex] : null;
    // 标准答案缺失（pairs 为空）时不做本地判定，避免误标红
    const resultCorrect = submitted && pair && data.pairs.length > 0 ? isPairCorrect(pair, data) : null;
    const tone = isPaired ? PAIR_TONES[pairedIndex % PAIR_TONES.length] : '';
    const badgeTone = isPaired ? PAIR_BADGE_TONES[pairedIndex % PAIR_BADGE_TONES.length] : '';

    return (
      <button
        key={item.key}
        type="button"
        disabled={submitted}
        onClick={() => (side === 'left' ? handleLeftClick(item.key) : handleRightClick(item.key))}
        aria-pressed={isPaired || isPending}
        className={cn(
          'flex w-full min-h-[44px] items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors',
          !submitted && 'ui-press cursor-pointer',
          // 默认
          !isPaired && !isPending && 'border-border/50 bg-card/40 hover:border-foreground/25 hover:bg-foreground/[0.03]',
          // 半选（等待另一侧）
          isPending && 'border-primary/60 bg-primary/[0.07] dark:bg-primary/[0.14] ring-1 ring-inset ring-primary/30',
          // 已配对（未提交，或提交后无标准答案可判定）：同色标识
          isPaired && resultCorrect === null && tone,
          // 提交后揭示
          submitted && resultCorrect === true && 'border-success/60 bg-success/[0.08] dark:bg-success/[0.15]',
          submitted && resultCorrect === false && 'border-destructive/50 bg-destructive/[0.08] dark:bg-destructive/[0.15] qbank-anim-shake',
          submitted && !isPaired && 'border-border/40 opacity-55',
          'disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
        )}
      >
        {/* 配对徽标 / 待配对指示 */}
        <span
          className={cn(
            'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white transition-colors',
            isPaired && resultCorrect === null && badgeTone,
            submitted && resultCorrect === true && 'bg-success',
            submitted && resultCorrect === false && 'bg-destructive',
            !isPaired && 'bg-transparent border border-dashed border-foreground/25 text-transparent'
          )}
          aria-hidden
        >
          {submitted && resultCorrect === true ? (
            <Check size={11} weight="bold" />
          ) : submitted && resultCorrect === false ? (
            <X size={11} />
          ) : isPaired ? (
            pairedIndex + 1
          ) : (
            '·'
          )}
        </span>
        <LatexText content={item.content} className="min-w-0 flex-1 text-sm leading-relaxed" />
        {isPaired && !submitted && (
          <X size={12} className="flex-shrink-0 text-muted-foreground/60" aria-hidden />
        )}
      </button>
    );
  };

  return (
    <div className={cn('space-y-3', className)}>
      {/* 操作提示 + 已配对进度 */}
      {!submitted && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <LinkSimple size={13} className="flex-shrink-0" />
          <span>
            {pendingLeft || pendingRight
              ? t('editor.matching.pickOtherSide')
              : t('editor.matching.instruction')}
          </span>
          <span className="ml-auto tabular-nums">
            {t('editor.matching.pairedCount', {
              count: pairs.length,
              total: Math.min(data.left.length, data.right.length),
            })}
          </span>
        </div>
      )}

      {/* 左右两列 */}
      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t('editor.matching.leftColumn')}
          </div>
          {data.left.map((item) => renderItem('left', item))}
        </div>
        <div className="min-w-0 space-y-1.5">
          <div className="px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t('editor.matching.rightColumn')}
          </div>
          {data.right.map((item) => renderItem('right', item))}
        </div>
      </div>

      {/* 提交后：漏配 / 配错项的标准答案对照 */}
      {submitted && missedCorrectPairs.length > 0 && (
        <div className="ui-rise-in space-y-1.5 rounded-md border border-success/30 bg-success/[0.05] p-2.5">
          <div className="text-xs font-medium text-success">
            {t('editor.matching.correctPairs')}
          </div>
          {missedCorrectPairs.map((pair) => (
            <div key={`${pair.left}-${pair.right}`} className="flex items-center gap-1.5 text-sm">
              <LatexText
                content={contentByKey.get(`L:${pair.left}`) || pair.left}
                className="min-w-0 text-foreground/80"
              />
              <ArrowRight size={12} className="flex-shrink-0 text-success" aria-hidden />
              <LatexText
                content={contentByKey.get(`R:${pair.right}`) || pair.right}
                className="min-w-0 text-foreground/80"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MatchingAnswer;
