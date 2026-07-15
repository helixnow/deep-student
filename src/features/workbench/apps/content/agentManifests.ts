import { useQuestionBankStore } from '@/stores/questionBankStore';
import type {
  ActivationContext,
  ActivationHandlerResult,
  AgentActionResult,
  AppAgentManifest,
} from '../../core/types';
import {
  NO_ARGS_SCHEMA,
  actionArgs,
  executeActivation,
  objectSchema,
  rejectMismatchedTarget,
  shortLabel,
  stableAgentRef,
  stableRevision,
} from '../agentManifestUtils';
import { getResourceWorkspaceActive } from './resourceWorkspaceRegistry';

const PRACTICE_MODES = [
  'sequential', 'random', 'review_first', 'review_only', 'by_tag',
  'timed', 'mock_exam', 'daily', 'paper',
];

function questionRef(id: string): string {
  return stableAgentRef('exam', 'question', id);
}

function practiceSessionSummaries(
  state: ReturnType<typeof useQuestionBankStore.getState>,
  examId: string | null,
) {
  const timed = state.timedSession?.exam_id === examId
    ? {
        sessionId: state.timedSession.id,
        questionIds: state.timedSession.question_ids.slice(0, 100),
        questionCount: state.timedSession.question_ids.length,
        answeredCount: state.timedSession.answered_count,
        correctCount: state.timedSession.correct_count,
        startedAt: state.timedSession.started_at,
        isTimeout: state.timedSession.is_timeout,
        isSubmitted: state.timedSession.is_submitted,
      }
    : null;
  const mockExam = state.mockExamSession?.exam_id === examId
    ? {
        sessionId: state.mockExamSession.id,
        questionIds: state.mockExamSession.question_ids.slice(0, 100),
        questionCount: state.mockExamSession.question_ids.length,
        answeredCount: Object.keys(state.mockExamSession.answers).length,
        gradedCount: Object.keys(state.mockExamSession.results).length,
        startedAt: state.mockExamSession.started_at,
        isSubmitted: state.mockExamSession.is_submitted,
        // Deliberately expose the UI-authoritative score summary only after submission.
        // Answers, per-question verdicts, and wrong-question IDs remain private to the UI.
        scoreSummary: state.mockExamSession.is_submitted
          && state.mockExamScoreCard?.exam_id === examId
          ? {
              totalCount: state.mockExamScoreCard.total_count,
              answeredCount: state.mockExamScoreCard.answered_count,
              correctCount: state.mockExamScoreCard.correct_count,
              wrongCount: state.mockExamScoreCard.wrong_count,
              unansweredCount: state.mockExamScoreCard.unanswered_count,
              correctRate: state.mockExamScoreCard.correct_rate,
              timeSpentSeconds: state.mockExamScoreCard.time_spent_seconds,
              completedAt: state.mockExamScoreCard.completed_at,
            }
          : null,
      }
    : null;
  const daily = state.dailyPractice?.exam_id === examId
    ? {
        sessionId: state.dailyPractice.date,
        date: state.dailyPractice.date,
        questionIds: state.dailyPractice.question_ids.slice(0, 100),
        questionCount: state.dailyPractice.question_ids.length,
        completedCount: state.dailyPractice.completed_count,
        correctCount: state.dailyPractice.correct_count,
        isCompleted: state.dailyPractice.is_completed,
      }
    : null;
  const activePracticeSession = state.practiceMode === 'timed'
    ? timed && { mode: 'timed', ...timed }
    : state.practiceMode === 'mock_exam'
      ? mockExam && { mode: 'mock_exam', ...mockExam }
      : state.practiceMode === 'daily'
        ? daily && { mode: 'daily', ...daily }
        : null;
  return { timed, mockExam, daily, activePracticeSession };
}

export function createExamAgentManifest(
  activation: (ctx: ActivationContext) => ActivationHandlerResult | Promise<ActivationHandlerResult>,
): AppAgentManifest {
  return {
    version: 2,
    description: '观察并导航题目、筛选和练习视图。不会代替用户答题、评分或提交考试。',
    capabilities: [
      {
        name: 'focusQuestion', description: '聚焦指定题目。',
        inputSchema: objectSchema({ questionId: { type: 'string', minLength: 1 } }, ['questionId']),
        risk: 'read', mutates: true, reversible: true, idempotent: true,
        targetKinds: ['exam-question'],
      },
      { name: 'nextQuestion', description: '前往下一题。', inputSchema: NO_ARGS_SCHEMA, risk: 'read', mutates: true, reversible: true, idempotent: false },
      { name: 'previousQuestion', description: '返回上一题。', inputSchema: NO_ARGS_SCHEMA, risk: 'read', mutates: true, reversible: true, idempotent: false },
      {
        name: 'setFilters', description: '设置题目状态、难度、题型、标签、搜索或收藏筛选。',
        inputSchema: objectSchema({
          filters: objectSchema({
            status: { type: 'array', items: { type: 'string' }, maxItems: 10 },
            difficulty: { type: 'array', items: { type: 'string' }, maxItems: 10 },
            question_type: { type: 'array', items: { type: 'string' }, maxItems: 20 },
            tags: { type: 'array', items: { type: 'string' }, maxItems: 100 },
            search: { type: 'string', maxLength: 500 },
            is_favorite: { type: 'boolean' },
          }),
        }, ['filters']),
        risk: 'read', mutates: true, reversible: true, idempotent: true,
      },
      { name: 'resetFilters', description: '清除题目筛选。', inputSchema: NO_ARGS_SCHEMA, risk: 'read', mutates: true, reversible: true, idempotent: true },
      {
        name: 'setPracticeMode', description: '切换练习编排模式；不作答也不提交。',
        inputSchema: objectSchema({
          mode: { type: 'string', enum: PRACTICE_MODES },
          tag: { type: 'string', maxLength: 200 },
        }, ['mode']),
        risk: 'low', mutates: true, reversible: true, idempotent: true,
      },
      {
        name: 'hydratePracticeSession',
        description: '载入题库工具生成的 timed/mock/daily 会话交接；只建立用户答题会话，不作答或交卷。',
        inputSchema: objectSchema({
          handoff: {
            type: 'object',
            properties: {
              version: { type: 'integer', const: 1 },
              kind: { type: 'string', const: 'qbank_practice_session' },
              handoff_id: { type: 'string', minLength: 1 },
              exam_id: { type: 'string', minLength: 1 },
              mode: { type: 'string', enum: ['timed', 'mock_exam', 'daily'] },
              session: { type: 'object', additionalProperties: true },
              agentCanAnswer: { type: 'boolean', const: false },
            },
            required: ['version', 'kind', 'handoff_id', 'exam_id', 'mode', 'session', 'agentCanAnswer'],
            additionalProperties: false,
          },
        }, ['handoff']),
        risk: 'low', mutates: true, reversible: false, idempotent: true,
      },
      {
        name: 'setFocusMode', description: '开启或关闭专注答题视图。',
        inputSchema: objectSchema({ enabled: { type: 'boolean' } }, ['enabled']),
        risk: 'low', mutates: true, reversible: true, idempotent: true,
      },
      {
        name: 'showSettings', description: '打开或关闭题库设置面板。',
        inputSchema: objectSchema({ open: { type: 'boolean' } }, ['open']),
        risk: 'low', mutates: true, reversible: true, idempotent: true,
      },
    ],
    observe(ctx) {
      const state = useQuestionBankStore.getState();
      const examId = ctx.instanceKey ?? getResourceWorkspaceActive('exam') ?? state.currentExamId;
      const practiceSessions = practiceSessionSummaries(state, examId);
      const ids = state.questionOrder.slice(0, 80);
      const entities = ids.flatMap((id) => {
        const question = state.questions.get(id);
        if (!question) return [];
        return [{
          ref: questionRef(id),
          kind: 'exam-question',
          label: shortLabel(question.question_label || question.content) ?? id,
          description: `${question.question_type} · ${question.status}`,
          actions: ['focusQuestion'],
          state: {
            status: question.status,
            questionType: question.question_type,
            difficulty: question.difficulty ?? null,
            favorite: question.is_favorite,
            attempted: question.attempt_count > 0,
            answeredByUser: Boolean(question.user_answer),
            updatedAt: question.updated_at,
          },
        }];
      });
      return {
        revision: stableRevision(
          ctx.instanceKey,
          state.currentExamId,
          state.currentQuestionId,
          state.questionOrder,
          state.filters,
          state.practiceMode,
          state.focusMode,
          state.isLoading,
          state.isSubmitting,
          practiceSessions,
        ),
        route: `exam/${examId ?? 'home'}/${state.currentQuestionId ?? 'none'}`,
        mode: state.practiceMode,
        busy: state.isLoading || state.isSubmitting || state.isLoadingPractice,
        selection: state.currentQuestionId ? [questionRef(state.currentQuestionId)] : [],
        availableActions: ['focusQuestion', 'nextQuestion', 'previousQuestion', 'setFilters', 'resetFilters', 'setPracticeMode', 'hydratePracticeSession'],
        entities,
        affordances: entities.map((entity) => ({
          ref: entity.ref,
          kind: entity.kind,
          label: entity.label,
          description: entity.description,
          actions: entity.actions,
          selected: entity.ref === (state.currentQuestionId ? questionRef(state.currentQuestionId) : ''),
          value: { questionId: decodeURIComponent(entity.ref.split(':').at(-1) ?? '') },
        })),
        state: {
          examId,
          currentQuestionId: state.currentQuestionId,
          questionCount: state.questionOrder.length,
          questionsTruncated: state.questionOrder.length > ids.length,
          practiceMode: state.practiceMode,
          focusMode: state.focusMode,
          filters: {
            status: state.filters.status ?? [],
            difficulty: state.filters.difficulty ?? [],
            questionType: state.filters.question_type ?? [],
            tags: state.filters.tags ?? [],
            search: state.filters.search ?? null,
            favorite: state.filters.is_favorite ?? null,
          },
          submitting: state.isSubmitting,
          error: state.error,
          agentCanAnswer: false,
          agentCanSubmit: false,
          practiceSessions: {
            timed: practiceSessions.timed,
            mockExam: practiceSessions.mockExam,
            daily: practiceSessions.daily,
          },
          activePracticeSession: practiceSessions.activePracticeSession,
          filtersRevision: stableRevision(state.filters),
        },
      };
    },
    async execute(ctx, action) {
      const before = useQuestionBankStore.getState();
      const snapshot = {
        currentQuestionId: before.currentQuestionId,
        filters: { ...before.filters },
        practiceMode: before.practiceMode,
        focusMode: before.focusMode,
        practiceSessions: practiceSessionSummaries(
          before,
          ctx.instanceKey ?? getResourceWorkspaceActive('exam') ?? before.currentExamId,
        ),
      };
      const requestedArgs = actionArgs(action);
      if (action.name === 'setFocusMode' || action.name === 'showSettings') {
        return {
          handled: false,
          changed: false,
          code: 'ACTION_UNAVAILABLE',
          hint: `${action.name} 尚未提供题库表面 ACK`,
        };
      }
      let expectedQuestionId: string | null = null;
      if (action.name === 'focusQuestion' && typeof requestedArgs.questionId === 'string') {
        const mismatch = rejectMismatchedTarget(action, questionRef(requestedArgs.questionId));
        if (mismatch) return mismatch;
        expectedQuestionId = requestedArgs.questionId;
      } else if (action.name === 'nextQuestion' || action.name === 'previousQuestion') {
        const currentIndex = before.questionOrder.indexOf(before.currentQuestionId ?? '');
        const delta = action.name === 'nextQuestion' ? 1 : -1;
        const baseIndex = currentIndex >= 0 ? currentIndex : delta > 0 ? -1 : 0;
        const targetIndex = Math.min(
          Math.max(baseIndex + delta, 0),
          Math.max(0, before.questionOrder.length - 1),
        );
        expectedQuestionId = before.questionOrder[targetIndex] ?? null;
        if (!expectedQuestionId || expectedQuestionId === before.currentQuestionId) {
          return {
            handled: false,
            changed: false,
            code: 'ACTION_UNAVAILABLE',
            hint: action.name === 'nextQuestion' ? '当前已是最后一题' : '当前已是第一题',
          };
        }
      }
      const result = await executeActivation(activation, ctx, action);
      if (!result.handled) return result;
      // Settings are per-resource visual state. The activation event is the
      // authoritative delivery mechanism, so do not invent a global state
      // postcondition or undo record for it.
      const after = useQuestionBankStore.getState();
      result.changed = stableRevision(snapshot) !== stableRevision({
        currentQuestionId: after.currentQuestionId,
        filters: after.filters,
        practiceMode: after.practiceMode,
        focusMode: after.focusMode,
        practiceSessions: practiceSessionSummaries(
          after,
          ctx.instanceKey ?? getResourceWorkspaceActive('exam') ?? after.currentExamId,
        ),
      });
      if (!result.changed && action.name !== 'hydratePracticeSession') {
        return {
          handled: false,
          changed: false,
          code: 'ACTION_UNAVAILABLE',
          hint: `${action.name} 未改变题库状态`,
        };
      }
      result.acknowledged = true;
      const args = requestedArgs;
      const targetId = expectedQuestionId;
      if (targetId && ['focusQuestion', 'nextQuestion', 'previousQuestion'].includes(action.name)) {
        result.entityRefs = [questionRef(targetId)];
        result.postconditions = [{ kind: 'selection_includes', ref: questionRef(targetId) }];
        if (result.changed && snapshot.currentQuestionId) {
          result.undo = {
            inverse: {
              name: 'focusQuestion',
              args: { questionId: snapshot.currentQuestionId },
              targetRef: questionRef(snapshot.currentQuestionId),
              expect: [{ kind: 'selection_includes', ref: questionRef(snapshot.currentQuestionId) }],
            },
            label: '恢复当前题目',
          };
        }
      } else if (action.name === 'setPracticeMode' && typeof args.mode === 'string') {
        result.postconditions = [{ kind: 'state_equals', path: 'practiceMode', value: args.mode }];
        if (result.changed) result.undo = { inverse: { name: 'setPracticeMode', args: { mode: snapshot.practiceMode }, expect: [{ kind: 'state_equals', path: 'practiceMode', value: snapshot.practiceMode }] }, label: '恢复练习模式' };
      } else if (action.name === 'hydratePracticeSession') {
        const handoff = args.handoff && typeof args.handoff === 'object'
          ? args.handoff as Record<string, unknown>
          : {};
        if (typeof handoff.mode === 'string' && typeof handoff.handoff_id === 'string') {
          const key = handoff.mode === 'mock_exam' ? 'mockExam' : handoff.mode;
          result.postconditions = [{
            kind: 'state_equals',
            path: `practiceSessions.${key}.sessionId`,
            value: handoff.handoff_id,
          }];
        }
      } else if (action.name === 'setFocusMode' && typeof args.enabled === 'boolean') {
        result.postconditions = [{ kind: 'state_equals', path: 'focusMode', value: args.enabled }];
        if (result.changed) result.undo = { inverse: { name: 'setFocusMode', args: { enabled: snapshot.focusMode }, expect: [{ kind: 'state_equals', path: 'focusMode', value: snapshot.focusMode }] }, label: '恢复专注视图' };
      } else if (action.name === 'setFilters' || action.name === 'resetFilters') {
        result.undo = {
          inverse: {
            name: 'setFilters',
            args: { filters: snapshot.filters },
            expect: [{ kind: 'state_equals', path: 'filtersRevision', value: stableRevision(snapshot.filters) }],
          },
          label: '恢复题目筛选',
        };
      }
      return result;
    },
  };
}

export function createResourceContentManifest(
  typeId: string,
  activation: (ctx: ActivationContext) => ActivationHandlerResult | Promise<ActivationHandlerResult>,
): AppAgentManifest {
  const canGotoPage = typeId === 'textbook' || typeId === 'file' || typeId === 'file-preview';
  return {
    version: 2,
    description: canGotoPage
      ? '观察资源预览并按页导航；内容本身通过领域工具读取或修改。'
      : '暴露当前资源身份和就绪状态；该应用尚无安全的 ACR 语义操作。',
    capabilities: canGotoPage
      ? [{
          name: 'gotoPage', description: '跳转到指定页码。',
          inputSchema: objectSchema({ page: { type: 'integer', minimum: 1 } }, ['page']),
          risk: 'read' as const, mutates: true, reversible: false, idempotent: true,
        }]
      : [],
    observe(ctx) {
      const ref = stableAgentRef(typeId, 'resource', ctx.instanceKey ?? 'home');
      return {
        revision: stableRevision(typeId, ctx.instanceKey),
        route: `${typeId}/${ctx.instanceKey ?? 'home'}`,
        mode: canGotoPage ? 'preview' : 'resource',
        selection: ctx.instanceKey ? [ref] : [],
        availableActions: canGotoPage ? ['gotoPage'] : [],
        entities: ctx.instanceKey ? [{ ref, kind: `${typeId}-resource`, label: ctx.instanceKey, actions: canGotoPage ? ['gotoPage'] : [] }] : [],
        affordances: ctx.instanceKey ? [{ ref, kind: `${typeId}-resource`, label: ctx.instanceKey, actions: canGotoPage ? ['gotoPage'] : [], selected: true }] : [],
        state: { resourceId: ctx.instanceKey, ready: Boolean(ctx.instanceKey) },
      };
    },
    async execute(ctx, action): Promise<AgentActionResult> {
      const result = await executeActivation(activation, ctx, action);
      if (!result.handled) return result;
      const args = actionArgs(action);
      const page = typeof args.page === 'number' ? Math.floor(args.page) : null;
      if (page == null || result.acknowledged !== true) {
        return {
          handled: false,
          changed: false,
          code: 'ACTION_UNAVAILABLE',
          hint: '资源预览表面没有确认页码跳转',
        };
      }
      result.changed = true;
      result.entityRefs = [stableAgentRef(typeId, 'page', ctx.instanceKey ?? 'unknown', page)];
      return result;
    },
  };
}
