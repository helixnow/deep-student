import type {
  AnkiDocumentGenerationRequest, AnkiGenerationOptions, CreateTemplateRequest, CustomAnkiTemplate,
  FieldExtractionRule, UpdateTemplateRequest,
} from '../../../contracts/ipc/generated/L16-anki.ts';
import type { AnkiCard } from '../../../contracts/ipc/generated/_shared.ts';
import type { DocumentTask, TaskStatus } from '../../../contracts/ipc/generated/_shared.ts';
import type {
  FsrsDailyLimitsStatus, FsrsEnqueuedCard, FsrsEnqueueResult,
  FsrsSchedulerConfig, FsrsSchedulerConfigUpdate, FsrsStats,
} from '../../../contracts/ipc/generated/L15-review-analytics.ts';
import type { ContextRef } from '../../../contracts/ipc/generated/L04-chat-session.ts';
import type {
  VfsContextRefData, VfsResourceRef, VfsResourceType,
} from '../../../contracts/ipc/generated/L13-vfs-api.ts';
import type {
  FsrsAgentReviewMutationOutcome, FsrsAgentReviewStateSnapshot, ReviewService,
} from '../review/api.ts';
import type {
  AnkiDocumentPipeline, AnkiLibraryCardLocator, AnkiLibraryCardVersionUpdate, AnkiService,
} from '../anki/api.ts';
import type { ChatAnkiApkgImporter, ChatAnkiApkgVfs } from './src/apkg-port.ts';

export type { AnkiCard, AnkiDocumentGenerationRequest, AnkiGenerationOptions, ContextRef, DocumentTask, TaskStatus };
export type { CreateTemplateRequest, CustomAnkiTemplate, FieldExtractionRule, UpdateTemplateRequest };
export type {
  FsrsDailyLimitsStatus, FsrsEnqueuedCard, FsrsEnqueueResult,
  FsrsSchedulerConfig, FsrsSchedulerConfigUpdate, FsrsStats,
};
export type { VfsContextRefData, VfsResourceRef, VfsResourceType };
export type { FsrsAgentReviewMutationOutcome, FsrsAgentReviewStateSnapshot };

/** Rust dstu-core::agent::{ToolCall, ToolResultInfo}, camelCase on the wire. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResultInfo {
  toolCallId?: string;
  blockId?: string;
  toolName: string;
  input: unknown;
  output: unknown;
  success: boolean;
  error?: string;
  durationMs?: number;
  reasoningContent?: string;
  thoughtSignature?: string;
}

/** L16's template repository operations used by TemplateDesignerExecutor. */
export interface TemplateDatabase {
  getAllCustomTemplates(): CustomAnkiTemplate[];
  getCustomTemplateById(id: string): CustomAnkiTemplate | null;
  createCustomTemplate(request: CreateTemplateRequest): string;
  updateCustomTemplate(id: string, request: UpdateTemplateRequest): void;
  markTemplateUserModified(id: string): void;
  countAnkiCardsReferencingTemplate(id: string): number;
  softDeleteBuiltinTemplate(id: string): void;
  deleteCustomTemplate(id: string): void;
  setDefaultTemplate(id: string): void;
  importBuiltinTemplatesIfEmpty(): void;
  getSetting?(key: string): string | null;
  saveSetting?(key: string, value: string): void;
}

/** L15 FsrsReviewService operations; failures preserve the Rust Display text. */
export interface SchedulerService {
  getSchedulerConfig(): FsrsSchedulerConfig;
  /**
   * L15 review statistics carrying `dailyLimits` (Rust
   * `FsrsReviewService::get_review_statistics(Some(7))`). L15's published
   * `ReviewService` does not declare it yet; the host attaches the method when
   * the real implementation exposes it.
   */
  getReviewStatistics?(days: number | null): { dailyLimits: FsrsDailyLimitsStatus };
  updateSchedulerConfig(update: FsrsSchedulerConfigUpdate): FsrsSchedulerConfig;
}

/** L15 `FsrsReviewService::get_stats` used by `chatanki_review_stats`. */
export interface ChatAnkiReviewStatsService {
  getStats(): FsrsStats;
}

/** L16 `anki_connect_service::check_anki_connect_availability` boundary. */
export interface ChatAnkiAnkiConnect {
  checkAnkiConnectAvailability(): Promise<boolean>;
}

/**
 * L16 `anki.pipeline` (`EnhancedAnkiService` run control + `DocumentProcessingService`
 * task reads) consumed by `chatanki_control` (`chatanki_executor.rs:6483–6759`).
 */
export type ChatAnkiDocumentPipeline = AnkiDocumentPipeline;

/**
 * The generation half of L16's run control that `chatanki_start`/`chatanki_run` drive
 * (`chatanki_executor.rs:8296–8480,8664–8708`); the tools are claimed only while the live
 * `anki.pipeline` carries all four methods.
 */
export type ChatAnkiGenerationPipeline = Pick<
  AnkiDocumentPipeline,
  'startDocumentProcessingWithId' | 'cancelStreaming' | 'cancelDocumentProcessing' | 'updateTaskStatus'
>;

/** `ChatAnkiPipelineGuard::register` (`pipeline-registry.ts`). */
export interface ChatAnkiPipelineGuards {
  register(ankiBlockId: string, parentCancelled: (() => boolean) | null): {
    readonly ankiBlockId: string;
    isCancelled(): boolean;
    release(): void;
  };
}

/** `upsert_block_allow_orphan`'s message-side effects (`chatanki_executor.rs:14592–14727`). */
export interface ChatAnkiMessageLinks {
  /** `get_block_v2(block_id).block_index` for a block of `messageId`; null when it is not stored yet. */
  blockIndex(messageId: string, blockId: string): number | null;
  /** `INSERT OR IGNORE` of the placeholder assistant message when `messageId` has no row. */
  ensurePlaceholderMessage(messageId: string, fallbackSessionId: string, timestampMs: number): void;
  /** `append_block_id_to_message`: no-op when the message is missing or already lists the block. */
  appendBlockId(messageId: string, blockId: string): void;
}

/** L16 `anki_connect_service` + receipts consumed by `chatanki_sync` (`chatanki_executor.rs:6141–6482`). */
export type ChatAnkiConnectSync = Pick<AnkiService,
  | 'checkAnkiConnectAvailability' | 'createDeckIfNotExists' | 'templateModelName'
  | 'readSyncOptions' | 'addNotesToAnkiDetailed' | 'writeAnkiExportReceipts'>;

/**
 * Hard-sandbox boundary used by transform script mode. The Rust lane calls
 * `shell_sandbox::PlatformSandboxBackend` (macOS Seatbelt / Linux bwrap /
 * Windows AppContainer); that backend belongs to L05, so this lane consumes it
 * as an injected service. Field names stay camelCase on the host side; L05's
 * eventual published API is adapted at the Cordis wiring layer.
 */
export interface TransformSandboxPolicy {
  readableRoots: string[];
  writableRoots: string[];
  protectedReadRoots: string[];
  protectedWriteRoots: string[];
  restrictReadToRoots: boolean;
  allowNetwork: boolean;
}

/** dstu-agent shell_sandbox::SandboxEffectReport (enforcement declarations). */
export interface TransformSandboxEffects {
  backend: string;
  shellKind: string;
  outputEncoding: string;
  enforced: boolean;
  networkEnforced: boolean;
  processGroupIsolated: boolean;
  cpuTimeLimitSeconds: number | null;
  fileSizeLimitBytes: number | null;
  activeProcessLimit: number | null;
  readableRoots: number;
  writableRoots: number;
  protectedReadRoots: number;
  protectedWriteRoots: number;
}

export interface TransformSandboxSpawnRequest {
  /** Shell line built by `buildShellCommand`; the backend wraps it in the sandbox. */
  command: string;
  cwd: string;
  policy: TransformSandboxPolicy;
  /** Complete environment whitelist: the backend must not inherit the parent env. */
  env: Record<string, string>;
  /** Optional cancellation forwarded to the published L05 async spawn. */
  signal?: AbortSignal;
}

/** A sandboxed child process. Pipes are bounded by the caller, not the backend. */
export interface TransformSandboxProcess {
  readonly pid: number;
  readonly stdout: AsyncIterable<Uint8Array> | null;
  readonly stderr: AsyncIterable<Uint8Array> | null;
  /** Exit code, or null when the process was killed by a signal. */
  wait(): Promise<number | null>;
  /** Kill the whole process group (timed-out scripts). */
  terminateProcessGroup(): Promise<void>;
  /** Reap descendants that inherited the group after a clean exit. */
  cleanupFinishedProcessGroup(): Promise<void>;
  /** Release backend bookkeeping; must not touch the job directory. */
  cleanupResources(): Promise<void>;
}

/**
 * L05 publishes `agentTransformSandbox` with asynchronous `capability`/`spawn`
 * (native probe and spawn only resolve after the backend is ready). The
 * optional Promise return keeps the in-process test backend synchronous while
 * the production path always awaits the same methods.
 */
export interface TransformSandboxBackend {
  capability(): { available: true } | { available: false; reason: string }
    | Promise<{ available: true } | { available: false; reason: string }>;
  contract(): { backend: string; shellKind: string; outputEncoding: string };
  effectReport(policy: TransformSandboxPolicy): TransformSandboxEffects;
  /** Throws/rejects when the sandbox cannot be constructed or the process cannot start. */
  spawn(request: TransformSandboxSpawnRequest): TransformSandboxProcess | Promise<TransformSandboxProcess>;
}

/** Keep the owner's full-i64 snapshot types, rather than a drifting local mirror. */
export type FsrsAgentLatestReviewSnapshot = NonNullable<FsrsAgentReviewStateSnapshot['latestReview']>;

/** dstu-storage::AnkiCardVersionUpdate. */
export type AnkiCardVersionUpdate =
  | { kind: 'updated'; card: AnkiCard }
  | { kind: 'conflict'; current: AnkiCard }
  | { kind: 'notFound' };

/**
 * Minimal L16 card-repository surface used by chatanki get/update/delete/add.
 * Ownership-aware reads and CAS updates keep the Rust failure vocabulary:
 * the repository returns null/notFound instead of leaking document existence.
 */
export type AnkiCardVersionDelete =
  | { kind: 'deleted' }
  | { kind: 'conflict'; current: AnkiCard }
  | {
    kind: 'reviewConflict';
    current: AnkiCard;
    review: FsrsAgentReviewStateSnapshot | null;
  }
  | { kind: 'notFound' };

export interface ChatAnkiCardRepository {
  isDocumentOwnedBySession(documentId: string, sessionId: string): boolean;
  getCardsForDocumentForSession(documentId: string, sessionId: string): AnkiCard[] | null;
  getCardsForDocument(documentId: string): AnkiCard[];
  getCardWithDocument(cardId: string): { card: AnkiCard; documentId: string } | null;
  getCardForSession(cardId: string, sessionId: string): { card: AnkiCard; documentId: string } | null;
  /** Live library cards in requested order; throws `library_cards_unavailable: ids` on any miss. */
  getLibraryCardsByIds(cardIds: readonly string[]): AnkiCard[];
  loadOwnedCard(cardId: string, sessionId: string): { card: AnkiCard; documentId: string } | null;
  insertCard(card: AnkiCard): boolean;
  insertCardsForDocument(
    documentId: string, sessionId: string, cards: readonly AnkiCard[],
  ): AnkiCard[];
  updateCardIfVersionForSession(
    card: AnkiCard, expectedVersion: string, sessionId: string,
  ): AnkiCardVersionUpdate;
  /**
   * Atomic retemplate batch: ownership, live-set/version-set equality, version
   * CAS, cloze guard and field mapping all reject before any write.
   */
  retemplateCardsForSession(
    selector: { kind: 'document'; documentId: string } | { kind: 'cards'; cardIds: readonly string[] },
    target: AnkiRetemplateTarget,
    expectedVersions: ReadonlyMap<string, string>,
    sessionId: string,
    preflightedDocumentIds: readonly string[],
  ): AnkiRetemplateBatchResult;
  /** Rust i64 CAS: exact bigint internally; legacy integer number arguments are accepted. */
  deleteCardForSession(
    cardId: string, expectedVersion: string, expectedReviewVersion: number | bigint | null,
    sessionId: string,
  ): AnkiCardVersionDelete;
}

/** L16 anki@1 `saveJsonFile`; the host adapter owns the export directory. */
export interface ChatAnkiJsonExportSink {
  saveJsonFile(content: string, suggestedName: string): Promise<string>;
}

/** L16 settings read/write used by preference-memory persistence. */
export interface ChatAnkiSettingsStore {
  getSetting(key: string): string | null;
  saveSetting(key: string, value: string): void;
}

/** L04 context-ref lookup used by the APKG session-ownership preflight. */
export interface ChatAnkiSessionResourceLookup {
  /** User refs matching the requested ids; null when the session is unknown. */
  resolveSessionUserRefs(sessionId: string, resourceIds: readonly string[]): ContextRef[] | null;
}

export { ChatAnkiApkgError } from './src/apkg-port.ts';
export type {
  ChatAnkiApkgErrorType, ChatAnkiApkgImporter, ChatAnkiApkgImportResult, ChatAnkiApkgMediaReport,
  ChatAnkiApkgMediaSkip, ChatAnkiApkgReviewEnqueueReport, ChatAnkiApkgVfs, ChatAnkiResolvedApkgFile,
  ChatAnkiVfsFile,
} from './src/apkg-port.ts';

/**
 * L16 `anki_preference_memory` boundary. The serialized store is written to the
 * `chatanki_preference_memory_store` setting, so entry fields keep the Rust
 * serde snake_case wire shape; observation input uses camelCase.
 */
export type ChatAnkiPreferenceKind =
  | 'language' | 'card_density' | 'no_translation' | 'template_preference';

/** Rust i64: retain exact bigint values and legacy integer-number calls. */
export type ChatAnkiPreferenceTimestamp = number | bigint;

export interface ChatAnkiPreferenceEntry {
  kind: ChatAnkiPreferenceKind;
  statement: string;
  subject: string | null;
  confidence: number;
  evidence_count: number;
  last_evidence: string;
  first_seen_ms: ChatAnkiPreferenceTimestamp;
  last_seen_ms: ChatAnkiPreferenceTimestamp;
}

export interface ChatAnkiPreferenceStore {
  entries: ChatAnkiPreferenceEntry[];
}

export interface ChatAnkiConsolidateOutcome {
  added: string[];
  reinforced: string[];
  evicted: string[];
}

export interface ChatAnkiCardEditObservation {
  field: string;
  before: string;
  after: string;
}

export interface ChatAnkiCardDeleteObservation {
  front: string;
  back: string;
}

export interface ChatAnkiSessionObservation {
  extraRequirements: string | null;
  edits: ChatAnkiCardEditObservation[];
  deletions: ChatAnkiCardDeleteObservation[];
  generatedCount: number;
  templateUsed: string | null;
}

export interface ChatAnkiPreferenceMemory {
  emptyStore(): ChatAnkiPreferenceStore;
  consolidateObservation(
    store: ChatAnkiPreferenceStore,
    observation: ChatAnkiSessionObservation,
    nowMs: ChatAnkiPreferenceTimestamp,
  ): ChatAnkiConsolidateOutcome;
}

/** Minimal L04 block view used by mutation UI-sync preflight. */
export interface ChatAnkiChatBlock {
  id: string;
  sessionId: string;
  type: string;
  toolOutput: unknown;
  status?: string;
  error?: string | null;
  messageId?: string;
  toolName?: string | null;
  blockIndex?: number;
  startedAt?: number | null;
  firstChunkAt?: number | null;
  endedAt?: number | null;
}

/** L04 block read/write side; the adapter maps ChatSessionService messages/blocks. */
export interface ChatAnkiChatBlockStore {
  /** Session blocks in chronological order. */
  listSessionBlocks(sessionId: string): ChatAnkiChatBlock[];
  getBlock(blockId: string): ChatAnkiChatBlock | null;
  /** Persists a full block row after a card mutation patch is merged. */
  updateBlock(block: ChatAnkiChatBlock): void;
  /** Insert-or-update used by running/terminal generation patches. */
  upsertBlock(block: ChatAnkiChatBlock): void;
}

/** dstu-storage retemplate batch contract (internal Rust enum, kind-tagged on the host). */
export interface AnkiRetemplateTarget {
  templateId: string;
  noteType: string;
  fields: string[];
  requiredFields: string[];
}

export interface AnkiRetemplateMissingField {
  field: string;
  required: boolean;
}

export interface AnkiRetemplateCardUpdate {
  documentId: string;
  card: AnkiCard;
  source: AnkiCard;
  missingFields: AnkiRetemplateMissingField[];
}

export interface AnkiRetemplateVersionConflict {
  cardId: string;
  expectedVersion: string;
  currentVersion: string;
}

export type AnkiRetemplateBatchResult =
  | { kind: 'updated'; targetNoteType: string; updates: AnkiRetemplateCardUpdate[] }
  | { kind: 'selectionNotFound'; cardIds: string[] }
  | { kind: 'ownershipRejected' }
  | { kind: 'crossDocumentSelection'; documentIds: string[] }
  | { kind: 'documentSetChanged'; documentIds: string[] }
  | {
    kind: 'expectedVersionsMismatch';
    missingVersionIds: string[];
    unexpectedVersionIds: string[];
  }
  | { kind: 'versionConflict'; conflicts: AnkiRetemplateVersionConflict[] }
  | { kind: 'invalidCloze'; cardIds: string[] };

/** L16 document_tasks surface used by placeholder failure/cancel sessions. */
export interface ChatAnkiDocumentTaskRepository {
  getTasksForDocument(documentId: string): DocumentTask[];
  insertDocumentTask(task: DocumentTask): void;
  getDocumentSessionSource(documentId: string): string | null;
  setDocumentSessionSource(documentId: string, sessionId: string): void;
}

/** L15 errors surface the Rust AppError type (`NotFound` is the ownership answer). */
export class ChatAnkiReviewStateError extends Error {
  readonly type: 'NotFound' | 'Validation' | 'Database';

  constructor(type: 'NotFound' | 'Validation' | 'Database', message: string) {
    super(message);
    this.type = type;
    this.name = 'ChatAnkiReviewStateError';
  }
}

/**
 * L15 review-state read/write side used by get_cards and the agent review
 * tools. `setSuspendedForSession`/`undoLastReviewForSession` are optional
 * capability probes: the published `review@1` delegates both, and a host
 * without them fails closed with an explicit wiring error instead of this lane
 * inventing a CAS implementation.
 */
export type ChatAnkiReviewStateService = Pick<ReviewService, 'getReviewStatesForSession'>
  & Partial<Pick<ReviewService,
    'enqueueCardsForSession' | 'getEnqueuedCards' | 'setSuspendedForSession' | 'undoLastReviewForSession'
  >>;

/** Exact agent-only page and library snapshots, owned by L16 and L15. */
export type ChatAnkiLibraryPageService = Pick<AnkiService, 'listAnkiAgentLibraryPage'>;
export type ChatAnkiLibraryReviewStateService = Pick<ReviewService, 'getReviewStatesForLibrary'>;

/**
 * L15 agent-scope library review writes (`*_for_library(AnkiLibraryScope::agent(), ..)`).
 * Members are capability probes: a host without one fails that tool explicitly.
 */
export type ChatAnkiLibraryReviewService = Partial<Pick<ReviewService,
  'enqueueCardsForLibrary' | 'getEnqueuedCards' | 'getReviewStatesForLibrary'
  | 'setSuspendedForLibrary' | 'undoLastReviewForLibrary'>>;

/** L16 flat library card (`AnkiLibraryCard`), as returned by the library CAS writes. */
export type ChatAnkiLibraryCard = Extract<AnkiLibraryCardVersionUpdate, { type: 'updated' }>['current'];

/** Rust `AnkiLibraryCardRecord`: one live library card plus the raw locator from the same row. */
export interface ChatAnkiLibraryCardRecord {
  libraryCard: ChatAnkiLibraryCard;
  locator: AnkiLibraryCardLocator;
}

/**
 * L16 library content writes. `getAnkiAgentLibraryCard` is Rust
 * `get_anki_agent_library_card` (database/mod.rs:5330-5341); members are
 * capability probes like the review service above.
 */
export interface ChatAnkiLibraryCardStore extends Partial<Pick<AnkiService,
  'updateAnkiCardIfVersionForLibrary' | 'deleteAnkiCardForLibrary'>> {
  getAnkiAgentLibraryCard?(cardId: string): ChatAnkiLibraryCardRecord | null;
}

/**
 * L04/L11 read-side adaptation used by chatanki_analyze: session snapshot refs
 * first, VFS source-id fallback, then per-ref extracted text for metrics.
 */
export interface ChatAnkiRefResolver {
  resolveSessionRefs(sessionId: string, ids: readonly string[]): ContextRef[];
  resolveVfsRef(id: string): ContextRef | null;
  /** File -> first `maxChars` chars of extracted text (SQL `substr`), image -> null, other -> snippet; trimmed by caller. */
  refText(ref: VfsResourceRef, maxChars: number): string | null;
}

/**
 * F7 `nativeRegex` boundary. Rust `regex` syntax and replacement semantics are
 * not JS RegExp; user/AI patterns must compile through this engine. The host
 * adapter is responsible for `(?i)`-style inline flags and `$name`/`${1}`
 * replacement capture expansion.
 */
export interface ChatAnkiRegexMatch {
  /** UTF-16 index in the searched string (host string indices). */
  start: number;
  end: number;
  text: string;
  /** Capture 0 is the full match; unmatched groups are null. */
  captures: ReadonlyArray<string | null>;
  named: Readonly<Record<string, string | null>>;
}

export interface ChatAnkiCompiledRegex {
  /** Rust `find_iter`: non-overlapping matches in order; empty matches advance. */
  execAll(text: string): ChatAnkiRegexMatch[];
}

export interface ChatAnkiNativeRegex {
  /** Throws with the engine's Rust-regex error text on an invalid pattern. */
  compile(pattern: string): ChatAnkiCompiledRegex;
}

/** F7 `NativeRegex` (WASI `regex` crate), async because the engine is a worker. */
export interface ChatAnkiAsyncRegexPattern {
  readonly pattern: string;
}

export interface ChatAnkiAsyncRegexMatch {
  start: number;
  end: number;
  text: string;
}

export interface ChatAnkiAsyncRegexGroup extends ChatAnkiAsyncRegexMatch {
  name: string | null;
}

export interface ChatAnkiAsyncRegexCaptures extends ChatAnkiAsyncRegexMatch {
  groups: Array<ChatAnkiAsyncRegexGroup | null>;
}

/**
 * Result of F7's byte-projected full-text replacement. On failure `bytes` is
 * the first cumulative UTF-8 count that exceeded the caller's limit, returned
 * without allocating the complete output. On success it is the exact final
 * byte count of `value`.
 */
export type ChatAnkiProjectedReplacement =
  | { ok: true; value: string; bytes: number }
  | { ok: false; bytes: number };

export interface ChatAnkiAsyncNativeRegex {
  compile(pattern: string): Promise<ChatAnkiAsyncRegexPattern>;
  findIter(pattern: ChatAnkiAsyncRegexPattern, text: string): Promise<ChatAnkiAsyncRegexMatch[]>;
  captures(
    pattern: ChatAnkiAsyncRegexPattern, text: string,
  ): Promise<ChatAnkiAsyncRegexCaptures | null>;
  replace(pattern: ChatAnkiAsyncRegexPattern, text: string, replacement: string): Promise<string>;
  replaceAll(
    pattern: ChatAnkiAsyncRegexPattern, text: string, replacement: string,
  ): Promise<string>;
  /**
    * Published F7 primitive: run the same full-text
   * `replace_all` as above, projecting UTF-8 output bytes during the capture
   * scan. `limitBytes` is Rust `bounded_regex_replace`'s allocation limit
   * (`max(CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES, utf8Bytes(text))`).
   *
   * The engine must return `{ ok: false, bytes }` as soon as the cumulative
   * projection exceeds `limitBytes`, *before* materializing `value`; `bytes` is
   * the first over-limit cumulative count (not the final total). On success
   * `bytes` must equal the UTF-8 byte length of `value`. Capture expansion uses
   * the same `$name`/`$1`/`${...}`/`$$` semantics as `replaceAll` over the full
    * original text. The JS API accepts only non-negative safe-integer limits;
    * the engine's u64 counters do not widen that input domain.
   */
  replaceAllProjected(
    pattern: ChatAnkiAsyncRegexPattern, text: string, replacement: string, limitBytes: number,
  ): Promise<ChatAnkiProjectedReplacement>;
}

/**
 * L02 Planner slot boundary for `chatanki_analyze`/pipeline route planning.
 * L02 owns the routed Planner→model2 fallback; this side only builds the prompt
 * and parses the response. Missing capability must fail explicitly, not skip.
 */
export interface ChatAnkiRoutePlanner {
  callAnkiRoutedRawPrompt(task: string, prompt: string): Promise<string>;
}

/** `call_vlm_extract` (`chatanki_executor.rs:9719`): the assistant message of the Vlm-slot image call. */
export interface ChatAnkiVlmExtractor {
  callVlmExtract(task: string, prompt: string, images: readonly { mime: string; base64: string }[]): Promise<string>;
}

/**
 * L02 `call_model2_raw_prompt(..., CallerType::Anki)` boundary used by
 * `chatanki_retemplate` phase 2. The host adapts the published L02
 * `llmRawPrompt.callModel2RawPrompt(prompt, null, 'anki')` service.
 */
export interface ChatAnkiRawPrompt {
  callAnkiModel2RawPrompt(
    prompt: string,
  ): Promise<{ assistantMessage: string }>;
}

/** L07 `agentTools.registerToolExecutors` (published by `agent-skills/api.ts`). */
export interface ChatAnkiToolRegistration {
  /** Returns L07's per-call `Disposer`; it withdraws exactly the entries of this call. */
  registerToolExecutors(executors: readonly ChatAnkiToolExecutor[]): { dispose(): void } | void;
}

/** ExecutionContext effects remain owned by the calling chat/agent plugin. */
export interface ToolExecutionContext {
  sessionId: string;
  messageId: string;
  blockId: string;
  mainDb?: TemplateDatabase | null;
  ankiDb?: TemplateDatabase | null;
  /**
   * L16 published template owner (`anki.templates`); the template designer
   * tools use it when no `mainDb`/`ankiDb` is supplied. `template_set_default`
   * additionally needs `settings` (same `settings` table as Rust).
   */
  templates?: AnkiService['templates'] | null;
  /** L16 `anki.getCustomTemplateById` adapter when no full template DB is supplied. */
  templateLookup?: { getCustomTemplateById(id: string): CustomAnkiTemplate | null } | null;
  scheduler?: SchedulerService | null;
  /** L15 `getStats()` snapshot; required by `chatanki_review_stats`. */
  reviewStats?: ChatAnkiReviewStatsService | null;
  /** L16 AnkiConnect probe; required by `chatanki_check_anki_connect`. */
  ankiConnect?: ChatAnkiAnkiConnect | null;
  /** L16 AnkiConnect sync + export receipts; required by `chatanki_sync`. */
  ankiConnectSync?: ChatAnkiConnectSync | null;
  /** L16 document-processing run control; required by `chatanki_control`. */
  pipeline?: ChatAnkiDocumentPipeline | null;
  /** L16 generation run control; required by `chatanki_start`/`chatanki_run`. */
  generation?: ChatAnkiGenerationPipeline | null;
  /** L04 history + L11 VFS + L02 planner/VLM reads of the `chatanki_run` VfsRef input. */
  runInput?: import('./src/run-vfs-input.ts').ChatAnkiRunInputSources | null;
  /** In-process registry of live background pipelines (kill switch + stale-block reaper). */
  pipelineGuards?: ChatAnkiPipelineGuards | null;
  /** Runs a background pipeline owned by the chatanki plugin (Rust `tokio::spawn`). */
  spawnBackground?: ((task: () => Promise<void>) => void) | null;
  /** L04 message rows touched by `upsert_block_allow_orphan`; absent leaves message rows alone. */
  messageLinks?: ChatAnkiMessageLinks | null;
  /** L16 `retrieve_preference_prompt`; absent means no preference hint. */
  retrievePreferencePrompt?: ((
    store: ChatAnkiPreferenceStore, goal: string, templateNames: readonly string[], maxTokens: number,
  ) => string) | null;
  /** dstu-learning `media_file_name` over the VFS connection; absent leaves `source_ref.title` null. */
  mediaFileName?: ((mediaId: string) => string | null) | null;
  /** `emitter.emit_start(ANKI_CARDS, message_id, block_id, payload, None)`; absent is headless. */
  emitBlockStart?: ((blockId: string, payload: unknown) => void) | null;
  /** `emitter.emit_end(ANKI_CARDS, block_id, result, None)`; absent is headless. */
  emitBlockEnd?: ((blockId: string, result: unknown) => void) | null;
  cards?: ChatAnkiCardRepository | null;
  documents?: ChatAnkiDocumentTaskRepository | null;
  chatBlocks?: ChatAnkiChatBlockStore | null;
  exportSink?: ChatAnkiJsonExportSink | null;
  /** Chat block snapshot count for document exports; absent means 0. */
  hiddenOverLimitCount?: ((sessionId: string, documentId: string) => number) | null;
  /** Optional read-side refs; absent means analyze falls back with a warning. */
  refs?: ChatAnkiRefResolver | null;
  /** F7 Rust-regex engine; required before user regex ops can run. */
  nativeRegex?: ChatAnkiNativeRegex | null;
  /** F7 async Rust-regex engine; production path for user regex ops. */
  nativeRegexAsync?: ChatAnkiAsyncNativeRegex | null;
  /** L02 Planner slot; required when analyze has resolvable refs to route. */
  llmPlanner?: ChatAnkiRoutePlanner | null;
  /**
   * True when the host published an LLM manager at all. Rust `chatanki_analyze`
   * treats `llm_manager=None` as "plan=None → heuristic"; when the manager exists
   * but the routed-prompt seam is missing this stays true and analyze fails with
   * an explicit wiring error instead of silently degrading.
   */
  llmManagerPresent?: boolean;
  /** L02 raw model2 prompt; required by `chatanki_retemplate` fill_missing_llm. */
  llmRawPrompt?: ChatAnkiRawPrompt | null;
  /** F4 settings store; required by preference-memory persistence. */
  settings?: ChatAnkiSettingsStore | null;
  /** L16 `anki_preference_memory`; required by preference learning side effects. */
  preferenceMemory?: ChatAnkiPreferenceMemory | null;
  /** L15 per-card review snapshots; required by get_cards and delete CAS conflicts. */
  reviewStates?: ChatAnkiReviewStateService | null;
  /** Agent library read scope; never used as authorization for session writes. */
  libraryCards?: ChatAnkiLibraryPageService | null;
  libraryReviewStates?: ChatAnkiLibraryReviewStateService | null;
  /** L15 agent-scope library review writes; absent means no review database. */
  libraryReviews?: ChatAnkiLibraryReviewService | null;
  /** L16 agent-scope library content writes; absent means no Anki database. */
  libraryCardStore?: ChatAnkiLibraryCardStore | null;
  /** L16 `ApkgImporterService`; required by `chatanki_import_apkg`. */
  apkgImporter?: ChatAnkiApkgImporter | null;
  /** L11 VFS APKG file/blob lookup; required for resourceId imports. */
  apkgVfs?: ChatAnkiApkgVfs | null;
  /** L04 session user refs; required for the APKG ownership preflight. */
  sessionResources?: ChatAnkiSessionResourceLookup | null;
  /** L05 hard-sandbox backend; required by `chatanki_transform` script mode. */
  transformSandbox?: TransformSandboxBackend | null;
  /** Session temp root for transform jobs; absent mirrors Rust's headless rejection. */
  transformTempRoot?: string | null;
  /** Run identity used by `fsrs://changed` payloads (Rust `ctx.run_id()`). */
  runId?: string | null;
  /** Live `anki_cards` chunk effect (`emit_anki_cards_chunk`); absent is headless. */
  emitChunk?: ((blockId: string, update: Record<string, unknown>) => void) | null;
  /**
   * `emitter.emit_error(event_types::ANKI_CARDS, block_id, error)`. Absent only
   * when the context is headless; hosted contexts must always publish it.
   */
  emitBlockError?: ((blockId: string, error: string) => void) | null;
  /** Backend event effect (`ctx.window_ref().emit`); absent is headless. */
  emitEvent?: ((event: string, payload: unknown) => void) | null;
  /** L04 cancellation token (`ctx.is_cancelled()`); absent means never cancelled. */
  isCancelled?: (() => boolean) | null;
  emitToolCallStart(name: string, args: unknown, callId: string | null): void;
  emitToolCallEnd(payload: unknown): void;
  emitToolCallError(error: string): void;
  /** `ctx.emitter.emit_error(TOOL_CALL, block_id, error, None)`: no variant/skill/round meta. */
  emitBareToolCallError?: ((error: string) => void) | null;
  saveToolBlock(result: ToolResultInfo): void;
  warn(message: string): void;
  info?(message: string): void;
}

export type ToolSensitivity = 'low' | 'medium' | 'high';
/** dstu-agent-api/src/executor.rs:43–51; the trait default is serial. */
export type ToolConcurrency = 'read_only' | 'safe_parallel' | 'serial';

export interface ChatAnkiToolExecutor {
  canHandle(toolName: string): boolean;
  sensitivityLevel(toolName: string): ToolSensitivity;
  /** Rust `sensitivity_level_for_call` (transform script = High). */
  sensitivityLevelForCall?(toolName: string, args: unknown): ToolSensitivity;
  /** Rust `has_dynamic_sensitivity` (approval must re-evaluate per call). */
  hasDynamicSensitivity?(toolName: string): boolean;
  concurrencyClass(toolName: string): ToolConcurrency;
  name(): string;
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResultInfo>;
}

/** Cordis service for `chatankiTools`. Only implemented tools are advertised. */
export interface ChatAnkiTools {
  readonly executors: readonly ChatAnkiToolExecutor[];
  canHandle(toolName: string): boolean;
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResultInfo>;
}

/** ARCHITECTURE.md service descriptor; consumers resolve `ctx.chatankiTools`. */
export const chatankiToolsService = { name: 'chatankiTools', version: '1.0.0' } as const;

/** Real production executor construction; metadata is available without booting a host. */
export { createChatAnkiExecutors } from './src/executors.ts';
export type { ChatAnkiExecutorCapabilities } from './src/executors.ts';

// ---------------------------------------------------------------------------
// Published pure-function API for L16 `anki_ai_native_integration` parity tests.
// These are the exact functions L16 imports; keeping the re-exports here avoids
// cross-plugin implementation imports.
// ---------------------------------------------------------------------------

export {
  ExpectedVersionsMismatch,
  InvalidPatternError,
  TransformSelectionError,
  applyTransformOps,
  changedFieldNames,
  checkExpectedVersions,
  compileTransformOps,
  normalizeTransformArgs,
  parseTransformArgs,
  planTransformOps,
  selectTransformCards,
  transformFieldsAreValid,
  transformFieldsFromCard,
} from './src/transform.ts';
export type {
  CompiledTransformOp, NormalizedTransformOp, TransformCardPlan, TransformFields,
} from './src/transform.ts';

export {
  buildScriptInput,
  evaluateScriptOutput,
  resolveInterpreterInDirs,
  textHasValidClozeMarkup,
  transformSandboxPolicy,
} from './src/transform-script.ts';
export type { ScriptCardPlan } from './src/transform-script.ts';

export {
  buildAnalyzeOutput,
  parseRoutePlanResponse,
  resolveRouteDecision,
  routePlanIsConfident,
} from './src/routing.ts';
export type { ChatAnkiRoute, RouteDecision, RoutePlan } from './src/routing.ts';

export { parseChatAnkiRetemplateStrategy } from './src/executor-args.ts';
export type { ChatAnkiRetemplateStrategy } from './src/executor-args.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatankiTools: ChatAnkiTools;
  }
}
