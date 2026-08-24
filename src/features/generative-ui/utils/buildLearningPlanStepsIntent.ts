/**
 * 今日学习计划 → steps + action-bar（start-review）
 *
 * 不改 Exam / Memory / Learning 既有 builder 签名；调用方按需组合。
 */

import type { GenerativeUIIntent } from '../types';
import { buildStepsIntent, type StepsItemInput } from './buildStepsIntent';

export interface LearningPlanStepsLabels {
  title: string;
  startReview: string;
  metaTitle?: string;
}

export interface LearningPlanStepsInput {
  title?: string;
  steps: StepsItemInput[];
  labels: LearningPlanStepsLabels;
}

export function buildLearningPlanStepsIntent(input: LearningPlanStepsInput): GenerativeUIIntent {
  const stepsIntent = buildStepsIntent({
    title: input.title ?? input.labels.title,
    steps: input.steps,
    labels: {
      title: input.labels.title,
      metaTitle: input.labels.metaTitle ?? input.labels.title,
    },
  });

  return {
    version: '1',
    meta: stepsIntent.meta,
    blocks: [
      ...stepsIntent.blocks,
      {
        type: 'action-bar',
        props: {
          actions: [
            {
              id: 'start-review',
              label: input.labels.startReview,
              variant: 'primary',
              riskLevel: 'low',
            },
          ],
        },
      },
    ],
  };
}
