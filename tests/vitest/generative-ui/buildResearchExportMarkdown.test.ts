import { describe, it, expect } from 'vitest';
import {
  buildResearchExportMarkdownFromIntent,
  extractResearchReportBody,
} from '@/features/generative-ui/utils/extractResearchContentFromIntent';
import { buildResearchExportMarkdownFromSnapshot } from '@/features/generative-ui/utils/buildResearchExportMarkdown';

describe('extractResearchContentFromIntent', () => {
  it('extracts report body from research-report block', () => {
    const intent = {
      version: '1' as const,
      blocks: [
        {
          type: 'research-report' as const,
          props: { title: 'Report', body: 'Summary [paper-1]' },
        },
      ],
    };
    expect(extractResearchReportBody(intent)).toBe('Summary [paper-1]');
  });

  it('builds export markdown from plan and report blocks', () => {
    const intent = {
      version: '1' as const,
      meta: { title: 'Deep Research' },
      blocks: [
        {
          type: 'research-plan' as const,
          props: {
            title: 'Pipeline',
            steps: [
              { label: 'Plan', status: 'done' as const },
              { label: 'Synthesis', status: 'active' as const },
            ],
          },
        },
        {
          type: 'research-report' as const,
          props: { body: 'Final findings.' },
        },
      ],
    };
    const md = buildResearchExportMarkdownFromIntent(intent);
    expect(md).toContain('# Deep Research');
    expect(md).toContain('[x] Plan');
    expect(md).toContain('[~] Synthesis');
    expect(md).toContain('Final findings.');
  });
});

describe('buildResearchExportMarkdownFromSnapshot', () => {
  it('includes plan steps and synthesis from hpias snapshot', () => {
    const md = buildResearchExportMarkdownFromSnapshot({
      snapshot: {
        sessionId: 's1',
        round: 2,
        plan: { core: { queries: ['Topic A'] } },
        synthesis: 'Report body',
        retrievalCount: 10,
        selectedCount: 3,
        subAgents: {},
      },
      question: 'How does X work?',
      planTitle: 'Research',
      roundLabel: 'Round',
      stepLabels: {
        stepPlan: 'Plan',
        stepRetrieval: 'Retrieval',
        stepSelection: 'Selection',
        stepSubagents: 'Subagents',
        stepSynthesis: 'Synthesis',
        subagentFallback: 'Sub {{id}}',
      },
    });
    expect(md).toContain('# How does X work?');
    expect(md).toContain('Round 2');
    expect(md).toContain('- Topic A');
    expect(md).toContain('Report body');
  });
});
