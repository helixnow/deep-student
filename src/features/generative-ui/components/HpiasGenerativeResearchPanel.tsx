/**
 * HpiasStore → Generative UI 研究仪表盘面板（Research #7 实时接线）
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useHpiasStore } from '@/stores/researchStore';
import { GenerativeUIPanel } from './GenerativeUIPanel';
import { buildHpiasResearchDashboardIntent } from '../utils/buildHpiasResearchDashboardIntent';
import { pickHpiasResearchSnapshot } from '../utils/mapHpiasStoreToResearchPlan';

export interface HpiasGenerativeResearchPanelProps {
  showChrome?: boolean;
  question?: string;
  emptyFallback?: React.ReactNode;
}

export function HpiasGenerativeResearchPanel({
  showChrome = false,
  question,
  emptyFallback = null,
}: HpiasGenerativeResearchPanelProps) {
  const { t } = useTranslation('generativeUi');
  const sessionId = useHpiasStore((s) => s.sessionId);
  const round = useHpiasStore((s) => s.round);
  const plan = useHpiasStore((s) => s.plan);
  const synthesis = useHpiasStore((s) => s.synthesis);
  const retrievalCount = useHpiasStore((s) => s.retrievalCount);
  const selectedCount = useHpiasStore((s) => s.selectedCount);
  const subAgents = useHpiasStore((s) => s.subAgents);
  const roundStatus = useHpiasStore((s) => s.roundsView[s.round]?.status);

  const snapshot = useMemo(
    () =>
      pickHpiasResearchSnapshot({
        sessionId,
        round,
        plan,
        synthesis,
        retrievalCount,
        selectedCount,
        subAgents,
        roundsView: roundStatus != null ? { [round]: { status: roundStatus } } : {},
      }),
    [
      sessionId,
      round,
      plan,
      synthesis,
      retrievalCount,
      selectedCount,
      subAgents,
      roundStatus,
    ],
  );

  const intent = useMemo(
    () =>
      buildHpiasResearchDashboardIntent({
        snapshot,
        question,
        labels: {
          metaTitle: t('research.hpias.meta_title'),
          roundLabel: t('research.plan.round_label'),
          planTitle: t('research.hpias.plan_title'),
          stepPlan: t('research.hpias.step_plan'),
          stepRetrieval: t('research.hpias.step_retrieval'),
          stepSelection: t('research.hpias.step_selection'),
          stepSubagents: t('research.hpias.step_subagents'),
          stepSynthesis: t('research.hpias.step_synthesis'),
          subagentFallback: t('research.hpias.subagent_fallback'),
          retrievalStatTitle: t('research.hpias.retrieval_stat'),
          selectedStatTitle: t('research.hpias.selected_stat'),
          reportMetaTitle: t('research.report.meta_title'),
          citationStatTitle: t('research.report.citation_stat'),
        },
      }),
    [question, snapshot, t],
  );

  if (!sessionId || !intent) {
    return emptyFallback ? <>{emptyFallback}</> : null;
  }

  return (
    <div data-testid="hpias-generative-research-panel">
      <GenerativeUIPanel intent={intent} showChrome={showChrome} />
    </div>
  );
}
