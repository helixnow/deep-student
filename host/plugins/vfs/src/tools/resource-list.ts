/** builtin_resource_executor.rs:123-135,547-1100. */
import type { Context } from '@deepseek-ai/cordis';
import { DstuListOptions, type DstuNode, type DstuNodeType } from '../dstu-types.ts';
import { noteToDstuNode, textbookToDstuNode, examToDstuNode, essayToDstuNode,
  sessionToDstuNode, translationToDstuNode, fileToDstuNode, mindmapToDstuNode } from '../node-converters.ts';
import { searchAll } from '../dstu-search.ts';
import { toolNotes, toolVfsDatabase, toolVfsRepos } from './tool-services.ts';

export function parseResourceType(type: string): DstuNodeType | null {
  switch (type) {
    case 'note': case 'notes': return 'note';
    case 'textbook': case 'textbooks': return 'textbook';
    case 'exam': case 'exams': return 'exam';
    case 'essay': case 'essays': return 'essay';
    case 'translation': case 'translations': return 'translation';
    case 'image': case 'images': return 'image';
    case 'file': case 'files': return 'file';
    case 'mindmap': case 'mindmaps': return 'mindmap';
    default: return null;
  }
}
const SENSITIVE = ['score', 'gradingResult', 'grading_result', 'latestScore', 'latest_score', 'gradeLevel', 'grade_level'];
export function sanitizeEssayNodesForList(nodes: DstuNode[], log: Context['logger']): void {
  for (const node of nodes) {
    if (node.type !== 'essay' || typeof node.metadata !== 'object' || node.metadata === null || Array.isArray(node.metadata)) continue;
    const metadata = node.metadata as Record<string, unknown>, removed: string[] = [];
    for (const key of SENSITIVE) if (Object.hasOwn(metadata, key)) { delete metadata[key]; removed.push(key); }
    if (removed.length > 0) log.debug('[BuiltinResourceExecutor] M-062: sanitized essay node %s, removed fields: %o', node.id, removed);
  }
}
function listOneType(ctx: Context, type: DstuNodeType, folder: string | null, limit: number, offset: number, all: boolean): DstuNode[] {
  const conn = toolVfsDatabase(ctx).getConnSafe(), repos = toolVfsRepos(ctx), scoped = folder !== null && folder !== 'root';
  switch (type) {
    case 'note': {
      const notes = toolNotes(ctx).repository;
      return (scoped ? notes.listNotesByFolder(folder, limit, offset, conn) : notes.listNotes(null, limit, offset, conn)).map(noteToDstuNode);
    }
    case 'textbook': return (scoped ? repos.textbooks.listTextbooksByFolder(conn, folder, limit, offset) : repos.textbooks.listTextbooks(conn, limit, offset)).map(textbookToDstuNode);
    case 'exam': return (scoped ? repos.exams.listExamSheetsByFolder(conn, folder, limit, offset) : repos.exams.listExamSheets(conn, null, limit, offset)).map(examToDstuNode);
    case 'essay': {
      if (scoped) return repos.essays.listEssaysByFolder(conn, folder, limit, offset).map(essayToDstuNode);
      return repos.essays.listSessions(conn, limit, offset).map(session => sessionToDstuNode({ id: session.id, title: session.title,
        essayType: session.essay_type, gradeLevel: session.grade_level, customPrompt: session.custom_prompt, totalRounds: session.total_rounds,
        latestScore: session.latest_score, isFavorite: session.is_favorite, createdAt: session.created_at, updatedAt: session.updated_at, deletedAt: session.deleted_at }));
    }
    case 'translation': return (scoped ? repos.translations.listTranslationsByFolder(conn, folder, limit, offset) : repos.translations.listTranslations(conn, null, limit, offset)).map(translationToDstuNode);
    case 'file': {
      const files = scoped ? repos.files.listFilesByFolder(conn, folder, limit, offset) : repos.files.listFilesByType(conn, 'document', limit, offset);
      return (all && scoped ? files.filter(file => file.fileType !== 'image') : files).map(fileToDstuNode);
    }
    case 'image': {
      const files = scoped ? repos.files.listFilesByFolder(conn, folder, limit, offset).filter(file => file.fileType === 'image') : repos.files.listFilesByType(conn, 'image', limit, offset);
      return files.map(fileToDstuNode);
    }
    case 'mindmap': return (scoped ? repos.mindmaps.listMindmapsByFolder(conn, folder, limit, offset) : repos.mindmaps.listMindmaps(conn).slice(0, limit)).map(mindmapToDstuNode);
    default: throw new Error(`Unsupported resource list type: ${type}`);
  }
}
export function listResourcesByToolType(ctx: Context, type: string, options: DstuListOptions): [DstuNode[], string[]] {
  const limit = options.limit ?? 20, offset = options.offset ?? 0, favorite = options.isFavorite ?? false, folder = options.folderId ?? null;
  let nodes: DstuNode[] = [];
  const errors: string[] = [];
  if (type === 'all') {
    const perType = Math.max(Math.floor(limit / 8), 5);
    for (const [kind, label] of [['note', 'notes'], ['textbook', 'textbooks'], ['exam', 'exams'], ['essay', 'essays'],
      ['translation', 'translations'], ['file', 'files'], ['image', 'images'], ['mindmap', 'mindmaps']] as const) {
      try { nodes.push(...listOneType(ctx, kind, folder, perType, 0, true)); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const logLabel = kind === 'essay' && (folder === null || folder === 'root') ? 'essays/sessions' : label;
        ctx.logger.warn(`[BuiltinResourceExecutor] all: ${logLabel} query failed: %s`, message);
        errors.push(`${label}: ${message}`);
      }
    }
    nodes.sort((a, b) => b.updatedAt - a.updatedAt); nodes = nodes.slice(0, limit);
  } else {
    const parsed = parseResourceType(type);
    if (parsed === null) throw new Error(`不支持的资源类型: '${type}', 有效类型: note, textbook, exam, essay, translation, image, file, mindmap, all`);
    nodes = listOneType(ctx, parsed, folder, limit, offset, false);
  }
  if (favorite) {
    nodes = nodes.filter(node => node.metadata !== null && typeof node.metadata === 'object' && !Array.isArray(node.metadata)
      && (node.metadata as Record<string, unknown>).isFavorite === true);
    ctx.logger.debug('[BuiltinResourceExecutor] Filtered to %d favorites', nodes.length);
  }
  return [nodes, errors];
}
export function executeResourceList(ctx: Context, args: Record<string, unknown>): Record<string, unknown> {
  if (!ctx.get('vfsDatabase')) throw new Error('VFS database not available');
  const type = typeof args.type === 'string' ? args.type : 'all', folder = typeof args.folder_id === 'string' ? args.folder_id : null;
  const search = typeof args.search === 'string' ? args.search : null;
  const rawLimit = typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit >= 0 && args.limit < 2 ** 64 ? args.limit : 20;
  const limit = Math.min(100, Math.max(1, rawLimit)), favorite = args.favorites_only === true;
  ctx.logger.debug('[BuiltinResourceExecutor] resource_list: type=%s, folder_id=%s, search=%s, limit=%d, favorites_only=%s', type, folder, search, limit, favorite);
  const start = performance.now(), parsed = type === 'all' ? null : parseResourceType(type);
  const options = DstuListOptions.from({ folderId: folder ?? 'root', types: parsed === null ? undefined : [parsed],
    isFavorite: favorite ? true : undefined, limit, sortBy: 'updatedAt', sortOrder: 'desc', search: search ?? undefined });
  const [results, errors]: [DstuNode[], string[]] = search !== null
    ? [searchAll({ database: toolVfsDatabase(ctx), log: ctx.logger }, search, options), []] : listResourcesByToolType(ctx, type, options);
  sanitizeEssayNodesForList(results, ctx.logger);
  const durationMs = Math.floor(performance.now() - start);
  const items = results.map(node => ({ id: node.id, name: node.name, type: node.type, path: node.path, updatedAt: node.updatedAt, size: node.size ?? null,
    isFavorite: typeof node.metadata === 'object' && node.metadata !== null && !Array.isArray(node.metadata) && (node.metadata as Record<string, unknown>).isFavorite === true }));
  ctx.logger.debug('[BuiltinResourceExecutor] resource_list completed: %d items, %d partial_errors in %dms', items.length, errors.length, durationMs);
  return { success: true, items, count: items.length, durationMs, ...(errors.length === 0 ? {} : { partial_errors: errors, partial_success: true }) };
}
