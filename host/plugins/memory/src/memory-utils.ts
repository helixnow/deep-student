/** Pure tag/path/validation helpers shared by the memory stores. */
import type { Context } from '@deepseek-ai/cordis';
import type { MemoryPurpose, MemoryType } from '../api.ts';
import type { AuditEntryInput } from '../repository/audit.ts';
import type { VfsFolder, VfsFolderItem, VfsNote } from '../repository/vfs.ts';

export const TAG_TYPE_PREFIX = '_type:';
export const TAG_PURPOSE_PREFIX = '_purpose:';
export const TAG_HITS_PREFIX = '_hits:';
export const TAG_REF_PREFIX = '_ref:';
export const TAG_LAST_HIT_PREFIX = '_last_hit:';
export const TAG_LAST_INJECTED_PREFIX = '_last_injected:';
export const TAG_ARCHIVED = '_archived';
export const TAG_STALE = '_stale';
export const TAG_NEEDS_DEDUP_REVIEW = '_needs_dedup_review';
export const TAG_IMPORTANT = '_important';
export const TAG_DAILY_LOG = 'daily_log';
export const TAG_DAILY_LOG_DATE_PREFIX = '_daily_log_date:';
export const SYSTEM_FOLDER_TITLE = '__system__';
export const PROFILE_NOTE_TITLE = '__user_profile__';
export const RESERVED_SYSTEM_PREFIX = '__';
export const MAX_BATCH_ITEMS = 200;
export const DAILY_LOG_CAS_MAX_RETRIES = 32;
export const TIME_DECAY_HALF_LIFE_DAYS = 60.0;
export const LOG_TARGET = 'dstu_memory::memory';
export const CONTENT_LIMITS: Record<MemoryType, number> = { fact: 200, study: 4000, note: 2000 };

export function parseMemoryType(value: string | null | undefined): MemoryType {
  if (value === null || value === undefined) return 'fact';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'fact') return 'fact';
  if (normalized === 'study') return 'study';
  if (normalized === 'note') return 'note';
  throw new Error(`Invalid memory_type '${normalized}', expected one of: fact, study, note`);
}

export function parseMemoryPurpose(value: string | null | undefined): MemoryPurpose | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'internalized' || normalized === 'memorized'
    || normalized === 'supplementary' || normalized === 'systemic') return normalized;
  throw new Error(`Invalid memory_purpose '${normalized}', expected one of: internalized, memorized, supplementary, systemic`);
}

export function memoryTypeFromTags(tags: readonly string[]): MemoryType {
  const tag = tags.find(item => item.startsWith(TAG_TYPE_PREFIX));
  return tag === undefined ? 'fact' : parseMemoryType(tag.slice(TAG_TYPE_PREFIX.length));
}

export function memoryPurposeFromTags(tags: readonly string[]): MemoryPurpose {
  const tag = tags.find(item => item.startsWith(TAG_PURPOSE_PREFIX));
  const purpose = tag === undefined ? null : parseMemoryPurpose(tag.slice(TAG_PURPOSE_PREFIX.length));
  return purpose ?? 'memorized';
}

export function typeTag(memoryType: MemoryType): string | null {
  return memoryType === 'fact' ? null : `${TAG_TYPE_PREFIX}${memoryType}`;
}

export function memoryTags(memoryType: MemoryType, purpose: MemoryPurpose | null): string[] {
  const tags: string[] = [];
  const tag = typeTag(memoryType);
  if (tag !== null) tags.push(tag);
  if (purpose !== null) tags.push(`${TAG_PURPOSE_PREFIX}${purpose}`);
  return tags;
}

export function isReservedSystemName(name: string): boolean {
  return name.trimStart().startsWith(RESERVED_SYSTEM_PREFIX);
}

/** Rust retries on CAS conflicts and retryable SQLite lock errors. */
export function isDailyLogRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('CONFLICT(notes.conflict)')
    || message.includes('database is locked')
    || message.includes('SQLITE_BUSY')
    || message.includes(' BUSY');
}

export function isProfileRetryable(error: unknown): boolean {
  return isDailyLogRetryable(error);
}

export function normalizeFolderSegments(path: string, rootTitle: string | null): string[] {
  const unified = Array.from(path).map(ch => (ch === '\\' || ch === '\uFF0F' || ch === '\uFF3C') ? '/' : ch).join('');
  const segments = unified.split('/').map(segment => segment.trim())
    .filter(segment => segment.length > 0 && segment !== '.');
  if (rootTitle !== null && rootTitle.trim().length > 0) {
    const title = rootTitle.trim();
    while (segments.length > 0 && segments[0] === title) segments.shift();
  }
  return segments;
}

export function relativizeFolderPath(absolutePath: string, rootPath: string): string {
  if (absolutePath === rootPath) return '';
  if (absolutePath.startsWith(`${rootPath}/`)) return absolutePath.slice(rootPath.length + 1);
  return absolutePath;
}

export function folderJson(folder: VfsFolder): Record<string, unknown> {
  return {
    id: folder.id,
    ...(folder.parentId === null ? {} : { parentId: folder.parentId }),
    title: folder.title,
    ...(folder.icon === null ? {} : { icon: folder.icon }),
    ...(folder.color === null ? {} : { color: folder.color }),
    isExpanded: folder.isExpanded, isFavorite: folder.isFavorite, sortOrder: folder.sortOrder,
    createdAt: folder.createdAt, updatedAt: folder.updatedAt,
  };
}

export function itemJson(item: VfsFolderItem): Record<string, unknown> {
  return {
    id: item.id,
    ...(item.folderId === null ? {} : { folderId: item.folderId }),
    itemType: item.itemType, itemId: item.itemId, sortOrder: item.sortOrder,
    createdAt: item.createdAt,
    ...(item.cachedPath === null ? {} : { cachedPath: item.cachedPath }),
  };
}

export function localDateStamp(now: Date): string {
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

export function sameText(lhs: string, rhs: string): boolean { return lhs.trim() === rhs.trim(); }

export function purposeMatches(tags: readonly string[], purpose: MemoryPurpose | null): boolean {
  return memoryPurposeFromTags(tags) === (purpose ?? 'memorized');
}

export function factHardRejectReason(title: string, content: string): string | null {
  const combined = `${title}\n${content}`.toLowerCase();
  const keywords = ['知识点', '词汇', '单词', '释义', '例句', '语法', '定理', '公式', '概念',
    '题干', '选项', '答案', '解题', '错题', '文档摘要', '章节概要'];
  if (keywords.some(keyword => combined.includes(keyword))) {
    return "fact 类型只允许保存用户事实；检测到学科知识/题目内容，请改用 memory_type='study' 或 'note'。";
  }
  const posMarkers = [' n.', ' v.', ' adj.', ' adv.', ' prep.', ' pron.'];
  const looksLikeVocab = posMarkers.some(marker => combined.includes(marker))
    && (content.includes('/') || content.includes('=') || content.includes('＝'));
  return looksLikeVocab ? "fact 类型不适合保存词汇释义；请改用 memory_type='study'。" : null;
}

export function validateExpectedVersion(note: VfsNote, expectedUpdatedAt: string): void {
  const expected = expectedUpdatedAt.trim();
  if (expected.length === 0) {
    throw new Error("Invalid argument 'expected_updated_at': expected_updated_at must not be empty");
  }
  if (note.updatedAt !== expected) {
    throw new Error('CONFLICT(notes.conflict): The memory note has changed since it was read; refresh before retrying.');
  }
}

/** Rust `should_downgrade_smart_mutation`: mutations below 0.65 become NONE. */
export function shouldDowngradeSmartMutation(event: string, confidence: number): boolean {
  if (event !== 'UPDATE' && event !== 'APPEND' && event !== 'DELETE') return false;
  return confidence < Math.fround(0.65);
}

/** Rust `MemoryPurpose::search_weight`. */
export function purposeSearchWeight(purpose: MemoryPurpose): number {
  switch (purpose) {
    case 'internalized': return 1.4;
    case 'memorized': return 1.0;
    case 'supplementary': return 0.8;
    case 'systemic': return 0.65;
  }
}

/** Rust `MemoryService::compute_tag_weight`. */
export function computeTagWeight(tags: readonly string[]): number {
  let weight = 1;
  for (const tag of tags) {
    if (tag === TAG_IMPORTANT) weight *= 1.25;
    else if (tag === TAG_STALE) weight *= 0.6;
  }
  return weight * purposeSearchWeight(memoryPurposeFromTags(tags));
}

export function extractHits(tags: readonly string[]): number {
  for (const tag of tags) {
    if (!tag.startsWith(TAG_HITS_PREFIX)) continue;
    const parsed = Number.parseInt(tag.slice(TAG_HITS_PREFIX.length), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read a Cordis service without assuming the renamed/legacy key. */
export function ctxGet(ctx: Context, name: string): unknown {
  return (ctx as unknown as { get(service: string): unknown }).get(name);
}

/** Audit payload shape shared by the stores. */
export type AuditInput = Partial<AuditEntryInput> & Pick<AuditEntryInput, 'operation' | 'success'>;
