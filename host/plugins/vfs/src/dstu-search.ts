/** dstu/handler_utils/search_helpers.rs and `dstu_search` / `dstu_search_in_folder`. */
import { CommandError } from '../../../kernel/api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import type { VfsDatabase } from '../api.ts';
import type { DstuListOptions, DstuNode, DstuNodeType } from './dstu-types.ts';
import {
  DstuListOptions as ListOptions,
  dstuNodeTypeFromString,
} from './dstu-types.ts';
import {
  essayToDstuNode,
  examToDstuNode,
  fileToDstuNode,
  mindmapToDstuNode,
  noteToDstuNode,
  sessionToDstuNode,
  textbookToDstuNode,
  translationToDstuNode,
} from './node-converters.ts';
import { getFolderWithConn, listItemsByFolderWithConn } from '../repository/folders.ts';
import {
  getEssaySessionWithConn,
  getExamWithConn,
  getFileWithConn,
  getMindmapWithConn,
  getNoteContentWithConn,
  getNoteWithConn,
  getResourceSourceWithConn,
  getTextbookWithConn,
  getTranslationWithConn,
  listExamsWithConn,
  listNotesWithConn,
  listTranslationsWithConn,
  searchEssaySessionsWithConn,
  searchFilesWithConn,
  searchImagesWithConn,
  searchIndexSegmentsWithConn,
  searchMindmapsWithConn,
  searchTextbooksWithConn,
  type NoteListLog,
} from '../repository/resources.ts';

export interface DstuSearchDeps {
  readonly database: VfsDatabase;
  readonly log?: NoteListLog;
}

function command<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(error instanceof Error ? error.message : String(error));
  }
}

/** `build_snippet` (search_helpers.rs:55-80). */
export function buildSnippet(text: string, query: string, maxLength: number): string | undefined {
  const trimmed = rustTrim(query);
  if (trimmed === '') return undefined;
  const lowerText = text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  if (!lowerText.includes(lowerQuery)) return undefined;
  // Map the lowercase byte offset back to a character index in the original text;
  // lowercasing rarely changes length, mirroring the Rust implementation.
  const charIndex = Array.from(lowerText.slice(0, lowerText.indexOf(lowerQuery))).length;
  const chars = Array.from(text);
  if (chars.length === 0) return undefined;
  const half = Math.floor(maxLength / 2);
  const start = Math.max(0, charIndex - half);
  const end = Math.min(start + maxLength, chars.length);
  let snippet = chars.slice(start, end).join('');
  if (start > 0) snippet = `…${snippet}`;
  if (end < chars.length) snippet = `${snippet}…`;
  return snippet;
}

export function normalizePropFilters(options: DstuListOptions): Array<[string, string]> {
  const filters = options.propFilters;
  if (filters === null || filters === undefined) return [];
  return filters
    .map(filter => {
      const key = typeof filter?.key === 'string' ? rustTrim(filter.key).toLowerCase() : '';
      const value = typeof filter?.value === 'string' ? rustTrim(filter.value).toLowerCase() : '';
      return [key, value] as [string, string];
    })
    .filter(([key]) => key !== '');
}

export function propsMatchFilters(props: unknown, required: Array<[string, string]>): boolean {
  if (required.length === 0) return true;
  if (typeof props !== 'object' || props === null || Array.isArray(props)) return false;
  const byKey = new Map<string, unknown>();
  for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
    byKey.set(rustTrim(key).toLowerCase(), value);
  }
  return required.every(([key, expected]) => {
    if (!byKey.has(key)) return false;
    const actual = byKey.get(key);
    let text: string;
    if (typeof actual === 'string') text = actual;
    else if (typeof actual === 'number' || typeof actual === 'boolean') text = String(actual);
    else return false;
    return text.toLowerCase().includes(expected);
  });
}

function typeFilterOf(options: DstuListOptions): DstuNodeType | undefined {
  const value = options.typeFilter;
  if (value !== null && value !== undefined && typeof value === 'object') {
    const key = Object.keys(value as unknown as Record<string, unknown>)[0];
    return key === undefined ? undefined : dstuNodeTypeFromString(key);
  }
  return typeof value === 'string' ? dstuNodeTypeFromString(value) : undefined;
}

function typesAllow(options: DstuListOptions, type: DstuNodeType): boolean {
  const types = options.types;
  if (types === null || types === undefined) return true;
  return types.some(value => dstuNodeTypeFromString(
    typeof value === 'string' ? value : Object.keys(value as unknown as Record<string, unknown>)[0] ?? '',
  ) === type);
}

function folderItemIds(deps: DstuSearchDeps, folderId: string): Set<string> {
  const conn = deps.database.getConnSafe();
  return new Set(listItemsByFolderWithConn(conn, folderId).map(item => item.itemId));
}

/** `search_notes` (search_helpers.rs:124-244). */
export function searchNotes(
  deps: DstuSearchDeps,
  query: string,
  options: DstuListOptions,
): DstuNode[] {
  if (!typesAllow(options, 'note')) return [];
  const requiredTags = (options.tags ?? [])
    .map(tag => rustTrim(tag).toLowerCase())
    .filter(tag => tag !== '');
  const hasTagFilter = requiredTags.length > 0;
  const requiredProps = normalizePropFilters(options);
  const hasPropFilter = requiredProps.length > 0;
  const folderId = options.folderId ?? undefined;
  const folderIds = folderId === undefined ? undefined : folderItemIds(deps, folderId);
  const hasFolderFilter = folderIds !== undefined;

  const conn = deps.database.getConnSafe();
  const limit = options.getLimit();
  const offset = options.getOffset();
  const results: DstuNode[] = [];

  const pushNote = (noteId: string, iterate: () => DstuNode): void => {
    const node = iterate();
    const content = getNoteContentWithConn(conn, noteId);
    if (content !== undefined) {
      const snippet = buildSnippet(content, query, 160);
      if (snippet !== undefined) {
        const metadata = typeof node.metadata === 'object' && node.metadata !== null
          ? node.metadata as Record<string, unknown>
          : {};
        node.metadata = { ...metadata, snippet };
      }
    }
    results.push(node);
  };

  if (!hasTagFilter && !hasPropFilter && !hasFolderFilter) {
    for (const note of listNotesWithConn(conn, query, limit, offset, deps.log)) {
      pushNote(note.id, () => noteToDstuNode(note));
    }
    return results;
  }

  const pageSize = Math.min(Math.max(limit, 50), 200);
  let skipped = 0;
  let pageOffset = 0;
  let rounds = 0;
  for (;;) {
    const notes = listNotesWithConn(conn, query, pageSize, pageOffset, deps.log);
    if (notes.length === 0) break;
    for (const note of notes) {
      if (folderIds !== undefined && !folderIds.has(note.id)) continue;
      const noteTags = new Set(note.tags.map(tag => rustTrim(tag).toLowerCase()));
      if (!requiredTags.every(tag => noteTags.has(tag))) continue;
      if (!propsMatchFilters(note.props, requiredProps)) continue;
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      pushNote(note.id, () => noteToDstuNode(note));
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
    pageOffset += pageSize;
    rounds += 1;
    if (rounds > 10_000) break;
  }
  return results;
}

function filterTypes(options: DstuListOptions, nodes: DstuNode[]): DstuNode[] {
  return nodes.filter(node => typesAllow(options, node.type));
}

/** `search_all` (search_helpers.rs:892-990). */
export function searchAll(deps: DstuSearchDeps, query: string, options: DstuListOptions): DstuNode[] {
  const conn = deps.database.getConnSafe();
  const folderId = options.folderId ?? undefined;
  const folderIds = folderId === undefined ? undefined : folderItemIds(deps, folderId);
  const requiredProps = normalizePropFilters(options);

  if (requiredProps.length > 0) {
    const filter = typeFilterOf(options);
    if ((filter !== undefined && filter !== 'note') || !typesAllow(options, 'note')) return [];
    return searchNotes(deps, query, options);
  }

  const typeFilter = typeFilterOf(options);
  if (typeFilter !== undefined) {
    let typed: DstuNode[];
    switch (typeFilter) {
      case 'note': typed = searchNotes(deps, query, options); break;
      case 'exam': typed = filterTypes(options, listExamsWithConn(conn, query, options.getLimit(), options.getOffset()).map(examToDstuNode)); break;
      case 'translation': typed = filterTypes(options, listTranslationsWithConn(conn, query, options.getLimit(), options.getOffset()).map(translationToDstuNode)); break;
      case 'textbook': typed = filterTypes(options, searchTextbooksWithConn(conn, query, options.getLimit(), options.getOffset()).map(textbookToDstuNode)); break;
      case 'essay': typed = filterTypes(options, searchEssaySessionsWithConn(conn, query, options.getLimit(), options.getOffset()).map(sessionToDstuNode)); break;
      case 'file': typed = filterTypes(options, searchFilesWithConn(conn, query, options.getLimit(), options.getOffset()).map(fileToDstuNode)); break;
      case 'image': typed = filterTypes(options, searchImagesWithConn(conn, query, options.getLimit(), options.getOffset()).map(fileToDstuNode)); break;
      case 'mindmap': typed = filterTypes(options, searchMindmapsWithConn(conn, query, options.getLimit(), options.getOffset()).map(mindmapToDstuNode)); break;
      default: typed = [];
    }
    return folderIds === undefined ? typed : typed.filter(node => folderIds.has(node.id));
  }

  const results: DstuNode[] = [];
  results.push(...searchNotes(deps, query, options));
  results.push(...filterTypes(options, listExamsWithConn(conn, query, options.getLimit(), options.getOffset()).map(examToDstuNode)));
  results.push(...filterTypes(options, listTranslationsWithConn(conn, query, options.getLimit(), options.getOffset()).map(translationToDstuNode)));
  results.push(...filterTypes(options, searchTextbooksWithConn(conn, query, options.getLimit(), options.getOffset()).map(textbookToDstuNode)));
  results.push(...filterTypes(options, searchEssaySessionsWithConn(conn, query, options.getLimit(), options.getOffset()).map(sessionToDstuNode)));
  results.push(...filterTypes(options, searchFilesWithConn(conn, query, options.getLimit(), options.getOffset()).map(fileToDstuNode)));
  results.push(...filterTypes(options, searchImagesWithConn(conn, query, options.getLimit(), options.getOffset()).map(fileToDstuNode)));
  results.push(...filterTypes(options, searchMindmapsWithConn(conn, query, options.getLimit(), options.getOffset()).map(mindmapToDstuNode)));

  let filtered = folderIds === undefined ? results : results.filter(node => folderIds.has(node.id));

  const existingIds = new Set(filtered.map(node => node.id));
  const indexLimit = Math.max(options.getLimit() - filtered.length, 20);
  let indexResults = searchByIndex(deps, query, indexLimit, existingIds);
  if (folderIds !== undefined) indexResults = indexResults.filter(node => folderIds.has(node.id));
  filtered = filtered.concat(indexResults);

  filtered.sort((left, right) => right.updatedAt - left.updatedAt);
  return filtered;
}

/** `resolve_source_to_node` (search_helpers.rs:789-836). */
function resolveSourceToNode(
  deps: DstuSearchDeps,
  sourceId: string,
  sourceTable: string,
): DstuNode | undefined {
  const conn = deps.database.getConnSafe();
  switch (sourceTable) {
    case 'notes': {
      const note = getNoteWithConn(conn, sourceId);
      return note === undefined ? undefined : noteToDstuNode(note);
    }
    case 'files': {
      const file = getFileWithConn(conn, sourceId);
      return file === undefined ? undefined : fileToDstuNode(file);
    }
    case 'textbooks': {
      const textbook = getTextbookWithConn(conn, sourceId);
      return textbook === undefined ? undefined : textbookToDstuNode(textbook);
    }
    case 'translations': {
      const translation = getTranslationWithConn(conn, sourceId);
      return translation === undefined ? undefined : translationToDstuNode(translation);
    }
    case 'exam_sheets': {
      const exam = getExamWithConn(conn, sourceId);
      return exam === undefined ? undefined : examToDstuNode(exam);
    }
    case 'essay_sessions': {
      const session = getEssaySessionWithConn(conn, sourceId);
      return session === undefined ? undefined : sessionToDstuNode(session);
    }
    case 'mindmaps': {
      const mindmap = getMindmapWithConn(conn, sourceId);
      return mindmap === undefined ? undefined : mindmapToDstuNode(mindmap);
    }
    default:
      return undefined;
  }
}

/** `search_by_index` (search_helpers.rs:701-787). */
export function searchByIndex(
  deps: DstuSearchDeps,
  query: string,
  limit: number,
  existingIds: Set<string>,
): DstuNode[] {
  const conn = deps.database.getConnSafe();
  const hits = searchIndexSegmentsWithConn(conn, query, limit);
  if (hits.length === 0) return [];
  const results: DstuNode[] = [];
  for (const hit of hits) {
    const resource = getResourceSourceWithConn(conn, hit.resourceId);
    if (resource === undefined || resource.sourceId === null || resource.sourceTable === null) continue;
    if (existingIds.has(resource.sourceId)) continue;
    const node = resolveSourceToNode(deps, resource.sourceId, resource.sourceTable);
    if (node === undefined) continue;
    const snippet = buildSnippet(hit.contentText, query, 160);
    if (snippet !== undefined) {
      const metadata = typeof node.metadata === 'object' && node.metadata !== null
        ? node.metadata as Record<string, unknown>
        : {};
      node.metadata = { ...metadata, snippet, matchSource: 'index' };
    }
    results.push(node);
  }
  return results;
}

/** `dstu_search` (handlers.rs:3267-3286). */
export function searchCommand(
  deps: DstuSearchDeps,
  query: string,
  options: DstuListOptions | null | undefined,
): DstuNode[] {
  return command(() => {
    const opts = ListOptions.from(options ?? undefined);
    return searchAll(deps, query, opts).filter(node => !isHidden(node.name));
  });
}

function titleMatches(value: string | null | undefined, queryLower: string): boolean {
  return (value ?? '').toLowerCase().includes(queryLower);
}

/** `dstu_search_in_folder` (handlers.rs:5655-5783). */
export function searchInFolderCommand(
  deps: DstuSearchDeps,
  folderId: string | null | undefined,
  query: string,
  options: DstuListOptions | null | undefined,
): DstuNode[] {
  return command(() => {
    const opts = ListOptions.from(options ?? undefined);
    if (folderId === null || folderId === undefined) return searchCommand(deps, query, opts);

    const conn = deps.database.getConnSafe();
    if (getFolderWithConn(conn, folderId) === undefined) {
      throw new CommandError(`Folder not found: ${folderId}`);
    }
    const items = listItemsByFolderWithConn(conn, folderId);
    const itemIds = new Set(items.map(item => item.itemId));
    const queryLower = query.toLowerCase();
    const results: DstuNode[] = [];

    for (const item of items) {
      let node: DstuNode | undefined;
      switch (item.itemType) {
        case 'note': {
          const note = getNoteWithConn(conn, item.itemId);
          if (note !== undefined && titleMatches(note.title, queryLower)) node = noteToDstuNode(note);
          break;
        }
        case 'textbook': {
          const textbook = getTextbookWithConn(conn, item.itemId);
          if (textbook !== undefined && titleMatches(textbook.fileName, queryLower)) node = textbookToDstuNode(textbook);
          break;
        }
        case 'file': {
          const file = getFileWithConn(conn, item.itemId);
          if (file !== undefined && titleMatches(file.fileName, queryLower)) node = fileToDstuNode(file);
          break;
        }
        case 'translation': {
          const translation = getTranslationWithConn(conn, item.itemId);
          if (translation !== undefined && titleMatches(translation.title, queryLower)) node = translationToDstuNode(translation);
          break;
        }
        case 'exam': {
          const exam = getExamWithConn(conn, item.itemId);
          if (exam !== undefined && titleMatches(exam.examName, queryLower)) node = examToDstuNode(exam);
          break;
        }
        case 'mindmap': {
          const mindmap = getMindmapWithConn(conn, item.itemId);
          if (mindmap !== undefined && titleMatches(mindmap.title, queryLower)) node = mindmapToDstuNode(mindmap);
          break;
        }
        default:
          break;
      }
      if (node === undefined || isHidden(node.name)) continue;
      results.push(node);
    }

    const existingIds = new Set(results.map(node => node.id));
    const indexLimit = opts.limit ?? 50;
    for (const node of searchByIndex(deps, query, indexLimit, existingIds)) {
      if (!itemIds.has(node.id) || isHidden(node.name)) continue;
      results.push(node);
    }

    results.sort((left, right) => right.updatedAt - left.updatedAt);
    return opts.limit === undefined || opts.limit === null
      ? results
      : results.slice(0, opts.limit);
  });
}

function isHidden(name: string): boolean {
  const trimmed = rustTrim(name);
  return utf8ByteLength(trimmed) > 4 && trimmed.startsWith('__') && trimmed.endsWith('__');
}
