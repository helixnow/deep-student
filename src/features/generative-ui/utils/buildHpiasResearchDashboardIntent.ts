/**
 * HpiasStore 实时快照 → Generative UI 研究仪表盘意图
 */
import type { GenerativeUIIntent } from '../types';
import { buildResearchPlanIntent } from './buildResearchPlanIntent';
import { buildResearchReportIntent } from './buildResearchReportIntent';
import { buildStepsIntent } from './buildStepsIntent';
import {
  mapHpiasStoreToResearchPlanSteps,
  type HpiasResearchPlanLabels,
  type HpiasResearchSnapshot,
} from './mapHpiasStoreToResearchPlan';

export interface HpiasResearchDashboardLabels extends HpiasResearchPlanLabels {
  metaTitle: string;
  roundLabel: string;
  planTitle: string;
  retrievalStatTitle: string;
  selectedStatTitle: string;
  reportMetaTitle: string;
  citationStatTitle: string;
  copyReport: string;
  exportPlan: string;
  exportIntent?: string;
  copyIntent?: string;
  stepsListTitle?: string;
  stepStatusPending?: string;
  stepStatusActive?: string;
  stepStatusDone?: string;
  digestFallbackTitle?: string;
  emptySteps?: string;
  stepsBlockTitle?: string;
}

export interface HpiasResearchDashboardInput {
  snapshot: HpiasResearchSnapshot;
  question?: string;
  labels: HpiasResearchDashboardLabels;
}

function extractPlanQueries(plan: unknown): string[] {
  if (!plan || typeof plan !== 'object') return [];
  const core = (plan as { core?: { queries?: unknown } }).core;
  if (!Array.isArray(core?.queries)) return [];
  return core.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0);
}

function stepStatusBadge(
  status: 'pending' | 'active' | 'done' | undefined,
  labels: HpiasResearchDashboardLabels,
): string {
  if (status === 'done') return labels.stepStatusDone ?? 'done';
  if (status === 'active') return labels.stepStatusActive ?? 'active';
  return labels.stepStatusPending ?? 'pending';
}

/** 将 HpiasStore 快照合成为 research-plan + 子步骤 list + 可选 paper-digest / research-report */
export function buildHpiasResearchDashboardIntent(
  input: HpiasResearchDashboardInput,
): GenerativeUIIntent | null {
  const { snapshot, question, labels } = input;
  if (!snapshot.sessionId) return null;

  const steps = mapHpiasStoreToResearchPlanSteps(snapshot, labels);
  const planIntent = buildResearchPlanIntent({
    title: question?.trim() || labels.planTitle,
    round: snapshot.round > 0 ? snapshot.round : undefined,
    steps,
    labels: {
      metaTitle: labels.metaTitle,
      roundLabel: labels.roundLabel,
    },
  });

  const blocks = [...planIntent.blocks];

  const statBlocks: typeof blocks = [];
  if (snapshot.retrievalCount != null) {
    statBlocks.push({
      type: 'stat-card',
      props: {
        title: labels.retrievalStatTitle,
        value: snapshot.retrievalCount,
      },
    });
  }
  if (snapshot.selectedCount != null) {
    statBlocks.push({
      type: 'stat-card',
      props: {
        title: labels.selectedStatTitle,
        value: snapshot.selectedCount,
      },
    });
  }
  if (statBlocks.length > 0) {
    blocks.unshift(...statBlocks);
  }

  blocks.push({
    type: 'list',
    props: {
      title: labels.stepsListTitle ?? labels.planTitle,
      items: steps.slice(0, 12).map((step, index) => ({
        id: `hpias-step-${index}`,
        label: step.label.slice(0, 200),
        badge: stepStatusBadge(step.status, labels).slice(0, 40),
      })),
      emptyLabel: labels.emptySteps,
    },
  });

  blocks.push(
    ...buildStepsIntent({
      title: labels.stepsBlockTitle ?? labels.stepsListTitle ?? labels.planTitle,
      steps: steps.map((step, index) => ({
        id: `hpias-step-${index}`,
        label: step.label,
        status: step.status,
      })),
    }).blocks,
  );

  const queries = extractPlanQueries(snapshot.plan);
  const synthesisExcerpt = snapshot.synthesis?.trim();
  const digestTitle = (question?.trim() || labels.digestFallbackTitle || labels.planTitle).slice(0, 300);
  if (synthesisExcerpt || queries.length > 0) {
    blocks.push({
      type: 'paper-digest',
      props: {
        title: digestTitle,
        keyFindings: queries.slice(0, 8).map((query) => query.slice(0, 300)),
        abstractExcerpt: synthesisExcerpt ? synthesisExcerpt.slice(0, 500) : undefined,
      },
    });
  }

  if (snapshot.synthesis?.trim()) {
    const reportIntent = buildResearchReportIntent({
      title: question,
      body: snapshot.synthesis,
      labels: {
        metaTitle: labels.reportMetaTitle,
        citationStatTitle: labels.citationStatTitle,
      },
    });
    blocks.push(...reportIntent.blocks);
  }

  const actions: Array<{
    id: string;
    label: string;
    variant: 'primary' | 'default';
    riskLevel: 'low' | 'medium';
  }> = [];

  if (snapshot.synthesis?.trim()) {
    actions.push({
      id: 'copy-report',
      label: labels.copyReport,
      variant: 'primary',
      riskLevel: 'low',
    });
  }

  if (steps.length > 0) {
    actions.push({
      id: 'export-plan',
      label: labels.exportPlan,
      variant: 'default',
      riskLevel: 'medium',
    });
  }

  if (labels.exportIntent) {
    actions.push({
      id: 'export-intent',
      label: labels.exportIntent,
      variant: 'default',
      riskLevel: 'low',
    });
  }

  if (labels.copyIntent && actions.length < 6) {
    actions.push({
      id: 'copy-intent',
      label: labels.copyIntent,
      variant: 'default',
      riskLevel: 'low',
    });
  }

  if (actions.length > 0) {
    blocks.push({
      type: 'action-bar',
      props: { actions },
    });
  }

  return {
    version: '1',
    meta: planIntent.meta,
    blocks,
  };
}
