/** L17 public service surface, version 1. Rust wire DTOs retain their generated shapes. */
import type {} from '@deepseek-ai/cordis';
import type {
  MemoryAuditLogItem, MemoryProfileSection, MemorySearchResult, SmartWriteOutput,
} from '../../../contracts/ipc/generated/L17-memory-research.ts';
import type { SqlExecutor } from '../../platform/storage/api.ts';
import type { WindowRef } from '../../kernel/api.ts';
import type { InsightCommandService } from './src/insight-api.ts';
import type { CandidateMemory, ExtractionResult } from './src/auto-extractor.ts';
import type { LearnerProfile } from './src/learner-profile.ts';

export type * from '../../../contracts/ipc/generated/L17-memory-research.ts';
export type { InsightCommandService, CandidateMemory, ExtractionResult };
/**
 * Host-internal Rust `MemoryAuditLogItem`: `id`/`duration_ms` are exact i64 values. The kernel
 * projects bigint to the JSON number of the {@link MemoryAuditLogItem} wire DTO only at the IPC edge.
 */
export type MemoryAuditLogRecord = Omit<MemoryAuditLogItem, 'id' | 'durationMs'> & {
  id: bigint;
  durationMs: bigint | null;
};
/** F1 routing/sensitivity/concurrency checks; these are explicitly not callable executors. */
export { createMemoryToolMetadata } from './src/tool-metadata.ts';
export type { MemoryExecutorMetadata, MemoryToolMetadata } from './src/tool-metadata.ts';

/** L13 `MemoryRetrievalPort` result item (Rust `CompressedMemoryResult`). */
export interface CompressedRetrievalMemory {
  noteId: string | null;
  noteTitle: string;
  folderPath: string;
  chunkText: string;
  score: number;
  sourceNoteIds: string[];
}

/**
 * L13 `MemoryRetrievalPort`. `signal` must stop in-flight work: the memory
 * search only records hits and returns after the owner confirms completion.
 */
export interface MemoryRetrievalService {
  getRootFolderId(): string | null;
  search(query: string, topK: number, signal: AbortSignal | null): Promise<MemorySearchResult[]>;
  /** Rust `MemoryCompressor::compress` via the L02 memory-decision role. */
  compress(query: string, results: MemorySearchResult[]): Promise<CompressedRetrievalMemory[]>;
}

/**
 * L13 `GenerativeResearchPort`: owns the research-block gate, process environment
 * DEEP_STUDENT_HPIAS_BACKEND selection and synchronous session_started emission.
 * Default/disabled is silent; explicit stub schedules the remaining 350ms timeline.
 * question = title ?? extractQuestionFromIntent(intent), preserving Some("").
 * Retrieval without VFS/LLM warns and returns; with dependencies it currently throws
 * an explicit unavailable-backend error (remaining L17 pipeline / L02 raw-prompt work).
 */
export interface GenerativeResearchPort {
  startFromIntent(request: {
    window: WindowRef;
    sessionId: string;
    title: string | null;
    intent: unknown;
  }): void;
}

/** L13 `AttachmentConfigStore`: `memory_config` key/value access. */
export interface AttachmentConfigStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/**
 * R4-SYNC-05: owner implementation of Rust `learner_profile::merge_profile_json_for_sync`
 * for L20's `resources.data` field merge. Pure; returns the merged profile JSON, or `null`
 * when either side is not a learner-profile JSON (caller falls back to row-level LWW/conflict).
 * Symmetric: newer side by updated_at → version → serialized string; version = max + 1.
 */
export { mergeProfileJsonForSync } from './src/learner-profile.ts';

/** Version descriptors required by docs/plugins/ARCHITECTURE.md. */
export const memoryService = { name: 'memory', version: '1.0.0' } as const;
export const insightService = { name: 'insight', version: '1.0.0' } as const;
export const masteryProfileSinkService = { name: 'masteryProfileSink', version: '1.0.0' } as const;

/** Mastery evidence shape shared with L15 (`review/api.ts`). */
export interface MasteryProfileSinkEvidence {
  score: number;
  total: number;
  wrongCount: number;
  recentWrongSummary: string;
}

/** L15 mastery → memory learner-profile reflux (Rust `mastery_hook.rs`). */
export interface MasteryProfileSinkService {
  upsertWeakPointFromMastery(conn: SqlExecutor, concept: string,
    evidence: MasteryProfileSinkEvidence): void;
  removeWeakPointFromMastery(conn: SqlExecutor, concept: string): void;
}

export type AutoExtractFrequency = 'off' | 'balanced' | 'aggressive';
export type MemoryType = 'fact' | 'study' | 'note';
export type MemoryPurpose = 'internalized' | 'memorized' | 'supplementary' | 'systemic';
export type MemoryOpSource = 'tool_call' | 'auto_extract' | 'handler' | 'evolution' | 'semantic_dedup';

export interface FlushFact {
  title: string;
  content: string;
  folder: string | null;
}
export interface FlushExtraction {
  facts: FlushFact[];
  activities: string[];
}
export interface FlushReport {
  facts_extracted: number;
  facts_stored: number;
  activities_extracted: number;
  activities_stored: number;
}

/**
 * L02 `LLMManager::call_memory_decision_raw_prompt` port
 * (`dstu-llm/src/llm_manager/model2_pipeline.rs:8842`).
 *
 * Model routing is L02-owned: `memory_decision_model` with `model2` fallback,
 * caller type `Memory`, task `memory_decision`, non-streaming raw prompt with
 * JSON mode enabled. `signal` is optional because the Rust entry has no
 * per-call cancellation; callers that need timeout/cancel wrap it themselves.
 */
export interface MemoryDecisionCompletion {
  callMemoryDecisionRawPrompt(prompt: string,
    signal?: AbortSignal): Promise<{ assistant_message: string }>;
}

/** Per-fact receipt written atomically with the VFS note (`memory_write_idempotency`). */
export interface FlushReceipt {
  idempotencyKey: string;
  noteId: string | null;
  event: string;
  isNew: boolean;
  confidence: number;
  reason: string;
  resourceId: string | null;
  downgraded: boolean;
  createdAt: number;
  /** `true` while a writer holds the lease (`event = IN_PROGRESS`). */
  inProgress: boolean;
}

/**
 * D1 receipt transaction seam: an `IN_PROGRESS` lease created by
 * `tryReserveFlushReceiptWithConn` and renewed/cached/cleared on the same
 * caller-owned `SqlExecutor`. Only L17 writes `memory_write_idempotency`.
 */
export interface FlushReceiptReservation {
  key: string;
  ownerToken: string;
}

export interface FlushApplyOptions {
  /** Ledger segment id; when null the fact writes are not idempotent (Rust `flush_segment`). */
  segmentId: string | null;
  sessionId: string | null;
  /** Chat ledger progress already committed by L03; skipped items are not replayed. */
  factsCompleted?: number;
  activitiesCompleted?: number;
  /** Called after each fact/activity commit so L03 can persist ledger progress. */
  onProgress?: (factsCompleted: number, activitiesCompleted: number) => void;
}

export interface FlushFactOutcome {
  index: number;
  idempotencyKey: string | null;
  output: SmartWriteOutput;
  stored: boolean;
}

export interface FlushActivityOutcome {
  index: number;
  noteId: string;
  appended: boolean;
  reason: string;
}

export interface FlushApplyResult {
  report: FlushReport;
  factsCompleted: number;
  activitiesCompleted: number;
  facts: FlushFactOutcome[];
  activities: FlushActivityOutcome[];
}
export type { LearnerPreferences, LearnerProfile, LearningGoal, WeakPoint } from './src/learner-profile.ts';
export interface EvolutionTuning {
  stale_hit_days: number;
  stale_injected_days: number;
  stale_min_hits: number;
  archive_after_stale_days: number;
  category_quota: number;
  semantic_merge_max_pairs: number;
  semantic_merge_min_score: number;
  semantic_dedup_interval_minutes: number;
}

/** Additive surface: methods are published only with their implementing work unit. */
export interface MemoryService {
  readonly version: 1;
  readonly insightJobs: InsightJobQueue;
  getAutoExtractFrequency(): AutoExtractFrequency;
  getEvolutionTuning(): EvolutionTuning;
  isPrivacyMode(): boolean;
  isAutoCreateSubfolders(): boolean;
  getDefaultCategory(): string;
  setPrivacyMode(enabled: boolean): void;
  setAutoCreateSubfolders(enabled: boolean): void;
  setDefaultCategory(category: string): void;
  setAutoExtractFrequency(frequency: AutoExtractFrequency): void;
  queryAuditLogs(limit: number, offset: number, source: string | null,
    operation: string | null, success: boolean | null): MemoryAuditLogRecord[];
  /**
   * Rust `memory_search`: unified VFS retrieval + memory time-decay/tag weighting.
   * `signal` aborts the in-flight route before any hit is recorded.
   */
  search(query: string, topK: number, signal?: AbortSignal | null): Promise<MemorySearchResult[]>;
  /** Configured memory root id without creating a folder (Rust `get_root_folder_id`). */
  getRootFolderId(): string | null;
  /** Rust `MemoryCompressor::compress`; failures fall back to the original results. */
  compress(query: string, results: MemorySearchResult[]): Promise<CompressedRetrievalMemory[]>;
  /** Rust `insight_run_jobs`: drain one consolidation batch; returns the processed count. */
  runInsightJobs(batchSize: number): number;
  /** Rust `CompactionMemoryFlush::extract`: memory-decision LLM call + tolerant parse. */
  extractCompactionSegment(segmentText: string, signal?: AbortSignal | null): Promise<FlushExtraction>;
  /**
   * Persists one extraction with per-fact idempotency receipts and daily-log
   * activities. Safe to retry after a crash; returns progress for the L03 ledger.
   */
  applyFlushExtraction(extraction: FlushExtraction, options: FlushApplyOptions): Promise<FlushApplyResult>;
  /**
   * Rust `CompactionMemoryFlush::flush_segment`: extract + best-effort persist.
   * A failed fact/activity is warned and skipped (never aborts the rest); no
   * ledger receipts are written. `segmentId` is accepted for call-site parity
   * but only `applyFlushExtraction` writes receipts for the L03 ledger worker.
   */
  flushSegment(segmentText: string, sessionId: string | null, segmentId?: string | null,
    signal?: AbortSignal | null): Promise<FlushReport>;
  /** Receipts for `compaction_flush:<segmentId>:fact:*`, ordered by creation. */
  queryFlushReceipts(segmentId: string): FlushReceipt[];
  /** One fact receipt (including an in-progress lease), for crash diagnostics. */
  getFlushReceipt(segmentId: string, index: number): FlushReceipt | undefined;
  /**
   * Rust `cleanup_memory_flush_receipts`: deletes keys matching
   * `compaction_flush:<segmentId>:fact:*` (SQLite GLOB), returns the deleted
   * row count and propagates SQL failures to the caller.
   */
  cleanupFlushReceipts(segmentId: string): number;
  /**
   * D1 seam for a caller-owned transaction: reserve one fact receipt
   * (`compaction_flush:<segmentId>:fact:<i>`), returning null when another
   * writer holds an unexpired lease. SQL remains inside L17's repository.
   */
  tryReserveFlushReceiptWithConn(conn: SqlExecutor, idempotencyKey: string): FlushReceiptReservation | null;
  /** D1 seam: renew a receipt lease (Rust `renew_smart_write_reservation_with_conn`). */
  renewFlushReceiptWithConn(conn: SqlExecutor, reservation: FlushReceiptReservation): void;
  /** D1 seam: cache the write result (Rust `cache_smart_write_result_with_conn`). */
  cacheFlushReceiptWithConn(conn: SqlExecutor, reservation: FlushReceiptReservation,
    output: SmartWriteOutput): void;
  /** D1 seam: clear a reservation after a failed write on the same transaction. */
  clearFlushReceiptWithConn(conn: SqlExecutor, reservation: FlushReceiptReservation): void;
  /** D1 seam: list segment receipts on the caller-owned executor. */
  listFlushReceiptsWithConn(conn: SqlExecutor, segmentId: string): FlushReceipt[];
  /** D1 seam: read one segment receipt on the caller-owned executor. */
  getFlushReceiptWithConn(conn: SqlExecutor, segmentId: string, index: number): FlushReceipt | undefined;
  /** D1 seam: GLOB cleanup on the caller-owned executor; returns deleted rows. */
  cleanupFlushReceiptsWithConn(conn: SqlExecutor, segmentId: string): number;
  /** L03 calls this after the Chat ledger is completed; failures are non-fatal. */
  spawnPostWriteMaintenance(): Promise<void>;
  /** Rust `MemoryAutoExtractor::extract_candidates_and_activities` (no persistence). */
  extractMemoryCandidates(userContent: string, assistantContent: string,
    existingProfile: string | null, signal?: AbortSignal | null): Promise<ExtractionResult>;
  /** Rust `MemoryAutoExtractor::extract_and_store`; returns the stored candidate count. */
  extractAndStoreMemory(userContent: string, assistantContent: string,
    signal?: AbortSignal | null): Promise<number>;
  /**
   * Rust `MemoryCategoryManager::load_all_category_summaries` (system folder first, then
   * root; first title wins; empty contents skipped). `[]` without a memory root.
   */
  listCategorySummaries(): MemoryProfileSection[];
  /**
   * Rust `load_all_category_summaries_with_members` (prompt.rs `load_user_profile`): the same
   * sections plus each category note's `_member:<noteId>` ids, for `recordInjectionPresence`.
   */
  listCategorySummariesWithMembers(): MemoryCategorySummary[];
  /** Rust `get_profile_summary`: legacy `__user_profile__` note content, `null` when absent or empty. */
  getProfileSummary(): string | null;
  /** Rust `learner_profile::load_profile`; `null` when no profile has been written. */
  loadProfile(): LearnerProfile | null;
  /** Rust `LearnerProfile::render_markdown` (prompt_builder.rs `load_learner_profile_block`). */
  renderLearnerProfile(profile: LearnerProfile): string;
  /** Rust `LearnerProfile::is_content_empty`. */
  isProfileContentEmpty(profile: LearnerProfile): boolean;
  /**
   * Rust `record_used` (persistence.rs cited `[记忆-N]` notes): `_used:N`+1, refresh `_last_hit`,
   * drop `_stale`, without touching `updated_at`. Fire-and-forget: failures only warn.
   */
  recordUsed(noteIds: readonly string[]): void;
  /**
   * Rust `record_injection_presence` (prompt.rs, injected category members): replace
   * `_last_injected:<ms>` without touching `updated_at`. Fire-and-forget: failures only warn.
   * Throttling (once per session per hour) stays with the caller, as in Rust.
   */
  recordInjectionPresence(noteIds: readonly string[]): void;
}

/** One injected profile category: `### {category}` section text and its member note ids. */
export interface MemoryCategorySummary {
  category: string;
  content: string;
  memberIds: string[];
}

/** Rust insight/jobs.rs queue primitives; transaction ownership remains with the caller. */
export interface InsightJobQueue {
  enqueue(jobType: string, dedupeKey: string, payloadJson: string): string | null;
  recoverStaleLeases(): number;
  claimDue(workerId: string, limit: number): Array<[id: string, jobType: string, payloadJson: string, attempt: number]>;
  complete(jobId: string): void;
  fail(jobId: string, error: string): void;
}

/** Ports the research executors consume; owners publish them as `paperLibrary` / `pendingMemoryCandidates`. */
export type { PaperFileInput, PaperFileRecord, PaperLibraryPort, PaperPreview, PaperUnitInput } from './src/paper-save-executor.ts';
export type { PendingMemoryCandidateRow, PendingMemoryCandidateWriter } from './src/knowledge-executor.ts';
export type { InsightHintRequest } from './src/insight-hints.ts';

/** Rust `InsightHintProvider` slot (chat-pipeline `insightHints` prompt source). */
export interface InsightHintsService {
  /** Existence-level passive hints; `null` = no hint (including every failure). */
  existenceHints(request: import('./src/insight-hints.ts').InsightHintRequest): string | null;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService;
    insight: InsightCommandService;
    masteryProfileSink: MasteryProfileSinkService;
    /** L13 retrieval-executor dependency; served by this plugin. */
    memoryRetrieval: MemoryRetrievalService;
    /** L13 generative-UI research branch; served by this plugin. */
    hpiasResearch: GenerativeResearchPort;
    /** L13 attachment config storage; served by this plugin. */
    memoryConfig: AttachmentConfigStore;
    /** Routing metadata of the research executors (same policies as the registered executors). */
    memoryToolMetadata: import('./src/tool-metadata.ts').MemoryToolMetadata;
    insightHints: InsightHintsService;
  }
}
