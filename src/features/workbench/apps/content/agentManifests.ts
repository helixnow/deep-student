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

const PRACTICE_MODES = [
  'sequential', 'random', 'review_first', 'review_only', 'by_tag',
  'timed', 'mock_exam', 'daily', 'paper',
];

function questionRef(id: string): string {
  return stableAgentRef('exam', 'question', id);
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
        inputSchema: objectSchema({ mode: { type: 'string', enum: PRACTICE_MODES } }, ['mode']),
        risk: 'low', mutates: true, reversible: true, idempotent: true,
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
          state.showSettingsPanel,
          state.isLoading,
          state.isSubmitting,
        ),
        route: `exam/${state.currentExamId ?? ctx.instanceKey ?? 'home'}/${state.currentQuestionId ?? 'none'}`,
        mode: state.practiceMode,
        busy: state.isLoading || state.isSubmitting || state.isLoadingPractice,
        selection: state.currentQuestionId ? [questionRef(state.currentQuestionId)] : [],
        availableActions: ['focusQuestion', 'nextQuestion', 'previousQuestion', 'setFilters', 'resetFilters', 'setPracticeMode', 'setFocusMode', 'showSettings'],
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
          examId: state.currentExamId ?? ctx.instanceKey,
          currentQuestionId: state.currentQuestionId,
          questionCount: state.questionOrder.length,
          questionsTruncated: state.questionOrder.length > ids.length,
          practiceMode: state.practiceMode,
          focusMode: state.focusMode,
          settingsOpen: state.showSettingsPanel,
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
        settingsOpen: before.showSettingsPanel,
      };
      const requestedArgs = actionArgs(action);
      if (action.name === 'focusQuestion' && typeof requestedArgs.questionId === 'string') {
        const mismatch = rejectMismatchedTarget(action, questionRef(requestedArgs.questionId));
        if (mismatch) return mismatch;
      }
      const result = await executeActivation(activation, ctx, action);
      if (!result.handled) return result;
      const after = useQuestionBankStore.getState();
      result.changed = stableRevision(snapshot) !== stableRevision({
        currentQuestionId: after.currentQuestionId,
        filters: after.filters,
        practiceMode: after.practiceMode,
        focusMode: after.focusMode,
        settingsOpen: after.showSettingsPanel,
      });
      const args = requestedArgs;
      const targetId = typeof args.questionId === 'string'
        ? args.questionId
        : after.currentQuestionId;
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
      } else if (action.name === 'setFocusMode' && typeof args.enabled === 'boolean') {
        result.postconditions = [{ kind: 'state_equals', path: 'focusMode', value: args.enabled }];
        if (result.changed) result.undo = { inverse: { name: 'setFocusMode', args: { enabled: snapshot.focusMode }, expect: [{ kind: 'state_equals', path: 'focusMode', value: snapshot.focusMode }] }, label: '恢复专注视图' };
      } else if (action.name === 'showSettings' && typeof args.open === 'boolean') {
        result.postconditions = [{ kind: 'state_equals', path: 'settingsOpen', value: args.open }];
        if (result.changed) result.undo = { inverse: { name: 'showSettings', args: { open: snapshot.settingsOpen }, expect: [{ kind: 'state_equals', path: 'settingsOpen', value: snapshot.settingsOpen }] }, label: '恢复题库设置面板' };
      } else if ((action.name === 'setFilters' || action.name === 'resetFilters') && result.changed) {
        result.undo = {
          inverse: {
            name: 'setFilters',
            args: { filters: snapshot.filters },
            expect: [{ kind: 'state_equals', path: 'filtersRevision', value: stableRevision(snapshot.filters) }],
          },
          label: '恢复题目筛选',
        };
      } else if (action.name === 'setFilters' || action.name === 'resetFilters') {
        result.postconditions = [{ kind: 'state_equals', path: 'filtersRevision', value: stableRevision(after.filters) }];
      }
      return result;
    },
  };
}

const lastRequestedPage = new Map<string, number>();

function previewKey(typeId: string, instanceKey: string | null): string {
  return `${typeId}:${instanceKey ?? ''}`;
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
      const page = lastRequestedPage.get(previewKey(typeId, ctx.instanceKey)) ?? null;
      const ref = stableAgentRef(typeId, 'resource', ctx.instanceKey ?? 'home');
      return {
        revision: stableRevision(typeId, ctx.instanceKey, page),
        route: `${typeId}/${ctx.instanceKey ?? 'home'}`,
        mode: canGotoPage ? 'preview' : 'resource',
        selection: ctx.instanceKey ? [ref] : [],
        availableActions: canGotoPage ? ['gotoPage'] : [],
        entities: ctx.instanceKey ? [{ ref, kind: `${typeId}-resource`, label: ctx.instanceKey, actions: canGotoPage ? ['gotoPage'] : [] }] : [],
        affordances: ctx.instanceKey ? [{ ref, kind: `${typeId}-resource`, label: ctx.instanceKey, actions: canGotoPage ? ['gotoPage'] : [], selected: true }] : [],
        state: { resourceId: ctx.instanceKey, ready: Boolean(ctx.instanceKey), lastRequestedPage: page },
      };
    },
    async execute(ctx, action): Promise<AgentActionResult> {
      const result = await executeActivation(activation, ctx, action);
      if (!result.handled) return result;
      const args = actionArgs(action);
      const page = typeof args.page === 'number' ? Math.floor(args.page) : null;
      const key = previewKey(typeId, ctx.instanceKey);
      const before = lastRequestedPage.get(key) ?? null;
      if (page != null) lastRequestedPage.set(key, page);
      result.changed = page != null && page !== before;
      if (page != null) {
        result.postconditions = [{ kind: 'state_equals', path: 'lastRequestedPage', value: page }];
        result.entityRefs = [stableAgentRef(typeId, 'page', ctx.instanceKey ?? 'unknown', page)];
      }
      return result;
    },
  };
}
