/**
 * Learning Hub 拖拽导入路由工具
 */

import type { FinderPathLike, FinderViewKind } from './learningHubContracts';
import { getViewCapabilities } from './learningHubContracts';

/** 不允许拖拽导入的视图类型 */
export const DRAG_DROP_BLOCKED_VIEWS = ['favorites', 'trash', 'recent', 'indexStatus', 'memory', 'desktop'] as const;

/** 识别为 Markdown 笔记导入的扩展名 */
export const MARKDOWN_NOTE_EXTENSIONS = new Set(['md', 'markdown']);

/**
 * 当前视图是否禁止拖拽导入
 */
export function isDragDropBlockedView(pathOrViewKind: FinderPathLike | FinderViewKind | string | null | undefined): boolean {
  if (!pathOrViewKind) return false;
  const viewKind =
    typeof pathOrViewKind === 'string'
      ? (pathOrViewKind === 'root' ? 'folder' : pathOrViewKind)
      : pathOrViewKind.viewKind;

  return !getViewCapabilities(viewKind as FinderViewKind).canDragDrop;
}

/**
 * 消费“本次已走路径导入”的标记。
 *
 * 返回 true 表示当前 files 回调应被跳过（避免同一次拖拽重复导入）。
 */
export function consumePathsDropHandledFlag(flagRef: { current: boolean }): boolean {
  if (!flagRef.current) return false;
  flagRef.current = false;
  return true;
}

/**
 * 按是否应作为 Markdown 笔记导入进行分流。
 *
 * 当且仅当当前处于“笔记”视图时，`.md/.markdown` 会进入 `markdownItems`，
 * 其余文件维持原链路。
 */
export function partitionMarkdownNoteImports<T>(
  items: T[],
  getName: (item: T) => string,
  shouldImportMarkdownAsNotes: boolean,
): { markdownItems: T[]; otherItems: T[] } {
  if (!shouldImportMarkdownAsNotes) {
    return {
      markdownItems: [],
      otherItems: [...items],
    };
  }

  const markdownItems: T[] = [];
  const otherItems: T[] = [];

  for (const item of items) {
    const fileName = getName(item);
    const extension = (fileName.split('.').pop() || '').toLowerCase();
    if (MARKDOWN_NOTE_EXTENSIONS.has(extension)) {
      markdownItems.push(item);
    } else {
      otherItems.push(item);
    }
  }

  return { markdownItems, otherItems };
}

export interface ImportFormatOptions {
  listSeparator: string;
  clauseSeparator: string;
  formatItemWithReason: (name: string, reason: string) => string;
  joinMessageWithDetail: (message: string, detail: string) => string;
}

type TranslateLike = (key: string, options?: Record<string, unknown>) => string;

export function isZhLocale(language?: string | null): boolean {
  return typeof language === 'string' && language.trim().toLowerCase().startsWith('zh');
}

export function getDefaultImportFormatOptions(language?: string | null): ImportFormatOptions {
  const zh = isZhLocale(language);
  return {
    listSeparator: zh ? '、' : ', ',
    clauseSeparator: zh ? '；' : '; ',
    formatItemWithReason: (name, reason) => (zh ? `${name}（${reason}）` : `${name} (${reason})`),
    joinMessageWithDetail: (message, detail) => (zh ? `${message}；${detail}` : `${message}; ${detail}`),
  };
}

function resolveTranslatedPattern(
  t: TranslateLike,
  key: string,
  fallback: string,
  params?: Record<string, unknown>,
): string {
  const value = t(key, { ...params, defaultValue: fallback });
  if (!value || value === key || value.endsWith(`:${key}`)) {
    return fallback;
  }
  return value;
}

export function resolveImportFormatOptions(
  t: TranslateLike,
  language?: string | null,
): ImportFormatOptions {
  const defaults = getDefaultImportFormatOptions(language);
  const listSeparator = resolveTranslatedPattern(t, 'finder.format.listSeparator', defaults.listSeparator);
  const clauseSeparator = resolveTranslatedPattern(t, 'finder.format.clauseSeparator', defaults.clauseSeparator);
  return {
    listSeparator,
    clauseSeparator,
    formatItemWithReason: (name, reason) =>
      resolveTranslatedPattern(
        t,
        'finder.format.itemWithReason',
        defaults.formatItemWithReason(name, reason),
        { name, reason },
      ),
    joinMessageWithDetail: (message, detail) =>
      resolveTranslatedPattern(
        t,
        'finder.format.messageWithDetail',
        defaults.joinMessageWithDetail(message, detail),
        { message, detail },
      ),
  };
}

export function formatFailedImportSummary(
  failedDetails: ReadonlyArray<{ name: string; reason?: string }>,
  format: Pick<ImportFormatOptions, 'clauseSeparator' | 'formatItemWithReason'>,
  maxItems = 3,
): string {
  return failedDetails
    .slice(0, maxItems)
    .map((entry) => (entry.reason ? format.formatItemWithReason(entry.name, entry.reason) : entry.name))
    .join(format.clauseSeparator);
}

/**
 * 将失败文件列表压缩为便于通知展示的摘要。
 */
export function summarizeFailedMarkdownFiles(failedFiles: string[], separator = '、'): string | null {
  if (failedFiles.length === 0) {
    return null;
  }

  const preview = failedFiles.slice(0, 3).join(separator);
  const remaining = failedFiles.length - 3;
  return remaining > 0 ? `${preview} +${remaining}` : preview;
}

/**
 * 已作为资料导入的 Markdown「转为笔记」：预览派发，学习资源侧栏处理
 * （新建同名笔记放进当前文件夹并打开，原文件移到回收站、可撤销）。
 */
export const CONVERT_MARKDOWN_TO_NOTE_EVENT = 'learningHub:convertMarkdownToNote';

export interface ConvertMarkdownToNoteDetail {
  resourceId: string;
  name: string;
  content: string;
}

/** 拆出 Markdown 开头的一级标题（前面只允许空行）；没有则 title 为 null、body 原样返回。 */
export function splitLeadingMarkdownHeading(content: string): { title: string | null; body: string } {
  const match = content.match(/^\s*#\s+([^\n]+?)\s*#*\s*(?:\n|$)/);
  if (!match) return { title: null, body: content };
  const title = match[1].trim();
  if (!title) return { title: null, body: content };
  return { title, body: content.slice(match[0].length).replace(/^\s*\n/, '') };
}

/**
 * 用户操作里主动移除的资源（如 Markdown 转为笔记后把原文件移到回收站）：
 * 标签页照常关闭，但不弹「资源已删除或已移动」警告。标记一次性消费。
 */
const intentionalRemovals = new Set<string>();

export function markIntentionalRemoval(resourceId: string): void {
  intentionalRemovals.add(resourceId);
  // 兜底清理：删除事件没到达时不让标记长期残留
  setTimeout(() => intentionalRemovals.delete(resourceId), 10_000);
}

export function consumeIntentionalRemoval(resourceId: string): boolean {
  return intentionalRemovals.delete(resourceId);
}
