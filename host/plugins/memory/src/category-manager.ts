/** Rust `dstu-memory/src/memory/category_manager.rs`: key/tag codec and `refresh_all_categories`. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { MemoryDecisionCompletion, MemoryListItem } from '../api.ts';
import type { MemoryVfsDependencies } from '../repository/vfs.ts';
import {
  createNote, deleteNoteWithFolderItem, findNoteByTitle, getNoteContent, markDisabled, updateNote,
} from '../repository/vfs.ts';
import type { EvolutionLogger } from './evolution-cycle.ts';
import { errorText } from './memory-utils.ts';

const CATEGORY_NOTE_PREFIX = '__cat_';
const CATEGORY_NOTE_SUFFIX = '__';
const MEMBER_TAG_PREFIX = '_member:';

export function categoryNoteTitle(categoryKey: string): string {
  return `${CATEGORY_NOTE_PREFIX}${categoryKey}${CATEGORY_NOTE_SUFFIX}`;
}

/** Rust `urlencoding::encode`: only ALPHA / DIGIT / `-._~` stay literal, space becomes `%20`. */
function urlEncode(value: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(value)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch) && byte < 0x80) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}
/** Rust `urlencoding::decode`: `%XX` sequences, `+` untouched, invalid UTF-8 becomes an error. */
function urlDecode(value: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '%') {
      const hex = value.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      for (const byte of new TextEncoder().encode(ch)) bytes.push(byte);
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

export function encodeCategoryKey(categoryName: string, folderPath: string): string {
  if (folderPath.length === 0) return categoryName;
  return `path:${urlEncode(folderPath)}`;
}

export function decodeCategoryKey(categoryKey: string): string {
  const decoded = categoryKey.startsWith('path:')
    ? urlDecode(categoryKey.slice('path:'.length)) ?? categoryKey.slice('path:'.length)
    : categoryKey.replace(/／/g, '/');
  return decoded;
}

export function buildCategoryNoteTags(memberIds: readonly string[]): string[] {
  return ['_system', ...memberIds.map(id => `${MEMBER_TAG_PREFIX}${id}`)];
}

export function extractMemberIds(tags: readonly string[]): string[] {
  return tags.filter(tag => tag.startsWith(MEMBER_TAG_PREFIX)).map(tag => tag.slice(MEMBER_TAG_PREFIX.length));
}

const SEED_CATEGORIES: ReadonlyArray<readonly [string, string]> = [
  ['偏好', '偏好'],
  ['个人背景', '偏好/个人背景'],
  ['学科状态', '经历/学科状态'],
  ['时间节点', '经历/时间节点'],
  ['经历与计划', '经历'],
];

export interface CategoryRefreshHost {
  readonly db: SqlExecutor;
  readonly deps: MemoryVfsDependencies;
  getTree(): Record<string, unknown> | null;
  listShallow(folderPath: string, limit: number, offset: number): MemoryListItem[];
  systemFolderId(): string;
  /** Throws when no memory-decision model is available; Rust fails the same way at call time. */
  completion(): MemoryDecisionCompletion;
  log: EvolutionLogger;
}

interface FolderTreeNode {
  folder: { title: string };
  children: FolderTreeNode[];
}

/** Rust `MemoryCategoryManager::refresh_all_categories`: seed categories plus every non-system folder path. */
export async function refreshAllCategories(host: CategoryRefreshHost): Promise<void> {
  const categories: Array<[string, string]> = SEED_CATEGORIES.map(([name, path]) => [name, path]);
  let tree: Record<string, unknown> | null = null;
  try { tree = host.getTree(); } catch { /* boundary-allow empty-catch: Rust `if let Ok(Some(tree))` 读树失败只用种子分类且无日志 */ }
  if (tree !== null) collectFolderCategories((tree as unknown as FolderTreeNode).children, '', categories);

  const seenPaths = new Set<string>();
  for (const [name, folderPath] of categories) {
    if (seenPaths.has(folderPath)) continue;
    seenPaths.add(folderPath);
    try {
      await refreshCategory(host, name, folderPath);
    } catch (error) {
      host.log.warn(`[CategoryManager] Failed to refresh category '${name}': ${errorText(error)}`);
    }
  }
}

function collectFolderCategories(children: readonly FolderTreeNode[], parentPath: string,
  out: Array<[string, string]>): void {
  for (const child of children) {
    const title = child.folder.title;
    if (title.startsWith('__')) continue;
    const path = parentPath === '' ? title : `${parentPath}/${title}`;
    if (!out.some(([, existing]) => existing === path)) out.push([title, path]);
    if (child.children.length > 0) collectFolderCategories(child.children, path, out);
  }
}

/** Rust `refresh_category`: summarize up to 50 live members, or delete the summary of an empty category. */
async function refreshCategory(host: CategoryRefreshHost, categoryName: string, folderPath: string): Promise<void> {
  const memories = host.listShallow(folderPath, 50, 0)
    .filter(memory => !memory.title.startsWith('__') && !memory.isStale && !memory.isArchived);
  const title = categoryNoteTitle(encodeCategoryKey(categoryName, folderPath));

  if (memories.length === 0) {
    host.log.debug(`[CategoryManager] No memories in '${folderPath}', deleting stale category file if exists`);
    const existing = findNoteByTitle(host.db, host.systemFolderId(), title);
    if (existing !== undefined) {
      deleteNoteWithFolderItem(host.deps, host.db, existing.id);
      host.log.debug(`[CategoryManager] Deleted empty category note: ${title}`);
    }
    return;
  }

  const contents: string[] = [];
  for (const memory of memories) {
    if (memory.memoryType === 'note') { contents.push(`[经验笔记] ${memory.title}`); continue; }
    if (memory.memoryType === 'study') { contents.push(`[学习记忆] ${memory.title}`); continue; }
    const content = getNoteContent(host.deps, host.db, memory.id);
    contents.push(content === '' ? memory.title : content);
  }

  const summary = await generateCategorySummary(host, categoryName, contents);
  const systemFolderId = host.systemFolderId();
  const tags = buildCategoryNoteTags(memories.map(memory => memory.id));
  const existing = findNoteByTitle(host.db, systemFolderId, title);
  if (existing !== undefined) {
    const updated = updateNote(host.deps, host.db, existing.id, { content: summary, tags });
    try { markDisabled(host.deps, host.db, updated.resourceId, 'system category note'); }
    catch (error) {
      host.log.warn(`[CategoryManager] Failed to disable indexing for category note update: ${errorText(error)}`);
    }
    host.log.debug(`[CategoryManager] Updated category note: ${title}`);
  } else {
    const note = createNote(host.deps, host.db, { title, content: summary, tags }, systemFolderId);
    try { markDisabled(host.deps, host.db, note.resourceId, 'system category note'); }
    catch (error) {
      host.log.warn(`[CategoryManager] Failed to disable indexing for category note: ${errorText(error)}`);
    }
    host.log.debug(`[CategoryManager] Created category note: ${title}`);
  }
  host.log.info(`[CategoryManager] Refreshed category '${categoryName}' with ${memories.length} memories`);
}

/** Rust `generate_category_summary` (exact prompt; the model output is stored verbatim). */
async function generateCategorySummary(host: CategoryRefreshHost, categoryName: string,
  memoryContents: readonly string[]): Promise<string> {
  const factsList = memoryContents.map((content, i) => `${i + 1}. ${content}`).join('\n');
  const prompt = `你是一个用户画像聚合器。请将以下关于用户的原子事实聚合为**结构化的分类摘要**。

## 分类: ${categoryName}

## 原子事实列表
${factsList}

## 要求
1. 生成 Markdown 格式的结构化摘要
2. 合并相关事实，消除冗余
3. 如果事实之间有矛盾，以编号较大（较新）的为准
4. 保持简洁，每条不超过一行
5. 不要添加原子事实中没有的信息

## 输出格式
直接输出 Markdown 内容，不要包裹代码块。`;
  try {
    return (await host.completion().callMemoryDecisionRawPrompt(prompt)).assistant_message;
  } catch (error) {
    throw new Error(`Category summary LLM call failed: ${errorText(error)}`, { cause: error });
  }
}
