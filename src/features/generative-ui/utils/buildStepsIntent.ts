/**
 * 通用学习步骤 — 确定性意图构建（与 research-plan 研究专用块分离）
 */

import type { GenerativeUIIntent } from '../types';
import { STEPS_STATUSES, type StepsStatus } from '../components/StepsBlock';

const STATUS_SET = new Set<string>(STEPS_STATUSES);

export interface StepsItemInput {
  id?: string;
  label: string;
  description?: string;
  status?: string;
  durationLabel?: string;
}

export interface StepsLabels {
  title?: string;
  metaTitle?: string;
}

export interface StepsIntentInput {
  id?: string;
  title?: string;
  steps: StepsItemInput[];
  labels?: StepsLabels;
}

function clampText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function normalizeStepsStatus(status: unknown): StepsStatus {
  if (typeof status === 'string' && STATUS_SET.has(status)) {
    return status as StepsStatus;
  }
  return 'pending';
}

export function normalizeStepsItems(steps: StepsItemInput[]): Array<{
  id?: string;
  label: string;
  description?: string;
  status: StepsStatus;
  durationLabel?: string;
}> {
  return steps
    .filter((step) => typeof step.label === 'string' && step.label.trim().length > 0)
    .slice(0, 20)
    .map((step) => {
      const description = step.description?.trim();
      const durationLabel = step.durationLabel?.trim();
      return {
        ...(step.id ? { id: step.id } : {}),
        label: clampText(step.label.trim(), 160),
        ...(description ? { description: clampText(description, 300) } : {}),
        status: normalizeStepsStatus(step.status),
        ...(durationLabel ? { durationLabel: clampText(durationLabel, 40) } : {}),
      };
    });
}

export function buildStepsIntent(input: StepsIntentInput): GenerativeUIIntent {
  const titleSource = (input.title ?? input.labels?.title)?.trim();
  const title = titleSource ? clampText(titleSource, 120) : undefined;
  const steps = normalizeStepsItems(input.steps);

  return {
    version: '1',
    meta: input.labels?.metaTitle
      ? {
          title: input.labels.metaTitle,
        }
      : undefined,
    blocks:
      steps.length === 0
        ? []
        : [
            {
              type: 'steps',
              id: input.id,
              props: {
                ...(title ? { title } : {}),
                steps,
              },
            },
          ],
  };
}
