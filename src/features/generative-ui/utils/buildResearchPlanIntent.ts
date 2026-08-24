/**
 * 研究计划步骤 — 确定性意图构建（映射 HpiasStore plan 词汇表 POC）
 */

import type { GenerativeUIIntent } from '../types';

export type ResearchPlanStepStatus = 'pending' | 'active' | 'done';

export interface ResearchPlanStepInput {
  label: string;
  status?: ResearchPlanStepStatus;
}

export interface ResearchPlanLabels {
  metaTitle: string;
  roundLabel?: string;
}

export interface ResearchPlanInput {
  title: string;
  round?: number;
  steps: ResearchPlanStepInput[];
  labels: ResearchPlanLabels;
}

export function buildResearchPlanIntent(input: ResearchPlanInput): GenerativeUIIntent {
  const done = input.steps.filter((s) => s.status === 'done').length;

  return {
    version: '1',
    meta: {
      title: input.labels.metaTitle,
      description:
        input.labels.roundLabel && input.round != null
          ? `${input.labels.roundLabel} ${input.round}`
          : undefined,
    },
    blocks: [
      {
        type: 'progress',
        props: {
          title: input.title,
          current: done,
          total: input.steps.length,
        },
      },
      {
        type: 'research-plan',
        props: {
          title: input.title,
          round: input.round,
          steps: input.steps,
        },
      },
    ],
  };
}
