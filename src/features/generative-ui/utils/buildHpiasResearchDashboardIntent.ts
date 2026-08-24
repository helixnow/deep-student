/**
 * HpiasStore 实时快照 → Generative UI 研究仪表盘意图
 */
import type { GenerativeUIIntent } from '../types';
import { buildResearchPlanIntent } from './buildResearchPlanIntent';
import { buildResearchReportIntent } from './buildResearchReportIntent';
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
}

export interface HpiasResearchDashboardInput {
  snapshot: HpiasResearchSnapshot;
  question?: string;
  labels: HpiasResearchDashboardLabels;
}

/** 将 HpiasStore 快照合成为 research-plan + 可选 research-report 块 */
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
