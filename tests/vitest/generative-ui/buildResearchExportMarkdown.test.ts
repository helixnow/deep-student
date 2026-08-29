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

  it('uses optional report labels for intent exports', () => {
    const intent = {
      version: '1' as const,
      blocks: [
        { type: 'research-plan' as const, props: { steps: [{ label: 'Plan' }] } },
        { type: 'research-report' as const, props: { body: 'Result' } },
      ],
    };
    const md = buildResearchExportMarkdownFromIntent(intent, undefined, {
      researchPlan: '研究计划',
      report: '研究报告',
    });
    expect(md).toContain('## 研究计划');
    expect(md).toContain('## 研究报告');
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

  it('uses optional locale labels for snapshot section headings and counts', () => {
    const md = buildResearchExportMarkdownFromSnapshot({
      snapshot: {
        sessionId: 's2',
        round: 1,
        plan: { core: { queries: ['主题 A'] } },
        synthesis: '报告正文',
        retrievalCount: 4,
        selectedCount: 2,
        subAgents: {},
      },
      planTitle: '研究',
      roundLabel: '第',
      stepLabels: {
        stepPlan: '计划',
        stepRetrieval: '检索',
        stepSelection: '筛选',
        stepSubagents: '子任务',
        stepSynthesis: '综合',
        subagentFallback: '子任务 {{id}}',
      },
    }, {
      researchPlan: '研究计划',
      queries: '检索问题',
      retrieval: '检索结果',
      retrieved: '已检索',
      selected: '已入选',
      report: '研究报告',
    });

    expect(md).toContain('## 研究计划');
    expect(md).toContain('## 检索问题');
    expect(md).toContain('## 检索结果');
    expect(md).toContain('- 已检索: 4');
    expect(md).toContain('- 已入选: 2');
    expect(md).toContain('## 研究报告');
  });
});
