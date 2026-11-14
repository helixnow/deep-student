import type { ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { ImageOcclusionOverlay } from '@/components/anki/ImageOcclusionOverlay';
import { WeakConceptsStrip } from '@/components/dashboard/WeakConceptsStrip';
import { ExamReadinessHud } from '@/components/exam-sprint/ExamReadinessHud';
import { setSprintReadinessForTest } from '@/components/exam-sprint/sprintLauncherStore';
import { SprintSettlementScreen } from '@/components/exam-sprint/SprintSettlementScreen';
import { UnifiedDailySprintPlayer } from '@/components/exam-sprint/UnifiedDailySprintPlayer';
import { LearningHeatmap } from '@/components/LearningHeatmap';
import { LlmUsageStatsSection } from '@/components/llm-usage/LlmUsageStatsSection';
import { DailyPracticeMode } from '@/components/practice/DailyPracticeMode';
import { MockExamMode } from '@/components/practice/MockExamMode';
import { QBankAgentDiffBar } from '@/components/practice/QBankAgentDiffBar';
import { TimedPracticeMode } from '@/components/practice/TimedPracticeMode';
import { KnowledgeRadar } from '@/components/stats/KnowledgeRadar';
import { LearningTrendChart } from '@/components/stats/LearningTrendChart';
import { StudySpaceBadgeStrip } from '@/components/study-space/StudySpaceBadgeStrip';
import { PlanSteps } from '@/features/chat/components/agent-task/PlanSteps';
import { RuntimeSection } from '@/features/chat/components/agent-task/RuntimeSection';
import { CompletionCard } from '@/features/chat/components/CompletionCard';
import { ContextualMiniChat } from '@/features/chat/components/ContextualMiniChat';
import { ContextUsageRing } from '@/features/chat/components/ContextUsageRing';
import { PlanGateCard } from '@/features/chat/components/PlanGateCard';
import { ProjectKnowledgeDagDrawer } from '@/features/chat/components/ProjectKnowledgeDagDrawer';
import { ToolApprovalCard } from '@/features/chat/components/ToolApprovalCard';
import { TurnDiffReviewCard } from '@/features/chat/components/TurnDiffReviewCard';
import { RetentionInsightsPanel } from '@/features/flashcards/components/RetentionInsightsPanel';
import { ReviewHeatmap } from '@/features/flashcards/components/ReviewHeatmap';
import '@/features/flashcards/flashcards-dashboard.css';
import '@/features/flashcards/flashcards.css';
import { SessionSummary } from '@/features/flashcards/review/SessionSummary';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { MediaCheckpointCard } from '@/features/learning-hub/apps/views/media/MediaCheckpointCard';
import { PdfPageMarginBacklinks } from '@/features/pdf/components/PdfPageMarginBacklinks';
import { PluginRow } from '@/features/plugin-manager/PluginRow';
import { WorkshopProposalCard } from '@/features/plugin-workshop/components/WorkshopProposalCard';
import type { SettleSprintSessionRequest } from '@/shared/exam-sprint';
import { useQbankAgentDiffStore } from '@/stores/qbankAgentDiffStore';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import { mockHostCall, mockInvoke } from '../shims/tauri-core';
import { brand } from '../theme';
import { useFontsReady } from '../ui/tex';
import { TextbookPage } from '../ui/TextbookPage';
import { AppSurface } from './AppSurface';
import {
  automationApproval,
  backlinks,
  checkInCalendar,
  completion,
  dailyPractice,
  EXAM,
  heatmapDays,
  horizon,
  installed,
  knowledge,
  knowledgeStats,
  learningActivities,
  learningTrend,
  llmUsage,
  mediaCheckpoint,
  miniChatAnchor,
  miniChatMessages,
  mockExamScoreCard,
  mockExamSession,
  noteApproval,
  noteTurnDiff,
  occlusion,
  planGate,
  planSteps,
  plugins,
  proposal,
  qbankDiffs,
  readiness,
  reviewBriefing,
  reviewBriefingActions,
  reviewStatistics,
  runtimeEnvironment,
  runtimeItems,
  SESSION,
  sessionSummary,
  settlement,
  settleSprint,
  space,
  sprintPlan,
  timedSession,
  weakestConcepts,
} from './fixtures';
import { PAGES as DELEGATE_PAGES } from './pages/delegate';
import { PAGES as DESKTOP_PAGES } from './pages/desktop';
import { PAGES as EXAM_PAGES } from './pages/exam';
import { PAGES as PLATFORM_PAGES } from './pages/platform';
import { PAGES as READER_PAGES } from './pages/reader';
import { PAGES as TUTOR_PAGES } from './pages/tutor';
import { click, Staged, waitFor, waitForText, type StageAction } from './Staged';

/**
 * 检查用合成（AppUiGallery）：把引进来的主应用组件按固定数据摆出来，确认样式、文案与打包链路。不进成片。
 * 第 0 帧：插件工坊确认卡、冲刺结算页；第 1 帧：学习空间、考试冲刺 HUD、课中检查点；
 * 第 2、3 帧：今日冲刺播放器走完一轮（错题答错 → 多来源闪卡 → 导图挖空 → 重练 → 结算）；
 * 第 4 帧：生成式界面、本轮改动审阅、工具审批与计划确认；
 * 第 5 帧：计划步骤、任务完成卡、上下文用量、伴读小窗、计划拓扑、闪卡复习小结与热力图；
 * 第 6 帧：学习热力图、学习趋势、知识点掌握度；第 7 帧：限时练习、模拟考试成绩单、每日一练与打卡日历；
 * 第 8 帧：插件管理行、题目集改动条、图片遮挡卡与 PDF 页边回链；
 * 第 9 帧：保留率与记忆分布、薄弱知识点条、任务面板的本地环境区、模型用量。
 */
const noop = () => {};

// 组件自己从 store / 后端取数：在模块加载时放进固定数据
setSprintReadinessForTest(readiness(0.812), horizon);
mockHostCall('review', 'settleSprintSession', ([request]) => settleSprint(request as SettleSprintSessionRequest));
mockInvoke('get_learning_heatmap', () => learningActivities);
mockInvoke('qbank_get_learning_trend', () => learningTrend);
mockInvoke('qbank_get_knowledge_stats_with_comparison', () => knowledgeStats);
mockInvoke('qbank_get_check_in_calendar', () => checkInCalendar);
mockInvoke('fsrs_get_review_statistics', () => reviewStatistics);
mockInvoke('llm_usage_summary', () => llmUsage.summary);
mockInvoke('llm_usage_get_trends', () => llmUsage.trends);
mockInvoke('llm_usage_by_model', () => llmUsage.byModel);
mockInvoke('llm_usage_by_caller', () => llmUsage.byCaller);
useQuestionBankStore.setState({ timedSession, mockExamSession, mockExamScoreCard, dailyPractice });
useQbankAgentDiffStore.setState({ entriesByExamId: { [EXAM]: qbankDiffs } });

const At = ({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) => (
  <AppSurface style={{ left: x, top: y, width: w, background: 'transparent' }}>{children}</AppSurface>
);

const PageWorkshopAndSprint = () => (
  <>
    <At x={80} y={60} w={520}>
      <WorkshopProposalCard item={proposal} onAction={noop} onRepair={noop} />
    </At>
    <At x={80} y={600} w={520}>
      <WorkshopProposalCard item={installed} onAction={noop} onRepair={noop} />
    </At>
    <AppSurface style={{ left: 680, top: 60, width: 1160, height: 960, borderRadius: 16, overflow: 'hidden', border: `1px solid ${brand.hairline}` }}>
      <SprintSettlementScreen settlement={settlement} deferredBacklogCount={9} onFinish={noop} onExtraSprint={noop} />
    </AppSurface>
  </>
);

const PageStudy = () => (
  <>
    <At x={60} y={40} w={560}>
      <StudySpaceBadgeStrip space={space} onEditSpace={noop} onOpenFolder={noop} onReviewDeck={noop} />
    </At>
    <At x={60} y={130} w={560}>
      <ExamReadinessHud variant="study-space-header" />
    </At>
    <At x={60} y={220} w={560}>
      <ExamReadinessHud variant="agenda-strip" />
    </At>
    <At x={680} y={40} w={420}>
      <MediaCheckpointCard checkpoint={mediaCheckpoint} pauseAtCheckpoints={false} onPauseAtCheckpointsChange={noop} onSeek={noop} onResume={noop} onClose={noop} onAnswered={noop} />
    </At>
  </>
);

const reveal = click('[data-testid="sprint-reveal-button"]');
const rate = (rating: 1 | 2 | 3 | 4) => click(`[data-testid="sprint-rate-${rating}"]`);
/** 一轮冲刺：第 7 题选 A（错）→ 重来；ξ 卡 → 良好；导图节点 → 良好；重练的第 7 题选 C → 良好 → 结算。 */
const SPRINT: StageAction[] = [
  click('[data-testid="sprint-option-A"]'),
  reveal,
  rate(1),
  reveal,
  rate(3),
  reveal,
  rate(3),
  click('[data-testid="sprint-option-C"]'),
  reveal,
  rate(3),
  waitFor('[data-testid="sprint-settlement-screen"]'),
];

/** 播放器是 fixed 全屏层：挂载面加 transform，让它以挂载面为包含块。 */
const Sprint = ({ x, step }: { x: number; step: number }) => (
  <AppSurface style={{ left: x, top: 40, width: 900, height: 1000, transform: 'translateZ(0)', overflow: 'hidden', borderRadius: 16, border: `1px solid ${brand.hairline}` }}>
    <Staged actions={SPRINT} step={step}>
      <UnifiedDailySprintPlayer initialPlan={sprintPlan} usePortal={false} onClose={noop} />
    </Staged>
  </AppSurface>
);

const PageAgent = () => (
  <>
    <At x={40} y={30} w={880}>
      <GenerativeUIRenderer intent={reviewBriefing} actionHandlers={reviewBriefingActions} onAction={noop} />
    </At>
    <At x={960} y={30} w={920}>
      <TurnDiffReviewCard entries={noteTurnDiff} onRevertFile={noop} onRevertAll={noop} />
    </At>
    <At x={960} y={420} w={450}>
      <ToolApprovalCard request={automationApproval} sessionId={SESSION} />
    </At>
    <At x={1430} y={420} w={450}>
      <PlanGateCard request={planGate} sessionId={SESSION} />
    </At>
    <At x={1430} y={760} w={450}>
      <ToolApprovalCard request={noteApproval} sessionId={SESSION} />
    </At>
  </>
);

const OPEN_USAGE = [click('[data-testid="context-usage-ring"]')];

const PageAgentParts = () => (
  <>
    <At x={40} y={30} w={520}>
      <PlanSteps steps={planSteps} />
    </At>
    <At x={40} y={300} w={520}>
      <CompletionCard data={completion} />
    </At>
    <At x={300} y={700} w={260}>
      <Staged actions={OPEN_USAGE} step={1}>
        <ContextUsageRing usedTokens={86_400} maxWindowTokens={128_000} showInlineSummary onCompress={noop} />
      </Staged>
    </At>
    <At x={600} y={30} w={400}>
      <ContextualMiniChat anchor={miniChatAnchor} initialMessages={miniChatMessages} />
    </At>
    <At x={1040} y={30} w={450}>
      <ProjectKnowledgeDagDrawer data={knowledge} activePlanId={knowledge.plans[0].id} />
    </At>
    <AppSurface style={{ left: 1530, top: 30, width: 350, height: 470, overflow: 'hidden', borderRadius: 16, border: `1px solid ${brand.hairline}` }}>
      <SessionSummary {...sessionSummary} busy={false} canUndo={false} canResume={false} onUndo={noop} onResume={noop} onBack={noop} onContinue={noop} />
    </AppSurface>
    <At x={40} y={930} w={740}>
      <div data-flashcards-app>
        <ReviewHeatmap dayCounts={heatmapDays} />
      </div>
    </At>
  </>
);

/** 这几个组件挂载后自己取数：等数据画出来再截帧。 */
const HEATMAP_READY = [waitFor('.lh-cell[data-date]')];
const CHART_READY = [waitFor('svg[role="img"]')];

const PageStats = () => (
  <>
    <At x={40} y={30} w={900}>
      <Staged actions={HEATMAP_READY} step={1}>
        <LearningHeatmap />
      </Staged>
    </At>
    <At x={40} y={470} w={900}>
      <Staged actions={CHART_READY} step={1}>
        <LearningTrendChart examId={EXAM} />
      </Staged>
    </At>
    <At x={980} y={30} w={900}>
      <Staged actions={CHART_READY} step={1}>
        <KnowledgeRadar examId={EXAM} />
      </Staged>
    </At>
  </>
);

const TIMED_READY = [waitForText('18:00')];
const SCORE_READY = [waitForText('成绩单')];
const DAILY_READY = [waitForText('连续打卡天数')];

const PagePractice = () => (
  <>
    <At x={40} y={30} w={560}>
      <Staged actions={TIMED_READY} step={1}>
        <TimedPracticeMode examId={EXAM} />
      </Staged>
    </At>
    <At x={660} y={30} w={560}>
      <Staged actions={SCORE_READY} step={1}>
        <MockExamMode examId={EXAM} />
      </Staged>
    </At>
    <At x={1280} y={30} w={600}>
      <Staged actions={DAILY_READY} step={1}>
        <DailyPracticeMode examId={EXAM} />
      </Staged>
    </At>
  </>
);

const OPEN_BACKLINKS = [click('[data-testid="pdf-margin-backlinks"] button')];
const REVEALED = new Set([1]);
/** 教材第 132 页的上半页 */
const PAGE = { x: 1000, y: 30, w: 688, h: 520 };

const PageExtensions = () => {
  useFontsReady();
  return (
    <>
      <At x={40} y={30} w={900}>
        <div role="list">
          {plugins.map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} platform="desktop" busy={false} errorBudget={null} autoUninstalled={null} onToggle={noop} onConfigure={noop} onUninstall={noop} onReviewConsent={noop} />
          ))}
        </div>
      </At>
      <At x={40} y={330} w={900}>
        <QBankAgentDiffBar examId={EXAM} onRevertQuestions={noop} defaultExpanded />
      </At>
      {/* 教材页是片子自己画的；遮挡层与页边回链是主应用组件，叠在同一块区域上 */}
      <div style={{ position: 'absolute', left: PAGE.x, top: PAGE.y, width: PAGE.w, height: PAGE.h, overflow: 'hidden', borderRadius: 4 }}>
        <TextbookPage />
      </div>
      <AppSurface style={{ left: PAGE.x, top: PAGE.y, width: PAGE.w, height: PAGE.h, background: 'transparent' }}>
        <ImageOcclusionOverlay spec={occlusion} revealedIndices={REVEALED} />
        <Staged actions={OPEN_BACKLINKS} step={1}>
          <PdfPageMarginBacklinks summary={backlinks} page={132} />
        </Staged>
      </AppSurface>
    </>
  );
};

const RETENTION_READY = [waitFor('[data-testid="fsrs-retention-insights"]')];
const USAGE_READY = [waitFor('.recharts-area-curve'), waitFor('.recharts-pie-sector')];

const PageInsights = () => (
  <>
    <At x={40} y={30} w={900}>
      <div data-flashcards-app>
        <Staged actions={RETENTION_READY} step={1}>
          <RetentionInsightsPanel />
        </Staged>
      </div>
    </At>
    <At x={40} y={470} w={900}>
      <WeakConceptsStrip concepts={weakestConcepts} />
    </At>
    <At x={40} y={560} w={560}>
      <RuntimeSection items={runtimeItems} environment={runtimeEnvironment} />
    </At>
    <At x={980} y={30} w={900}>
      <Staged actions={USAGE_READY} step={USAGE_READY.length}>
        <LlmUsageStatsSection sessionTrends={llmUsage.sessions} />
      </Staged>
    </At>
  </>
);

const PAGES = [
  <PageWorkshopAndSprint />,
  <PageStudy />,
  <>
    <Sprint x={40} step={2} />
    <Sprint x={980} step={4} />
  </>,
  <>
    <Sprint x={40} step={6} />
    <Sprint x={980} step={SPRINT.length} />
  </>,
  <PageAgent />,
  <PageAgentParts />,
  <PageStats />,
  <PagePractice />,
  <PageExtensions />,
  <PageInsights />,
  // 各 lane 的检查页（src/app-ui/pages/<名字>.tsx）接在后面
  ...TUTOR_PAGES,
  ...READER_PAGES,
  ...DESKTOP_PAGES,
  ...EXAM_PAGES,
  ...DELEGATE_PAGES,
  ...PLATFORM_PAGES,
];
export const GALLERY_PAGES = PAGES.length;

export const Gallery = () => <AbsoluteFill style={{ background: brand.paper }}>{PAGES[useCurrentFrame()]}</AbsoluteFill>;
