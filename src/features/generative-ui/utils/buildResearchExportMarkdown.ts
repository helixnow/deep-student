/**
 * HpiasStore 快照 → 可导出研究 Markdown
 */

import {
  mapHpiasStoreToResearchPlanSteps,
  type HpiasResearchPlanLabels,
  type HpiasResearchSnapshot,
} from './mapHpiasStoreToResearchPlan';

export interface BuildResearchExportMarkdownFromSnapshotInput {
  snapshot: HpiasResearchSnapshot;
  question?: string;
  planTitle: string;
  roundLabel: string;
  stepLabels: HpiasResearchPlanLabels;
}

export function buildResearchExportMarkdownFromSnapshot(
  input: BuildResearchExportMarkdownFromSnapshotInput,
): string {
  const { snapshot, question, planTitle, roundLabel, stepLabels } = input;
  const lines: string[] = [];

  const title = question?.trim() || planTitle;
  lines.push(`# ${title}`, '');

  if (snapshot.round > 0) {
    lines.push(`> ${roundLabel} ${snapshot.round}`, '');
  }

  const steps = mapHpiasStoreToResearchPlanSteps(snapshot, stepLabels);
  if (steps.length > 0) {
    lines.push('## Research Plan', '');
    for (const step of steps) {
      const mark =
        step.status === 'done' ? '[x]' : step.status === 'active' ? '[~]' : '[ ]';
      lines.push(`- ${mark} ${step.label}`);
    }
    lines.push('');
  }

  const queries = extractPlanQueries(snapshot.plan);
  if (queries.length > 0) {
    lines.push('## Queries', '');
    for (const q of queries) {
      lines.push(`- ${q}`);
    }
    lines.push('');
  }

  if (snapshot.retrievalCount != null || snapshot.selectedCount != null) {
    lines.push('## Retrieval', '');
    if (snapshot.retrievalCount != null) {
      lines.push(`- Retrieved: ${snapshot.retrievalCount}`);
    }
    if (snapshot.selectedCount != null) {
      lines.push(`- Selected: ${snapshot.selectedCount}`);
    }
    lines.push('');
  }

  if (snapshot.synthesis?.trim()) {
    lines.push('## Report', '', snapshot.synthesis.trim());
  }

  return lines.join('\n').trim();
}

function extractPlanQueries(plan: unknown): string[] {
  if (!plan || typeof plan !== 'object') return [];
  const core = (plan as { core?: { queries?: unknown } }).core;
  if (!Array.isArray(core?.queries)) return [];
  return core.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0);
}
