/**
 * 只读「打开已有资源」导航 action handlers — 零写副作用的子应用入口。
 *
 * 边界（对照 docs/generative-ui/NOTES_INTEGRATION.md 写入规约与
 * docs/dev/wave2-B-ledger.md「GenUI 只读冻结」不变量）：
 * 1. 本模块只派发既有导航事件，**禁止** save / create / dstu 写 API；
 * 2. 打开笔记走 `DSTU_OPEN_NOTE` 契约（features/notes/openNoteEvent.ts），
 *    source 固定为 'generative-ui'（显式非 Notes 自有 source → Chat 侧处理，
 *    workbench 模式下经 chat 窗回落 navigateToNote 由 WorkbenchEventBridge 开窗）；
 *    标题锚点复用 notes headingTargetBridge 的冷启动 pending 语义，
 *    编辑器挂载后自行 consume，无论哪个宿主最终打开笔记；
 * 3. 打开 PDF 页走 `pdf-ref:open`（document 级 CustomEvent），与 Chat 引用
 *    [PDF@id:3] 内联链接完全同一条消费链（useChatPageEvents / WorkbenchEventBridge）；
 * 4. 目标 id / 页码在派发前强校验，非法输入静默拒绝（返回 false，不派发）。
 */

import { publishNotesHeadingTarget } from '@/features/notes/headingTargetBridge';
import type { DstuOpenNoteDetail } from '@/features/notes/openNoteEvent';
import type { GenerativeActionDefinition } from '../types';

/** DSTU_OPEN_NOTE 的显式 source：非 Notes 自有 → Chat 侧处理（openNoteEvent 三分规则第 2 条） */
export const GENERATIVE_UI_OPEN_NOTE_SOURCE = 'generative-ui';

/** 组合 action id 前缀（含分隔符）。目标 id 直接拼在后面，供 intent ↔ handler 对齐。 */
export const OPEN_NOTE_ACTION_PREFIX = 'open-note:';
export const OPEN_PDF_PAGE_ACTION_PREFIX = 'open-pdf-page:';

/** 对齐 actionBarPropsSchema 的 action.id max(64) */
export const MAX_OPEN_RESOURCE_ACTION_ID_LENGTH = 64;
/** 页码上限：拒绝荒谬值，防 payload 注入超长 id */
export const MAX_OPEN_PDF_PAGE_NUMBER = 99_999;

/** 资源 id 白名单形状（note_xxx / tb_xxx / uuid 等均命中；拒绝路径分隔与空白） */
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_RESOURCE_ID_LENGTH = 48;
const PDF_PAGE_SEGMENT_PATTERN = /^[1-9][0-9]{0,4}$/;

export interface OpenNoteNavigationTarget {
  noteId: string;
  /** 可选标题锚点（`[[Note#Heading]]` 同源规范化，headingTargetBridge 冷启动跳转） */
  heading?: string;
}

export interface OpenPdfPageNavigationTarget {
  sourceId: string;
  /** 1-based 页码 */
  pageNumber: number;
}

export type OpenResourceActionTarget =
  | ({ kind: 'note' } & OpenNoteNavigationTarget)
  | ({ kind: 'pdf-page' } & OpenPdfPageNavigationTarget);

export function isValidOpenResourceId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_RESOURCE_ID_LENGTH &&
    RESOURCE_ID_PATTERN.test(id)
  );
}

export function isValidOpenPdfPageNumber(page: unknown): page is number {
  return (
    typeof page === 'number' &&
    Number.isInteger(page) &&
    page >= 1 &&
    page <= MAX_OPEN_PDF_PAGE_NUMBER
  );
}

/** 组合「打开笔记」action id；目标非法或超长时返回 null（调用方跳过该目标）。 */
export function openNoteActionId(noteId: string): string | null {
  if (!isValidOpenResourceId(noteId)) return null;
  const actionId = `${OPEN_NOTE_ACTION_PREFIX}${noteId}`;
  return actionId.length <= MAX_OPEN_RESOURCE_ACTION_ID_LENGTH ? actionId : null;
}

/** 组合「打开 PDF 页」action id；目标非法或超长时返回 null。 */
export function openPdfPageActionId(sourceId: string, pageNumber: number): string | null {
  if (!isValidOpenResourceId(sourceId) || !isValidOpenPdfPageNumber(pageNumber)) return null;
  const actionId = `${OPEN_PDF_PAGE_ACTION_PREFIX}${sourceId}:${pageNumber}`;
  return actionId.length <= MAX_OPEN_RESOURCE_ACTION_ID_LENGTH ? actionId : null;
}

/**
 * 从 action id 反解导航目标（chat bridge 用；heading 不进 id，反解结果无锚点）。
 * 任何形状不符 / 校验不过 → null，绝不产出半合法目标。
 */
export function parseOpenResourceActionId(actionId: string): OpenResourceActionTarget | null {
  if (typeof actionId !== 'string' || actionId.length > MAX_OPEN_RESOURCE_ACTION_ID_LENGTH) {
    return null;
  }
  if (actionId.startsWith(OPEN_NOTE_ACTION_PREFIX)) {
    const noteId = actionId.slice(OPEN_NOTE_ACTION_PREFIX.length);
    return isValidOpenResourceId(noteId) ? { kind: 'note', noteId } : null;
  }
  if (actionId.startsWith(OPEN_PDF_PAGE_ACTION_PREFIX)) {
    const rest = actionId.slice(OPEN_PDF_PAGE_ACTION_PREFIX.length);
    const splitAt = rest.lastIndexOf(':');
    if (splitAt <= 0) return null;
    const sourceId = rest.slice(0, splitAt);
    const pageSegment = rest.slice(splitAt + 1);
    if (!isValidOpenResourceId(sourceId) || !PDF_PAGE_SEGMENT_PATTERN.test(pageSegment)) {
      return null;
    }
    const pageNumber = Number.parseInt(pageSegment, 10);
    return isValidOpenPdfPageNumber(pageNumber)
      ? { kind: 'pdf-page', sourceId, pageNumber }
      : null;
  }
  return null;
}

/**
 * 派发「打开笔记」导航（只读，无落盘）。
 * 返回 false = 输入非法，未派发任何事件。
 */
export function dispatchOpenNoteNavigation(target: OpenNoteNavigationTarget): boolean {
  if (!isValidOpenResourceId(target.noteId)) return false;
  const heading = target.heading?.trim();
  if (heading) {
    // pending map 按 noteId 暂存，编辑器挂载后 consume——与 wikilink 冷启动跳转同机制。
    publishNotesHeadingTarget({ noteId: target.noteId, heading });
  }
  const detail: DstuOpenNoteDetail = {
    noteId: target.noteId,
    source: GENERATIVE_UI_OPEN_NOTE_SOURCE,
    ...(heading ? { heading } : {}),
  };
  window.dispatchEvent(new CustomEvent<DstuOpenNoteDetail>('DSTU_OPEN_NOTE', { detail }));
  return true;
}

/**
 * 派发「打开 PDF 页」导航（只读，无落盘）。
 * 返回 false = 输入非法，未派发任何事件。
 */
export function dispatchOpenPdfPageNavigation(target: OpenPdfPageNavigationTarget): boolean {
  if (!isValidOpenResourceId(target.sourceId) || !isValidOpenPdfPageNumber(target.pageNumber)) {
    return false;
  }
  // 与 MarkdownRenderer 内联 PDF 引用同事件、同 detail 形状（document 级）。
  document.dispatchEvent(
    new CustomEvent('pdf-ref:open', {
      detail: { sourceId: target.sourceId, pageNumber: target.pageNumber },
    }),
  );
  return true;
}

export interface OpenNoteActionInput extends OpenNoteNavigationTarget {
  label: string;
}

export interface OpenPdfPageActionInput extends OpenPdfPageNavigationTarget {
  label: string;
}

export interface OpenResourceActionHandlersInput {
  notes?: readonly OpenNoteActionInput[];
  pdfPages?: readonly OpenPdfPageActionInput[];
}

/**
 * 生成只读导航 handler 表（riskLevel 恒 low，无 undo——导航不产生可撤销的持久化变更）。
 * 目标在创建时闭包绑定；非法目标被跳过，与 buildOpenResourceEntryBlock 的过滤口径一致。
 */
export function createOpenResourceActionHandlers(
  input: OpenResourceActionHandlersInput,
): Record<string, GenerativeActionDefinition> {
  const handlers: Record<string, GenerativeActionDefinition> = Object.create(null);

  for (const note of input.notes ?? []) {
    const actionId = openNoteActionId(note.noteId);
    if (!actionId || !note.label) continue;
    const target: OpenNoteNavigationTarget = { noteId: note.noteId, heading: note.heading };
    handlers[actionId] = {
      id: actionId,
      label: note.label,
      riskLevel: 'low',
      handler: async () => {
        dispatchOpenNoteNavigation(target);
      },
    };
  }

  for (const pdfPage of input.pdfPages ?? []) {
    const actionId = openPdfPageActionId(pdfPage.sourceId, pdfPage.pageNumber);
    if (!actionId || !pdfPage.label) continue;
    const target: OpenPdfPageNavigationTarget = {
      sourceId: pdfPage.sourceId,
      pageNumber: pdfPage.pageNumber,
    };
    handlers[actionId] = {
      id: actionId,
      label: pdfPage.label,
      riskLevel: 'low',
      handler: async () => {
        dispatchOpenPdfPageNavigation(target);
      },
    };
  }

  return handlers;
}
