/**
 * ChatAnki LLM critic（AI 质检终审）块级摘要横幅。
 *
 * 数据来源：后端 `emit_critic_summary`（streaming_anki_service.rs）派发的
 * `CriticSummary` 事件载荷，wire 格式为 snake_case
 * （examined / kept / revised / flagged / rejected_unknown_ids /
 * skipped_over_budget / gold_references / gold_references_truncated /
 * persist_failures / degraded，另有可选 routed_* 路由观测字段）。
 * TauriAdapter.handleAnkiGenerationEvent 归一化为 camelCase 后 patch 进
 * `block.toolOutput.criticSummary`（AnkiCardsBlockData 已正式声明该字段，
 * 类型见 ankiCardsBlockState.AnkiCriticSummary）。本组件仍接受 `unknown`
 * 并在内部宽松解析（同时兼容 snake_case 与 camelCase）：这是对历史
 * 会话持久化数据与后端序列化策略调整的防御边界；本横幅只渲染其中
 * 与用户相关的子集（rejectedUnknownIds / goldReferencesTruncated /
 * routed_* 仅用于调试面板观测，不在横幅展示）。
 *
 * 呈现规则：
 * - 无数据（undefined / 非对象 / 全零且未降级）→ 不渲染；
 * - degraded 非空 → 警示色，展示降级说明（本批卡片未经终审直接保留），
 *   不再展示 kept/revised/flagged 统计句（此时统计无意义）；
 * - 正常 → 摘要句（examined/kept/revised/flagged），并按需追加
 *   skippedOverBudget / goldReferences / persistFailures 明细行；
 * - persistFailures > 0（修订写回失败）单独用警示色标出。
 *
 * 与 AnkiQaFlagBadge 的分工：徽标负责**单卡**的 `_qa_flags` 结构化展示
 * （flaggedFlag / revisedFlag），本横幅只做**任务级**聚合统计，二者
 * 共用 `agent.critic.*` 词条但互不依赖。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Info, Warning } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';

/** 解析收紧后的任务级 critic 摘要。 */
export interface AnkiCriticSummary {
  examined: number;
  kept: number;
  revised: number;
  flagged: number;
  /** 因 token 预算 / 单次上限被跳过未评审的卡片数。 */
  skippedOverBudget: number;
  /** 实际注入 prompt 的同源金标参照对数（0 = 规则 rubric 模式）。 */
  goldReferences: number;
  /** 修订写回（持久化）失败的卡片数。 */
  persistFailures: number;
  /** 非 null 表示本次 critic 降级（模型失败/超时/解析失败）。 */
  degraded: string | null;
}

function readCount(raw: Record<string, unknown>, snake: string, camel: string): number {
  const value = raw[snake] ?? raw[camel];
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return 0;
}

/**
 * 宽松解析后端透传的 critic 摘要（兼容 snake_case wire 格式与 camelCase）。
 * 返回 null 表示无可展示内容（调用方/组件据此不渲染）。
 */
export function parseAnkiCriticSummary(raw: unknown): AnkiCriticSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;

  const degradedRaw = source['degraded'];
  const degraded =
    typeof degradedRaw === 'string' && degradedRaw.trim().length > 0 ? degradedRaw : null;

  const summary: AnkiCriticSummary = {
    examined: readCount(source, 'examined', 'examined'),
    kept: readCount(source, 'kept', 'kept'),
    revised: readCount(source, 'revised', 'revised'),
    flagged: readCount(source, 'flagged', 'flagged'),
    skippedOverBudget: readCount(source, 'skipped_over_budget', 'skippedOverBudget'),
    goldReferences: readCount(source, 'gold_references', 'goldReferences'),
    persistFailures: readCount(source, 'persist_failures', 'persistFailures'),
    degraded,
  };

  const hasSignal =
    summary.examined > 0 ||
    summary.skippedOverBudget > 0 ||
    summary.persistFailures > 0 ||
    summary.degraded !== null;
  return hasSignal ? summary : null;
}

export const AnkiCriticSummaryBanner: React.FC<{
  /** 后端透传的 critic 摘要（形状未收紧，内部宽松解析；缺失/无效时不渲染）。 */
  criticSummary?: unknown;
  className?: string;
}> = ({ criticSummary, className }) => {
  const { t } = useTranslation('anki');
  const summary = React.useMemo(() => parseAnkiCriticSummary(criticSummary), [criticSummary]);

  if (!summary) return null;

  const isDegraded = summary.degraded !== null;
  const hasWriteBackFailure = summary.persistFailures > 0;
  const warnTone = isDegraded || hasWriteBackFailure;

  return (
    <div
      role="note"
      data-testid="chatanki-critic-summary"
      data-degraded={isDegraded ? 'true' : 'false'}
      className={cn(
        'ui-rise-in mt-2 flex items-start gap-1.5 rounded-lg border px-3 py-1.5 text-xs leading-snug',
        warnTone
          ? 'border-warning/40 bg-warning/10 text-warning'
          : 'border-border bg-muted/40 text-muted-foreground',
        className,
      )}
    >
      {warnTone ? (
        <Warning size={14} weight="fill" className="mt-0.5 flex-shrink-0" aria-hidden="true" />
      ) : (
        <Info size={14} weight="fill" className="mt-0.5 flex-shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0 space-y-0.5">
        <div>
          <span className="font-medium">{t('agent.critic.title')}</span>
          {' · '}
          {isDegraded ? (
            <span data-testid="chatanki-critic-degraded">{t('agent.critic.degraded')}</span>
          ) : (
            <span data-testid="chatanki-critic-sentence">
              {t('agent.critic.summary', {
                examined: summary.examined,
                kept: summary.kept,
                revised: summary.revised,
                flagged: summary.flagged,
              })}
            </span>
          )}
        </div>
        {summary.skippedOverBudget > 0 && (
          <div data-testid="chatanki-critic-skipped" className="opacity-90">
            {t('agent.critic.skippedOverBudget', { count: summary.skippedOverBudget })}
          </div>
        )}
        {summary.goldReferences > 0 && (
          <div data-testid="chatanki-critic-gold" className="opacity-90">
            {t('agent.critic.goldReferences', { count: summary.goldReferences })}
          </div>
        )}
        {hasWriteBackFailure && (
          <div data-testid="chatanki-critic-persist-failures" className="font-medium">
            {t('agent.critic.persistFailures', { count: summary.persistFailures })}
          </div>
        )}
      </div>
    </div>
  );
};
