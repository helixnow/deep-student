import type { CallerTypeSummary, ModelSummary, UsageSummary, UsageTrendPoint } from '@/api/llmUsageApi';
import type { Question } from '@/api/questionBankApi';
import type { OcclusionSpec } from '@/components/anki/utils/imageOcclusion';
import type { MasteryState } from '@/components/dashboard/WeakConceptsStrip';
import type { SprintCompoundPlan } from '@/components/exam-sprint/sprintContracts';
import type { RuntimeEnvironment, RuntimeItem, Step } from '@/features/chat/components/agent-task/types';
import type { CompletionData } from '@/features/chat/components/CompletionCard';
import type { MiniChatContextAnchor, MiniChatMessage } from '@/features/chat/components/ContextualMiniChat';
import type { PlanGateRequestData } from '@/features/chat/components/PlanGateCard';
import type { ApprovalRequestData } from '@/features/chat/components/ToolApprovalCard';
import type { TurnFileDiffEntry } from '@/features/chat/components/TurnDiffReviewCard';
import type { KnowledgeNote, KnowledgePlan, KnowledgeTodo } from '@/features/chat/utils/projectKnowledgeDag';
import type { SessionRatingCounts } from '@/features/flashcards/store/fsrsReviewStore';
import type { GenerativeActionDefinition, GenerativeUIIntent } from '@/features/generative-ui/types';
import type { MediaCheckpoint } from '@/features/learning-hub/apps/views/media/mediaCheckpoints';
import type { AnchorBacklinkSummary } from '@/features/pdf/interop/pdfInteropBridge';
import type { ChannelPlugins } from '@/features/plugin-manager/ChannelPluginSection';
import type { ManagedPlugin } from '@/features/plugin-manager/types';
import type { WorkshopItem } from '@/features/plugin-workshop/types';
import type { DeepSeekCapabilitySettings } from '@/features/settings/components/DeepSeekCapabilities';
import type { LearningActivity } from '@/hooks/useLearningHeatmap';
import type {
  ExamHorizonConfig,
  ExamReadinessSnapshot,
  SettleSprintSessionRequest,
  SprintItemTriageMeta,
  SprintSessionSettlement,
  SprintSourceAnchor,
} from '@/shared/exam-sprint';
import type { StudySpace } from '@/shared/study-space/types';
import { computeQuestionFieldChanges, type QuestionDiffEntry } from '@/stores/qbankAgentDiffStore';
import type {
  CheckInCalendar,
  DailyPracticeResult,
  KnowledgePoint,
  KnowledgeStatsComparison,
  LearningTrendPoint,
  MockExamScoreCard,
  MockExamSession,
  TimedPracticeSession,
} from '@/stores/questionBankStore';
import type { ApiConfig, ModelProfile, VendorConfig } from '@/types';
import type { AnchorEdgeRecord, AnchorEdgeSourceKind } from '@/ui-kernel/contracts/interop';
import { rand } from '../lib/time';
import { FINDINGS_NEW, FINDINGS_OLD } from '../ui/notes';
import { NOTE_TITLE, STEPS } from '../ui/research';
import { FILM_NOW } from './clock';

/**
 * 主应用组件在片子里用的固定数据。时间以片中的「今天」为准（2026-10-03，见 clock.ts）：
 * 期中考试在 10 月 27 日，还有 24 天，处在强化期（主应用的分期：8–30 天）。
 * 题目、卡片与导图节点沿用片中已有的内容（第 7 题、ξ 卡、「微分中值定理」导图）。
 */
export const SESSION = 'pv-session';
export const SPACE = 'space-calculus';
const ROOT_FOLDER = 'fld_calculus';
const EXAM_DATE = '2026-10-27';
const DAYS_LEFT = 24;

export const proposal: WorkshopItem = {
  id: 'dstu.community.formula-sheet',
  proposalId: 'wp-formula-sheet-1',
  name: '公式速查表',
  version: '0.1.0',
  description: '从当前学习空间的笔记里汇总公式，按章节排成一页速查表，可固定在学习桌面。',
  capabilities: ['service:notes（读取笔记）', 'service:workbench（添加桌面小组件）'],
  changes: ['新增桌面小组件「公式速查」', '新增命令「刷新公式速查表」'],
  trust: 'full',
  phase: 'ready',
  visualVerified: true,
};
export const installed: WorkshopItem = { ...proposal, proposalId: 'wp-formula-sheet-2', phase: 'installed' };

export const readiness = (predicted: number): ExamReadinessSnapshot => ({
  spaceId: SPACE,
  examDate: EXAM_DATE,
  daysUntilExam: DAYS_LEFT,
  phase: 'reinforce',
  effectiveTargetRetention: 0.92,
  dailyNewCardQuota: 12,
  newIntakeFrozen: false,
  predictedExamRetrievability: predicted,
  currentRetrievability: predicted + 0.04,
  totalActiveItems: 386,
  selectedSprintCount: 24,
  estimatedSprintMinutes: 18,
  estimatedSprintSeconds: 1080,
  deferredBacklogCount: 9,
  breakdown: { fsrsDueCount: 14, fsrsNewCount: 4, mistakeDueCount: 4, mindmapWeakCount: 2 },
  computedAtMs: 0,
});

export const horizon: ExamHorizonConfig = {
  spaceId: SPACE,
  rootFolderId: ROOT_FOLDER,
  examDate: EXAM_DATE,
  sprintBudgetMinutes: 20,
  baseTargetRetention: 0.9,
  defaultDeckId: null,
  dayRolloverHour: 4,
};

export const settlement: SprintSessionSettlement = {
  planSessionId: 'sprint-2026-10-03',
  readinessBefore: readiness(0.812),
  readinessAfter: readiness(0.839),
  readinessDeltaPctPoints: 2.7,
  totalCompleted: 24,
  passedCount: 20,
  againCount: 4,
  totalElapsedSeconds: 1068,
  studyTimeRecordedSeconds: 1068,
  masteryEventsWritten: 24,
  byKind: { fsrsCards: 14, mistakes: 5, variantsSolved: 2, mindmapNodes: 3 },
  conceptDeltas: [
    { concept: '拉格朗日中值定理', scoreAfter: 0.86, outcome: 'improved' },
    { concept: 'ξ 的取值范围', scoreAfter: 0.62, outcome: 'needs_reinforce' },
    { concept: '罗尔定理', scoreAfter: 0.91, outcome: 'steady' },
  ],
};

export const space: StudySpace = {
  spaceId: SPACE,
  name: '高等数学 · 期中',
  defaultSkillIds: [],
  pinnedResourceIds: [],
  sortOrder: 0,
  persistStatus: 'active',
  rootFolderId: ROOT_FOLDER,
  examDate: EXAM_DATE,
  dailyBudgetMinutes: 45,
  targetRetention: 0.9,
  workbenchLayoutPreset: 'split_reader_chat',
  mountedResourceIds: [],
  mounts: [],
  defaultDeckId: null,
  memoryScope: 'space_and_global',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

export const mediaCheckpoint: MediaCheckpoint = {
  questionId: 'q-cp-3',
  examId: 'exam-cp',
  seconds: 320,
  content: 'n 阶矩阵有 n 个互不相同的特征值，能推出什么？',
  questionType: 'single_choice',
  options: [
    { key: 'A', content: '一定可以对角化' },
    { key: 'B', content: '一定是对称矩阵' },
    { key: 'C', content: '行列式一定不为零' },
  ],
  answer: 'A',
  explanation: '不同特征值对应的特征向量线性无关，n 个线性无关的特征向量即可对角化。',
  attemptCount: 0,
  isCorrect: null,
};

const anchor = (kind: SprintSourceAnchor['kind'], resourceId: string, label: string, at: Partial<SprintSourceAnchor> = {}): SprintSourceAnchor => ({
  anchorUri: null,
  kind,
  resourceId,
  label,
  page: null,
  startMs: null,
  blockId: null,
  nodeId: null,
  questionId: null,
  quote: null,
  ...at,
});

const triage = (concept: string, estimatedSeconds: number, retrievability: number): SprintItemTriageMeta => ({
  utilityScore: 0.8,
  currentRetrievability: retrievability,
  examRetrievabilityBefore: retrievability - 0.1,
  importance: 1,
  estimatedSeconds,
  conceptTags: [concept],
});

const MINDMAP = 'mm-mvt';
const MINDMAP_TITLE = '微分中值定理';
const TEXTBOOK = '高等数学（第七版）上册';

/** 第 7 题（题面同 ui/exam.tsx）：冲刺队列和题目集改动条共用。 */
const Q7 = {
  content: '设 f(x) 在 [a, b] 上连续，在 (a, b) 内可导，且 f(a) = f(b)。下列结论一定成立的是（　　）',
  options: [
    { key: 'A', content: '存在 ξ ∈ [a, b]，使 f′(ξ) = 0' },
    { key: 'B', content: '存在 ξ ∈ (a, b)，使 f(ξ) = 0' },
    { key: 'C', content: '存在 ξ ∈ (a, b)，使 f′(ξ) = 0' },
    { key: 'D', content: '对任意 x ∈ (a, b)，都有 f′(x) = 0' },
  ],
  answer: 'C',
  explanation: '题设正好是罗尔定理的三个条件。ξ 只保证落在开区间 (a, b) 内，A 把区间写成了闭区间，端点不在结论里。',
};

/** 今日冲刺队列的三种条目各一：昨天做错的第 7 题、多来源的 ξ 卡、导图里挖空的节点。 */
export const sprintPlan: SprintCompoundPlan = {
  planSessionId: settlement.planSessionId,
  config: horizon,
  readinessBefore: readiness(0.812),
  deferredBacklogCount: 9,
  generatedVariantsCount: 0,
  createdAtMs: 0,
  items: [
    {
      kind: 'mistake_question',
      sprintItemId: 'mistake:plan-q7',
      planId: 'plan-q7',
      examId: 'exam-midterm',
      examName: '高数期中模拟卷',
      questionId: 'q-7',
      originalQuestionId: 'q-7',
      isVariant: false,
      variantBadgeReason: null,
      questionType: 'single_choice',
      content: Q7.content,
      options: Q7.options,
      answer: Q7.answer,
      explanation: Q7.explanation,
      structuredData: null,
      originalPromptPreview: null,
      originalAnswerPreview: null,
      lapsesCount: 1,
      repetitions: 0,
      intervalDays: 1,
      sourceAnchor: anchor('qbank', 'exam-midterm', '高数期中模拟卷 · 第 7 题', { questionId: 'q-7' }),
      triage: triage('罗尔定理', 60, 0.52),
    },
    {
      kind: 'fsrs_card',
      sprintItemId: 'fsrs:cs-xi',
      cardStateId: 'cs-xi',
      ankiCardId: 'card-xi',
      deckName: '高等数学::微分中值定理',
      cardFormat: 'qa',
      front: 'ξ 取在闭区间还是开区间？',
      back: '开区间 $(a, b)$，不含端点。',
      fields: {},
      templateId: null,
      state: 3,
      lapses: 1,
      reps: 2,
      stability: 0.4,
      difficulty: 6.8,
      sourceAnchor: null,
      sourceAnchors: [
        anchor('mindmap', MINDMAP, MINDMAP_TITLE, { nodeId: 'lag' }),
        anchor('pdf', 'tb-calculus-7', TEXTBOOK, { page: 132, quote: '那么在 (a, b) 内至少有一点 ξ，使等式 f(b) − f(a) = f′(ξ)(b − a) 成立。' }),
      ],
      ancestorPath: [MINDMAP_TITLE, '拉格朗日中值定理'],
      personalNote: '端点只要求连续，不保证可导，所以 ξ 落不到端点上。',
      triage: triage('ξ 的取值范围', 20, 0.61),
    },
    {
      kind: 'mindmap_cloze',
      sprintItemId: `mindmap:${MINDMAP}:lag2`,
      mindmapId: MINDMAP,
      mindmapTitle: MINDMAP_TITLE,
      nodeId: 'lag2',
      ancestorPath: [MINDMAP_TITLE, '拉格朗日中值定理'],
      siblingHints: ['f(b) − f(a) = f′(ξ)(b − a)'],
      fullText: '关键：构造辅助函数 φ(x)',
      maskedText: '关键：构造［ ？ ］',
      blankedRanges: [{ start: 5, end: 14 }],
      noteExcerpt: '令 φ(x) = f(x) − L(x)，L(x) 是弦 AB 的直线方程；φ(a) = φ(b)，于是可以用罗尔定理。',
      smoothedErrorRate: 0.5,
      attempts: 2,
      misses: 1,
      sourceAnchor: anchor('mindmap', MINDMAP, MINDMAP_TITLE, { nodeId: 'lag2' }),
      triage: triage('辅助函数', 25, 0.58),
    },
  ],
};

/** 冲刺结算（Host 的 review.settleSprintSession）：条数按这一轮实际的评分记录算，预测提取率沿用 settlement。 */
export const settleSprint = (request: SettleSprintSessionRequest): SprintSessionSettlement => {
  const final = [...new Map(request.completedItems.map((record) => [record.sprintItemId, record])).values()];
  const count = (kind: (typeof final)[number]['kind']) => final.filter((record) => record.kind === kind).length;
  return {
    ...settlement,
    planSessionId: request.planSessionId,
    totalCompleted: final.length,
    passedCount: final.filter((record) => record.passed).length,
    againCount: request.completedItems.filter((record) => record.rating === 1).length,
    masteryEventsWritten: final.length,
    byKind: { fsrsCards: count('fsrs_card'), mistakes: count('mistake_question'), variantsSolved: 0, mindmapNodes: count('mindmap_cloze') },
  };
};

/** 生成式界面：回答里直接给出的复习概览（数字与冲刺 HUD、冲刺队列一致）。 */
export const reviewBriefing: GenerativeUIIntent = {
  version: '1.1',
  layout: { mode: 'grid', columns: 2 },
  meta: { title: '期中复习概览', description: '根据这一周的复习记录与题目集作答情况' },
  blocks: [
    { type: 'stat-card', props: { title: '预测提取率', value: '81.2%', subtitle: '距期中考试 24 天', trend: 'up', trendLabel: '较上周 +3.4%' } },
    { type: 'progress', props: { title: '今日冲刺', current: 0, total: 24, label: '24 项，预计 18 分钟' } },
    {
      type: 'chart',
      span: 2,
      props: {
        title: '本周复习量',
        kind: 'bar',
        categories: ['周一', '周二', '周三', '周四', '周五'],
        series: [
          { name: '已复习', values: [18, 22, 15, 26, 21] },
          { name: '到期', values: [20, 22, 19, 26, 24] },
        ],
        unit: '张',
      },
    },
    {
      type: 'mistake-analysis',
      props: {
        topic: 'ξ 的取值范围',
        errorRate: 50,
        mistakeCount: 2,
        suggestion: '把罗尔、拉格朗日、柯西三个定理的结论并排对照：ξ 都取在开区间内。',
        severity: 'high',
      },
    },
    {
      type: 'review-calendar',
      props: {
        days: [
          { date: '2026-10-03', label: '今天', dueCount: 24, completedCount: 0 },
          { date: '2026-10-04', dueCount: 18 },
          { date: '2026-10-05', dueCount: 21 },
          { date: '2026-10-06', dueCount: 15 },
        ],
      },
    },
    {
      type: 'action-bar',
      span: 2,
      props: {
        actions: [
          { id: 'start-sprint', label: '开始今日冲刺', variant: 'primary', riskLevel: 'low' },
          { id: 'open-qbank', label: '打开题目集', variant: 'default', riskLevel: 'low' },
        ],
      },
    },
  ],
};

const action = (id: string, label: string): GenerativeActionDefinition => ({ id, label, riskLevel: 'low', handler: () => {} });
export const reviewBriefingActions = {
  'start-sprint': action('start-sprint', '开始今日冲刺'),
  'open-qbank': action('open-qbank', '打开题目集'),
};

const findings = (items: string[]) => ['## 主要发现', ...items.map((item) => `- ${item}`)].join('\n');

/** 本轮改动审阅：片中「把主要发现改精炼些」那一轮对笔记的改写（与 ui/notes.tsx 同文）。 */
export const noteTurnDiff: TurnFileDiffEntry[] = [
  {
    id: 'note-findings',
    path: `笔记/${NOTE_TITLE}.md`,
    kind: 'modified',
    beforeContent: findings(FINDINGS_OLD),
    afterContent: findings(FINDINGS_NEW),
    additions: 0,
    deletions: 0,
  },
];

/** 工具审批：创建定时自动化是高风险操作，逐次确认。 */
export const automationApproval: ApprovalRequestData = {
  toolCallId: 'call-automation',
  toolName: 'builtin-automation_propose',
  arguments: {
    name: '每晚复习清单',
    schedule: { kind: 'daily', time: '21:00' },
    prompt: '检查今天到期的闪卡和错题，列出今晚的复习清单。',
  },
  sensitivity: 'high',
  description: '创建定时自动化「每晚复习清单」',
  timeoutSeconds: 120,
};

/** 已批准的一次改笔记。 */
export const noteApproval: ApprovalRequestData = {
  toolCallId: 'call-note',
  toolName: 'builtin-note_replace',
  arguments: { noteId: 'note-research', search: '形式化证明成为主流路线', replace: '形式化证明' },
  sensitivity: 'medium',
  description: '',
  timeoutSeconds: 120,
  resolvedStatus: 'approved',
};

/** 计划确认（想一想模式）：写操作执行前先过一遍计划。 */
export const planGate: PlanGateRequestData = {
  planId: 'plan-findings',
  toolCallId: 'call-plan',
  toolName: 'builtin-note_replace',
  summary: '把「主要发现」的三条各压成一句，保留原有的引用编号。',
  timeoutSeconds: 60,
  arguments: { noteId: 'note-research' },
};

/** 任务面板的计划步骤：片中调研那一轮的 6 步（与 ui/research.tsx 同文），停在第 5 步执行中。 */
export const planSteps: Step[] = STEPS.map((description, i) => ({
  id: `step-${i + 1}`,
  description,
  status: i < 4 ? 'completed' : i === 4 ? 'running' : 'pending',
  ...(i === 1 ? { result: '找到 12 篇相关论文，保留近两年的 5 篇。' } : {}),
  createdAt: 0,
}));

/** 任务完成卡：带验收结论。 */
export const completion: CompletionData = {
  result: `调研完成，报告已保存为笔记「${NOTE_TITLE}」，引用的 5 篇论文已存入资源库并建立索引。`,
  finalization: { verdict: 'verified_complete', exceptions: [] },
};

/** 伴读小窗：锚在教材第 132 页选中的那一句上。 */
export const miniChatAnchor: MiniChatContextAnchor = {
  kind: 'pdf_page',
  label: `${TEXTBOOK} 第 132 页`,
  referenceId: 'tb-calculus-7',
  snippet: '那么在 (a, b) 内至少有一点 ξ，使等式 f(b) − f(a) = f′(ξ)(b − a) 成立。',
};
export const miniChatMessages: MiniChatMessage[] = [
  { id: 'm1', role: 'user', content: '为什么 ξ 不能取到端点？', anchor: miniChatAnchor },
  { id: 'm2', role: 'assistant', content: '定理只要求 f(x) 在端点处连续，不要求可导；f′(a)、f′(b) 可能根本不存在，所以结论只能落在开区间 (a, b) 内。' },
];

const todo = (id: string, body: string, completed: boolean, dependsOn: string[] = []): KnowledgeTodo => ({ id, body, completed, planId: 'plan-midterm', dependsOn });

/** 学习计划与任务拓扑：两项已完成，一项就绪，一项被前一项挡住。 */
export const knowledge: { plans: KnowledgePlan[]; todos: KnowledgeTodo[]; notes: KnowledgeNote[] } = {
  plans: [
    {
      id: 'plan-midterm',
      body: ['# 高等数学 · 期中复习计划', '', '## Steps', '- [x] 梳理「微分中值定理」导图', '- [x] 重做期中模拟卷的错题', '- [ ] 整理三个中值定理的对照笔记', '- [ ] 考前两天做一次限时模拟'].join('\n'),
      sessionId: SESSION,
      progress: { done: 2, total: 4 },
    },
  ],
  todos: [
    todo('todo-map', '梳理「微分中值定理」导图', true),
    todo('todo-mistakes', '重做期中模拟卷的错题', true, ['todo-map']),
    todo('todo-compare', '整理三个中值定理的对照笔记', false, ['todo-mistakes']),
    todo('todo-mock', '考前两天做一次限时模拟', false, ['todo-compare']),
  ],
  notes: [{ id: 'note-xi', body: 'ξ 的取值范围写错过两次：三个定理的结论都只保证开区间。', sessionId: SESSION }],
};

/** 闪卡复习小结（非冲刺的普通一轮）。 */
const ratingCounts: SessionRatingCounts = { 1: 4, 2: 3, 3: 14, 4: 3 };
export const sessionSummary = {
  empty: false,
  headline: '本轮复习已完成',
  ratedCount: 24,
  ratingCounts,
  bestStreak: 9,
  elapsedMs: 1_068_000,
  remainingDue: 9,
};

/** 近一年的复习热力图：学期从 9 月中旬开始变密，暑假稀疏；以片中的「今天」（10 月 3 日）为最后一天。 */
export const heatmapDays: Map<string, number> = (() => {
  const days = new Map<string, number>();
  const two = (n: number) => String(n).padStart(2, '0');
  for (let i = 0; i < 365; i++) {
    const date = new Date(2026, 9, 3 - i);
    const density = i < 20 ? 1 : i < 110 ? 0.35 : i < 230 ? 0.8 : 0.5;
    const r = rand(i + 500);
    if (r > density) continue;
    days.set(`${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`, 4 + Math.round(rand(i + 900) * 26 * density));
  }
  return days;
})();

const two = (n: number) => String(n).padStart(2, '0');
const dayKey = (date: Date) => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
/** 片中「今天」往前第 i 天。 */
const daysAgo = (i: number) => dayKey(new Date(2026, 9, 3 - i));

/** 题目集「高数期中模拟卷」：18 题，题型与难度分布同 ui/exam.tsx。 */
export const EXAM = 'exam-midterm';
const questionIds = (n: number) => Array.from({ length: n }, (_, i) => `q-${i + 1}`);

/** 学习热力图（设置里的学习统计）：近一年每天的学习活动与学习时长，疏密同 heatmapDays。 */
export const learningActivities: LearningActivity[] = Array.from({ length: 365 }, (_, i) => {
  const density = i < 20 ? 1 : i < 110 ? 0.35 : i < 230 ? 0.8 : 0.5;
  const active = i > 0 && rand(i + 500) <= density;
  const n = (seed: number, max: number) => (active ? Math.round(rand(i + seed) * max * density) : 0);
  const details = {
    chatSessions: n(1100, 3),
    chatMessages: n(1200, 14),
    notesEdited: n(1300, 3),
    textbooksOpened: n(1400, 2),
    examsCreated: 0,
    translationsCreated: n(1500, 1),
    essaysCreated: n(1600, 1),
    ankiCardsCreated: n(1700, 12),
    questionsAnswered: n(1800, 18),
  };
  return {
    date: daysAgo(i),
    count: Object.values(details).reduce((sum, v) => sum + v, 0),
    details,
    studySeconds: active ? 600 + Math.round(rand(i + 1900) * 6600 * density) : 0,
  };
}).reverse();

/** 学习趋势（本周）：到昨晚为止的 7 天。 */
export const learningTrend: LearningTrendPoint[] = [
  [14, 9],
  [18, 13],
  [12, 9],
  [22, 17],
  [16, 13],
  [20, 17],
  [24, 20],
].map(([attempt_count, correct_count], i) => ({
  date: daysAgo(7 - i),
  attempt_count,
  correct_count,
  correct_rate: Math.round((correct_count / attempt_count) * 100),
}));

const point = (tag: string, mastered: number, in_progress: number, review: number, correct_rate: number): KnowledgePoint => {
  const total = mastered + in_progress + review;
  return { tag, total, mastered, in_progress, review, new_count: 0, mastery_rate: Math.round((mastered / total) * 100), correct_rate };
};

/** 知识点掌握度：18 题按章节归到 6 个知识点，中值定理最弱（第 7、18 题做错）。 */
export const knowledgeStats: KnowledgeStatsComparison = {
  current: [
    point('极限与连续', 2, 1, 0, 100),
    point('导数与微分', 3, 0, 0, 100),
    point('微分中值定理', 1, 1, 2, 50),
    point('导数的应用', 3, 1, 0, 100),
    point('积分', 2, 0, 1, 67),
    point('泰勒公式', 1, 0, 0, 100),
  ],
  previous: [],
};

/** 限时练习：30 分钟 20 题，开始了 12 分钟，答了 8 题对 6 题。 */
export const timedSession: TimedPracticeSession = {
  id: 'timed-1',
  exam_id: EXAM,
  duration_minutes: 30,
  question_count: 20,
  question_ids: questionIds(20),
  started_at: new Date(FILM_NOW - 12 * 60_000).toISOString(),
  answered_count: 8,
  correct_count: 6,
  is_timeout: false,
  is_submitted: false,
  paused_seconds: 0,
  is_paused: false,
  answered_question_ids: questionIds(8),
};

const MOCK_STARTED = FILM_NOW - 120 * 60_000;
const MOCK_SPENT_S = 52 * 60;

/** 模拟考试：整卷 18 题，已交卷。 */
export const mockExamSession: MockExamSession = {
  id: 'mock-1',
  exam_id: EXAM,
  config: { duration_minutes: 60, type_distribution: {}, difficulty_distribution: {}, total_count: 18, shuffle: true, include_mistakes: true },
  question_ids: questionIds(18),
  started_at: new Date(MOCK_STARTED).toISOString(),
  ended_at: new Date(MOCK_STARTED + MOCK_SPENT_S * 1000).toISOString(),
  answers: {},
  results: {},
  is_submitted: true,
};

const stat = (correct: number, total: number) => ({ total, correct, rate: Math.round((correct / total) * 100) });

/** 成绩单：做错第 7、14、18 题，分题型与分难度的数字由此算出。 */
export const mockExamScoreCard: MockExamScoreCard = {
  session_id: mockExamSession.id,
  exam_id: EXAM,
  total_count: 18,
  answered_count: 18,
  correct_count: 15,
  wrong_count: 3,
  unanswered_count: 0,
  correct_rate: 83.3,
  time_spent_seconds: MOCK_SPENT_S,
  type_stats: { single_choice: stat(9, 10), fill_blank: stat(4, 5), short_answer: stat(1, 2), calculation: stat(1, 1) },
  difficulty_stats: { easy: stat(5, 5), medium: stat(8, 10), hard: stat(2, 2), very_hard: stat(0, 1) },
  wrong_question_ids: ['q-7', 'q-14', 'q-18'],
  comment: '基础题全部答对，失分集中在微分中值定理。',
  completed_at: new Date(MOCK_STARTED + MOCK_SPENT_S * 1000).toISOString(),
};

/** 每日一练：今天的 10 题做了 6 题。 */
export const dailyPractice: DailyPracticeResult = {
  date: daysAgo(0),
  exam_id: EXAM,
  question_ids: questionIds(10),
  daily_target: 10,
  completed_count: 6,
  correct_count: 5,
  source_distribution: { mistake_count: 4, new_count: 3, review_count: 3 },
  is_completed: false,
};

const checkIn = (i: number, question_count: number, correct_count: number, study_duration_seconds: number) => ({
  date: daysAgo(i),
  exam_id: EXAM,
  question_count,
  correct_count,
  study_duration_seconds,
  target_achieved: question_count >= 10,
});

/** 打卡日历（10 月，今天是 3 号）：连续打卡从 9 月延续过来。 */
export const checkInCalendar: CheckInCalendar = {
  exam_id: EXAM,
  year: 2026,
  month: 10,
  days: [checkIn(2, 12, 10, 1500), checkIn(1, 10, 8, 1320), checkIn(0, 6, 5, 540)],
  streak_days: 12,
  month_check_in_days: 3,
  month_total_questions: 28,
  month_focus_seconds: 3360,
};

/** 插件管理：工坊做出来的「公式速查表」在运行；另一个离线安装的社区插件还在等权限确认。 */
export const plugins: ManagedPlugin[] = [
  {
    id: 'dstu.community.formula-sheet',
    displayName: '公式速查表',
    description: '从当前学习空间的笔记里汇总公式，按章节排成一页速查表，可固定在学习桌面。',
    icon: 'BookOpen',
    trust: 'full',
    source: 'workshop',
    permissions: ['service:notes', 'service:workbench'],
    version: '0.1.0',
    origin: 'community',
    platforms: ['desktop'],
    enabled: true,
    runtime: 'running',
    consent: 'granted',
    configurable: true,
  },
  {
    id: 'community.word-of-day',
    displayName: '每日一词',
    description: '每天在学习桌面上推一个考纲词汇，附例句。',
    icon: 'ChatCircle',
    trust: 'restricted',
    source: 'package',
    permissions: ['service:workbench'],
    version: '1.2.0',
    origin: 'community',
    platforms: ['desktop', 'mobile'],
    enabled: false,
    runtime: 'stopped',
    consent: 'required',
    configurable: false,
  },
];

const question7: Question = {
  id: 'q-7',
  questionLabel: '第 7 题',
  content: Q7.content,
  questionType: 'single_choice',
  options: Q7.options,
  answer: Q7.answer,
  explanation: '',
  difficulty: 'medium',
  tags: [],
};
const question18: Question = {
  id: 'q-18',
  questionLabel: '第 18 题',
  content: '设 f(x) 在 [0, 1] 上连续，在 (0, 1) 内可导，f(0) = f(1) = 0，f(1/2) = 1。证明：存在 ξ ∈ (0, 1)，使 f′(ξ) = 1。',
  questionType: 'short_answer',
  answer: '构造 F(x) = f(x) − x，先用零点定理再用罗尔定理。',
  difficulty: 'very_hard',
  tags: [],
};
const diffEntry = (before: Question, after: Question): QuestionDiffEntry => ({
  examId: EXAM,
  questionId: before.id,
  before,
  after,
  changes: computeQuestionFieldChanges(before, after),
  createdAt: 0,
});

/** 题目集改动条：Agent 给第 7 题补了解析和知识点标签，给第 18 题补了标签，等用户逐处核对。 */
export const qbankDiffs: QuestionDiffEntry[] = [
  diffEntry(question7, { ...question7, explanation: Q7.explanation, tags: ['罗尔定理', 'ξ 的取值范围'] }),
  diffEntry(question18, { ...question18, tags: ['零点定理', '罗尔定理'] }),
];

/** 图片遮挡卡：遮挡框按教材第 132 页上半页（688×520）归一化——定理名已揭开，(1-1) 式还遮着。 */
export const occlusion: OcclusionSpec = {
  imageRef: 'tb-calculus-7#p132',
  boxes: [
    { x: 0.09, y: 0.436, w: 0.23, h: 0.06, label: '拉格朗日中值定理', clozeIndex: 1 },
    { x: 0.205, y: 0.755, w: 0.45, h: 0.08, label: 'f(b) − f(a) = f′(ξ)(b − a)', clozeIndex: 2 },
  ],
};

/** 片中不从回链跳转，引用方的锚点 URI 留空。 */
const edge = (i: number, sourceKind: AnchorEdgeSourceKind, sourceResourceId: string, sourceLabel: string): AnchorEdgeRecord => ({
  edgeId: `edge-${i}`,
  sourceKind,
  sourceResourceId,
  sourceSubId: '',
  sourceAnchorUri: '',
  sourceLabel,
  targetKind: 'pdf',
  targetResourceId: 'tb-calculus-7',
  targetLocatorKey: 'p132',
  targetPage: 132,
  targetStartMs: null,
  targetEndMs: null,
  targetRect: null,
  targetAnchorUri: '',
  studySpaceId: SPACE,
  createdAt: 0,
  updatedAt: 0,
});

/** PDF 页边回链：教材第 132 页被导图节点、ξ 卡和一篇笔记引用。 */
export const backlinks: AnchorBacklinkSummary = {
  total: 3,
  mindmapCount: 1,
  flashcardCount: 1,
  noteCount: 1,
  edges: [
    edge(1, 'mindmap', MINDMAP, `${MINDMAP_TITLE} · 拉格朗日中值定理`),
    edge(2, 'flashcard', 'card-xi', 'ξ 取在闭区间还是开区间？'),
    edge(3, 'note', 'note-proof', '中值定理证明套路'),
  ],
};

const retention = (period: string, youngReviews: number, youngPassed: number, matureReviews: number, maturePassed: number) => ({
  period,
  youngReviews,
  youngPassed,
  matureReviews,
  maturePassed,
});

/** 复习统计（fsrs_get_review_statistics 的原始响应）：389 张已学卡，近 30 天真实保留率 1066 / 1162，同 SceneReview 的记忆面板。 */
export const reviewStatistics = {
  dayStartMs: new Date(2026, 9, 3).getTime(),
  trueRetention: [
    retention('today', 4, 3, 8, 8),
    retention('yesterday', 14, 12, 24, 23),
    retention('week', 96, 84, 172, 161),
    retention('month', 412, 368, 750, 698),
    retention('year', 1380, 1215, 2460, 2302),
  ],
  memoryDistributions: {
    cards: 389,
    retrievability: [0, 0, 0, 0, 1, 2, 5, 14, 52, 315],
    stability: [12, 31, 58, 74, 96, 81, 29, 8, 0],
    difficulty: [6, 21, 48, 79, 92, 68, 41, 22, 9, 3],
  },
  dailyReviews: [9, 22, 18, 25, 14, 20, 17].map((minutes, i) => ({ date: daysAgo(i), studyMs: minutes * 60_000 })),
};

/** 把 total 按权重拆成整数，最后一份取余数，各份相加恒等于 total。 */
const split = (total: number, weights: number[]) => {
  const head = weights.slice(0, -1).map((w) => Math.round(total * w));
  return [...head, total - head.reduce((a, b) => a + b, 0)];
};

const usageTrends: UsageTrendPoint[] = Array.from({ length: 30 }, (_, k) => {
  const i = 29 - k;
  const requestCount = 6 + Math.round(rand(i + 2100) * 30);
  const promptTokens = requestCount * (2600 + Math.round(rand(i + 2200) * 1800));
  const completionTokens = requestCount * (700 + Math.round(rand(i + 2300) * 500));
  return { timeLabel: daysAgo(i), timestamp: new Date(2026, 9, 3 - i).getTime(), totalTokens: promptTokens + completionTokens, promptTokens, completionTokens, requestCount };
});
const usageTotal = (pick: (point: UsageTrendPoint) => number) => usageTrends.reduce((sum, point) => sum + pick(point), 0);
const USAGE = {
  requests: usageTotal((point) => point.requestCount),
  prompt: usageTotal((point) => point.promptTokens),
  completion: usageTotal((point) => point.completionTokens),
};
const USAGE_ERRORS = 4;
/** 模型同第三幕「多个模型，同时作答」的三个。 */
const MODELS: Array<[string, number]> = [
  ['deepseek-v4', 0.64],
  ['glm-5', 0.22],
  ['kimi-k3', 0.14],
];
const CALLERS: Array<[string, number]> = [
  ['chat_v2', 0.46],
  ['embedding', 0.17],
  ['anki', 0.14],
  ['exam_sheet', 0.09],
  ['translation', 0.08],
  ['media_transcription', 0.06],
];
const shares = (weights: number[]) => {
  const requests = split(USAGE.requests, weights);
  const prompt = split(USAGE.prompt, weights);
  const completion = split(USAGE.completion, weights);
  return weights.map((_, i) => ({ requestCount: requests[i], promptTokens: prompt[i], completionTokens: completion[i], totalTokens: prompt[i] + completion[i] }));
};
const modelShares = shares(MODELS.map(([, weight]) => weight));
const callerShares = shares(CALLERS.map(([, weight]) => weight));

/** 模型用量（近 30 天）：总览、按模型、按调用方的数字都由同一组每日数据加出来。 */
export const llmUsage = {
  summary: {
    startDate: daysAgo(30),
    endDate: daysAgo(0),
    totalRequests: USAGE.requests,
    successRequests: USAGE.requests - USAGE_ERRORS,
    errorRequests: USAGE_ERRORS,
    totalPromptTokens: USAGE.prompt,
    totalCompletionTokens: USAGE.completion,
    totalTokens: USAGE.prompt + USAGE.completion,
    avgDurationMs: 4200,
  } satisfies UsageSummary,
  trends: usageTrends,
  byModel: MODELS.map(([modelId], i): ModelSummary => ({ modelId, ...modelShares[i] })),
  // displayName 留空：名称走主应用 llm_usage 文案里的 callerTypes
  byCaller: CALLERS.map(([callerType], i): CallerTypeSummary => ({ callerType, displayName: '', requestCount: callerShares[i].requestCount, totalTokens: callerShares[i].totalTokens })),
  sessions: usageTrends.map((point) => ({ date: point.timeLabel, displayDate: point.timeLabel.slice(5), sessions: Math.max(1, Math.round(point.requestCount / 7)) })),
};

/** 任务面板的本地环境区：在学习空间目录的沙盒里读成绩表、跑脚本、写产物；要联网的命令被拦下。 */
export const runtimeEnvironment: RuntimeEnvironment = {
  rootId: 'workspace',
  rootLabel: '高等数学 · 期中',
  cwd: '.',
  sandboxBackend: 'macos_seatbelt',
  platform: 'macOS',
  networkAllowed: false,
};
const runtime = (id: number, action: RuntimeItem['action'], label: string, toolName: string, more: Partial<RuntimeItem> = {}): RuntimeItem => ({
  id: `rt-${id}`,
  action,
  rootId: 'workspace',
  label,
  toolName,
  ...more,
});
export const runtimeItems: RuntimeItem[] = [
  runtime(1, 'list', '资料/', 'builtin-workspace_file_list', { detail: '12 项' }),
  runtime(2, 'read', '资料/期中模拟卷-成绩.csv', 'builtin-workspace_file_read', { detail: '18 行' }),
  runtime(3, 'check', 'python3 score_summary.py', 'builtin-local_shell_execute', { command: 'python3 scripts/score_summary.py 资料/期中模拟卷-成绩.csv', detail: '退出码 0' }),
  runtime(4, 'write', '产物/错题分布.md', 'builtin-workspace_file_write', { detail: '新建' }),
  runtime(5, 'blocked', 'pip install pandas', 'builtin-local_shell_execute', { command: 'pip install pandas', dangerFlags: ['net'], error: '沙盒内网络已关闭，命令未执行' }),
];

/** 薄弱知识点条：冲刺之前的掌握度。 */
export const weakestConcepts: MasteryState[] = [
  { conceptKey: 'ξ 的取值范围', score: 0.38, total: 6, wrongCount: 3 },
  { conceptKey: '辅助函数', score: 0.52, total: 5, wrongCount: 2 },
  { conceptKey: '泰勒余项', score: 0.58, total: 4, wrongCount: 2 },
  { conceptKey: '反常积分', score: 0.64, total: 3, wrongCount: 1 },
];

const noopAsync = async () => {};

/** 渠道插件：微信 iLink Bot 运行中（供 ChannelPluginSection 直接挂载）。 */
export const weChatChannel: ChannelPlugins = {
  plugins: [
    {
      id: 'ilinkbot',
      label: '微信 iLink Bot',
      blurb: '微信扫码绑定主人身份，发送文字或图片聚合批处理，直接调用本机学习桌面工作流。',
      kind: 'channel',
      state: 'running',
      enabled: true,
      configured: true,
      bound: true,
    },
  ],
  loading: false,
  refresh: noopAsync,
  setEnabled: noopAsync,
  beginLogin: noopAsync,
};

/** DeepSeek 官方应用能力设置页夹具（DeepSeekCapabilities）。 */
export const deepseekVendor: VendorConfig = {
  id: 'builtin-deepseek-app',
  name: 'DeepSeek Official App',
  providerType: 'deepseek_app',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '***',
  isBuiltin: true,
};

export const deepseekCapabilityModels: { profile: ModelProfile; api: ApiConfig }[] = [
  {
    profile: {
      id: 'ds-ocr-prof',
      vendorId: deepseekVendor.id,
      label: 'DeepSeek OCR',
      model: 'deepseek-ocr',
      modelAdapter: 'deepseek',
      enabled: true,
      isMultimodal: true,
      isReasoning: false,
      isEmbedding: false,
      isReranker: false,
    },
    api: {
      id: 'ds-ocr-api',
      name: 'DeepSeek OCR',
      vendorId: deepseekVendor.id,
      apiKey: '***',
      baseUrl: deepseekVendor.baseUrl,
      model: 'deepseek-ocr',
      modelAdapter: 'deepseek',
      enabled: true,
      isMultimodal: true,
      isReasoning: false,
      isEmbedding: false,
      isReranker: false,
    },
  },
  {
    profile: {
      id: 'ds-asr-prof',
      vendorId: deepseekVendor.id,
      label: 'DeepSeek ASR',
      model: 'deepseek-asr',
      modelAdapter: 'deepseek',
      enabled: true,
      isMultimodal: false,
      isReasoning: false,
      isEmbedding: false,
      isReranker: false,
    },
    api: {
      id: 'ds-asr-api',
      name: 'DeepSeek ASR',
      vendorId: deepseekVendor.id,
      apiKey: '***',
      baseUrl: deepseekVendor.baseUrl,
      model: 'deepseek-asr',
      modelAdapter: 'deepseek',
      enabled: true,
      isMultimodal: false,
      isReasoning: false,
      isEmbedding: false,
      isReranker: false,
    },
  },
];

export const deepseekCapabilitySettings: DeepSeekCapabilitySettings = {
  config: {
    deepseekChatWebSearch: true,
    deepseekChatReadUrl: true,
    deepseekChatFiles: true,
    deepseekChatSafetyCheck: true,
    deepseekTtsVoice: 'stella',
    webSearchDeepseekKey: '***',
    webSearchDeepseekFetchEnabled: true,
    voice_input_asr_model_config_id: 'ds-asr-api',
  },
  changeConfig: () => {},
  assignAsr: noopAsync,
  enableModel: noopAsync,
};

export const pairingSettingValues: Record<string, string | null> = {
  'sync.include_skills': 'true',
  'sync.include_plugins': 'true',
  'cloud_storage.config.safe_v1': JSON.stringify({ provider: 'webdav' }),
  cloud_storage_credentials: JSON.stringify({ endpoint: 'https://dav.deepstudent.local' }),
  vendor_configs: JSON.stringify([{ id: 'builtin-deepseek-app', name: 'DeepSeek' }]),
  'session.selected_search_engines': 'bing_rss,deepseek',
};
