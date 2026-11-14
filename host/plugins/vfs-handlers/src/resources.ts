/** vfs/handlers.rs 资源与列表命令（薄层，复用 L10/L11 仓储）。 */
import type { Context } from '@deepseek-ai/cordis';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import { CommandError } from '../../../kernel/api.ts';
import { VfsError } from '../../vfs/portable.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { sanitize_unicode } from '../../../platform/paths/api.ts';
import type {
  EssayRepository,
  ExamRepository,
  ResourceRepository,
  TextbookRepository,
  TranslationRepository,
  VfsCreateResourceResult,
  VfsResourceMetadata,
} from '../../vfs-repos/api.ts';
import type {
  VfsEssay,
  VfsExamSheet,
  VfsListItem,
  VfsResource,
  VfsTextbook,
  VfsTranslation,
} from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import type { VfsNote } from '../../../../contracts/ipc/generated/_shared.ts';

export interface ListInput {
  search?: string | null;
  limit?: number;
  offset?: number;
}

export interface SearchAllInput {
  query: string;
  types?: string[] | null;
  limit?: number;
  offset?: number;
}

export interface CreateResourceInput {
  type: string;
  data: string;
  sourceId?: string | null;
  metadata?: VfsResourceMetadata | null;
}

export interface ResourceDeps {
  readonly conn: () => DatabaseHandle;
  readonly resources: ResourceRepository;
  readonly textbooks: TextbookRepository;
  readonly exams: ExamRepository;
  readonly translations: TranslationRepository;
  readonly essays: EssayRepository;
  readonly log: Context['logger'];
}

/** VfsResourceType::from_str (types.rs:128-142): lowercase comparison. */
export function parseResourceType(value: string): VfsListItem['type'] | undefined {
  switch (value.toLowerCase()) {
    case 'note': return 'note';
    case 'textbook': return 'textbook';
    case 'exam': return 'exam';
    case 'translation': return 'translation';
    case 'essay': return 'essay';
    case 'image': return 'image';
    case 'file': return 'file';
    case 'retrieval': return 'retrieval';
    case 'mindmap': return 'mindmap';
    case 'insight_card':
    case 'insightcard': return 'insightcard';
    default: return undefined;
  }
}

/** handlers.rs:241-254 */
export function getMaxSizeBytes(type: VfsListItem['type']): number {
  switch (type) {
    case 'image': return 50 * 1024 * 1024;
    case 'file': return 200 * 1024 * 1024;
    case 'note': return 50 * 1024 * 1024;
    case 'retrieval': return 10 * 1024 * 1024;
    case 'exam': return 50 * 1024 * 1024;
    case 'textbook': return 50 * 1024 * 1024;
    case 'translation': return 10 * 1024 * 1024;
    case 'essay': return 10 * 1024 * 1024;
    case 'mindmap': return 50 * 1024 * 1024;
    case 'insightcard': return 10 * 1024 * 1024;
  }
}

export function validateFileSize(type: VfsListItem['type'], data: string): void {
  const size = utf8ByteLength(data);
  const max = getMaxSizeBytes(type);
  if (size > max) {
    const maxMb = max / (1024 * 1024);
    const actualMb = size / (1024 * 1024);
    throw new VfsError('InvalidArgument', {
      param: 'data',
      reason: `File too large: ${type === 'insightcard' ? 'insight_card' : type} type max ${maxMb}MB, got ${actualMb.toFixed(2)}MB`,
    });
  }
}

/** handlers.rs:144-165 */
export function validateIdFormat(id: string, prefix: string, paramName: string): void {
  if (sanitize_unicode(id) !== id) {
    throw new VfsError('InvalidArgument', { param: paramName, reason: 'ID contains invalid Unicode characters' });
  }
  if (!id.startsWith(prefix)) {
    throw new VfsError('InvalidArgument', { param: paramName, reason: `Invalid ${paramName} format: ${id}` });
  }
}

function fail(error: unknown): never {
  if (error instanceof CommandError) throw error;
  if (error instanceof VfsError) throw new CommandError(error.toString());
  // Rust signature is Result<_, String>: every repository error surfaces as Display text.
  if (error instanceof Error) throw new CommandError(error.message);
  throw error;
}

export function createOrReuse(deps: ResourceDeps, params: CreateResourceInput): VfsCreateResourceResult {
  const type = parseResourceType(params.type);
  if (type === undefined) {
    return fail(new VfsError('InvalidArgument', {
      param: 'type', reason: `Invalid resource type: ${params.type}`,
    }));
  }
  try {
    validateFileSize(type, params.data);
    deps.log.info('[VFS::handlers] vfs_create_or_reuse: type=%s, data_len=%d, source_id=%s',
      params.type, utf8ByteLength(params.data), params.sourceId ?? null);
    const result = deps.resources.createOrReuse(
      deps.conn(), type, params.data, params.sourceId ?? null, null, params.metadata ?? null,
    );
    deps.log.info('[VFS::handlers] Resource %s: id=%s, hash=%s, is_new=%s',
      result.isNew ? 'created' : 'reused', result.resourceId, result.hash.slice(0, 16), result.isNew);
    return result;
  } catch (error) {
    return fail(error);
  }
}

/** L11 keeps the Rust Display spelling in its union; the wire value is serde lowercase. */
function wireResource(resource: NonNullable<ReturnType<ResourceRepository['getResource']>>): VfsResource {
  const type = (resource.type as string) === 'insight_card' ? 'insightcard' : resource.type as VfsResource['type'];
  return { ...resource, type };
}

export function getResource(deps: ResourceDeps, resourceId: string): VfsResource | null {
  try {
    validateIdFormat(resourceId, 'res_', 'resource_id');
    const resource = deps.resources.getResource(deps.conn(), resourceId);
    return resource === null ? null : wireResource(resource);
  } catch (error) {
    return fail(error);
  }
}

export function resourceExists(deps: ResourceDeps, resourceId: string): boolean {
  if (!resourceId.startsWith('res_')) return false;
  try {
    return deps.resources.exists(deps.conn(), resourceId);
  } catch (error) {
    return fail(error);
  }
}

export function incrementRef(deps: ResourceDeps, resourceId: string): null {
  deps.log.info('[VFS::handlers] vfs_increment_ref: id=%s', resourceId);
  try {
    validateIdFormat(resourceId, 'res_', 'resource_id');
    deps.resources.incrementRef(deps.conn(), resourceId);
    return null;
  } catch (error) {
    return fail(error);
  }
}

export function decrementRef(deps: ResourceDeps, resourceId: string): null {
  deps.log.info('[VFS::handlers] vfs_decrement_ref: id=%s', resourceId);
  try {
    validateIdFormat(resourceId, 'res_', 'resource_id');
    deps.resources.decrementRef(deps.conn(), resourceId);
    return null;
  } catch (error) {
    return fail(error);
  }
}

function normalizeList(params: ListInput | null): { search: string | null; limit: number; offset: number } {
  return {
    search: params?.search ?? null,
    limit: params?.limit ?? 50,
    offset: params?.offset ?? 0,
  };
}

export function listTextbooks(deps: ResourceDeps, params: ListInput | null): VfsTextbook[] {
  const { search, limit, offset } = normalizeList(params);
  try {
    const trimmed = rustTrim(search ?? '');
    return trimmed === ''
      ? deps.textbooks.listTextbooks(deps.conn(), limit, offset)
      : deps.textbooks.searchTextbooks(deps.conn(), trimmed, limit, offset);
  } catch (error) {
    return fail(error);
  }
}

export function listExamSheets(deps: ResourceDeps, params: ListInput | null): VfsExamSheet[] {
  const { search, limit, offset } = normalizeList(params);
  try {
    return deps.exams.listExamSheets(deps.conn(), search, limit, offset);
  } catch (error) {
    return fail(error);
  }
}

export function listTranslations(deps: ResourceDeps, params: ListInput | null): VfsTranslation[] {
  const { search, limit, offset } = normalizeList(params);
  try {
    return deps.translations.listTranslations(deps.conn(), search, limit, offset);
  } catch (error) {
    return fail(error);
  }
}

export function listEssays(deps: ResourceDeps, params: ListInput | null): VfsEssay[] {
  const { search, limit, offset } = normalizeList(params);
  try {
    return deps.essays.listEssays(deps.conn(), search, limit, offset);
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:1017-1021 */
export function parseTimestamp(value: string): number {
  return parseRfc3339(value)?.millis ?? 0;
}

export interface SearchAllDeps extends ResourceDeps {
  readonly listNotes: (search: string, limit: number, offset: number) => VfsNote[];
}

/** handlers.rs:811-1014 */
export function searchAll(deps: SearchAllDeps, params: SearchAllInput): VfsListItem[] {
  if (rustTrim(params.query) === '') {
    return fail(new VfsError('InvalidArgument', {
      param: 'query', reason: 'Search query cannot be empty',
    }));
  }
  const types = params.types ?? null;
  const searchLimit = Math.min(params.limit ?? 50, 50);
  const enabled = (name: string) => types === null || types.some(entry => entry === name);
  const results: VfsListItem[] = [];

  const searchType = <T>(name: string, run: () => T[]): T[] | null => {
    if (!enabled(name)) return null;
    try {
      return run();
    } catch (error) {
      deps.log.warn("[VFS::handlers] %s search failed for query '%s': %s", name, params.query, error);
      return null;
    }
  };

  const notes = searchType('note', () => deps.listNotes(params.query, searchLimit, 0));
  if (notes !== null) {
    for (const note of notes) {
      results.push({
        id: note.id,
        resourceId: note.resourceId,
        type: 'note',
        title: note.title,
        previewType: 'markdown',
        createdAt: parseTimestamp(note.createdAt),
        updatedAt: parseTimestamp(note.updatedAt),
      });
    }
  }
  const exams = searchType('exam', () => deps.exams.searchExamSheets(deps.conn(), params.query, searchLimit));
  if (exams !== null) {
    for (const exam of exams) {
      results.push({
        id: exam.id,
        resourceId: exam.resourceId ?? '',
        type: 'exam',
        title: exam.examName ?? '未命名题目集',
        previewType: 'card',
        createdAt: parseTimestamp(exam.createdAt),
        updatedAt: parseTimestamp(exam.updatedAt),
      });
    }
  }
  const translations = searchType('translation', () => deps.translations.searchTranslations(deps.conn(), params.query, searchLimit));
  if (translations !== null) {
    for (const translation of translations) {
      results.push({
        id: translation.id,
        resourceId: translation.resourceId,
        type: 'translation',
        title: `翻译 (${translation.srcLang}→${translation.tgtLang})`,
        previewType: 'card',
        createdAt: parseTimestamp(translation.createdAt),
      });
    }
  }
  const essays = searchType('essay', () => deps.essays.searchEssays(deps.conn(), params.query, searchLimit));
  if (essays !== null) {
    for (const essay of essays) {
      results.push({
        id: essay.id,
        resourceId: essay.resourceId,
        type: 'essay',
        title: essay.title ?? '未命名作文',
        previewType: 'markdown',
        createdAt: parseTimestamp(essay.createdAt),
        updatedAt: parseTimestamp(essay.updatedAt),
      });
    }
  }

  results.sort((left, right) => {
    const leftTime = left.updatedAt ?? left.createdAt;
    const rightTime = right.updatedAt ?? right.createdAt;
    return rightTime - leftTime;
  });

  const offset = params.offset ?? 0;
  const paged = offset >= results.length ? [] : results.slice(offset);
  return paged.slice(0, params.limit ?? 50);
}

export type { VfsNote };
