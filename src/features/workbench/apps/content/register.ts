/**
 * 七类内容应用注册（P8）
 *
 * note / textbook / exam / translation / essay / image / file
 * - weight：textbook=3，note/exam/translation/essay=2，image/file=1（设计文档 §9.1）
 * - exam / essay 为 single 工作区，资源 ID 只用于工作区内导航
 * - 其余资源应用为 multi，instanceKey = resourceId
 * - note/translation/essay 接未保存关窗拦截（脏状态挂点见 contentDirtyRegistry）
 *
 * 由 P11 的 apps 装配入口统一 import 本模块使注册生效。
 *
 * ACR R2-10：统一 onActivation
 * - note：scrollToHeading → CrepeEditor
 * - exam：focusQuestion → qbank:focus-question；scrollToHeading 回执 handled:false
 * - textbook/file：scrollToHeading 若 payload 含 page → pdf-ref:focus；否则可行动回执
 * - 其余：scrollToHeading 返回 handled:false + hint（禁止假成功）
 */
import React from 'react';
import i18next from 'i18next';
import {
  TextbookIcon,
  ExamIcon,
  TranslationIcon,
  EssayIcon,
  ImageFileIcon,
  GenericFileIcon,
} from '@/features/learning-hub/icons';
import {
  useQuestionBankStore,
  validateQbankPracticeHandoff,
  type PracticeMode,
  type QuestionFilters,
} from '@/stores/questionBankStore';
import { useReviewPlanStore } from '@/stores/reviewPlanStore';
import {
  QBANK_CONTROL_EVENT,
  QBANK_FOCUS_EVENT,
  type QbankControlAction,
  type QbankControlEventDetail,
  type QbankControlResult,
  type QbankFocusEventDetail,
} from '../../agent/drivers/qbankDriver';
import { getNoteEditor } from '../../agent/drivers/noteDriver';
import { appRegistry } from '../../core/appRegistry';
import type { ActivationContext, ActivationResult, AppDefinition } from '../../core/types';
import { createContentApp, type CreateContentAppOptions } from './createContentApp';
import { requestContentCloseConfirmation } from './ContentCloseConfirmation';
import { isContentDirty } from './contentDirtyRegistry';
import {
  getResourceWorkspaceActive,
  requestResourceWorkspace,
  waitForResourceWorkspaceActive,
} from './resourceWorkspaceRegistry';
import {
  createExamAgentManifest,
  createResourceContentManifest,
} from './agentManifests';
import { requestPdfPageFocus } from './pdfFocusAck';

function parseHeadingPayload(payload: unknown): { heading: string; level: number; page?: number } {
  let heading = '';
  let level = 1;
  let page: number | undefined;
  if (typeof payload === 'string') {
    heading = payload;
  } else if (payload && typeof payload === 'object') {
    const p = payload as {
      heading?: unknown;
      text?: unknown;
      level?: unknown;
      page?: unknown;
      pageNumber?: unknown;
    };
    if (typeof p.heading === 'string') heading = p.heading;
    else if (typeof p.text === 'string') heading = p.text;
    if (typeof p.level === 'number' && p.level >= 1 && p.level <= 6) level = p.level;
    const pageRaw = p.page ?? p.pageNumber;
    if (typeof pageRaw === 'number' && Number.isFinite(pageRaw) && pageRaw > 0) {
      page = Math.floor(pageRaw);
    }
  }
  return { heading, level, page };
}

function parseQuestionId(payload: unknown): string | null {
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  if (payload && typeof payload === 'object') {
    const p = payload as { questionId?: unknown; id?: unknown };
    if (typeof p.questionId === 'string' && p.questionId.trim()) return p.questionId.trim();
    if (typeof p.id === 'string' && p.id.trim()) return p.id.trim();
  }
  return null;
}

/**
 * note onActivation：scrollToHeading — R1-12
 * payload: { heading: string, level?: number } | string
 */
export function handleNoteActivation(ctx: ActivationContext): ActivationResult {
  if (ctx.action !== 'scrollToHeading') {
    console.warn(`[workbench:note] unknown activation action: ${ctx.action}`);
    return {
      handled: false,
      code: 'UNKNOWN_ACTION',
      hint: `note 不支持 action=${ctx.action}`,
    };
  }
  const resourceId = ctx.instanceKey;
  if (!resourceId) {
    return {
      handled: false,
      code: 'WINDOW_NOT_FOUND',
      hint: '缺少笔记 resourceId（instanceKey）',
    };
  }

  const api = getNoteEditor(resourceId, ctx.windowId);
  if (!api) {
    console.warn('[workbench:note] scrollToHeading ignored: editor not registered');
    return {
      handled: false,
      code: 'ANCHOR_NOT_FOUND',
      hint: '笔记编辑器尚未就绪，请稍后重试 scrollToHeading',
    };
  }

  const { heading, level } = parseHeadingPayload(ctx.payload);
  if (!heading.trim()) {
    return {
      handled: false,
      code: 'INVALID_ARGS',
      hint: 'scrollToHeading 需要 payload.heading',
    };
  }
  api.scrollToHeading(heading, level);
  return { handled: true };
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/** Keep an unfinished SM-2 queue scoped to its exam and ask before the OS shell closes it. */
async function canCloseExamWorkspace(instanceKey: string | null): Promise<boolean> {
  const store = useReviewPlanStore.getState();
  const { session } = store;
  const hasRemainingItems =
    session.isActive && session.currentIndex < session.queue.length;
  const examId = instanceKey ?? getResourceWorkspaceActive('exam');
  // The OS exam app is a single resource workspace. When it closes (no
  // instanceKey), any active queue belongs to that window even if the user
  // switched its visible resource after starting the queue.
  const ownsReviewSession = instanceKey === null
    || !session.examId
    || instanceKey === session.examId;

  if (hasRemainingItems && ownsReviewSession) {
    const confirmed = await requestContentCloseConfirmation({
      description: i18next.t('review:session.exitDescription', {
        defaultValue: '已提交的评分会保留，剩余题目可稍后重新开始复习。',
      }),
    });
    if (!confirmed) return false;
    store.endSession();
  }

  if (!isContentDirty('exam', examId)) return true;
  return requestContentCloseConfirmation({
    description: i18next.t('workbench:content.confirmCloseUnsaved', {
      defaultValue: '当前内容有未保存的修改，确定要关闭窗口吗？',
    }),
  });
}

function resolveExamTarget(ctx: ActivationContext): string | null {
  return ctx.instanceKey ?? getResourceWorkspaceActive('exam');
}

function dispatchExamFocus(targetResourceId: string, questionId: string): ActivationResult {
  if (typeof window === 'undefined') {
    return {
      handled: false,
      code: 'WINDOW_NOT_FOUND',
      hint: '题目集视图未就绪，无法定位题目',
    };
  }

  let acknowledgement: { handled: boolean; previousQuestionId: string | null } | null = null;
  window.dispatchEvent(
    new CustomEvent<QbankFocusEventDetail>(QBANK_FOCUS_EVENT, {
      detail: {
        targetResourceId,
        questionId,
        acknowledge: (result) => {
          acknowledgement = result;
        },
      },
    }),
  );

  if (!acknowledgement) {
    return {
      handled: false,
      code: 'WINDOW_NOT_FOUND',
      hint: '题目集视图未就绪，无法定位题目',
    };
  }
  if (!acknowledgement.handled) {
    return { handled: false, code: 'QUESTION_NOT_FOUND', hint: '当前题目集不存在该题目' };
  }
  return { handled: true };
}

function dispatchExamControl(
  targetResourceId: string,
  action: QbankControlAction,
  payload?: unknown,
): QbankControlResult {
  if (typeof window === 'undefined') {
    return {
      handled: false,
      code: 'WINDOW_NOT_FOUND',
      hint: '题目集视图未就绪，无法执行该操作',
    };
  }

  let acknowledgement: QbankControlResult | null = null;
  window.dispatchEvent(
    new CustomEvent<QbankControlEventDetail>(QBANK_CONTROL_EVENT, {
      detail: {
        targetResourceId,
        action,
        payload,
        acknowledge: (result) => {
          acknowledgement = result;
        },
      },
    }),
  );
  return acknowledgement ?? {
    handled: false,
    code: 'WINDOW_NOT_FOUND',
    hint: '题目集视图未就绪，无法执行该操作',
  };
}

async function hydrateExamPracticeSession(
  ctx: ActivationContext,
  targetResourceId: string,
): Promise<ActivationResult> {
  const payload = payloadRecord(ctx.payload);
  const rawHandoff = payload.handoff ?? ctx.payload;
  const validated = validateQbankPracticeHandoff(rawHandoff, targetResourceId);
  if ('ok' in validated) {
    return { handled: false, code: validated.code, hint: validated.hint };
  }

  if (getResourceWorkspaceActive('exam') !== targetResourceId) {
    requestResourceWorkspace('exam', targetResourceId);
    if (!(await waitForResourceWorkspaceActive('exam', targetResourceId))) {
      return {
        handled: false,
        code: 'CONFIRMATION_REQUIRED',
        hint: '题目集尚未切换；请先处理当前草稿/复习会话确认，再重试交接',
      };
    }
  }

  const result = dispatchExamControl(
    targetResourceId,
    'hydratePracticeSession',
    { handoff: validated },
  );
  if (!result.handled || result.acknowledged !== true) {
    return {
      handled: false,
      code: result.code ?? 'ACTION_UNVERIFIED',
      hint: result.hint ?? '题库 UI 未确认练习会话已注入',
    };
  }
  return { handled: true, acknowledged: true };
}

/** exam：安全导航与视图控制；答题/交卷仍归 qbank 领域工具和用户。 */
export function handleExamActivation(
  ctx: ActivationContext,
): ActivationResult | Promise<ActivationResult> {
  if (ctx.action === 'hydratePracticeSession') {
    const payload = payloadRecord(ctx.payload);
    const handoff = payloadRecord(payload.handoff ?? ctx.payload);
    const handoffExamId = typeof handoff?.exam_id === 'string' && handoff.exam_id.trim()
      ? handoff.exam_id.trim()
      : null;
    const requestedExamId = ctx.instanceKey ?? handoffExamId;
    if (!requestedExamId) {
      return {
        handled: false,
        code: 'INVALID_PRACTICE_HANDOFF',
        hint: 'hydratePracticeSession 缺少目标题目集或 handoff.exam_id',
      };
    }
    return hydrateExamPracticeSession(ctx, requestedExamId);
  }
  const targetResourceId = resolveExamTarget(ctx);
  if (!targetResourceId) {
    return {
      handled: false,
      code: 'WINDOW_NOT_FOUND',
      hint: '当前题目集尚未就绪',
    };
  }

  if (ctx.action === 'focusQuestion') {
    const questionId = parseQuestionId(ctx.payload);
    if (!questionId) {
      return {
        handled: false,
        code: 'INVALID_ARGS',
        hint: 'focusQuestion 需要 payload.questionId',
      };
    }
    const result = dispatchExamFocus(targetResourceId, questionId);
    if (result.handled) {
      // The global store is an agent-observation mirror; the mounted view owns
      // the actual per-resource session and acknowledged the navigation above.
      useQuestionBankStore.getState().setCurrentQuestion(questionId);
    }
    return result;
  }
  if (ctx.action === 'nextQuestion' || ctx.action === 'previousQuestion') {
    const result = dispatchExamControl(targetResourceId, ctx.action);
    if (result.handled && result.currentQuestionId) {
      useQuestionBankStore.getState().setCurrentQuestion(result.currentQuestionId);
    }
    return result;
  }
  if (ctx.action === 'setFilters') {
    const payload = payloadRecord(ctx.payload);
    const filters = payload.filters && typeof payload.filters === 'object'
      ? (payload.filters as QuestionFilters)
      : (payload as QuestionFilters);
    const result = dispatchExamControl(targetResourceId, 'setFilters', { filters });
    if (result.handled) useQuestionBankStore.getState().setFilters(filters);
    return result;
  }
  if (ctx.action === 'resetFilters') {
    const result = dispatchExamControl(targetResourceId, 'resetFilters');
    if (result.handled) useQuestionBankStore.getState().resetFilters();
    return result;
  }
  if (ctx.action === 'setPracticeMode') {
    const payload = payloadRecord(ctx.payload);
    const mode = payload.mode;
    const allowed = new Set([
      'sequential',
      'random',
      'review_first',
      'review_only',
      'by_tag',
      'timed',
      'mock_exam',
      'daily',
      'paper',
    ]);
    if (typeof mode !== 'string' || !allowed.has(mode)) {
      return { handled: false, code: 'INVALID_ARGS', hint: 'practice mode 值无效' };
    }
    const tag = payload.tag;
    if (mode === 'by_tag' && (typeof tag !== 'string' || !tag.trim())) {
      return {
        handled: false,
        code: 'INVALID_ARGS',
        hint: 'by_tag 需要 payload.tag；请先选择要练习的标签',
      };
    }
    const result = dispatchExamControl(targetResourceId, 'setPracticeMode', {
      mode: mode as PracticeMode,
      tag: typeof tag === 'string' ? tag : undefined,
    });
    if (result.handled) useQuestionBankStore.getState().setPracticeMode(mode as PracticeMode);
    return result;
  }
  if (ctx.action === 'setFocusMode') {
    const enabled = payloadRecord(ctx.payload).enabled;
    if (typeof enabled !== 'boolean') {
      return { handled: false, code: 'INVALID_ARGS', hint: 'setFocusMode 需要 enabled' };
    }
    useQuestionBankStore.getState().setFocusMode(enabled);
    return { handled: true };
  }
  if (ctx.action === 'showSettings') {
    const open = payloadRecord(ctx.payload).open;
    if (typeof open !== 'boolean') {
      return { handled: false, code: 'INVALID_ARGS', hint: 'showSettings 需要 open' };
    }
    if (typeof window === 'undefined') {
      return {
        handled: false,
        code: 'WINDOW_NOT_FOUND',
        hint: '当前题目集尚未就绪，无法打开设置面板',
      };
    }
    let acknowledgement: ActivationResult | null = null;
    window.dispatchEvent(
      new CustomEvent('exam:openSettings', {
        detail: {
          targetResourceId,
          open,
          acknowledge: (result: ActivationResult) => {
            acknowledgement = result;
          },
        },
      }),
    );
    return acknowledgement ?? {
      handled: false,
      code: 'WINDOW_NOT_FOUND',
      hint: '题目集视图未就绪，无法打开设置面板',
    };
  }
  if (ctx.action === 'scrollToHeading') {
    return {
      handled: false,
      code: 'UNSUPPORTED_ACTION',
      hint: 'exam 请用 focusQuestion {questionId}，不支持 scrollToHeading',
    };
  }
  console.warn(`[workbench:exam] unknown activation action: ${ctx.action}`);
  return {
    handled: false,
    code: 'UNKNOWN_ACTION',
    hint: `exam 不支持 action=${ctx.action}`,
  };
}

/**
 * textbook/file：若 payload 含 page/pageNumber，经 pdf-ref:focus 跳页（既有 PDF 监听）。
 * 纯标题锚点无大纲 API → 可行动回执，禁止假成功。
 */
async function handlePdfLikeScroll(typeId: string, ctx: ActivationContext): Promise<ActivationResult> {
  const resourceId = ctx.instanceKey;
  if (!resourceId) {
    return {
      handled: false,
      code: 'WINDOW_NOT_FOUND',
      hint: `缺少 ${typeId} resourceId`,
    };
  }
  const { heading, page } = parseHeadingPayload(ctx.payload);
  if (page != null) {
    return requestPdfPageFocus(resourceId, page);
  }
  return {
    handled: false,
    code: 'UNSUPPORTED_ACTION',
    hint: heading.trim()
      ? `${typeId} 暂不支持按标题滚动；请传 payload.page（页码）或改用 note`
      : `${typeId} scrollToHeading 需要 payload.page（页码）或改用 note 的 heading`,
  };
}

/**
 * 内容类统一 onActivation — R1-16 / R2-10
 */
function createContentActivationHandler(typeId: string) {
  return async (ctx: ActivationContext): Promise<ActivationResult> => {
    if (typeId === 'note') {
      return handleNoteActivation(ctx);
    }
    if (typeId === 'exam') {
      return handleExamActivation(ctx);
    }
    if (ctx.action === 'scrollToHeading' || ctx.action === 'gotoPage') {
      if (typeId === 'textbook' || typeId === 'file') {
        return handlePdfLikeScroll(typeId, ctx);
      }
      return {
        handled: false,
        code: 'UNSUPPORTED_ACTION',
        hint: `${typeId} 不支持 ${ctx.action}（仅 note 支持标题；textbook/file 可用 page）`,
      };
    }
    console.warn(`[workbench:${typeId}] unknown activation action: ${ctx.action}`);
    return {
      handled: false,
      code: 'UNKNOWN_ACTION',
      hint: `${typeId} 不支持 action=${ctx.action}`,
    };
  };
}

const icon = (Component: React.FC<{ className?: string }>): React.ReactNode =>
  React.createElement(Component, { className: 'h-full w-full' });

const CONTENT_APP_OPTIONS: CreateContentAppOptions[] = [
  {
    typeId: 'textbook',
    nameKey: 'workbench:apps.textbook',
    icon: icon(TextbookIcon),
    memoryWeight: 3,
    defaultFrame: { w: 920, h: 700 },
    minSize: { w: 420, h: 320 },
  },
  {
    typeId: 'exam',
    nameKey: 'workbench:apps.exam',
    icon: icon(ExamIcon),
    memoryWeight: 2,
    defaultFrame: { w: 880, h: 660 },
    instanceMode: 'single',
  },
  {
    typeId: 'translation',
    nameKey: 'workbench:apps.translation',
    icon: icon(TranslationIcon),
    memoryWeight: 2,
    defaultFrame: { w: 880, h: 620 },
    confirmUnsavedOnClose: true,
  },
  {
    typeId: 'essay',
    nameKey: 'workbench:apps.essay',
    icon: icon(EssayIcon),
    memoryWeight: 2,
    defaultFrame: { w: 880, h: 620 },
    confirmUnsavedOnClose: true,
    instanceMode: 'single',
  },
  {
    typeId: 'image',
    nameKey: 'workbench:apps.image',
    icon: icon(ImageFileIcon),
    memoryWeight: 1,
    defaultFrame: { w: 720, h: 560 },
  },
  {
    typeId: 'file',
    nameKey: 'workbench:apps.file',
    icon: icon(GenericFileIcon),
    memoryWeight: 1,
    defaultFrame: { w: 780, h: 600 },
  },
];

/** 七类内容应用定义（导出供测试断言元数据） */
export const CONTENT_APP_DEFINITIONS: AppDefinition[] =
  CONTENT_APP_OPTIONS.map(createContentApp);

// 统一挂载 onActivation（R1-16 / R2-10）
for (const def of CONTENT_APP_DEFINITIONS) {
  const activation = createContentActivationHandler(def.typeId);
  def.onActivation = activation;
  def.agentManifest = def.typeId === 'exam'
    ? createExamAgentManifest(activation)
    : createResourceContentManifest(def.typeId, activation);
  if (def.typeId === 'exam') {
    def.canClose = canCloseExamWorkspace;
  }
}

for (const def of CONTENT_APP_DEFINITIONS) {
  appRegistry.register(def);
}
