/**
 * HpiasStore → Generative UI 研究仪表盘面板（Research #7 实时接线）
 */
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useHpiasStore } from '@/stores/researchStore';
import { GenerativeUIPanel } from './GenerativeUIPanel';
import { buildHpiasResearchDashboardIntent } from '../utils/buildHpiasResearchDashboardIntent';
import { buildResearchExportMarkdownFromSnapshot } from '../utils/buildResearchExportMarkdown';
import { buildExportMarkdownI18nLabels } from '../utils/buildExportMarkdownI18nLabels';
import { pickHpiasResearchSnapshot } from '../utils/mapHpiasStoreToResearchPlan';
import { createResearchBriefingActionHandlers } from '../handlers/researchBriefingActionHandlers';
import { createCopyIntentActionHandlers } from '../handlers/copyIntentActionHandlers';

export interface HpiasGenerativeResearchPanelProps {
  /** 传入时只渲染匹配该 session 的 store 快照，避免并发研究串台。 */
  sessionId?: string;
  showChrome?: boolean;
  question?: string;
  emptyFallback?: React.ReactNode;
}

export function HpiasGenerativeResearchPanel({
  sessionId: expectedSessionId,
  showChrome = false,
  question,
  emptyFallback = null,
}: HpiasGenerativeResearchPanelProps) {
  const { t } = useTranslation('generativeUi');
  const exportMarkdownLabels = useMemo(() => buildExportMarkdownI18nLabels(t), [t]);
  const sessionSlice = useHpiasStore((s) =>
    expectedSessionId ? s.sessions[expectedSessionId] : undefined,
  );
  const topSessionId = useHpiasStore((s) => s.sessionId);
  const topRound = useHpiasStore((s) => s.round);
  const topPlan = useHpiasStore((s) => s.plan);
  const topSynthesis = useHpiasStore((s) => s.synthesis);
  const topRetrievalCount = useHpiasStore((s) => s.retrievalCount);
  const topSelectedCount = useHpiasStore((s) => s.selectedCount);
  const topSubAgents = useHpiasStore((s) => s.subAgents);
  const topRoundStatus = useHpiasStore((s) => s.roundsView[s.round]?.status);

  const usePinnedSlice = Boolean(expectedSessionId && sessionSlice);
  const useTopLevel =
    !expectedSessionId || (!usePinnedSlice && topSessionId === expectedSessionId);

  const sessionId = usePinnedSlice ? sessionSlice!.sessionId : useTopLevel ? topSessionId : null;
  const round = usePinnedSlice ? sessionSlice!.round : topRound;
  const plan = usePinnedSlice ? sessionSlice!.plan : topPlan;
  const synthesis = usePinnedSlice ? sessionSlice!.synthesis : topSynthesis;
  const retrievalCount = usePinnedSlice ? sessionSlice!.retrievalCount : topRetrievalCount;
  const selectedCount = usePinnedSlice ? sessionSlice!.selectedCount : topSelectedCount;
  const subAgents = usePinnedSlice ? sessionSlice!.subAgents : topSubAgents;
  const roundStatus = usePinnedSlice
    ? sessionSlice!.roundsView[sessionSlice!.round]?.status
    : topRoundStatus;

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

  const stepLabels = useMemo(
    () => ({
      stepPlan: t('research.hpias.step_plan'),
      stepRetrieval: t('research.hpias.step_retrieval'),
      stepSelection: t('research.hpias.step_selection'),
      stepSubagents: t('research.hpias.step_subagents'),
      stepSynthesis: t('research.hpias.step_synthesis'),
      subagentFallback: t('research.hpias.subagent_fallback'),
    }),
    [t],
  );

  const dashboardLabels = useMemo(
    () => ({
      metaTitle: t('research.hpias.meta_title'),
      roundLabel: t('research.plan.round_label'),
      planTitle: t('research.hpias.plan_title'),
      stepPlan: stepLabels.stepPlan,
      stepRetrieval: stepLabels.stepRetrieval,
      stepSelection: stepLabels.stepSelection,
      stepSubagents: stepLabels.stepSubagents,
      stepSynthesis: stepLabels.stepSynthesis,
      subagentFallback: stepLabels.subagentFallback,
      retrievalStatTitle: t('research.hpias.retrieval_stat'),
      selectedStatTitle: t('research.hpias.selected_stat'),
      reportMetaTitle: t('research.report.meta_title'),
      citationStatTitle: t('research.report.citation_stat'),
      copyReport: t('research.actions.copy_report'),
      exportPlan: t('research.actions.export_plan'),
      exportIntent: t('research.actions.export_intent'),
      copyIntent: t('action.copy_intent'),
      stepsListTitle: t('research.hpias.steps_list_title'),
      stepStatusPending: t('research.hpias.step_status_pending'),
      stepStatusActive: t('research.hpias.step_status_active'),
      stepStatusDone: t('research.hpias.step_status_done'),
      digestFallbackTitle: t('research.hpias.digest_fallback_title'),
      emptySteps: t('research.hpias.empty_steps'),
      stepsBlockTitle: t('research.hpias.steps_block_title'),
    }),
    [stepLabels, t],
  );

  const intent = useMemo(
    () =>
      buildHpiasResearchDashboardIntent({
        snapshot,
        question,
        labels: dashboardLabels,
      }),
    [dashboardLabels, question, snapshot],
  );

  const getReportBody = useCallback(
    () => snapshot.synthesis?.trim() ?? '',
    [snapshot.synthesis],
  );

  const getExportMarkdown = useCallback(
    () =>
      buildResearchExportMarkdownFromSnapshot(
        {
          snapshot,
          question,
          planTitle: dashboardLabels.planTitle,
          roundLabel: dashboardLabels.roundLabel,
          stepLabels,
        },
        exportMarkdownLabels.research,
      ),
    [
      dashboardLabels.planTitle,
      dashboardLabels.roundLabel,
      exportMarkdownLabels.research,
      question,
      snapshot,
      stepLabels,
    ],
  );

  const getIntent = useCallback(() => intent, [intent]);

  const actionHandlers = useMemo(() => {
    const researchHandlers = createResearchBriefingActionHandlers(
      { getReportBody, getExportMarkdown, getIntent },
      {
        copyReport: dashboardLabels.copyReport,
        exportPlan: dashboardLabels.exportPlan,
        exportIntent: dashboardLabels.exportIntent,
      },
      exportMarkdownLabels.intent,
    );
    if (!intent || !dashboardLabels.copyIntent) {
      return researchHandlers;
    }
    return {
      ...researchHandlers,
      ...createCopyIntentActionHandlers(intent, { copyIntent: dashboardLabels.copyIntent }),
    };
  }, [
    dashboardLabels.copyIntent,
    dashboardLabels.copyReport,
    dashboardLabels.exportIntent,
    dashboardLabels.exportPlan,
    exportMarkdownLabels.intent,
    getExportMarkdown,
    getIntent,
    getReportBody,
    intent,
  ]);

  if (!sessionId || !intent || (expectedSessionId && sessionId !== expectedSessionId)) {
    return emptyFallback ? <>{emptyFallback}</> : null;
  }

  return (
    <div data-testid="hpias-generative-research-panel">
      <GenerativeUIPanel intent={intent} showChrome={showChrome} actionHandlers={actionHandlers} />
    </div>
  );
}
