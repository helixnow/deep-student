/**
 * 七类内容应用注册（P8）
 *
 * note / textbook / exam / translation / essay / image / file
 * - weight：textbook=3，note/exam/translation/essay=2，image/file=1（设计文档 §9.1）
 * - 全部 multi，instanceKey = resourceId
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
  type PracticeMode,
  type QuestionFilters,
} from '@/stores/questionBankStore';
import { QBANK_FOCUS_EVENT } from '../../agent/drivers/qbankDriver';
import { getNoteEditor } from '../../agent/drivers/noteDriver';
import { appRegistry } from '../../core/appRegistry';
import type { ActivationContext, ActivationResult, AppDefinition } from '../../core/types';
import { createContentApp, type CreateContentAppOptions } from './createContentApp';

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

  const api = getNoteEditor(resourceId);
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

function focusCurrentQuestion(): ActivationResult {
  const questionId = useQuestionBankStore.getState().currentQuestionId;
  if (!questionId) {
    return { handled: false, code: 'QUESTION_NOT_FOUND', hint: '当前题目列表为空' };
  }
  window.dispatchEvent(new CustomEvent(QBANK_FOCUS_EVENT, { detail: { questionId } }));
  return { handled: true };
}

/** exam：安全导航与视图控制；答题/交卷仍归 qbank 领域工具和用户。 */
export function handleExamActivation(ctx: ActivationContext): ActivationResult {
  if (ctx.action === 'focusQuestion') {
    const questionId = parseQuestionId(ctx.payload);
    if (!questionId) {
      return {
        handled: false,
        code: 'INVALID_ARGS',
        hint: 'focusQuestion 需要 payload.questionId',
      };
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent(QBANK_FOCUS_EVENT, { detail: { questionId } }),
      );
    }
    return { handled: true };
  }
  const store = useQuestionBankStore.getState();
  if (ctx.action === 'nextQuestion' || ctx.action === 'previousQuestion') {
    const currentIndex = store.questionOrder.indexOf(store.currentQuestionId ?? '');
    const delta = ctx.action === 'nextQuestion' ? 1 : -1;
    const baseIndex = currentIndex >= 0 ? currentIndex : delta > 0 ? -1 : 0;
    const nextIndex = Math.min(
      Math.max(baseIndex + delta, 0),
      Math.max(0, store.questionOrder.length - 1),
    );
    store.goToQuestion(nextIndex);
    return focusCurrentQuestion();
  }
  if (ctx.action === 'setFilters') {
    const payload = payloadRecord(ctx.payload);
    store.setFilters(
      payload.filters && typeof payload.filters === 'object'
        ? (payload.filters as QuestionFilters)
        : (payload as QuestionFilters),
    );
    return { handled: true };
  }
  if (ctx.action === 'resetFilters') {
    store.resetFilters();
    return { handled: true };
  }
  if (ctx.action === 'setPracticeMode') {
    const mode = payloadRecord(ctx.payload).mode;
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
    store.setPracticeMode(mode as PracticeMode);
    return { handled: true };
  }
  if (ctx.action === 'setFocusMode') {
    const enabled = payloadRecord(ctx.payload).enabled;
    if (typeof enabled !== 'boolean') {
      return { handled: false, code: 'INVALID_ARGS', hint: 'setFocusMode 需要 enabled' };
    }
    store.setFocusMode(enabled);
    return { handled: true };
  }
  if (ctx.action === 'showSettings') {
    const open = payloadRecord(ctx.payload).open;
    if (typeof open !== 'boolean') {
      return { handled: false, code: 'INVALID_ARGS', hint: 'showSettings 需要 open' };
    }
    if (store.showSettingsPanel !== open) store.toggleSettingsPanel();
    return { handled: true };
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
function handlePdfLikeScroll(typeId: string, ctx: ActivationContext): ActivationResult {
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
    if (typeof document !== 'undefined') {
      document.dispatchEvent(
        new CustomEvent('pdf-ref:focus', {
          detail: {
            sourceId: resourceId,
            pageNumber: page,
            path: resourceId.startsWith('/') ? resourceId : `/${resourceId}`,
          },
        }),
      );
    }
    return { handled: true };
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
  return (ctx: ActivationContext): ActivationResult => {
    if (typeId === 'note') {
      return handleNoteActivation(ctx);
    }
    if (typeId === 'exam') {
      return handleExamActivation(ctx);
    }
    if (ctx.action === 'scrollToHeading') {
      if (typeId === 'textbook' || typeId === 'file') {
        return handlePdfLikeScroll(typeId, ctx);
      }
      return {
        handled: false,
        code: 'UNSUPPORTED_ACTION',
        hint: `${typeId} 不支持 scrollToHeading（仅 note 支持标题；textbook/file 可用 page）`,
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
  def.onActivation = createContentActivationHandler(def.typeId);
}

for (const def of CONTENT_APP_DEFINITIONS) {
  appRegistry.register(def);
}
