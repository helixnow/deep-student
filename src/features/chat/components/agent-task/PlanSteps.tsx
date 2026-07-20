/**
 * agent-task/PlanSteps — 计划步骤列表
 *
 * - 状态点（pending/running/completed/failed/skipped）
 * - completed/running/failed 且带 result 的步骤可展开查看结果全文
 *   （failed 的一行摘要仍默认可见，展开后显示完整 result）
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, CircleNotch, SkipForward, CaretDown, CaretUp } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import type { Step, StepStatus } from './types';

// ============================================================================
// StatusDot
// ============================================================================

const StatusDot: React.FC<{ status: StepStatus; index: number }> = ({ status, index }) => {
  switch (status) {
    case 'running':
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-[color:hsl(var(--primary))] text-[color:hsl(var(--primary-foreground))] text-2xs font-bold flex-shrink-0">
          {index + 1}
        </span>
      );
    case 'completed':
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full flex-shrink-0 text-[color:hsl(var(--success))]">
          <Check size={14} weight="bold" />
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full flex-shrink-0 text-[color:hsl(var(--destructive))]">
          <X size={13} weight="bold" />
        </span>
      );
    case 'skipped':
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full flex-shrink-0 text-[color:var(--text-muted)]">
          <SkipForward size={12} />
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full border border-[color:var(--border-soft)] flex-shrink-0" />
      );
  }
};

// ============================================================================
// PlanSteps
// ============================================================================

/** 这些状态的步骤带 result 时可展开查看全文 */
const EXPANDABLE_STATUSES: ReadonlySet<StepStatus> = new Set(['completed', 'failed', 'running']);

export interface PlanStepsProps {
  steps: Step[];
}

export const PlanSteps: React.FC<PlanStepsProps> = ({ steps }) => {
  const { t } = useTranslation('chatV2');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  const toggleStep = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="py-1 max-h-[260px] overflow-y-auto">
      {steps.map((step, idx) => {
        const key = step.id || String(idx);
        const hasDetail = !!step.result?.trim() && EXPANDABLE_STATUSES.has(step.status);
        const isExpanded = hasDetail && expandedKeys.has(key);

        return (
          <div
            key={key}
            className={cn(
              'mx-1 px-3 py-[7px] rounded-[10px]',
              'transition-colors duration-100',
              'hover:bg-[color:var(--interactive-hover)]',
            )}
          >
            <div className="flex items-start gap-2.5">
              <StatusDot status={step.status} index={idx} />
              <div className="flex-1 min-w-0">
                <span
                  className={cn(
                    'block text-ui leading-snug',
                    step.status === 'completed' && 'line-through text-[color:hsl(var(--success))] opacity-70',
                    step.status === 'running' && 'text-[color:var(--text-primary)] font-medium',
                    step.status === 'failed' && 'text-[color:hsl(var(--destructive))]',
                    step.status === 'skipped' && 'text-[color:var(--text-muted)] line-through',
                    step.status === 'pending' && 'text-[color:var(--text-muted)]',
                  )}
                >
                  {step.description}
                </span>
                {/* failed 的一行摘要始终可见（展开前不丢失失败原因） */}
                {step.status === 'failed' && step.result && !isExpanded && (
                  <span className="block text-[11px] text-[color:hsl(var(--destructive))] opacity-60 mt-0.5 truncate">
                    {step.result}
                  </span>
                )}
              </div>
              {step.status === 'running' && (
                <CircleNotch size={13} className="animate-spin text-[color:hsl(var(--primary))] flex-shrink-0 mt-[3px]" />
              )}
              {hasDetail && (
                <button
                  type="button"
                  onClick={() => toggleStep(key)}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? t('agentPanel.stepDetailCollapse') : t('agentPanel.stepDetailExpand')}
                  title={isExpanded ? t('agentPanel.stepDetailCollapse') : t('agentPanel.stepDetailExpand')}
                  className={cn(
                    'flex-shrink-0 mt-[2px] p-0.5 rounded-[5px]',
                    'text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]',
                    'hover:bg-[color:var(--interactive-hover)] cursor-pointer',
                    // ★ 触控目标：18px 视觉不变，触屏用伪元素把命中区扩到 ≥44px
                    "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3.5 [@media(pointer:coarse)]:after:content-['']",
                  )}
                >
                  {isExpanded ? <CaretUp size={10} /> : <CaretDown size={10} />}
                </button>
              )}
            </div>
            {isExpanded && (
              <div
                className={cn(
                  'mt-1 ml-[28px] rounded-[8px] px-2.5 py-1.5',
                  'border border-[color:var(--border-soft)]',
                  'text-[11px] leading-relaxed whitespace-pre-wrap break-words',
                  step.status === 'failed'
                    ? 'text-[color:hsl(var(--destructive))] border-[color:hsl(var(--destructive)/0.28)] bg-[color:hsl(var(--destructive)/0.06)]'
                    : 'text-[color:var(--text-secondary)]',
                  'max-h-40 overflow-y-auto',
                )}
              >
                {step.result}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default PlanSteps;
