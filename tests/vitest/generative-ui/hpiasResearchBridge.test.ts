import { describe, it, expect } from 'vitest';
import { stepsBlockPropsSchema } from '@/features/generative-ui/components/StepsBlock';
import {
  mapHpiasStoreToResearchPlanSteps,
  type HpiasResearchSnapshot,
} from '@/features/generative-ui/utils/mapHpiasStoreToResearchPlan';
import { buildHpiasResearchDashboardIntent } from '@/features/generative-ui/utils/buildHpiasResearchDashboardIntent';
import { parseGenerativeUIIntent } from '@/features/generative-ui/schema';

const labels = {
  stepPlan: 'Plan',
  stepRetrieval: 'Retrieval',
  stepSelection: 'Selection',
  stepSubagents: 'Subagents',
  stepSynthesis: 'Synthesis',
  subagentFallback: 'Sub {{id}}',
};

const dashboardLabels = {
  ...labels,
  metaTitle: 'Research',
  roundLabel: 'Round',
  planTitle: 'Task',
  retrievalStatTitle: 'Retrieved',
  selectedStatTitle: 'Selected',
  reportMetaTitle: 'Report',
  citationStatTitle: 'Citations',
  copyReport: 'Copy report',
  exportPlan: 'Export plan',
  exportIntent: 'Export all intents',
};

describe('mapHpiasStoreToResearchPlanSteps', () => {
  it('maps pipeline phases from store snapshot', () => {
    const snapshot: HpiasResearchSnapshot = {
      sessionId: 's1',
      round: 1,
      plan: { core: { queries: ['Q1'] } },
      synthesis: null,
      retrievalCount: 10,
      selectedCount: null,
      subAgents: {},
    };
    const steps = mapHpiasStoreToResearchPlanSteps(snapshot, labels);
    expect(steps[0]).toMatchObject({ label: 'Plan', status: 'done' });
    expect(steps[1]).toMatchObject({ label: 'Retrieval', status: 'done' });
    expect(steps[2]).toMatchObject({ label: 'Selection', status: 'active' });
  });

  it('expands subagents into individual steps', () => {
    const snapshot: HpiasResearchSnapshot = {
      sessionId: 's1',
      round: 1,
      plan: null,
      synthesis: 'done',
      retrievalCount: 5,
      selectedCount: 2,
      subAgents: {
        1: { status: 'completed', query: 'Topic A' },
        2: { status: 'running', query: 'Topic B' },
      },
    };
    const steps = mapHpiasStoreToResearchPlanSteps(snapshot, labels);
    expect(steps.some((s) => s.label === 'Topic A' && s.status === 'done')).toBe(true);
    expect(steps.some((s) => s.label === 'Topic B' && s.status === 'active')).toBe(true);
    expect(steps.at(-1)).toMatchObject({ label: 'Synthesis', status: 'done' });
  });
});

describe('buildHpiasResearchDashboardIntent', () => {
  it('returns null without active session', () => {
    expect(
      buildHpiasResearchDashboardIntent({
        snapshot: {
          sessionId: null,
          round: 0,
          plan: null,
          synthesis: null,
          retrievalCount: null,
          selectedCount: null,
          subAgents: {},
        },
        labels: dashboardLabels,
      }),
    ).toBeNull();
  });

  it('includes stat cards and research-report when synthesis present', () => {
    const intent = buildHpiasResearchDashboardIntent({
      snapshot: {
        sessionId: 's1',
        round: 1,
        plan: { core: { queries: ['Q1'] } },
        synthesis: 'Finding [paper-1] summary.',
        retrievalCount: 20,
        selectedCount: 5,
        subAgents: {},
      },
      question: 'Test question?',
      labels: dashboardLabels,
    });
    expect(intent).not.toBeNull();
    expect(intent!.blocks.some((b) => b.type === 'stat-card')).toBe(true);
    expect(intent!.blocks.some((b) => b.type === 'research-plan')).toBe(true);
    expect(intent!.blocks.some((b) => b.type === 'research-report')).toBe(true);
    expect(intent!.blocks.some((b) => b.type === 'list')).toBe(true);
    expect(intent!.blocks.some((b) => b.type === 'paper-digest')).toBe(true);
    expect(intent!.blocks.some((b) => b.type === 'action-bar')).toBe(true);
    const actionBar = intent!.blocks.find((b) => b.type === 'action-bar');
    const actionIds = ((actionBar?.props as { actions?: Array<{ id: string }> })?.actions ?? []).map(
      (a) => a.id,
    );
    expect(actionIds).toContain('export-intent');
    expect(actionIds).not.toContain('copy-intent');
    const stepsBlock = intent!.blocks.find((b) => b.type === 'steps');
    expect(stepsBlock).toBeDefined();
    expect(stepsBlockPropsSchema.safeParse(stepsBlock?.props).success).toBe(true);
    expect(parseGenerativeUIIntent(JSON.stringify(intent)).ok).toBe(true);
  });

  it('includes copy-intent on the action-bar when copyIntent label is present', () => {
    const intent = buildHpiasResearchDashboardIntent({
      snapshot: {
        sessionId: 's1',
        round: 1,
        plan: { core: { queries: ['Q1'] } },
        synthesis: 'Finding [paper-1] summary.',
        retrievalCount: 20,
        selectedCount: 5,
        subAgents: {},
      },
      question: 'Test question?',
      labels: { ...dashboardLabels, copyIntent: 'Copy intent' },
    });
    expect(intent).not.toBeNull();
    const actionBar = intent!.blocks.find((b) => b.type === 'action-bar');
    const actions = (actionBar?.props as { actions?: Array<{ id: string }> })?.actions ?? [];
    const actionIds = actions.map((a) => a.id);
    expect(actionIds).toContain('copy-intent');
    expect(actionIds).toContain('copy-report');
    expect(actionIds).toContain('export-plan');
    expect(actionIds).toContain('export-intent');
    expect(actions.length).toBeLessThanOrEqual(6);
    expect(parseGenerativeUIIntent(JSON.stringify(intent)).ok).toBe(true);
  });
});
