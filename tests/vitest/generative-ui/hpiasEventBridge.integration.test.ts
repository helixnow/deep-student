import { describe, it, expect, beforeEach } from 'vitest';
import { useHpiasStore } from '@/stores/researchStore';
import {
  createHpiasEventBridgeHandler,
  intentHasResearchBlocks,
  omitResearchBlocksFromIntent,
} from '@/features/generative-ui/bridge/hpiasEventBridge';
import { buildHpiasResearchDashboardIntent } from '@/features/generative-ui/utils/buildHpiasResearchDashboardIntent';
import { buildStyleLabHpiasDemoTimeline } from '@/features/generative-ui/demo/styleLabHpiasDemo';

const dashboardLabels = {
  metaTitle: 'Research',
  roundLabel: 'Round',
  planTitle: 'Task',
  stepPlan: 'Plan',
  stepRetrieval: 'Retrieval',
  stepSelection: 'Selection',
  stepSubagents: 'Subagents',
  stepSynthesis: 'Synthesis',
  subagentFallback: 'Sub {{id}}',
  retrievalStatTitle: 'Retrieved',
  selectedStatTitle: 'Selected',
  reportMetaTitle: 'Report',
  citationStatTitle: 'Citations',
  copyReport: 'Copy',
  exportPlan: 'Export',
  exportIntent: 'Export intent',
};

describe('hpiasEventBridge integration', () => {
  beforeEach(() => {
    useHpiasStore.getState().actions.clear();
  });

  it('feeds Style Lab demo timeline into dashboard intent with action-bar', () => {
    const handleEvent = createHpiasEventBridgeHandler();
    for (const event of buildStyleLabHpiasDemoTimeline()) {
      handleEvent(event);
    }

    const snapshot = {
      sessionId: useHpiasStore.getState().sessionId,
      round: useHpiasStore.getState().round,
      plan: useHpiasStore.getState().plan,
      synthesis: useHpiasStore.getState().synthesis,
      retrievalCount: useHpiasStore.getState().retrievalCount,
      selectedCount: useHpiasStore.getState().selectedCount,
      subAgents: useHpiasStore.getState().subAgents,
    };

    const intent = buildHpiasResearchDashboardIntent({
      snapshot,
      question: 'Demo question?',
      labels: dashboardLabels,
    });

    expect(intent).not.toBeNull();
    expect(intent!.blocks.some((b) => b.type === 'research-plan')).toBe(true);
    expect(intent!.blocks.some((b) => b.type === 'research-report')).toBe(true);
    expect(intent!.blocks.some((b) => b.type === 'action-bar')).toBe(true);

    const actionBar = intent!.blocks.find((b) => b.type === 'action-bar');
    const actions = (actionBar?.props as { actions?: Array<{ id: string }> })?.actions ?? [];
    expect(actions.map((a) => a.id)).toEqual(['copy-report', 'export-plan', 'export-intent']);
  });

  it('omitResearchBlocksFromIntent preserves non-research blocks for Chat dedup', () => {
    const intent = {
      version: '1' as const,
      blocks: [
        { type: 'text' as const, props: { body: 'Status' } },
        { type: 'research-plan' as const, props: { title: 'Plan', steps: [] } },
        { type: 'research-report' as const, props: { body: 'Done' } },
        {
          type: 'action-bar' as const,
          props: {
            actions: [
              { id: 'copy-report', label: 'Copy' },
              { id: 'export-plan', label: 'Export' },
              { id: 'copy-intent', label: 'Copy intent' },
            ],
          },
        },
      ],
    };
    expect(intentHasResearchBlocks(intent)).toBe(true);
    const filtered = omitResearchBlocksFromIntent(intent);
    expect(filtered.blocks.map((b) => b.type)).toEqual(['text']);
  });
});
