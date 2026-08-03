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
import { getContentAgentSurface } from './contentAgentSurfaces';
import { normalizeResourceInstanceKey } from './resourceIdentity';
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
        availableActions: ['focusQuestion', 'nextQuestion', 'previousQuestion', 'setFilters', 'resetFilters', 'setPracticeMode', 'hydratePracticeSession', 'setFocusMode', 'showSettings'],
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
      // ACR 4.0（A7）：exam:setFocusMode / exam:openSettings 的表面 ACK 带回
      // changed 与 previous* 前值；这两个字段是内部交接，剥离后不进回执。
      const surfaceAck = result as AgentActionResult & {
        previousOpen?: boolean;
        previousEnabled?: boolean;
      };
      const previousSettingsOpen = surfaceAck.previousOpen;
      delete surfaceAck.previousOpen;
      delete surfaceAck.previousEnabled;
      if (action.name === 'showSettings') {
        // 设置面板是资源视图局部状态（不进全局 store）：以视图 ACK 为准，
        // no-op 诚实报告 changed:false 而非伪造成功。
        result.acknowledged = true;
        result.changed = result.changed !== false;
        if (result.changed && typeof previousSettingsOpen === 'boolean') {
          result.undo = {
            inverse: {
              name: 'showSettings',
              args: { open: previousSettingsOpen },
            },
            label: '恢复设置面板',
          };
        }
        return result;
      }
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
  // ACR 4.0（A7）：translation/essay/image 视图挂载期注册真实可得的
  // 观察投影（contentAgentSurfaces）；image 额外提供 setZoom 动作落点。
  const hasContentSurface = typeId === 'translation' || typeId === 'essay' || typeId === 'image';
  const canSetZoom = typeId === 'image';

  // essay / translation 为 single 资源工作区：instanceKey 缺省时回退到工作区当前资源
  const resolveResourceId = (instanceKey: string | null): string | null =>
    normalizeResourceInstanceKey(instanceKey)
      ?? (typeId === 'essay' || typeId === 'translation'
        ? getResourceWorkspaceActive(typeId)
        : null);

  // A45-5（docs/dev/acr/ACR-4.5.md）：image 视图态能力 = 缩放 + 旋转。
  // UI 还有拖拽平移（无程序化落点表面）与「保存到本地」（走 OS 保存对话框，
  // 需用户交互），均不作为 agent 能力暴露——只报真可用。
  const canRotate = typeId === 'image';

  const description = canGotoPage
    ? '观察资源预览并按页导航；内容本身通过领域工具读取或修改。'
    : hasContentSurface
      ? canSetZoom
        ? '观察图片尺寸/缩放/旋转态，可设置缩放与旋转（视图态，不修改图片文件）；内容本身通过领域工具读取或修改。'
        : '观察资源身份与内容摘要（字数/段落/状态）；该应用尚无安全的 ACR 写操作。'
      : '暴露当前资源身份和就绪状态；该应用尚无安全的 ACR 语义操作。';

  return {
    version: 2,
    description,
    capabilities: [
      ...(canGotoPage
        ? [{
            name: 'gotoPage', description: '跳转到指定页码。',
            inputSchema: objectSchema({ page: { type: 'integer', minimum: 1 } }, ['page']),
            risk: 'read' as const, mutates: true, reversible: false, idempotent: true,
          }]
        : []),
      ...(canSetZoom
        ? [{
            name: 'setZoom',
            description: "设置图片缩放：zoom 为 10–800 的百分比（100 = 原始像素），或 'fit' 适应窗口。",
            inputSchema: objectSchema({
              zoom: {
                anyOf: [
                  { type: 'number' as const, minimum: 10, maximum: 800 },
                  { type: 'string' as const, const: 'fit' },
                ],
              },
            }, ['zoom']),
            risk: 'read' as const, mutates: true, reversible: true, idempotent: true,
          }]
        : []),
      // A45-5：旋转为视图态操作（低风险），可用 undo 反向旋转恢复；
      // 连续执行会继续叠加旋转，非幂等。
      ...(canRotate
        ? [{
            name: 'rotate',
            description: '顺时针旋转图片视图 90/180/270 度；只改变查看朝向，不修改图片文件。',
            inputSchema: objectSchema({
              degrees: { type: 'integer' as const, enum: [90, 180, 270] },
            }, ['degrees']),
            risk: 'low' as const, mutates: true, reversible: true, idempotent: false,
          }]
        : []),
    ],
    observe(ctx) {
      const resourceId = resolveResourceId(ctx.instanceKey);
      const surface = hasContentSurface ? getContentAgentSurface(typeId, resourceId) : null;
      const summary = surface?.getSummary() ?? null;
      const ref = stableAgentRef(typeId, 'resource', ctx.instanceKey ?? 'home');
      const actions = [
        ...(canGotoPage ? ['gotoPage'] : []),
        // 能力表静态声明 setZoom/rotate，但可用动作只在视图表面真实挂载时上报
        ...(canSetZoom && surface?.setZoom ? ['setZoom'] : []),
        ...(canRotate && surface?.rotate ? ['rotate'] : []),
      ];
      return {
        revision: stableRevision(typeId, ctx.instanceKey, summary),
        route: `${typeId}/${ctx.instanceKey ?? 'home'}`,
        mode: canGotoPage ? 'preview' : 'resource',
        selection: ctx.instanceKey ? [ref] : [],
        availableActions: actions,
        entities: ctx.instanceKey ? [{ ref, kind: `${typeId}-resource`, label: ctx.instanceKey, actions }] : [],
        affordances: ctx.instanceKey ? [{ ref, kind: `${typeId}-resource`, label: ctx.instanceKey, actions, selected: true }] : [],
        state: {
          resourceId: ctx.instanceKey,
          ready: Boolean(ctx.instanceKey),
          ...(summary ? { content: summary } : {}),
        },
      };
    },
    async execute(ctx, action): Promise<AgentActionResult> {
      if (canSetZoom && action.name === 'setZoom') {
        const resourceId = resolveResourceId(ctx.instanceKey);
        const surface = getContentAgentSurface(typeId, resourceId);
        if (!surface?.setZoom) {
          return {
            handled: false,
            changed: false,
            code: 'ACTION_UNAVAILABLE',
            hint: '图片视图未挂载，无法缩放',
          };
        }
        const zoomArg = actionArgs(action).zoom;
        const zoom = zoomArg === 'fit'
          ? 'fit' as const
          : typeof zoomArg === 'number' && Number.isFinite(zoomArg)
            ? zoomArg
            : null;
        if (zoom == null) {
          return {
            handled: false,
            changed: false,
            code: 'INVALID_ARGS',
            hint: "setZoom 需要 zoom：10–800 的百分比或 'fit'",
          };
        }
        const before = surface.getZoomState?.() ?? null;
        const outcome = surface.setZoom(zoom);
        if (!outcome.handled) {
          return {
            handled: false,
            changed: false,
            code: outcome.code ?? 'ACTION_UNAVAILABLE',
            hint: outcome.hint,
          };
        }
        const result: AgentActionResult = {
          handled: true,
          changed: outcome.changed !== false,
          acknowledged: true,
          entityRefs: [stableAgentRef(typeId, 'resource', ctx.instanceKey ?? 'unknown')],
        };
        if (result.changed && before) {
          result.undo = {
            inverse: {
              name: 'setZoom',
              args: { zoom: before.fitMode ? 'fit' : before.zoomPercent },
            },
            label: '恢复图片缩放',
          };
        }
        return result;
      }
      // A45-5：rotate 走挂载视图的真实表面落点；未挂载/未加载完成诚实失败。
      if (canRotate && action.name === 'rotate') {
        const resourceId = resolveResourceId(ctx.instanceKey);
        const surface = getContentAgentSurface(typeId, resourceId);
        if (!surface?.rotate) {
          return {
            handled: false,
            changed: false,
            code: 'ACTION_UNAVAILABLE',
            hint: '图片视图未挂载，无法旋转',
          };
        }
        const degreesArg = actionArgs(action).degrees;
        const degrees = degreesArg === 90 || degreesArg === 180 || degreesArg === 270
          ? degreesArg
          : null;
        if (degrees == null) {
          return {
            handled: false,
            changed: false,
            code: 'INVALID_ARGS',
            hint: 'rotate 需要 degrees：90/180/270（顺时针）',
          };
        }
        // 执行前读旋转角（undo/回执用）。React 状态异步提交，执行后同步 re-read
        // 拿不到新值；90/180/270 的增量对归一化角必然产生变化，changed 由
        // 表面回执 + 增量语义共同判定，不伪造。
        const beforeRotation = surface.getRotation?.() ?? null;
        const outcome = surface.rotate(degrees);
        if (!outcome.handled) {
          return {
            handled: false,
            changed: false,
            code: outcome.code ?? 'ACTION_UNAVAILABLE',
            hint: outcome.hint,
          };
        }
        const result: AgentActionResult = {
          handled: true,
          changed: outcome.changed !== false,
          acknowledged: true,
          entityRefs: [stableAgentRef(typeId, 'resource', ctx.instanceKey ?? 'unknown')],
          ...(beforeRotation != null
            ? {
                details: {
                  previousRotation: beforeRotation,
                  rotation: (beforeRotation + degrees) % 360,
                },
              }
            : {}),
        };
        if (result.changed) {
          // 反向旋转恢复：90↔270、180↔180，均在 schema 枚举内
          result.undo = {
            inverse: {
              name: 'rotate',
              args: { degrees: (360 - degrees) as 90 | 180 | 270 },
            },
            label: '恢复图片旋转',
          };
        }
        return result;
      }
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
