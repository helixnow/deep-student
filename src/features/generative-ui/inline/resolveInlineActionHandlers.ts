/**
 * 正文内联 ```genui — 只构造 INLINE_SAFE 的 action handler。
 *
 * 与 chat resolver（bridge/resolveGenerativeUIChatActionHandlers.ts）刻意分开：内联块来自模型
 * 正文，没有工具调用上下文，绝不能拿到 workbench / 笔记编辑 / 研究 / followup 等 handler。
 * 只放行：copy-block、copy-intent、open-note:<id>、open-pdf:<id>（第 1 页）、open-pdf-page:<id>:<page>。
 * 返回值始终是对象（即使为空），使 ActionBar 进入「注册表安全模式」——未注册的按钮不渲染。
 */

import i18n from '@/i18n';
import type { GenerativeActionDefinition, GenerativeUIIntent } from '../types';
import { withGenerativeActionInstrumentation } from '../actions';
import { isInlineSafeActionId } from '../validateIntentRules';
import {
  COPY_BLOCK_ACTION_ID,
  createCopyBlockActionHandlers,
} from '../handlers/copyBlockActionHandlers';
import {
  COPY_INTENT_ACTION_ID,
  createCopyIntentActionHandlers,
} from '../handlers/copyIntentActionHandlers';
import {
  MAX_OPEN_RESOURCE_ACTION_ID_LENGTH,
  dispatchOpenPdfPageNavigation,
  isValidOpenResourceId,
  createOpenResourceActionHandlers,
  parseOpenResourceActionId,
  type OpenNoteActionInput,
  type OpenPdfPageActionInput,
} from '../handlers/openResourceActionHandlers';

/** `open-pdf:<sourceId>`：打开 PDF 第 1 页（与 open-pdf-page 同一只读导航事件） */
export const INLINE_OPEN_PDF_ACTION_PREFIX = 'open-pdf:';

function label(key: string, defaultValue: string, options?: Record<string, unknown>): string {
  return String(i18n.t(`generativeUi:${key}`, { defaultValue, ...options }));
}

function collectInlineActionIds(intent: GenerativeUIIntent): Set<string> {
  const ids = new Set<string>();
  for (const block of intent.blocks ?? []) {
    if (block?.type !== 'action-bar') continue;
    const actions = (block.props as { actions?: Array<{ id?: unknown }> } | undefined)?.actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      if (typeof action?.id === 'string' && isInlineSafeActionId(action.id)) ids.add(action.id);
    }
  }
  return ids;
}

/** `open-pdf:<sourceId>` → sourceId；形状不符返回 null（不注册 → 按钮不渲染） */
export function parseInlineOpenPdfActionId(actionId: string): string | null {
  if (
    typeof actionId !== 'string' ||
    actionId.length > MAX_OPEN_RESOURCE_ACTION_ID_LENGTH ||
    !actionId.startsWith(INLINE_OPEN_PDF_ACTION_PREFIX)
  ) {
    return null;
  }
  const sourceId = actionId.slice(INLINE_OPEN_PDF_ACTION_PREFIX.length);
  return isValidOpenResourceId(sourceId) ? sourceId : null;
}

export function resolveInlineActionHandlers(
  intent: GenerativeUIIntent,
): Record<string, GenerativeActionDefinition> {
  const actionIds = collectInlineActionIds(intent);
  const handlers: Record<string, GenerativeActionDefinition> = Object.create(null);

  if (actionIds.has(COPY_INTENT_ACTION_ID)) {
    Object.assign(
      handlers,
      createCopyIntentActionHandlers(intent, {
        copyIntent: label('action.copy_intent', '复制意图'),
      }),
    );
  }

  if (actionIds.has(COPY_BLOCK_ACTION_ID)) {
    Object.assign(
      handlers,
      createCopyBlockActionHandlers(intent, {
        copyBlock: label('action.copy_block', '复制该组件'),
      }),
    );
  }

  const notes: OpenNoteActionInput[] = [];
  const pdfPages: OpenPdfPageActionInput[] = [];
  for (const id of actionIds) {
    const pdfSourceId = parseInlineOpenPdfActionId(id);
    if (pdfSourceId) {
      handlers[id] = {
        id,
        label: label('action.open_pdf_page', '打开 PDF 第 {{page}} 页', { page: 1 }),
        riskLevel: 'low',
        handler: async () => {
          dispatchOpenPdfPageNavigation({ sourceId: pdfSourceId, pageNumber: 1 });
        },
      };
      continue;
    }
    const parsed = parseOpenResourceActionId(id);
    if (!parsed) continue;
    if (parsed.kind === 'note') {
      notes.push({ noteId: parsed.noteId, label: label('action.open_note', '打开笔记') });
    } else {
      pdfPages.push({
        sourceId: parsed.sourceId,
        pageNumber: parsed.pageNumber,
        label: label('action.open_pdf_page', '打开 PDF 第 {{page}} 页', { page: parsed.pageNumber }),
      });
    }
  }
  if (notes.length > 0 || pdfPages.length > 0) {
    Object.assign(handlers, createOpenResourceActionHandlers({ notes, pdfPages }));
  }

  // 防御：任何非 inline-safe 的 id 都不可能出现在结果里
  for (const id of Object.keys(handlers)) {
    if (!isInlineSafeActionId(id)) delete handlers[id];
  }

  return withGenerativeActionInstrumentation(handlers);
}
