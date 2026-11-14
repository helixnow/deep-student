/**
 * Semantic dedup pass — TS port of `dstu-memory/src/memory/semantic_dedup.rs`: pure helpers
 * (LLM response parsing, merge guards, tag counters, prompt builder) and the throttled pass
 * `spawn_post_write_maintenance` runs (backlog review, routine sample, merge, audit).
 */
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type {
  AutoExtractFrequency, EvolutionTuning, MemoryConfigOutput, MemoryDecisionCompletion, MemoryListItem,
  MemorySearchResult,
} from '../api.ts';
import type { AuditEntryInput } from '../repository/audit.ts';
import {
  getNote, getNoteContent, listDedupReviewBacklog, readNoteTags, rewriteNoteTags,
  type MemoryVfsDependencies, type VfsNote,
} from '../repository/vfs.ts';
import type { EvolutionLogger } from './evolution-cycle.ts';
import { enhancedCleanJsonResponse, extractJsonObject } from './json.ts';
import { CONTENT_LIMITS, TAG_IMPORTANT, TAG_NEEDS_DEDUP_REVIEW, errorText, memoryTypeFromTags } from './memory-utils.ts';

export const TAG_HITS_PREFIX = '_hits:';
export const TAG_USED_PREFIX = '_used:';
export const TAG_ARCHIVED = '_archived';

export interface DedupDecision {
  action: string;
  keep_note_id?: string | null;
  merged_content?: string | null;
}

export interface DedupNote {
  id: string;
  title: string;
}

/** Rust `extract_tag_count`: first parseable `<prefix>N`, otherwise 0. */
export function extractTagCount(tags: readonly string[], prefix: string): number {
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue;
    const raw = tag.slice(prefix.length);
    if (!/^[0-9]+$/.test(raw)) continue;
    const value = Number(raw);
    if (value <= 0xffffffff) return value;
  }
  return 0;
}

/** Rust `build_dedup_prompt` (exact prompt text). */
export function buildDedupPrompt(note: DedupNote, content: string, other: DedupNote,
  otherContent: string, maxChars: number): string {
  return `你是记忆库的去重审查员。下面两条记忆可能是同一信息的措辞漂移（语义重复），请判断是否应合并。

## 记忆 A（本轮复核对象）
[ID: ${note.id}] 标题: ${note.title}
内容: ${content}

## 记忆 B（相似候选）
[ID: ${other.id}] 标题: ${other.title}
内容: ${otherContent}

## 判定规则
1. 两条记忆表达同一事实/同一薄弱点/同一偏好（即使措辞不同）→ merge
2. 一条的信息完全被另一条涵盖 → merge（keep_note_id 填信息更全的那条）
3. 两条各有独立价值（不同事实、不同侧面、互补信息）→ keep
4. merge 时给出合并后内容：保留两条中的全部有效信息、去除冗余，不要编造新信息；合并内容不超过 ${maxChars} 字
5. keep_note_id 必须是上面两条记忆之一的 ID

## 输出格式（严格 JSON，不要其他内容）
{"action": "merge" | "keep", "keep_note_id": "merge 时填保留记忆的 ID", "merged_content": "merge 时填合并后内容"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDecision(value: unknown): DedupDecision | null {
  if (!isRecord(value)) return null;
  const action = value['action'];
  const keepNoteId = value['keep_note_id'];
  const mergedContent = value['merged_content'];
  if (action !== undefined && typeof action !== 'string') return null;
  if (keepNoteId !== undefined && keepNoteId !== null && typeof keepNoteId !== 'string') return null;
  if (mergedContent !== undefined && mergedContent !== null
    && typeof mergedContent !== 'string') return null;
  return {
    action: action ?? '',
    keep_note_id: keepNoteId ?? null,
    merged_content: mergedContent ?? null,
  };
}

function decodeDecision(text: string): DedupDecision | null {
  try {
    return parseDecision(JSON.parse(text));
  } catch (error) {
    return null;
  }
}

/** Rust `parse_dedup_response` (noise tolerated; invalid action is a failure). */
export function parseDedupResponse(response: string): DedupDecision | null {
  const cleaned = enhancedCleanJsonResponse(response);
  const direct = decodeDecision(cleaned);
  let decision = direct;
  if (decision === null) {
    const extracted = extractJsonObject(cleaned);
    if (extracted !== null) decision = decodeDecision(extracted);
  }
  if (decision === null) {
    const extracted = extractJsonObject(response);
    if (extracted !== null) decision = decodeDecision(extracted);
  }
  if (decision === null) return null;
  const action = decision.action.toLowerCase();
  return action === 'merge' || action === 'keep' ? decision : null;
}

/** Rust `validate_merge_decision`: returns [keepId, mergedContent] or null. */
export function validateMergeDecision(decision: DedupDecision, a: DedupNote, b: DedupNote,
  maxChars: number): [string, string] | null {
  if (decision.action.toLowerCase() !== 'merge') return null;
  const keepId = decision.keep_note_id == null ? undefined : rustTrim(decision.keep_note_id);
  if (keepId === undefined || keepId === '') return null;
  if (keepId !== a.id && keepId !== b.id) return null;
  const merged = decision.merged_content == null ? undefined : rustTrim(decision.merged_content);
  if (merged === undefined || merged === '') return null;
  if (Array.from(merged).length > maxChars) return null;
  return [keepId, merged];
}

// ------------------------------------------------------------------ throttled pass

const DEDUP_INTERVAL_AGGRESSIVE_FLOOR_MS = 30 * 60 * 1000;
const REVIEW_BATCH_LIMIT = 10;
const ROUTINE_SAMPLE_LIMIT = 10;
const MAX_LLM_CALLS_PER_ROUND = 10;
const MAX_CONSECUTIVE_LLM_FAILURES = 2;
export const LLM_CALL_TIMEOUT_SECS = 60;

/** Rust `CandidateOutcome`. */
export type CandidateOutcome = 'merged' | 'kept' | 'skipped' | 'llm_failed';

export interface SemanticDedupReport {
  reviewed: number;
  merged: number;
  llm_calls: number;
}

export interface SemanticDedupHost {
  readonly db: SqlExecutor;
  readonly deps: MemoryVfsDependencies;
  getConfig(): Pick<MemoryConfigOutput, 'privacyMode'>;
  getEvolutionTuning(): EvolutionTuning;
  /** Rust `MemoryService::read`: the note with its tags, `null` when missing or outside the memory root. */
  read(noteId: string): { note: VfsNote; content: string } | null;
  searchForPurpose(query: string, topK: number, purpose: 'internal_dedup'): Promise<MemorySearchResult[]>;
  list(folderPath: string | null, limit: number, offset: number): MemoryListItem[];
  updateById(noteId: string, title: string | null, content: string | null, source: 'semantic_dedup'): unknown;
  delete(noteId: string, source: 'semantic_dedup'): Promise<void>;
  audit(entry: AuditEntryInput): void;
  /** Throws when no memory-decision model is available; Rust fails the same way at call time. */
  completion(): MemoryDecisionCompletion;
  readonly log: EvolutionLogger;
  nowMs(): number;
}

/** The `MemoryServiceImpl` surface the pass runs on. */
export interface SemanticDedupService {
  readonly db: DatabaseHandle;
  readonly deps: MemoryVfsDependencies;
  rootId(): string;
  isNoteInMemoryRoot(noteId: string, rootId: string): boolean;
  getConfig(): MemoryConfigOutput;
  getEvolutionTuning(): EvolutionTuning;
  searchForPurpose(query: string, topK: number, purpose: 'internal_dedup'): Promise<MemorySearchResult[]>;
  list(folderPath: string | null, limit: number, offset: number): MemoryListItem[];
  updateById(noteId: string, title: string | null, content: string | null, source: 'semantic_dedup'): unknown;
  delete(noteId: string, source: 'semantic_dedup'): Promise<void>;
  audit(entry: AuditEntryInput): void;
  memoryDecisionCompletion(): MemoryDecisionCompletion;
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export function createSemanticDedupHost(service: SemanticDedupService): SemanticDedupHost {
  return {
    get db() { return service.db; },
    get deps() { return service.deps; },
    getConfig: () => service.getConfig(),
    getEvolutionTuning: () => service.getEvolutionTuning(),
    read: noteId => {
      const rootId = service.rootId();
      const note = getNote(service.deps, service.db, noteId);
      if (note === undefined || !service.isNoteInMemoryRoot(noteId, rootId)) return null;
      return { note, content: getNoteContent(service.deps, service.db, noteId) };
    },
    searchForPurpose: (query, topK, purpose) => service.searchForPurpose(query, topK, purpose),
    list: (folderPath, limit, offset) => service.list(folderPath, limit, offset),
    updateById: (noteId, title, content, source) => service.updateById(noteId, title, content, source),
    delete: (noteId, source) => service.delete(noteId, source),
    audit: entry => service.audit(entry),
    completion: () => service.memoryDecisionCompletion(),
    log: {
      info: message => service.info(message),
      warn: message => service.warn(message),
      debug: message => service.debug(message),
    },
    nowMs: () => Date.now(),
  };
}

/** Rust's process-wide `static LAST_SEMANTIC_DEDUP_MS`: one per memory plugin instance, like `EvolutionThrottle`. */
export class SemanticDedupThrottle {
  lastSemanticDedupMs = 0;
}

/** Rust `SemanticDedup::run_throttled`: a failed pass rolls the timer back so the next write retries. */
export async function runSemanticDedupThrottled(host: SemanticDedupHost, frequency: AutoExtractFrequency,
  throttle: SemanticDedupThrottle): Promise<SemanticDedupReport | null> {
  const baseIntervalMs = host.getEvolutionTuning().semantic_dedup_interval_minutes * 60_000;
  const intervalMs = frequency === 'aggressive'
    ? Math.max(Math.trunc(baseIntervalMs / 3), DEDUP_INTERVAL_AGGRESSIVE_FLOOR_MS)
    : baseIntervalMs;
  const nowMs = host.nowMs();
  const last = throttle.lastSemanticDedupMs;
  if (nowMs - last < intervalMs) return null;
  throttle.lastSemanticDedupMs = nowMs;

  try {
    const report = await runSemanticDedupPass(host);
    if (report.reviewed > 0 || report.merged > 0) {
      host.log.info(`[SemanticDedup] Throttled pass: reviewed=${report.reviewed}, merged=${report.merged}, `
        + `llm_calls=${report.llm_calls}`);
    }
    return report;
  } catch (error) {
    throttle.lastSemanticDedupMs = last;
    host.log.warn(`[SemanticDedup] Throttled pass failed (non-fatal): ${errorText(error)}`);
    return null;
  }
}

/** Rust `SemanticDedup::run_dedup_pass`. */
export async function runSemanticDedupPass(host: SemanticDedupHost): Promise<SemanticDedupReport> {
  const report: SemanticDedupReport = { reviewed: 0, merged: 0, llm_calls: 0 };
  if (host.getConfig().privacyMode) {
    host.log.debug('[SemanticDedup] Privacy mode enabled, skipping pass');
    return report;
  }
  const tuning = host.getEvolutionTuning();
  if (tuning.semantic_merge_max_pairs === 0) {
    host.log.debug('[SemanticDedup] semantic_merge_max_pairs=0, pass disabled');
    return report;
  }
  const llmBudget = Math.min(tuning.semantic_merge_max_pairs, MAX_LLM_CALLS_PER_ROUND);
  const minScore = tuning.semantic_merge_min_score;

  let candidates = listDedupReviewBacklog(host.db, REVIEW_BATCH_LIMIT);
  const fromBacklog = candidates.length > 0;
  if (!fromBacklog) candidates = sampleRecentFacts(host, ROUTINE_SAMPLE_LIMIT);
  if (candidates.length === 0) return report;
  host.log.debug(`[SemanticDedup] Pass start: ${candidates.length} candidates `
    + `(${fromBacklog ? 'review backlog' : 'routine sample'})`);

  let consecutiveLlmFailures = 0;
  for (const noteId of candidates) {
    if (report.llm_calls >= llmBudget) {
      host.log.debug('[SemanticDedup] LLM call budget exhausted, ending round');
      break;
    }
    const [outcome, llmCalled] = await processCandidate(host, noteId, minScore);
    if (llmCalled) report.llm_calls += 1;
    if (outcome === 'merged') {
      report.reviewed += 1;
      report.merged += 1;
      consecutiveLlmFailures = 0;
    } else if (outcome === 'kept') {
      report.reviewed += 1;
      consecutiveLlmFailures = 0;
    } else if (outcome === 'llm_failed') {
      consecutiveLlmFailures += 1;
      if (consecutiveLlmFailures >= MAX_CONSECUTIVE_LLM_FAILURES) {
        host.log.warn(`[SemanticDedup] ${consecutiveLlmFailures} consecutive LLM failures, ending round early`);
        break;
      }
    }
  }
  return report;
}

const TIMED_OUT = Symbol('timed out');

/** `tokio::time::timeout(60s, call)`: on expiry the request is aborted, as dropping the future does. */
async function callWithTimeout(host: SemanticDedupHost, prompt: string): Promise<{ assistant_message: string } | typeof TIMED_OUT> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), LLM_CALL_TIMEOUT_SECS * 1000);
  });
  try {
    const call = Promise.resolve().then(() => host.completion().callMemoryDecisionRawPrompt(prompt, controller.signal));
    const result = await Promise.race([call, deadline]);
    if (result === TIMED_OUT) controller.abort();
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Rust `SemanticDedup::process_candidate`: `[outcome, whether an LLM call was spent]`. */
export async function processCandidate(host: SemanticDedupHost, noteId: string,
  minScore: number): Promise<[CandidateOutcome, boolean]> {
  let read: { note: VfsNote; content: string } | null;
  try {
    read = host.read(noteId);
  } catch (error) {
    host.log.warn(`[SemanticDedup] Failed to read candidate ${noteId}: ${errorText(error)}`);
    return ['skipped', false];
  }
  if (read === null) return ['skipped', false];
  const { note, content } = read;
  if (note.title.startsWith('__')) return ['skipped', false];
  if (note.tags.includes(TAG_ARCHIVED) || rustTrim(content) === '') {
    removeReviewTag(host, note.id);
    return ['kept', false];
  }
  const memoryType = memoryTypeFromTags(note.tags);

  let similar: MemorySearchResult[];
  try {
    similar = await host.searchForPurpose(content, 5, 'internal_dedup');
  } catch (error) {
    host.log.warn(`[SemanticDedup] Similar search failed for ${note.id}: ${errorText(error)}`);
    return ['skipped', false];
  }

  let pair: { note: VfsNote; content: string } | null = null;
  for (const hit of similar) {
    if (hit.noteId === note.id || hit.score < minScore) continue;
    let other: { note: VfsNote; content: string } | null;
    try {
      other = host.read(hit.noteId);
    } catch (error) {
      host.log.warn(`[SemanticDedup] Failed to read similar note ${hit.noteId}: ${errorText(error)}`);
      continue;
    }
    if (other === null) continue;
    if (other.note.title.startsWith('__') || other.note.tags.includes(TAG_ARCHIVED)
      || memoryTypeFromTags(other.note.tags) !== memoryType || rustTrim(other.content) === '') continue;
    pair = other;
    break;
  }
  if (pair === null) {
    removeReviewTag(host, note.id);
    return ['kept', false];
  }
  const other = pair.note;

  const maxChars = CONTENT_LIMITS[memoryType];
  const prompt = buildDedupPrompt(note, content, other, pair.content, maxChars);
  let response: string;
  try {
    const output = await callWithTimeout(host, prompt);
    if (output === TIMED_OUT) {
      host.log.warn(`[SemanticDedup] LLM call timed out (${LLM_CALL_TIMEOUT_SECS}s) for ${note.id}`);
      return ['llm_failed', true];
    }
    response = output.assistant_message;
  } catch (error) {
    host.log.warn(`[SemanticDedup] LLM call failed for ${note.id}: ${errorText(error)}`);
    return ['llm_failed', true];
  }
  const decision = parseDedupResponse(response);
  if (decision === null) {
    host.log.warn(`[SemanticDedup] Failed to parse LLM response for ${note.id}`);
    return ['llm_failed', true];
  }

  const merge = validateMergeDecision(decision, note, other, maxChars);
  if (merge === null) {
    removeReviewTag(host, note.id);
    return ['kept', true];
  }
  const [keepId, mergedContent] = merge;
  const [keeper, loser] = keepId === note.id ? [note, other] : [other, note];

  try {
    const currentKeeper = host.read(keeper.id);
    const currentLoser = host.read(loser.id);
    if (currentKeeper === null || currentLoser === null
      || currentKeeper.note.updatedAt !== keeper.updatedAt
      || currentLoser.note.updatedAt !== loser.updatedAt) return ['skipped', true];
  } catch (error) {
    host.log.warn(`[SemanticDedup] Failed to re-read merge pair: ${errorText(error)}`);
    return ['skipped', true];
  }

  const mergedHits = Math.max(extractTagCount(keeper.tags, TAG_HITS_PREFIX), extractTagCount(loser.tags, TAG_HITS_PREFIX));
  const mergedUsed = Math.max(extractTagCount(keeper.tags, TAG_USED_PREFIX), extractTagCount(loser.tags, TAG_USED_PREFIX));
  const mergedImportant = keeper.tags.includes(TAG_IMPORTANT) || loser.tags.includes(TAG_IMPORTANT);

  try {
    host.updateById(keeper.id, null, mergedContent, 'semantic_dedup');
  } catch (error) {
    host.log.warn(`[SemanticDedup] Failed to update keeper ${keeper.id} with merged content: ${errorText(error)}`);
    return ['skipped', true];
  }
  try {
    await host.delete(loser.id, 'semantic_dedup');
  } catch (error) {
    host.log.warn(`[SemanticDedup] Merged content written but failed to delete duplicate ${loser.id}: ${errorText(error)}`);
    logMergeAudit(host, keeper, loser, mergedContent, false, errorText(error));
    return ['skipped', true];
  }

  mergeKeeperTags(host, keeper.id, mergedHits, mergedUsed, mergedImportant);
  logMergeAudit(host, keeper, loser, mergedContent, true, null);
  host.log.info(`[SemanticDedup] Merged duplicate: kept '${keeper.title}' (${keeper.id}), deleted '${loser.title}' (${loser.id})`);
  return ['merged', true];
}

/** Rust `sample_recent_facts`: `list` is updated_at DESC; archived memories are not sampled. */
function sampleRecentFacts(host: SemanticDedupHost, limit: number): string[] {
  return host.list(null, limit * 3, 0)
    .filter(item => item.memoryType === 'fact' && !item.isArchived)
    .slice(0, limit)
    .map(item => item.id);
}

/** Rust `remove_review_tag`: tags-only rewrite without an `updated_at` bump; failures only warn. */
function removeReviewTag(host: SemanticDedupHost, noteId: string): void {
  try {
    const tags = readNoteTags(host.db, noteId);
    if (tags === null) return;
    const kept = tags.filter(tag => tag !== TAG_NEEDS_DEDUP_REVIEW);
    if (kept.length === tags.length) return;
    rewriteNoteTags(host.deps, host.db, noteId, kept);
  } catch (error) {
    host.log.warn(`[SemanticDedup] Failed to remove review tag from ${noteId}: ${errorText(error)}`);
  }
}

/** Rust `merge_keeper_tags`: `_hits`/`_used` take the larger count, `_important` if either had it. */
function mergeKeeperTags(host: SemanticDedupHost, noteId: string, mergedHits: number, mergedUsed: number,
  mergedImportant: boolean): void {
  try {
    const current = readNoteTags(host.db, noteId);
    if (current === null) return;
    const tags = current.filter(tag => !tag.startsWith(TAG_HITS_PREFIX) && !tag.startsWith(TAG_USED_PREFIX)
      && tag !== TAG_NEEDS_DEDUP_REVIEW && tag !== TAG_IMPORTANT);
    if (mergedHits > 0) tags.push(`${TAG_HITS_PREFIX}${mergedHits}`);
    if (mergedUsed > 0) tags.push(`${TAG_USED_PREFIX}${mergedUsed}`);
    if (mergedImportant) tags.push(TAG_IMPORTANT);
    rewriteNoteTags(host.deps, host.db, noteId, tags);
  } catch (error) {
    host.log.warn(`[SemanticDedup] Failed to merge keeper tags for ${noteId}: ${errorText(error)}`);
  }
}

/** Rust `log_merge_audit`. */
function logMergeAudit(host: SemanticDedupHost, keeper: VfsNote, loser: VfsNote, mergedContent: string,
  success: boolean, error: string | null): void {
  const reason = error === null
    ? `语义合并：保留「${keeper.title}」，删除重复记忆「${loser.title}」`
    : `语义合并未完成：保留「${keeper.title}」内容已更新，但删除「${loser.title}」失败：${error}`;
  host.audit({
    source: 'semantic_dedup', operation: 'semantic_merge', success,
    noteId: keeper.id, title: keeper.title, contentPreview: mergedContent, folder: null,
    event: 'SEMANTIC_MERGE', confidence: null, reason, sessionId: null, durationMs: null,
    extraJson: JSON.stringify({ deletedNoteId: loser.id, deletedTitle: loser.title }),
  });
}
