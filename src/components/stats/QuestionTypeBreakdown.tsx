/**
 * 题型分布与正确率组件
 *
 * 2026-07 新增：统计页按题型（13 种契约题型）展示题量分布 + 各题型正确率。
 *
 * 功能特性：
 * - 水平条形图（题量占比），颜色从语义 token 派生，深浅色模式自适应
 * - 每行右侧展示正确率徽标（按 attempt/correct 聚合；无作答显示占位）
 * - 行入场 ui-rise-in 错峰动画，条宽 mount 后过渡展开
 * - 数据来自 store 已加载题目；分页未取全时显示"基于已加载题目"提示
 * - 未知题型归入"其他"，不因题型契约扩展而崩溃
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ChartBarHorizontal } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import { percentOf } from './percent';
import {
  QUESTION_TYPE_ORDER,
  isKnownQuestionType,
  questionTypeColor,
  questionTypeLabelKey,
} from './questionTypeMeta';

// ============================================================================
// 类型定义
// ============================================================================

export interface QuestionTypeBreakdownProps {
  className?: string;
}

interface TypeRow {
  type: string;
  count: number;
  attempts: number;
  correct: number;
}

// ============================================================================
// 小工具
// ============================================================================

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** 正确率徽标着色（与 KnowledgeRadar 的 masteryTone 阈值一致） */
function accuracyToneClass(rate: number): string {
  if (rate >= 80) return 'text-success bg-success/10';
  if (rate >= 60) return 'text-info bg-info/10';
  if (rate >= 40) return 'text-warning bg-warning/10';
  return 'text-destructive bg-destructive/10';
}

// ============================================================================
// 主组件
// ============================================================================

export const QuestionTypeBreakdown: React.FC<QuestionTypeBreakdownProps> = ({ className }) => {
  const { t } = useTranslation('stats');
  const { questions, hasMore } = useQuestionBankStore(
    useShallow((state) => ({
      questions: state.questions,
      hasMore: state.pagination.hasMore,
    }))
  );

  // 条宽入场：先以 0 宽渲染，mount 后过渡到真实宽度
  const [entered, setEntered] = useState(() => prefersReducedMotion());

  const rows = useMemo<TypeRow[]>(() => {
    const byType = new Map<string, TypeRow>();
    for (const q of questions.values()) {
      const rawType = q.question_type || 'other';
      const type = isKnownQuestionType(rawType) ? rawType : 'other';
      const row = byType.get(type) ?? { type, count: 0, attempts: 0, correct: 0 };
      row.count += 1;
      row.attempts += Number.isFinite(q.attempt_count) ? q.attempt_count : 0;
      row.correct += Number.isFinite(q.correct_count) ? q.correct_count : 0;
      byType.set(type, row);
    }
    // 按契约顺序输出，只保留有题目的题型
    return QUESTION_TYPE_ORDER
      .map(type => byType.get(type))
      .filter((row): row is TypeRow => !!row && row.count > 0);
  }, [questions]);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setEntered(true);
      return;
    }
    setEntered(false);
    const rafIds: number[] = [];
    rafIds.push(requestAnimationFrame(() => {
      rafIds.push(requestAnimationFrame(() => setEntered(true)));
    }));
    return () => rafIds.forEach(cancelAnimationFrame);
  }, [rows]);

  if (rows.length === 0) {
    return null;
  }

  const maxCount = Math.max(...rows.map(r => r.count));

  return (
    <div className={cn('rounded-xl border border-border bg-card p-5', className)}>
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ChartBarHorizontal size={20} className="text-primary" />
          <h3 className="font-semibold">{t('typeBreakdown.title')}</h3>
        </div>
        <span className="text-xs text-muted-foreground">
          {t('typeBreakdown.typeCount', { count: rows.length })}
        </span>
      </div>

      {/* 分页未取全提示 */}
      {hasMore && (
        <p className="text-xs text-muted-foreground mb-3">
          {t('typeBreakdown.partialHint')}
        </p>
      )}

      {/* 题型条形列表 */}
      <div className="space-y-2.5">
        {rows.map((row, index) => {
          const color = questionTypeColor(row.type);
          const widthPercent = maxCount > 0 ? (row.count / maxCount) * 100 : 0;
          const accuracy = percentOf(row.correct, row.attempts);
          return (
            <div
              key={row.type}
              className="ui-rise-in"
              style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
            >
              <div className="flex items-center justify-between gap-3 mb-1 text-xs">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span className="text-foreground truncate">{t(questionTypeLabelKey(row.type))}</span>
                  <span className="text-muted-foreground tabular-nums shrink-0">
                    {t('typeBreakdown.questionUnit', { count: row.count })}
                  </span>
                </span>
                {row.attempts > 0 ? (
                  <span className={cn('px-1.5 py-0.5 rounded font-medium tabular-nums shrink-0', accuracyToneClass(accuracy))}>
                    {accuracy}%
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded text-muted-foreground bg-muted/50 shrink-0">
                    {t('typeBreakdown.noAttempt')}
                  </span>
                )}
              </div>
              <div className="h-2 rounded-full bg-muted/50 overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: entered ? `${widthPercent}%` : '0%',
                    backgroundColor: color,
                    transition: `width 500ms cubic-bezier(0.22, 1, 0.36, 1) ${Math.min(index, 12) * 30}ms`,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default QuestionTypeBreakdown;
