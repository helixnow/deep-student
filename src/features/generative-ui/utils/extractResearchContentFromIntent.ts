/**
 * 从 Generative UI intent 提取研究报告正文 / 导出 Markdown
 */

import type { GenerativeUIIntent } from '../types';
import type { ResearchExportMarkdownLabels } from './buildResearchExportMarkdown';

export function extractResearchReportBody(intent: GenerativeUIIntent): string | null {
  for (const block of intent.blocks) {
    if (block.type !== 'research-report') continue;
    const body = (block.props as { body?: unknown })?.body;
    if (typeof body === 'string' && body.trim()) {
      return body.trim();
    }
  }
  return null;
}

function formatPlanStepsMarkdown(
  title: string,
  steps: Array<{ label: string; status?: string }>,
): string[] {
  const lines = [`## ${title}`, ''];
  for (const step of steps) {
    const mark =
      step.status === 'done' ? '[x]' : step.status === 'active' ? '[~]' : '[ ]';
    lines.push(`- ${mark} ${step.label}`);
  }
  lines.push('');
  return lines;
}

/** 从 intent  blocks 合成可导出 Markdown（计划 + 报告） */
export function buildResearchExportMarkdownFromIntent(
  intent: GenerativeUIIntent,
  title?: string,
  labels?: Partial<ResearchExportMarkdownLabels>,
): string {
  const lines: string[] = [];
  const heading = title?.trim() || intent.meta?.title?.trim();
  if (heading) {
    lines.push(`# ${heading}`, '');
  }

  const planBlock = intent.blocks.find((b) => b.type === 'research-plan');
  if (planBlock) {
    const props = planBlock.props as {
      title?: string;
      steps?: Array<{ label: string; status?: string }>;
    };
    lines.push(
      ...formatPlanStepsMarkdown(
        props.title?.trim() || labels?.researchPlan || 'Research Plan',
        props.steps ?? [],
      ),
    );
  }

  const reportBody = extractResearchReportBody(intent);
  if (reportBody) {
    lines.push(`## ${labels?.report || 'Report'}`, '', reportBody);
  }

  return lines.join('\n').trim();
}
