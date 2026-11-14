/** builtin_resource_executor.rs:1677-2041. */
import type { Context } from '@deepseek-ai/cordis';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { DstuListOptions } from '../dstu-types.ts';
import { searchAll } from '../dstu-search.ts';
import { getContentByType } from '../dstu-content.ts';
import { inferTypeFromId } from './resource-read-helpers.ts';
import { resolveReadTarget } from './resource-read.ts';
import { parseResourceType } from './resource-list.ts';
import { toolVfsDatabase, toolVfsRepos } from './tool-services.ts';
import type { VfsFolder } from '../../../vfs-repos/api.ts';
import type { ReadResourceType } from './resource-read-helpers.ts';
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);

function stepScalarsBackward(text: string, fromOffset: number, count: number): number {
  let offset = Math.min(fromOffset, text.length);
  for (let i = 0; i < count && offset > 0; i += 1) {
    const low = text.charCodeAt(offset - 1);
    if (low >= 0xdc00 && low <= 0xdfff && offset >= 2) {
      const high = text.charCodeAt(offset - 2);
      if (high >= 0xd800 && high <= 0xdbff) {
        offset -= 2;
        continue;
      }
    }
    offset -= 1;
  }
  return offset;
}

function stepScalarsForward(text: string, fromOffset: number, count: number): number {
  let offset = Math.max(0, fromOffset);
  for (let i = 0; i < count && offset < text.length; i += 1) {
    const code = text.codePointAt(offset);
    offset += code !== undefined && code > 0xffff ? 2 : 1;
  }
  return offset;
}

function countScalars(text: string): number {
  let count = 0;
  for (let offset = 0; offset < text.length; ) {
    const code = text.codePointAt(offset);
    offset += code !== undefined && code > 0xffff ? 2 : 1;
    count += 1;
  }
  return count;
}

function formatSnippet(content: string, query: string): string {
  const lowerQuery = query.toLowerCase();
  const lowerContent = content.toLowerCase();
  const index = lowerContent.indexOf(lowerQuery);
  if (index >= 0) {
    const clampedIndex = Math.min(index, content.length);
    const startOffset = stepScalarsBackward(content, clampedIndex, 100);
    const endOffset = stepScalarsForward(content, clampedIndex, countScalars(lowerQuery) + 100);
    return `${startOffset > 0 ? '...' : ''}${rustTrim(content.slice(startOffset, endOffset))}${endOffset < content.length ? '...' : ''}`;
  }
  const endOffset = stepScalarsForward(content, 0, 200);
  const snippet = content.slice(0, endOffset);
  return endOffset < content.length ? `${rustTrim(snippet)}...` : snippet;
}

function resolveSnippetTarget(ctx: Context, id: string, sourceIdHint?: string): { type: ReadResourceType; readId: string } | null {
  const directType = inferTypeFromId(id);
  if (directType !== null) return { type: directType, readId: id };
  if (!id.startsWith('res_')) {
    ctx.logger.debug('[BuiltinResourceExecutor] resource_search snippet skipped: unsupported id=%s', id);
    return null;
  }
  if (sourceIdHint !== undefined && sourceIdHint !== '') {
    const hintedType = inferTypeFromId(sourceIdHint);
    if (hintedType !== null) return { type: hintedType, readId: sourceIdHint };
  }
  try {
    const target = resolveReadTarget(ctx, id);
    return { type: target.resourceType, readId: target.readId };
  } catch (error) {
    ctx.logger.debug('[BuiltinResourceExecutor] resource_search snippet skipped: id=%s reason=%s', id, detail(error));
    return null;
  }
}

export function searchSnippet(ctx: Context, id: string, query: string, sourceIdHint?: string): string | null {
  const target = resolveSnippetTarget(ctx, id, sourceIdHint);
  if (target === null) return null;
  let content: string;
  try { content = getContentByType({ database: toolVfsDatabase(ctx) }, target.type, target.readId); }
  catch (error) { ctx.logger.debug('[BuiltinResourceExecutor] resource_search snippet read failed: id=%s, resolved_id=%s, error=%s', id, target.readId, detail(error)); return null; }
  return formatSnippet(content, query);
}

export function executeResourceSearch(ctx: Context, args: Record<string, unknown>): Record<string, unknown> {
  if (!ctx.get('vfsDatabase')) throw new Error('VFS database not available');
  if (typeof args.query !== 'string') throw new Error('Missing \'query\' parameter. 请提供搜索关键词，例如 resource_search(query="关键词")。');
  const query = args.query, types = Array.isArray(args.types) ? args.types.filter((t): t is string => typeof t === 'string') : null;
  const folder = typeof args.folder_id === 'string' ? args.folder_id : null;
  const limit = typeof args.top_k === 'number' && Number.isInteger(args.top_k) && args.top_k >= 0 && args.top_k < 2 ** 64 ? args.top_k : 10;
  const topK = Math.min(50, Math.max(1, limit));
  ctx.logger.debug('[BuiltinResourceExecutor] resource_search: query=%s, types=%o, folder_id=%s, top_k=%d', query, types, folder, topK);
  const start = performance.now(), parsed = (types ?? []).flatMap(type => { const value = parseResourceType(type); return value === null ? [] : [value]; });
  const options = DstuListOptions.from({ folderId: folder ?? undefined, types: parsed.length === 0 ? undefined : parsed, limit: topK,
    sortBy: 'updatedAt', sortOrder: 'desc', search: query });
  const nodes = searchAll({ database: toolVfsDatabase(ctx), log: ctx.logger }, query, options);
  const durationMs = Math.floor(performance.now() - start);
  const snippetCache = new Map<string, string | null>();
  const items = nodes.map(node => {
    const compatible = ['file', 'image', 'textbook'].includes(node.type);
    let snippet = snippetCache.get(node.id);
    if (snippet === undefined && !snippetCache.has(node.id)) {
      snippet = searchSnippet(ctx, node.id, query, node.sourceId);
      snippetCache.set(node.id, snippet);
    }
    return {
      id: node.id, name: node.name, type: node.type, path: node.path, updatedAt: node.updatedAt, snippet: snippet ?? null,
      chatankiCompatible: compatible, chatankiTargetId: compatible ? node.id : null,
    };
  });
  ctx.logger.debug('[BuiltinResourceExecutor] resource_search completed: %d results in %dms', items.length, durationMs);
  return { success: true, query, items, count: items.length, durationMs };
}

function batchFolderItemCounts(ctx: Context, folderIds: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (folderIds.length === 0) return counts;
  const conn = toolVfsDatabase(ctx).getConnSafe();
  const foldersRepo = toolVfsRepos(ctx).folders;
  try {
    for (const item of foldersRepo.getItemsByFolders(conn, folderIds)) {
      if (item.folderId !== undefined) {
        counts.set(item.folderId, (counts.get(item.folderId) ?? 0) + 1);
      }
    }
    return counts;
  } catch (error) {
    ctx.logger.warn('[BuiltinResourceExecutor] Batch folder item count failed, falling back per folder: %s', detail(error));
  }
  for (const id of folderIds) {
    try { counts.set(id, foldersRepo.listItemsByFolder(conn, id).length); }
    catch (itemError) {
      ctx.logger.warn('[BuiltinResourceExecutor] Failed to count items in folder %s: %s', id, detail(itemError));
      counts.set(id, 0);
    }
  }
  return counts;
}

function collectFolderIds(childrenByParent: Map<string | null, VfsFolder[]>, parent: string | null, recursive: boolean, depth: number, out: string[]): void {
  if (recursive && depth > 50) return;
  for (const folder of childrenByParent.get(parent) ?? []) {
    out.push(folder.id);
    if (recursive) collectFolderIds(childrenByParent, folder.id, true, depth + 1, out);
  }
}

function buildFolderTree(
  ctx: Context,
  childrenByParent: Map<string | null, VfsFolder[]>,
  parent: string | null,
  count: boolean,
  recursive: boolean,
  depth: number,
  countsByFolder: Map<string, number>,
): Record<string, unknown>[] {
  if (recursive && depth > 50) { ctx.logger.warn('[BuiltinResourceExecutor] Folder depth exceeds limit (%d), stopping recursion', 50); return []; }
  const folders = childrenByParent.get(parent) ?? [];
  return folders.map(folder => {
    const result: Record<string, unknown> = { id: folder.id, name: folder.title, parent_id: folder.parentId ?? null, created_at: folder.createdAt, updated_at: folder.updatedAt };
    if (count) result.resource_count = countsByFolder.get(folder.id) ?? 0;
    if (recursive) {
      const children = buildFolderTree(ctx, childrenByParent, folder.id, count, true, depth + 1, countsByFolder);
      if (children.length > 0) result.children = children;
    }
    return result;
  });
}

function listFolders(ctx: Context, parent: string | null, count: boolean, recursive: boolean): Record<string, unknown>[] {
  const conn = toolVfsDatabase(ctx).getConnSafe();
  const foldersRepo = toolVfsRepos(ctx).folders;
  const childrenByParent = new Map<string | null, VfsFolder[]>();
  try {
    if (recursive) {
      for (const folder of foldersRepo.listAllFolders(conn)) {
        const key = folder.parentId ?? null;
        const list = childrenByParent.get(key);
        if (list !== undefined) list.push(folder);
        else childrenByParent.set(key, [folder]);
      }
    } else {
      childrenByParent.set(parent, foldersRepo.listFoldersByParent(conn, parent));
    }
  } catch (error) {
    throw new Error(`Failed to list folders: ${detail(error)}`);
  }
  let countsByFolder = new Map<string, number>();
  if (count) {
    const ids: string[] = [];
    collectFolderIds(childrenByParent, parent, recursive, 0, ids);
    countsByFolder = batchFolderItemCounts(ctx, ids);
  }
  return buildFolderTree(ctx, childrenByParent, parent, count, recursive, 0, countsByFolder);
}

export function executeFolderList(ctx: Context, args: Record<string, unknown>): Record<string, unknown> {
  if (!ctx.get('vfsDatabase')) throw new Error('VFS database not available');
  const parent = typeof args.parent_id === 'string' && args.parent_id !== 'root' && args.parent_id !== '' ? args.parent_id : null;
  const includeCount = typeof args.include_count === 'boolean' ? args.include_count : true, recursive = args.recursive === true;
  ctx.logger.debug('[BuiltinResourceExecutor] folder_list: parent_id=%s, include_count=%s, recursive=%s', parent, includeCount, recursive);
  const start = performance.now(), folders = listFolders(ctx, parent, includeCount, recursive), durationMs = Math.floor(performance.now() - start);
  ctx.logger.debug('[BuiltinResourceExecutor] folder_list completed: %d folders in %dms', folders.length, durationMs);
  return { success: true, parent_id: parent ?? 'root', folders, count: folders.length, recursive, durationMs };
}
