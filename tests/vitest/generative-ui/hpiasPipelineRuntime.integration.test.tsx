/**
 * HPIAS pipeline 运行时渐进式集成 — 模拟 Rust orchestrator 事件流
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { useHpiasStore } from '@/stores/researchStore';
import { createHpiasEventBridgeHandler } from '@/features/generative-ui/bridge/hpiasEventBridge';
import { buildHpiasResearchDashboardIntent } from '@/features/generative-ui/utils/buildHpiasResearchDashboardIntent';
import { buildStyleLabHpiasDemoTimeline } from '@/features/generative-ui/demo/styleLabHpiasDemo';
import { HpiasGenerativeResearchPanel } from '@/features/generative-ui/components/HpiasGenerativeResearchPanel';
import {
  assertHpiasLifecycleCoverage,
  extractHpiasEventTypes,
} from '@/features/generative-ui/contracts/hpiasLifecycleContract';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const SESSION = 'runtime-test-session';

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

function pickSnapshot() {
  const s = useHpiasStore.getState();
  return {
    sessionId: s.sessionId,
    round: s.round,
    plan: s.plan,
    synthesis: s.synthesis,
    retrievalCount: s.retrievalCount,
    selectedCount: s.selectedCount,
    subAgents: s.subAgents,
  };
}

function buildIntent() {
  return buildHpiasResearchDashboardIntent({
    snapshot: pickSnapshot(),
    question: 'Runtime test question?',
    labels: dashboardLabels,
  });
}

describe('hpiasPipelineRuntime integration', () => {
  beforeEach(() => {
    useHpiasStore.getState().actions.clear();
  });

  it('Style Lab timeline satisfies lifecycle contract', () => {
    const types = extractHpiasEventTypes(buildStyleLabHpiasDemoTimeline());
    assertHpiasLifecycleCoverage(types);
  });

  it('progressively builds dashboard intent through pipeline stages', () => {
    const handleEvent = createHpiasEventBridgeHandler({ sessionId: SESSION });
    const timeline = buildStyleLabHpiasDemoTimeline().map((e) => ({
      ...e,
      session_id: SESSION,
    }));

    handleEvent(timeline[0]);
    expect(useHpiasStore.getState().sessionId).toBe(SESSION);
    const earlyIntent = buildIntent();
    expect(earlyIntent?.blocks.some((b) => b.type === 'research-report')).toBe(false);
    expect(earlyIntent?.blocks.some((b) => b.type === 'stat-card')).toBe(false);

    const planIdx = timeline.findIndex((e) => e.type === 'plan_generated');
    for (let i = 1; i <= planIdx; i++) {
      handleEvent(timeline[i]);
    }
    expect(useHpiasStore.getState().plan).toBeTruthy();
    const afterPlan = buildIntent();
    expect(afterPlan?.blocks.some((b) => b.type === 'research-plan')).toBe(true);
    expect(afterPlan?.blocks.some((b) => b.type === 'research-report')).toBe(false);

    const retrievalIdx = timeline.findIndex((e) => e.type === 'retrieval_completed');
    handleEvent(timeline[retrievalIdx]);
    expect(useHpiasStore.getState().retrievalCount).not.toBeNull();
    expect(buildIntent()?.blocks.some((b) => b.type === 'stat-card')).toBe(true);

    for (const event of timeline) {
      handleEvent(event);
    }
    const finalIntent = buildIntent();
    expect(finalIntent?.blocks.some((b) => b.type === 'research-report')).toBe(true);
    expect(finalIntent?.blocks.some((b) => b.type === 'action-bar')).toBe(true);
  });

  it('renders HpiasGenerativeResearchPanel after full pipeline', () => {
    const handleEvent = createHpiasEventBridgeHandler({ sessionId: SESSION });
    for (const event of buildStyleLabHpiasDemoTimeline()) {
      handleEvent({ ...event, session_id: SESSION });
    }

    render(<HpiasGenerativeResearchPanel question="Runtime?" />);
    expect(screen.getByTestId('hpias-generative-research-panel')).toBeInTheDocument();
    expect(document.querySelector('[data-generative-research-plan]')).toBeTruthy();
    expect(document.querySelector('[data-generative-research-report]')).toBeTruthy();
  });
});
