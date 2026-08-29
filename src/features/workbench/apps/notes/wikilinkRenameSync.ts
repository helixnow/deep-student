/**
 * 笔记重命名后的双链回写。
 *
 * `[[旧标题]]` 形式的链接按标题解析，重命名后会集体失解析（或错误命中同名
 * 笔记）。本模块在 renameTreeItem 成功后扫描引用来源，把仍指向该笔记的
 * 按标题链接改写为新标题（保留 `#heading` 与 `|alias`），并用 DSTU 乐观锁
 * （expectedUpdatedAtMs）写回，绝不覆盖并发编辑。
 *
 * 来源发现 = 后端 note_links 图（全库视角）∪ 客户端标题候选搜索（后端图
 * 尚未重建时的兜底），两路都失败时返回 scan-failed 供宿主提示。
 * 正在编辑（脏）的来源直接跳过——磁盘改写会被编辑器自动保存覆盖。
 */

import { dstu, type DstuNode } from '@/dstu';
import {
  createWikiLinkIndex,
  normalizeWikiLinkTitle,
  parseWikiLinks,
  type WikiLinkNoteReference,
} from '@/features/notes/wikilinks';
import { isContentDirty } from '../content/contentDirtyRegistry';
import { fetchBacklinksFromBackend } from './backlinksBackend';

/** 与背链面板同款的有界扫描预算：重命名回写最多处理这么多来源。 */
export const RENAME_SYNC_SOURCE_LIMIT = 256;

export interface WikilinkRenameSyncRequest {
  noteId: string;
  oldTitle: string;
  newTitle: string;
  /**
   * 已知笔记标题表（用于判定旧标题在重命名前解析到谁）。
   * 调用方须保证 noteId 对应条目仍携带旧标题（重命名前的快照）。
   */
  knownNotes: readonly WikiLinkNoteReference[];
}

export interface WikilinkRenameSyncSummary {
  /** 实际改写并成功写回的来源笔记数 */
  updatedSources: number;
  /** 改写的链接总数 */
  rewrittenLinks: number;
  /** 因有未保存修改而跳过的来源数 */
  skippedDirtySources: number;
  /** 读取或写回失败（含乐观锁冲突）的来源数 */
  failedSources: number;
  /** true = 后端图与客户端搜索都不可用，完全没扫到候选 */
  scanFailed: boolean;
}

export interface RewriteWikiLinkTargetsResult {
  content: string;
  rewritten: number;
}

/**
 * 把 `content` 中按旧标题解析到 `noteId` 的 wikilink 改写为新标题。
 * 只动 `matchedBy === 'title'` 的链接：`[[note_xxx]]` 按 ID 解析、重命名后
 * 依旧有效，不改写。歧义标题（多篇同名）沿用解析器的确定性裁决——只有
 * 当时真正解析到本笔记的链接才改写，避免劫持指向同名他篇的链接。
 */
export function rewriteWikiLinkTargets(
  content: string,
  request: Pick<WikilinkRenameSyncRequest, 'noteId' | 'oldTitle' | 'newTitle' | 'knownNotes'>,
): RewriteWikiLinkTargetsResult {
  const { noteId, oldTitle, newTitle, knownNotes } = request;
  const oldTitleKey = normalizeWikiLinkTitle(oldTitle);
  if (!oldTitleKey || oldTitleKey === normalizeWikiLinkTitle(newTitle)) {
    return { content, rewritten: 0 };
  }
  const index = createWikiLinkIndex(knownNotes);
  const links = parseWikiLinks(content);
  let result = content;
  let rewritten = 0;
  // 从后往前替换，保持未处理链接的偏移量有效
  for (let cursor = links.length - 1; cursor >= 0; cursor -= 1) {
    const link = links[cursor];
    if (normalizeWikiLinkTitle(link.target) !== oldTitleKey) continue;
    const resolution = index.resolve(link.target);
    if (resolution.matchedBy !== 'title' || resolution.noteId !== noteId) continue;
    const heading = link.heading ? `#${link.heading}` : '';
    const alias = link.label !== undefined ? `|${link.label}` : '';
    result = `${result.slice(0, link.start)}[[${newTitle}${heading}${alias}]]${result.slice(link.end)}`;
    rewritten += 1;
  }
  return { content: result, rewritten };
}

/** 与 NotesBacklinksPanel.backlinkSearchQueries 同源的标题候选搜索变体。 */
function renameSearchQueries(oldTitle: string): string[] {
  const target = oldTitle.trim();
  if (!target) return [];
  return [
    `[[${target}]]`,
    `[[${target}|`,
    `[[${target}#`,
    `[[${target} `,
    `[[ ${target}]]`,
    `[[ ${target}|`,
    `[[ ${target}#`,
    `[[ ${target} `,
  ];
}

interface RenameSourceRef {
  id: string;
  path: string;
}

/** 后端图 ∪ 客户端搜索，两路都抛错时返回 null（完全无法扫描）。 */
async function findRenameSources(
  request: WikilinkRenameSyncRequest,
): Promise<RenameSourceRef[] | null> {
  const sourcesById = new Map<string, RenameSourceRef>();
  let backendOk = false;
  let clientOk = false;

  try {
    const rows = await fetchBacklinksFromBackend(request.noteId);
    backendOk = true;
    for (const row of rows) {
      if (!row.sourceId || row.sourceId === request.noteId) continue;
      if (!sourcesById.has(row.sourceId)) {
        sourcesById.set(row.sourceId, { id: row.sourceId, path: `/${row.sourceId}` });
      }
    }
  } catch {
    // 后端命令不可用（VFS 未配置等）：靠客户端搜索兜底
  }

  try {
    const results = await Promise.all(renameSearchQueries(request.oldTitle).map(async (query) => {
      const result = await dstu.search(query, {
        typeFilter: 'note',
        limit: RENAME_SYNC_SOURCE_LIMIT,
      });
      if (!result.ok) throw result.error;
      return result.value;
    }));
    clientOk = true;
    for (const nodes of results) {
      for (const node of nodes) {
        if (node.type !== 'note' || node.id === request.noteId) continue;
        if (!sourcesById.has(node.id)) {
          sourcesById.set(node.id, { id: node.id, path: node.path || `/${node.id}` });
        }
      }
    }
  } catch {
    // 搜索失败：若后端图已成功仍可继续
  }

  if (!backendOk && !clientOk) return null;
  return Array.from(sourcesById.values())
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .slice(0, RENAME_SYNC_SOURCE_LIMIT);
}

/**
 * 重命名成功后调用：扫描并回写引用来源里的按标题链接。
 * 永不抛出；一切失败都折叠进 summary 供宿主决定提示文案。
 */
export async function syncWikiLinksAfterNoteRename(
  request: WikilinkRenameSyncRequest,
): Promise<WikilinkRenameSyncSummary> {
  const summary: WikilinkRenameSyncSummary = {
    updatedSources: 0,
    rewrittenLinks: 0,
    skippedDirtySources: 0,
    failedSources: 0,
    scanFailed: false,
  };
  const oldTitle = request.oldTitle.trim();
  const newTitle = request.newTitle.trim();
  if (!oldTitle || !newTitle || normalizeWikiLinkTitle(oldTitle) === normalizeWikiLinkTitle(newTitle)) {
    return summary;
  }

  const sources = await findRenameSources(request);
  if (sources === null) {
    summary.scanFailed = true;
    return summary;
  }

  for (const source of sources) {
    if (isContentDirty('note', source.id)) {
      summary.skippedDirtySources += 1;
      continue;
    }
    try {
      // 写回基线取自写前的最新节点（乐观锁），并发编辑时后端拒绝覆盖
      const nodeResult = await dstu.get(source.path);
      const node: DstuNode | null = nodeResult.ok ? nodeResult.value : null;
      if (!node) {
        summary.failedSources += 1;
        continue;
      }
      const contentResult = await dstu.getContent(node.path);
      if (!contentResult.ok || typeof contentResult.value !== 'string') {
        summary.failedSources += 1;
        continue;
      }
      const { content, rewritten } = rewriteWikiLinkTargets(contentResult.value, {
        noteId: request.noteId,
        oldTitle,
        newTitle,
        knownNotes: request.knownNotes,
      });
      if (rewritten === 0) continue;
      const updateResult = await dstu.update(node.path, content, 'note', {
        expectedUpdatedAtMs: node.updatedAt,
      });
      if (!updateResult.ok) {
        summary.failedSources += 1;
        continue;
      }
      summary.updatedSources += 1;
      summary.rewrittenLinks += rewritten;
    } catch {
      summary.failedSources += 1;
    }
  }
  return summary;
}
