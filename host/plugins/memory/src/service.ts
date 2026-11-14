import { Service, type Context } from '@deepseek-ai/cordis';
import type { DatabaseHandle, SqlExecutor, TransactionScope } from '../../../platform/storage/api.ts';
import type {
  AutoExtractFrequency, BatchOperationResult, FlushApplyOptions, FlushApplyResult,
  FlushExtraction, FlushReceipt, FlushReceiptReservation, FlushReport,
  InsightJobQueue,
  MemoryAnkiDocument, MemoryConfigOutput, MemoryDecisionCompletion, MemoryExportItem,
  MemoryListItem, MemoryProfileSection, MemoryPurpose, MemoryReadOutput, MemorySearchResult,
  MemoryService, MemoryType, MemoryWriteOutput, SmartWriteOutput, ExtractionResult,
  CompressedRetrievalMemory, MemoryCategorySummary,
} from '../api.ts';
import { chronoRfc3339 } from '../../../platform/time/index.ts';
import { MemoryConfig, evolutionIntervalMs, shouldRefreshCategories } from './config.ts';
import { countActiveMemories } from '../repository/dedup-readiness.ts';
import { PromotionThrottle, runPromotionThrottled, type PromotionPassHost } from './promotion-pass.ts';
import { SemanticDedupThrottle, createSemanticDedupHost, runSemanticDedupThrottled } from './semantic-dedup.ts';
import {
  MemoryProfileStore,
  type LearnerProfileApplyOutcome, type MasteryWeakPointEvidence, type ProfileUpdateOptions,
} from './profile-store.ts';
export type { LearnerProfileApplyOutcome, ProfileUpdateOptions } from './profile-store.ts';
import { InsightJobWorker } from './insight-worker.ts';
import { queryAuditLogs, insertAuditLog, type AuditEntryInput } from '../repository/audit.ts';
import { createInsightJobQueue } from '../repository/insight-jobs.ts';
import {
  addItemToFolder, buildFolderPath, createFolder, createNote, deleteNoteWithFolderItem,
  filterAliveNoteIds, findNoteByTitle, recordInjectionPresenceNotes, recordUsedNotes, folderExists, getFolder, getFolderIdsRecursive,
  getNote, getNoteByResourceId, getNoteContent, getNoteLocation, listCategoryNotes,
  listFoldersByParent, listItemsByFolder, listNoteIdsInFolders, markDisabled, markIndexed,
  markPending, moveItemToFolder, nextUpdatedAt, updateNote, vfsDependencies, type MemoryVfsDependencies, type VfsFolder, type VfsFolderItem, type VfsNote,
} from '../repository/vfs.ts';
import {
  cacheResult, cleanupFlushReceipts as deleteFlushReceipts, clearReservation,
  getCachedResult, getFlushReceipt as readFlushReceipt,
  listFlushReceipts, renewReservation, tryReserve, type Reservation,
} from '../repository/idempotency.ts';
import { MemoryWriteStore, type WriteMode } from './write-store.ts';
import { FactDecisionBreaker, type SmartWriteSource } from './fact-decision.ts';
import {
  decodeCategoryKey, extractMemberIds, refreshAllCategories, type CategoryRefreshHost,
} from './category-manager.ts';
import { MemorySearchStore } from './search-store.ts';
import { compressMemoryResults } from './memory-compressor.ts';
import type { LogService } from '../../../platform/log/api.ts';
import type { NotesService } from '../../notes/api.ts';
import type { AnkiService } from '../../anki/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { RetrievalService, VfsIndexService } from '../../vfs-index/api.ts';
import {
  MemoryDailyLogStore, type DailyLogAppendOutcome,
} from './daily-log-store.ts';
export type { DailyLogAppendOutcome } from './daily-log-store.ts';
import { MemoryExtractionStore } from './extraction-store.ts';
import {
  isProfileContentEmpty, renderLearnerProfile, type LearnerProfile, type LearnerProfileUpdate,
} from './learner-profile.ts';
import {
  EvolutionThrottle, runThrottledEvolution, type EvolutionCycleHost,
} from './evolution-cycle.ts';

export type { WriteMode } from './write-store.ts';

export {
  CONTENT_LIMITS, TAG_ARCHIVED, TAG_HITS_PREFIX, TAG_IMPORTANT, TAG_LAST_HIT_PREFIX,
  TAG_LAST_INJECTED_PREFIX, TAG_NEEDS_DEDUP_REVIEW, TAG_PURPOSE_PREFIX, TAG_REF_PREFIX,
  TAG_STALE, TAG_TYPE_PREFIX, PROFILE_NOTE_TITLE, SYSTEM_FOLDER_TITLE, LOG_TARGET,
  DAILY_LOG_CAS_MAX_RETRIES, TIME_DECAY_HALF_LIFE_DAYS, MAX_BATCH_ITEMS,
  computeTagWeight, extractHits, factHardRejectReason, folderJson, isDailyLogRetryable,
  isReservedSystemName, itemJson, localDateStamp, memoryTags, memoryPurposeFromTags,
  memoryTypeFromTags, normalizeFolderSegments, parseMemoryPurpose, parseMemoryType,
  purposeMatches, purposeSearchWeight, relativizeFolderPath, sameText,
  shouldDowngradeSmartMutation, typeTag, validateExpectedVersion, errorText, ctxGet,
} from './memory-utils.ts';
import {
  CONTENT_LIMITS, MAX_BATCH_ITEMS, SYSTEM_FOLDER_TITLE, PROFILE_NOTE_TITLE, LOG_TARGET,
  DAILY_LOG_CAS_MAX_RETRIES, TIME_DECAY_HALF_LIFE_DAYS, TAG_ARCHIVED, TAG_HITS_PREFIX,
  TAG_IMPORTANT, TAG_LAST_HIT_PREFIX, TAG_LAST_INJECTED_PREFIX, TAG_NEEDS_DEDUP_REVIEW,
  TAG_PURPOSE_PREFIX, TAG_REF_PREFIX, TAG_STALE, TAG_TYPE_PREFIX,
  computeTagWeight, errorText, extractHits, factHardRejectReason, folderJson,
  isDailyLogRetryable, isReservedSystemName, itemJson, localDateStamp, memoryTags,
  memoryPurposeFromTags, memoryTypeFromTags, normalizeFolderSegments, parseMemoryPurpose,
  parseMemoryType, purposeMatches, relativizeFolderPath, sameText,
  shouldDowngradeSmartMutation, typeTag, validateExpectedVersion, ctxGet,
  type AuditInput,
} from './memory-utils.ts';

export class MemoryServiceImpl extends Service implements MemoryService {
  readonly version = 1 as const;
  readonly _config: MemoryConfig;
  readonly insightJobs: InsightJobQueue;
  private readonly profiles: MemoryProfileStore;
  private readonly dailyLog: MemoryDailyLogStore;
  private readonly extraction: MemoryExtractionStore;
  private readonly searchStore: MemorySearchStore;
  private readonly writes: MemoryWriteStore;
  private insightProjectionOwner: AnkiService | null = null;
  private readonly hostCtx: Context;
  private depsCache: MemoryVfsDependencies | null = null;
  private readonly warnedMaintenance = new Set<string>();
  readonly decisionBreaker = new FactDecisionBreaker();
  private readonly evolutionThrottle = new EvolutionThrottle();
  private readonly promotionThrottle = new PromotionThrottle();
  private readonly semanticDedupThrottle = new SemanticDedupThrottle();
  private maintenanceChain: Promise<void> = Promise.resolve();
  /** Set while an idempotent smart write owns a transaction (note + receipt commit together). */
  private dbOverride: DatabaseHandle | null = null;
  constructor(ctx: Context) {
    super(ctx, 'memory');
    this.hostCtx = ctx;
    this._config = new MemoryConfig(() => this.db, () => this.deps, message => this.warn(message));
    this.insightJobs = createInsightJobQueue(() => this.db);
    this.profiles = new MemoryProfileStore(this);
    this.dailyLog = new MemoryDailyLogStore(this);
    this.extraction = new MemoryExtractionStore(this);
    this.searchStore = new MemorySearchStore(this);
    this.writes = new MemoryWriteStore(this);
    // L16 is only needed by SRS projection jobs; other memory commands may start without it.
    ctx.inject(['anki'], scoped => {
      this.insightProjectionOwner = scoped.anki;
      scoped.effect(() => () => { this.insightProjectionOwner = null; });
    });
  }
  get config(): MemoryConfig { return this._config; }
  get hostContext(): Context { return this.hostCtx; }
  get vfsDatabase(): DatabaseHandle { return this.hostCtx.storage.database('vfs'); }
  withDbOverride<T>(db: DatabaseHandle, fn: () => T): T {
    this.dbOverride = db;
    try { return fn(); } finally { this.dbOverride = null; }
  }
  /**
   * ARCHITECTURE 附录 A names are preferred; the legacy `@1` keys stay readable
   * until the providing lanes rename their `ctx.provide` calls.
   */
  get deps(): MemoryVfsDependencies {
    if (this.depsCache !== null) return this.depsCache;
    const notes = ctxGet(this.hostCtx, 'notes') as
      NotesService | undefined;
    const repos = ctxGet(this.hostCtx, 'vfsRepo') as
      VfsReposService | undefined;
    if (notes === undefined) throw new Error('notes service is not available');
    if (repos === undefined) throw new Error('vfsRepo service is not available');
    this.depsCache = vfsDependencies(notes, repos);
    return this.depsCache;
  }
  get db(): DatabaseHandle { return this.dbOverride ?? this.hostCtx.storage.database('vfs'); }
  warn(message: string): void {
    this.hostCtx.log.logger(LOG_TARGET).warn(message);
  }
  info(message: string): void {
    this.hostCtx.log.logger(LOG_TARGET).info(message);
  }
  debug(message: string): void {
    this.hostCtx.log.logger(LOG_TARGET).debug(message);
  }
  warnOnce(key: string, message: string): void {
    if (this.warnedMaintenance.has(key)) return;
    this.warnedMaintenance.add(key);
    this.warn(message);
  }
  /** Rust `mark_pending` is best-effort at every call site. */
  markPendingBestEffort(resourceId: string): void {
    try { markPending(this.deps, this.db, resourceId); }
    catch (error) { this.warn(`[Memory] Failed to mark pending for indexing: ${errorText(error)}`); }
  }
  markDisabledBestEffort(resourceId: string, reason: string): void {
    try { markDisabled(this.deps, this.db, resourceId, reason); }
    catch (error) { this.warn(`[Memory] Failed to mark index disabled for ${resourceId}: ${errorText(error)}`); }
  }

  getAutoExtractFrequency() { return this._config.getAutoExtractFrequency(); }
  getEvolutionTuning() { return this._config.getEvolutionTuning(); }
  isPrivacyMode() { return this._config.isPrivacyMode(); }
  isAutoCreateSubfolders() { return this._config.isAutoCreateSubfolders(); }
  getDefaultCategory() { return this._config.getDefaultCategory(); }
  setPrivacyMode(enabled: boolean) { this._config.setPrivacyMode(enabled); }
  setAutoCreateSubfolders(enabled: boolean) { this._config.setAutoCreateSubfolders(enabled); }
  setDefaultCategory(category: string) { this._config.setDefaultCategory(category); }
  setAutoExtractFrequency(frequency: AutoExtractFrequency) { this._config.setAutoExtractFrequency(frequency); }
  queryAuditLogs(limit: number, offset: number, source: string | null,
    operation: string | null, success: boolean | null) {
    return queryAuditLogs(this.db, limit, offset, source, operation, success);
  }

  // ---------------------------------------------------------------- folders

  getConfig(): MemoryConfigOutput {
    const configured = this._config.getRootFolderId();
    const folder = configured === null ? undefined : getFolder(this.db, configured);
    return {
      memoryRootFolderId: folder?.id ?? null,
      memoryRootFolderTitle: folder?.title ?? null,
      autoCreateSubfolders: this._config.isAutoCreateSubfolders(),
      defaultCategory: this._config.getDefaultCategory(),
      privacyMode: this._config.isPrivacyMode(),
      autoExtractFrequency: this._config.getAutoExtractFrequency(),
    };
  }
  setRootFolder(folderId: string): void {
    if (!folderExists(this.db, folderId)) throw new Error(`Folder not found: ${folderId}`);
    const folder = getFolder(this.db, folderId);
    if (folder !== undefined && isReservedSystemName(folder.title)) {
      throw new Error("Invalid argument 'folder_id': 记忆根目录不能使用系统保留目录（'__*'）");
    }
    this._config.setRootFolderId(folderId);
  }
  createRootFolder(title: string): string { return this._config.createRootFolder(title); }
  getOrCreateRootFolder(): string { return this._config.getOrCreateRootFolder(); }

  rootId(): string { return this._config.getOrCreateRootFolder(); }
  private rootTitle(rootId: string): string | null { return getFolder(this.db, rootId)?.title ?? null; }
  ensureFolder(rootId: string, path: string): string {
    const parts = normalizeFolderSegments(path, this.rootTitle(rootId));
    let parentId = rootId;
    for (const part of parts) {
      const existing = listFoldersByParent(this.db, parentId).find(folder => folder.title.trim() === part);
      if (existing !== undefined) { parentId = existing.id; continue; }
      parentId = createFolder(this.deps, this.db, part, parentId).id;
    }
    return parentId;
  }
  private resolveFolderId(rootId: string, path: string): string | null {
    const parts = normalizeFolderSegments(path, this.rootTitle(rootId));
    let current = rootId;
    for (const part of parts) {
      const existing = listFoldersByParent(this.db, current).find(folder => folder.title.trim() === part);
      if (existing === undefined) return null;
      current = existing.id;
    }
    return current;
  }
  validateFolderPath(path: string | null | undefined): void {
    if (path === null || path === undefined) return;
    for (const segment of normalizeFolderSegments(path, null)) {
      if (isReservedSystemName(segment)) {
        throw new Error("Invalid argument 'folder_path': 路径包含系统保留目录（'__*'）");
      }
    }
  }
  resolveWriteTargetFolderId(folderPath: string | null | undefined, strictMissing: boolean): string {
    const rootId = this.rootId();
    const autoCreate = this._config.isAutoCreateSubfolders();
    const defaultCategory = this._config.getDefaultCategory();
    const hasDefault = defaultCategory.trim().length > 0;
    if (folderPath !== null && folderPath !== undefined) {
      if (folderPath === '') {
        if (hasDefault) {
          if (autoCreate) return this.ensureFolder(rootId, defaultCategory);
          const existing = this.resolveFolderId(rootId, defaultCategory);
          if (existing !== null) return existing;
        }
        return rootId;
      }
      if (autoCreate) return this.ensureFolder(rootId, folderPath);
      const found = this.resolveFolderId(rootId, folderPath);
      if (strictMissing && found === null) throw new Error(`Folder not found: ${folderPath}`);
      return found ?? rootId;
    }
    if (hasDefault) {
      if (autoCreate) return this.ensureFolder(rootId, defaultCategory);
      return this.resolveFolderId(rootId, defaultCategory) ?? rootId;
    }
    return rootId;
  }
  isNoteInMemoryRoot(noteId: string, rootId: string): boolean {
    const location = getNoteLocation(this.db, noteId);
    if (location === undefined || location.folderId === null) return false;
    if (location.folderId === rootId) return true;
    return getFolderIdsRecursive(this.db, rootId).includes(location.folderId);
  }
  ensureNoteInMemoryRoot(noteId: string): VfsNote {
    const rootId = this.rootId();
    const note = getNote(this.deps, this.db, noteId);
    if (note === undefined) throw new Error(`Note not found: ${noteId}`);
    if (!this.isNoteInMemoryRoot(noteId, rootId)) throw new Error(`MemoryNote not found: ${noteId}`);
    return note;
  }
  private ensureNoteWithinRoot(noteId: string): VfsNote {
    const rootId = this.rootId();
    const note = getNote(this.deps, this.db, noteId);
    if (note === undefined) throw new Error(`Note not found: ${noteId}`);
    if (!this.isNoteInMemoryRoot(noteId, rootId)) throw new Error(`MemoryNote not found: ${noteId}`);
    return note;
  }
  noteRelativeFolderPath(noteId: string): string {
    const rootId = this.rootId();
    const rootPath = buildFolderPath(this.db, rootId);
    return relativizeFolderPath(getNoteLocation(this.db, noteId)?.folderPath ?? '', rootPath);
  }
  private findSystemFolderId(rootId: string): string | null {
    return listFoldersByParent(this.db, rootId).find(folder => folder.title === SYSTEM_FOLDER_TITLE)?.id ?? null;
  }
  private ensureSystemFolderId(): string {
    const rootId = this.rootId();
    const existing = this.findSystemFolderId(rootId);
    if (existing !== null) return existing;
    return createFolder(this.deps, this.db, SYSTEM_FOLDER_TITLE, rootId).id;
  }
  private findNoteInRootOrSystem(title: string): VfsNote | undefined {
    const rootId = this.rootId();
    const systemId = this.findSystemFolderId(rootId);
    if (systemId !== null) {
      const note = findNoteByTitle(this.db, systemId, title);
      if (note !== undefined) return note;
    }
    return findNoteByTitle(this.db, rootId, title);
  }

  // ---------------------------------------------------------------- daily log

  findDailyLogFolderId(): string | null { return this.dailyLog.findDailyLogFolderId(); }

  dailyLogSnapshot(date: string): { noteId: string; updatedAt: string; content: string } | null {
    return this.dailyLog.dailyLogSnapshot(date);
  }

  appendDailyLog(date: string, entry: string,
    beforeFirstCommit?: () => void): DailyLogAppendOutcome {
    return this.dailyLog.appendDailyLog(date, entry, beforeFirstCommit);
  }

  // ---------------------------------------------------------------- learner profile

  loadProfile(): LearnerProfile | null { return this.profiles.loadProfile(); }

  renderLearnerProfile(profile: LearnerProfile): string { return renderLearnerProfile(profile); }

  isProfileContentEmpty(profile: LearnerProfile): boolean { return isProfileContentEmpty(profile); }

  loadProfileHistory(): LearnerProfile[] { return this.profiles.loadProfileHistory(); }

  profileHistorySnapshot(): { noteId: string; updatedAt: string; content: string } | null {
    return this.profiles.profileHistorySnapshot();
  }

  applyProfileUpdate(update: LearnerProfileUpdate,
    options: ProfileUpdateOptions): LearnerProfileApplyOutcome {
    return this.profiles.applyProfileUpdate(update, options);
  }

  applyProfilePromotionUpdate(update: LearnerProfileUpdate, fingerprint: string,
    options: ProfileUpdateOptions): LearnerProfileApplyOutcome {
    return this.profiles.applyProfilePromotionUpdate(update, fingerprint, options);
  }

  /** Rust `upsert_weak_point_from_mastery` (mastery hard reflux). */
  upsertWeakPointFromMastery(concept: string, evidence: MasteryWeakPointEvidence): void {
    this.profiles.upsertWeakPointFromMastery(concept, evidence);
  }

  /** Rust `remove_weak_point_from_mastery` (mastery recovery). */
  removeWeakPointFromMastery(concept: string): void {
    this.profiles.removeWeakPointFromMastery(concept);
  }

  // ---------------------------------------------------------------- read/write

  read(noteId: string): MemoryReadOutput | null { return this.writes.read(noteId); }

  /** `handlers.rs:249 memory_read` returns `get_note_folder_path` (root title included), not the relative path tools use. */
  readWithAbsoluteFolderPath(noteId: string): MemoryReadOutput | null {
    const note = this.read(noteId);
    if (note === null) return null;
    return { ...note, folderPath: getNoteLocation(this.db, noteId)?.folderPath ?? '' };
  }

  write(folderPath: string | null | undefined, title: string, content: string,
    mode: WriteMode): MemoryWriteOutput {
    return this.writes.write(folderPath, title, content, mode);
  }

  appendById(noteId: string, title: string, content: string): MemoryWriteOutput {
    return this.writes.appendById(noteId, title, content);
  }

  /** Rust `update_by_id_with_source`; command handlers keep the default `handler` source. */
  updateById(noteId: string, title: string | null, content: string | null,
    source: 'handler' | 'tool_call' | 'semantic_dedup' = 'handler'): MemoryWriteOutput {
    return this.writes.updateById(noteId, title, content, source);
  }

  /** Rust `delete_with_source`. */
  async delete(noteId: string, source: 'handler' | 'tool_call' | 'semantic_dedup' = 'handler'): Promise<void> {
    return this.writes.delete(noteId, source);
  }

  /**
   * Rust `MemoryNoteDeleteHook::capture_delete`
   * (`dstu-memory/src/memory/delete_hook.rs:92`).
   *
   * Captures the memory context before the VFS note is soft-deleted and returns
   * a continuation that purges index artifacts and writes a handler audit row.
   * Any lookup failure means "not a memory note", matching the Rust `ok()?`
   * chain so generic note deletion is never blocked.
   */
  captureNoteDelete(noteId: string): (() => void) | null {
    try {
      const rootId = this._config.getRootFolderId();
      if (rootId === null) return null;
      const note = getNote(this.deps, this.db, noteId);
      const location = getNoteLocation(this.db, noteId);
      if (note === undefined || location === undefined || location.folderId === null) return null;
      if (location.folderId !== rootId
        && !getFolderIdsRecursive(this.db, rootId).includes(location.folderId)) {
        return null;
      }
      return () => this.cleanupDeletedMemoryNote(noteId, note.resourceId, note.title);
    } catch (error) {
      this.warn(`[Memory] Failed to capture memory note delete context for ${noteId}: ${errorText(error)}`);
      return null;
    }
  }

  /** Rust `cleanup_deleted_memory_note`: best-effort index purge + audit. */
  private cleanupDeletedMemoryNote(noteId: string, resourceId: string, title: string): void {
    const index = ctxGet(this.hostCtx, 'vfsIndex') as VfsIndexService | undefined;
    if (index === undefined) {
      this.warn(`[Memory] vfsIndex is not available; deleted memory note ${noteId} index cleanup skipped`);
    } else {
      void index.indexing.deleteResourceIndex(resourceId).catch(error => {
        this.warn(`[Memory] Failed to purge index artifacts for deleted memory note ${noteId}: ${errorText(error)}`);
      });
    }
    insertAuditLog(this.db, {
      source: 'handler', operation: 'delete', success: true,
      noteId, title, contentPreview: null, folder: null, event: 'DELETE',
      confidence: null,
      reason: 'user_ui: 用户经 VFS/DSTU UI 删除记忆笔记 (vfs_delete_note)',
      sessionId: null, durationMs: null, extraJson: null,
    }, message => this.warn(message));
  }

  // ---------------------------------------------------------------- search

  /** Rust `MemoryService::search` (user retrieval purpose). */
  async search(query: string, topK: number,
    signal: AbortSignal | null = null): Promise<MemorySearchResult[]> {
    return this.searchStore.search(query, topK, signal);
  }

  /** Rust `MemoryConfig::get_root_folder_id` (configured id only, no folder creation). */
  getRootFolderId(): string | null { return this._config.getRootFolderId(); }

  /** Rust `MemoryCompressor::compress`; missing L02 provider degrades to passthrough. */
  async compress(query: string,
    results: MemorySearchResult[]): Promise<CompressedRetrievalMemory[]> {
    return compressMemoryResults(() => this.memoryDecisionCompletion(), query, results,
      message => this.warn(message));
  }

  async searchWithRerank(query: string, topK: number,
    useQueryRewrite: boolean): Promise<MemorySearchResult[]> {
    return this.searchStore.searchWithRerank(query, topK, useQueryRewrite);
  }

  async searchWithEmbeddingForPurpose(query: string, _queryEmbedding: readonly number[],
    topK: number, purpose: 'user_retrieval' | 'internal_dedup'): Promise<MemorySearchResult[]> {
    return this.searchStore.searchWithEmbeddingForPurpose(query, _queryEmbedding, topK, purpose);
  }

  async searchWithEmbedding(query: string, queryEmbedding: readonly number[],
    topK: number): Promise<MemorySearchResult[]> {
    return this.searchStore.searchWithEmbedding(query, queryEmbedding, topK);
  }

  async searchForPurpose(query: string, topK: number,
    purpose: 'user_retrieval' | 'internal_dedup'): Promise<MemorySearchResult[]> {
    return this.searchStore.searchForPurpose(query, topK, purpose);
  }

  /** Rust `insight_run_jobs`: drive one consolidation batch on the current databases. */
  runInsightJobs(batchSize: number): number {
    const worker = new InsightJobWorker({
      vfs: this.hostCtx.storage.database('vfs'),
      mistakes: this.hostCtx.storage.database('mistakes'),
      todos: this.deps.repos.todos,
      warn: message => this.warn(message),
      projectionOwner: () => {
        if (this.insightProjectionOwner === null) {
          throw new Error('anki owner service is not available for insight projection');
        }
        return this.insightProjectionOwner;
      },
    });
    return worker.runOnce(batchSize);
  }

  // ---------------------------------------------------------------- post-write side effects

  /** Rust handlers' `trigger_immediate_index` (fire-and-forget, failures only warn). */
  async triggerImmediateIndex(resourceId: string): Promise<void> {
    const index = this.hostCtx.get('vfsIndex') as VfsIndexService | undefined;
    if (index === undefined) {
      this.warn(`[Memory] vfsIndex is not available; immediate index for ${resourceId} skipped`);
      return;
    }
    try {
      const [chunkCount, dim] = await index.indexing.indexResource(resourceId, null, null);
      try { markIndexed(this.deps, this.db, resourceId, `mem_handler_${Date.now()}`); }
      catch (error) {
        this.warn(`[Memory] Failed to mark indexed after immediate indexing: ${errorText(error)}`);
      }
      this.hostCtx.log.logger(LOG_TARGET).info(
        `[Memory] Immediate index completed for resource ${resourceId} (${chunkCount} chunks, dim=${dim})`);
    } catch (error) {
      this.warn(`[Memory] Immediate index failed for resource ${resourceId} (will retry in next batch): ${errorText(error)}`);
    }
  }

  /** Rust `spawn_post_write_maintenance` (serialized, never blocks the write path). */
  spawnPostWriteMaintenance(): Promise<void> {
    const run = this.maintenanceChain.then(() => this.runPostWriteMaintenance());
    this.maintenanceChain = run.catch(error => {
      try { this.warn(`[Memory] Post-write maintenance chain failed: ${errorText(error)}`); }
      catch { /* boundary-allow empty-catch: 插件停用后 log 服务已不可取，后台维护链不能留下未处理的 rejection */ }
    });
    return run;
  }

  /** Fire-and-forget companion used by command handlers after a committed write. */
  scheduleAfterWrite(resourceIds: readonly (string | null | undefined)[]): void {
    for (const resourceId of resourceIds) {
      if (resourceId !== null && resourceId !== undefined && resourceId !== '') {
        void this.triggerImmediateIndex(resourceId);
      }
    }
    void this.spawnPostWriteMaintenance();
  }

  private async runPostWriteMaintenance(): Promise<void> {
    try { this.refreshProfileSummary(); }
    catch (error) { this.warn(`[Memory] Post-write profile refresh failed: ${errorText(error)}`); }

    const frequency = this._config.getAutoExtractFrequency();
    const privacyMode = this._config.isPrivacyMode();
    // Privacy mode skips every pass that sends memory content to the model.
    if (!privacyMode) {
      let shouldRefresh = false;
      try { shouldRefresh = shouldRefreshCategories(frequency, countActiveMemories(this.db, this.rootId())); }
      catch { /* boundary-allow empty-catch: Rust `count_active_memories` 失败按不刷新处理且无日志 */ }
      if (shouldRefresh) {
        try { await refreshAllCategories(this.categoryRefreshHost()); }
        catch (error) { this.warn(`[Memory] Post-write category refresh failed: ${errorText(error)}`); }
      }
    }
    await runThrottledEvolution(this.evolutionCycleHost(), evolutionIntervalMs(frequency), this.evolutionThrottle);
    if (!privacyMode) {
      await runPromotionThrottled(this.promotionPassHost(), evolutionIntervalMs(frequency), this.promotionThrottle);
      await runSemanticDedupThrottled(createSemanticDedupHost(this), frequency, this.semanticDedupThrottle);
    }
  }

  private maintenanceLog() {
    return {
      info: (message: string) => this.hostCtx.log.logger(LOG_TARGET).info(message),
      warn: (message: string) => this.warn(message),
      debug: (message: string) => this.hostCtx.log.logger(LOG_TARGET).debug(message),
    };
  }

  private categoryRefreshHost(): CategoryRefreshHost {
    return {
      db: this.db,
      deps: this.deps,
      getTree: () => this.getTree(),
      listShallow: (folderPath, limit, offset) => this.listShallow(folderPath, limit, offset),
      systemFolderId: () => this.ensureSystemFolderId(),
      completion: () => this.memoryDecisionCompletion(),
      log: this.maintenanceLog(),
    };
  }

  private promotionPassHost(): PromotionPassHost {
    return {
      listRecentDailyLogs: days => this.dailyLog.listRecent(days),
      getConfig: key => this._config.get(key),
      setConfig: (key, value) => this._config.set(key, value),
      loadProfile: () => this.loadProfile(),
      applyProfilePromotionUpdate: (update, fingerprint, options) =>
        this.applyProfilePromotionUpdate(update, fingerprint, options),
      completion: () => this.memoryDecisionCompletion(),
      log: this.maintenanceLog(),
      nowMs: () => Date.now(),
    };
  }

  private evolutionCycleHost(): EvolutionCycleHost {
    return {
      db: this.db,
      deps: this.deps,
      tuning: this._config.getEvolutionTuning(),
      list: (folderPath, limit, offset) => this.list(folderPath, limit, offset),
      listShallow: (folderPath, limit, offset) => this.listShallow(folderPath, limit, offset),
      getTree: () => this.getTree(),
      markPending: resourceId => this.markPendingBestEffort(resourceId),
      disableIndex: (resourceId, reason) => this.disableIndexForEvolution(resourceId, reason),
      audit: entry => insertAuditLog(this.db, entry, message => this.warn(message)),
      log: {
        info: message => this.hostCtx.log.logger(LOG_TARGET).info(message),
        warn: message => this.warn(message),
        debug: message => this.hostCtx.log.logger(LOG_TARGET).debug(message),
      },
      nowMs: () => Date.now(),
    };
  }

  /** Rust `MemoryEvolution::remove_resource_from_index`. */
  private async disableIndexForEvolution(resourceId: string, reason: string): Promise<void> {
    const index = ctxGet(this.hostCtx, 'vfsIndex') as VfsIndexService | undefined;
    if (index !== undefined) {
      try { await index.indexing.deleteResourceIndex(resourceId); }
      catch (error) {
        this.warn(`[MemoryEvolution] Failed to delete vector chunks for ${resourceId}: ${errorText(error)}`);
      }
    }
    this.markDisabledBestEffort(resourceId, reason);
  }

  // ---------------------------------------------------------------- listing

  list(folderPath: string | null | undefined, limit: number, offset: number): MemoryListItem[] {
    const rootId = this.rootId();
    const rootPath = buildFolderPath(this.db, rootId);
    let targetId = rootId;
    if (folderPath !== null && folderPath !== undefined && folderPath !== '') {
      const resolved = this.resolveFolderId(rootId, folderPath);
      if (resolved === null) return [];
      targetId = resolved;
    }
    const folderIds = getFolderIdsRecursive(this.db, targetId);
    const items: MemoryListItem[] = [];
    for (const noteId of listNoteIdsInFolders(this.db, folderIds, limit, offset)) {
      const note = getNote(this.deps, this.db, noteId);
      if (note === undefined) continue;
      const folderPathValue = relativizeFolderPath(getNoteLocation(this.db, note.id)?.folderPath ?? '', rootPath);
      items.push({
        id: note.id, title: note.title, folderPath: folderPathValue, updatedAt: note.updatedAt,
        hits: extractHits(note.tags),
        isImportant: note.tags.includes(TAG_IMPORTANT),
        isStale: note.tags.includes(TAG_STALE),
        isArchived: note.tags.includes(TAG_ARCHIVED),
        needsDedupReview: note.tags.includes(TAG_NEEDS_DEDUP_REVIEW),
        memoryType: memoryTypeFromTags(note.tags),
        memoryPurpose: memoryPurposeFromTags(note.tags),
      });
    }
    return items;
  }

  getTree(): Record<string, unknown> | null {
    const rootId = this.rootId();
    const rootFolder = getFolder(this.db, rootId);
    if (rootFolder === undefined) return null;
    const build = (parentId: string): Record<string, unknown>[] => {
      const nodes = listFoldersByParent(this.db, parentId).map(folder => ({
        folder: folderJson(folder),
        children: build(folder.id),
        items: listItemsByFolder(this.db, folder.id).map(itemJson),
      }));
      return nodes.sort((a, b) =>
        (a.folder as { sortOrder: number }).sortOrder - (b.folder as { sortOrder: number }).sortOrder);
    };
    return { folder: folderJson(rootFolder), children: build(rootId),
      items: listItemsByFolder(this.db, rootId).map(itemJson) };
  }

  listShallow(folderPath: string | null | undefined, limit: number, offset: number): MemoryListItem[] {
    const rootId = this.rootId();
    const rootPath = buildFolderPath(this.db, rootId);
    const targetId = folderPath === null || folderPath === undefined || folderPath === ''
      ? rootId : this.resolveFolderId(rootId, folderPath);
    if (targetId === null) return [];
    return listNoteIdsInFolders(this.db, [targetId], limit, offset).flatMap(noteId => {
      const note = getNote(this.deps, this.db, noteId);
      if (note === undefined) return [];
      return [{
        id: note.id, title: note.title,
        folderPath: relativizeFolderPath(getNoteLocation(this.db, note.id)?.folderPath ?? '', rootPath),
        updatedAt: note.updatedAt, hits: extractHits(note.tags),
        isImportant: note.tags.includes(TAG_IMPORTANT), isStale: note.tags.includes(TAG_STALE),
        isArchived: note.tags.includes(TAG_ARCHIVED),
        needsDedupReview: note.tags.includes(TAG_NEEDS_DEDUP_REVIEW),
        memoryType: memoryTypeFromTags(note.tags), memoryPurpose: memoryPurposeFromTags(note.tags),
      }];
    });
  }

  // ---------------------------------------------------------------- relations/tags

  addRelation(noteIdA: string, noteIdB: string): void {
    const noteA = this.ensureNoteInMemoryRoot(noteIdA);
    const noteB = this.ensureNoteInMemoryRoot(noteIdB);
    this.addRelationWithOcc(noteIdA, noteA.updatedAt, noteIdB, noteB.updatedAt);
  }

  addRelationWithOcc(noteIdA: string, expectedA: string, noteIdB: string, expectedB: string,
    source: SmartWriteSource = 'handler', sessionId: string | null = null): {
    noteA: VfsNote; noteB: VfsNote; changed: boolean;
  } {
    if (noteIdA === noteIdB) throw new Error('不能将记忆与自身建立关联');
    this.ensureNoteInMemoryRoot(noteIdA);
    this.ensureNoteInMemoryRoot(noteIdB);
    const { db, noteA, noteB } = this.readRelationEndpoints(noteIdA, expectedA, noteIdB, expectedB);
    const refAb = `${TAG_REF_PREFIX}${noteIdB}`;
    const refBa = `${TAG_REF_PREFIX}${noteIdA}`;
    const result = relationSavepoint(db, scope => {
      const updatedA = noteA.tags.includes(refAb) ? noteA
        : updateNote(this.deps, scope, noteIdA, { tags: [...noteA.tags, refAb], expectedUpdatedAt: noteA.updatedAt });
      const updatedB = noteB.tags.includes(refBa) ? noteB
        : updateNote(this.deps, scope, noteIdB, { tags: [...noteB.tags, refBa], expectedUpdatedAt: noteB.updatedAt });
      return { noteA: updatedA, noteB: updatedB, changed: updatedA !== noteA || updatedB !== noteB };
    });
    this.info(`[Memory] Added relation: ${noteIdA} <-> ${noteIdB}`);
    this.audit({ source, operation: 'add_relation', success: true, noteId: noteIdA,
      reason: `关联 ${noteIdA} <-> ${noteIdB}`, sessionId });
    return result;
  }

  removeRelation(noteIdA: string, noteIdB: string): void {
    const noteA = this.ensureNoteInMemoryRoot(noteIdA);
    const noteB = this.ensureNoteInMemoryRoot(noteIdB);
    this.removeRelationWithOcc(noteIdA, noteA.updatedAt, noteIdB, noteB.updatedAt);
  }

  removeRelationWithOcc(noteIdA: string, expectedA: string, noteIdB: string, expectedB: string,
    source: SmartWriteSource = 'handler', sessionId: string | null = null): {
    noteA: VfsNote; noteB: VfsNote; changed: boolean;
  } {
    if (noteIdA === noteIdB) {
      throw new Error("Invalid argument 'note_id_b': relation endpoints must be different");
    }
    this.ensureNoteInMemoryRoot(noteIdA);
    this.ensureNoteInMemoryRoot(noteIdB);
    const { db, noteA, noteB } = this.readRelationEndpoints(noteIdA, expectedA, noteIdB, expectedB);
    const result = relationSavepoint(db, scope => {
      const tagsA = noteA.tags.filter(tag => tag !== `${TAG_REF_PREFIX}${noteIdB}`);
      const tagsB = noteB.tags.filter(tag => tag !== `${TAG_REF_PREFIX}${noteIdA}`);
      const updatedA = tagsA.length === noteA.tags.length ? noteA
        : updateNote(this.deps, scope, noteIdA, { tags: tagsA, expectedUpdatedAt: noteA.updatedAt });
      const updatedB = tagsB.length === noteB.tags.length ? noteB
        : updateNote(this.deps, scope, noteIdB, { tags: tagsB, expectedUpdatedAt: noteB.updatedAt });
      return { noteA: updatedA, noteB: updatedB, changed: updatedA !== noteA || updatedB !== noteB };
    });
    this.info(`[Memory] Removed relation: ${noteIdA} <-> ${noteIdB}`);
    this.audit({ source, operation: 'remove_relation', success: true, noteId: noteIdA,
      reason: `解除关联 ${noteIdA} <-> ${noteIdB}`, sessionId });
    return result;
  }

  /**
   * Rust add/remove_relation_with_occ (service.rs:3620-3637, 3741-3758): both endpoints are
   * read on the connection and version-checked before any savepoint or write lock.
   */
  private readRelationEndpoints(noteIdA: string, expectedA: string, noteIdB: string,
    expectedB: string): { db: DatabaseHandle; noteA: VfsNote; noteB: VfsNote } {
    const db = this.db;
    const noteA = getNote(this.deps, db, noteIdA);
    if (noteA === undefined) throw new Error(`MemoryNote not found: ${noteIdA}`);
    const noteB = getNote(this.deps, db, noteIdB);
    if (noteB === undefined) throw new Error(`MemoryNote not found: ${noteIdB}`);
    validateExpectedVersion(noteA, expectedA);
    validateExpectedVersion(noteB, expectedB);
    return { db, noteA, noteB };
  }

  getRelated(noteId: string): string[] {
    return this.ensureNoteInMemoryRoot(noteId).tags
      .filter(tag => tag.startsWith(TAG_REF_PREFIX))
      .map(tag => tag.slice(TAG_REF_PREFIX.length));
  }
  getRelatedIds(noteId: string): string[] { return this.getRelated(noteId); }

  getTags(noteId: string): string[] { return this.ensureNoteInMemoryRoot(noteId).tags; }

  updateTags(noteId: string, userTags: readonly string[]): void {
    this.writes.updateTags(noteId, userTags);
  }

  updateTagsWithOcc(noteId: string, expectedUpdatedAt: string,
    userTags: readonly string[], source: SmartWriteSource = 'handler',
    sessionId: string | null = null): [VfsNote, VfsNote] {
    return this.writes.updateTagsWithOcc(noteId, expectedUpdatedAt, userTags, source, sessionId);
  }

  removeStaleTag(note: VfsNote, sessionId: string | null): VfsNote {
    return this.writes.removeStaleTag(note, sessionId);
  }

  restoreStale(noteId: string): boolean { return this.writes.restoreStale(noteId); }

  restoreArchived(noteId: string): boolean { return this.writes.restoreArchived(noteId); }

  moveToFolder(noteId: string, targetFolderPath: string): void {
    this.writes.moveToFolder(noteId, targetFolderPath);
  }

  moveToFolderWithOcc(noteId: string, expectedUpdatedAt: string,
    targetFolderPath: string, source: SmartWriteSource = 'handler',
    sessionId: string | null = null): [VfsNote, string] {
    return this.writes.moveToFolderWithOcc(noteId, expectedUpdatedAt, targetFolderPath, source, sessionId);
  }

  async batchDelete(noteIds: readonly string[]): Promise<BatchOperationResult & { changedIds: string[] }> {
    return this.writes.batchDelete(noteIds);
  }

  batchMove(noteIds: readonly string[], targetFolderPath: string): BatchOperationResult & { changedIds: string[] } {
    return this.writes.batchMove(noteIds, targetFolderPath);
  }

  // ---------------------------------------------------------------- export/profile

  exportAll(): MemoryExportItem[] {
    return this.list(null, 500, 0).map(item => ({
      title: item.title, content: getNoteContent(this.deps, this.db, item.id),
      folder: item.folderPath, updatedAt: item.updatedAt,
    }));
  }

  listCategorySummaries(): MemoryProfileSection[] {
    return this.listCategorySummariesWithMembers().map(({ category, content }) => ({ category, content }));
  }

  listCategorySummariesWithMembers(): MemoryCategorySummary[] {
    const rootId = this._config.getRootFolderId();
    if (rootId === null) return [];
    const folderIds: string[] = [];
    const systemId = this.findSystemFolderId(rootId);
    if (systemId !== null) folderIds.push(systemId);
    folderIds.push(rootId);
    const seen = new Set<string>();
    const results: MemoryCategorySummary[] = [];
    for (const folderId of folderIds) {
      for (const note of listCategoryNotes(this.db, folderId)) {
        const key = note.title.startsWith('__cat_') && note.title.endsWith('__')
          ? note.title.slice('__cat_'.length, -2) : note.title;
        const decoded = decodeCategoryKey(key);
        if (seen.has(decoded)) continue;
        seen.add(decoded);
        const content = getNoteContent(this.deps, this.db, note.id);
        if (content.length > 0) results.push({ category: decoded, content, memberIds: extractMemberIds(note.tags) });
      }
    }
    return results;
  }

  getProfileSummary(): string | null {
    const note = this.findNoteInRootOrSystem(PROFILE_NOTE_TITLE);
    if (note === undefined) return null;
    const content = getNoteContent(this.deps, this.db, note.id);
    return content.length === 0 ? null : content;
  }

  /** Rust `refresh_profile_summary` (structured profile from atomic facts, DB only). */
  refreshProfileSummary(): void {
    const systemId = this.ensureSystemFolderId();
    const allMemories = this.list(null, 15, 0);
    if (allMemories.length === 0) return;
    const facts: Array<[string, string]> = [];
    for (const memory of allMemories) {
      if (memory.title.startsWith('__')) continue;
      if (memory.memoryType === 'note') {
        facts.push([memory.folderPath, `[经验笔记] ${memory.title}`]);
        continue;
      }
      if (memory.memoryType === 'study') {
        facts.push([memory.folderPath, `[学习记忆] ${memory.title}`]);
        continue;
      }
      const content = getNoteContent(this.deps, this.db, memory.id);
      facts.push([memory.folderPath, content.length > 0 ? content : memory.title]);
    }
    if (facts.length === 0) return;
    const profileContent = generateStructuredProfile(facts);
    const existing = findNoteByTitle(this.db, systemId, PROFILE_NOTE_TITLE);
    if (existing !== undefined) {
      updateNote(this.deps, this.db, existing.id, { content: profileContent });
      return;
    }
    const note = createNote(this.deps, this.db, {
      title: PROFILE_NOTE_TITLE, content: profileContent, tags: ['_system'],
    }, systemId);
    this.markDisabledBestEffort(note.resourceId, 'system profile note');
  }

  getProfile(): MemoryProfileSection[] {
    if (this._config.getRootFolderId() === null) return [];
    const summaries = this.listCategorySummaries();
    if (summaries.length > 0) return summaries;
    const profile = this.getProfileSummary();
    return profile === null ? [] : [{ category: '画像', content: profile }];
  }

  toAnkiDocument(folderPath: string | null | undefined, purposeFilter: string | null | undefined,
    limit: number): MemoryAnkiDocument {
    const items = this.list(folderPath, Math.min(1000, Math.max(1, limit)), 0);
    const lines: string[] = [];
    let count = 0;
    for (const item of items) {
      if (item.title.startsWith('__')) continue;
      if (purposeFilter !== null && purposeFilter !== undefined && item.memoryPurpose !== purposeFilter) continue;
      const content = getNoteContent(this.deps, this.db, item.id);
      const text = content.length === 0 ? item.title : content;
      lines.push(`## ${item.title}\n\n${text}\n\n---\n`);
      count += 1;
    }
    const documentContent = lines.length === 0 ? ''
      : `# 用户记忆知识卡片\n\n以下是从用户记忆库中提取的 ${count} 条记忆，请为每条生成对应的 Anki 卡片。\n\n${lines.join('\n')}`;
    return { documentContent, memoryCount: count,
      documentName: `记忆卡片_${localDateStamp(new Date())}` };
  }

  // ---------------------------------------------------------------- smart writes

  writeSmart(folderPath: string | null | undefined, title: string, content: string,
    memoryType: MemoryType, purpose: MemoryPurpose | null, idempotencyKey: string | null | undefined,
    source: 'handler' | 'tool_call' | 'auto_extract' = 'handler',
    sessionId: string | null = null): Promise<SmartWriteOutput> {
    return this.writes.writeSmart(folderPath, title, content, memoryType, purpose,
      idempotencyKey, source, sessionId);
  }

  // ------------------------------------------------------- compaction memory flush

  /**
   * L02 `LLMManager::call_memory_decision_raw_prompt` is the only external
   * dependency; tests may provide an `llm` double but the L17 write/idempotency
   * path always stays real (`writeSmart` + `memory_write_idempotency`).
   */
  memoryDecisionCompletion(): MemoryDecisionCompletion {
    const llm = ctxGet(this.hostCtx, 'llmRawPrompt') as Partial<MemoryDecisionCompletion> | undefined;
    const call = llm?.callMemoryDecisionRawPrompt;
    if (llm === undefined || typeof call !== 'function') {
      throw new Error('L02 service does not expose callMemoryDecisionRawPrompt '
        + '(memory decision role); memory model operation cannot run');
    }
    return {
      callMemoryDecisionRawPrompt: (prompt, signal) => call.call(llm, prompt, signal),
    };
  }

  searchForDedup(content: string): Promise<MemorySearchResult[]> {
    return this.searchStore.searchForPurpose(content, 15, 'internal_dedup');
  }

  /** Rust `CompactionMemoryFlush::extract` (`compaction_flush.rs:95`). */
  extractCompactionSegment(segmentText: string, signal?: AbortSignal | null): Promise<FlushExtraction> {
    return this.extraction.extractCompactionSegment(segmentText, signal);
  }

  /** Rust `process_claimed_memory_flush` persistence half (`memory_flush.rs:780-870`). */
  applyFlushExtraction(extraction: FlushExtraction, options: FlushApplyOptions): Promise<FlushApplyResult> {
    return this.extraction.applyFlushExtraction(extraction, options);
  }

  /** Rust `CompactionMemoryFlush::flush_segment` (`compaction_flush.rs:78`). */
  flushSegment(segmentText: string, sessionId: string | null,
    _segmentId: string | null = null,
    signal?: AbortSignal | null): Promise<FlushReport> {
    return this.extraction.flushSegment(segmentText, sessionId, signal);
  }

  queryFlushReceipts(segmentId: string): FlushReceipt[] {
    return listFlushReceipts(this.db, segmentId);
  }

  getFlushReceipt(segmentId: string, index: number): FlushReceipt | undefined {
    return readFlushReceipt(this.db, segmentId, index);
  }

  cleanupFlushReceipts(segmentId: string): number {
    return deleteFlushReceipts(this.db, segmentId);
  }

  tryReserveFlushReceiptWithConn(conn: SqlExecutor,
    idempotencyKey: string): FlushReceiptReservation | null {
    return tryReserve(conn, idempotencyKey) ?? null;
  }

  renewFlushReceiptWithConn(conn: SqlExecutor, reservation: FlushReceiptReservation): void {
    renewReservation(conn, reservation);
  }

  cacheFlushReceiptWithConn(conn: SqlExecutor, reservation: FlushReceiptReservation,
    output: SmartWriteOutput): void {
    cacheResult(conn, reservation, output);
  }

  clearFlushReceiptWithConn(conn: SqlExecutor, reservation: FlushReceiptReservation): void {
    clearReservation(conn, reservation);
  }

  listFlushReceiptsWithConn(conn: SqlExecutor, segmentId: string): FlushReceipt[] {
    return listFlushReceipts(conn, segmentId);
  }

  getFlushReceiptWithConn(conn: SqlExecutor, segmentId: string,
    index: number): FlushReceipt | undefined {
    return readFlushReceipt(conn, segmentId, index);
  }

  cleanupFlushReceiptsWithConn(conn: SqlExecutor, segmentId: string): number {
    return deleteFlushReceipts(conn, segmentId);
  }

  // -------------------------------------------------------------- auto extraction

  /** Rust `MemoryAutoExtractor::extract_candidates_and_activities` (`auto_extractor.rs:62`). */
  extractMemoryCandidates(userContent: string, assistantContent: string,
    existingProfile: string | null, signal?: AbortSignal | null): Promise<ExtractionResult> {
    return this.extraction.extractMemoryCandidates(userContent, assistantContent, existingProfile, signal);
  }

  /** Rust `MemoryAutoExtractor::extract_and_store` (`auto_extractor.rs:100`). */
  extractAndStoreMemory(userContent: string, assistantContent: string,
    signal?: AbortSignal | null): Promise<number> {
    return this.extraction.extractAndStoreMemory(userContent, assistantContent, signal);
  }

  writeExplicit(folderPath: string | null | undefined, title: string, content: string,
    memoryType: MemoryType, purpose: MemoryPurpose | null): SmartWriteOutput {
    return this.writes.writeExplicit(folderPath, title, content, memoryType, purpose);
  }

  writeBatch(items: readonly {
    title: string; content: string; folderPath?: string | null; memoryType?: string | null;
    memoryPurpose?: string | null; idempotencyKey?: string | null;
  }[], defaultFolderPath: string | null | undefined, defaultMemoryType: string | null | undefined,
  defaultMemoryPurpose: string | null | undefined): Promise<{
    total: number; succeeded: number; failed: number; added: number; updated: number;
    skipped: number; filtered: number;
    results: ({ title: string } & SmartWriteOutput)[];
    noteIds: string[];
  }> {
    return this.writes.writeBatch(items, defaultFolderPath, defaultMemoryType, defaultMemoryPurpose);
  }

  audit(entry: Partial<AuditEntryInput> & Pick<AuditEntryInput, 'operation' | 'success'>): void {
    insertAuditLog(this.db, {
      source: 'handler', noteId: null, title: null, contentPreview: null, folder: null,
      event: null, confidence: null, reason: null, sessionId: null, durationMs: null,
      extraJson: null, ...entry,
    }, message => this.warn(message));
  }

  auditWriteSmart(source: 'handler' | 'tool_call' | 'auto_extract', title: string,
    content: string, folder: string | null | undefined, output: SmartWriteOutput,
    sessionId: string | null, durationMs: number): void {
    insertAuditLog(this.db, {
      source, operation: 'write_smart', success: true,
      noteId: output.noteId === '' ? null : output.noteId, title, contentPreview: content,
      folder: folder ?? null, event: output.event, confidence: output.confidence,
      reason: output.reason, sessionId, durationMs,
      extraJson: output.downgraded ? '{"downgraded":true}' : null,
    }, message => this.warn(message));
  }

  replaySmart(key: string): SmartWriteOutput | undefined { return this.writes.replayCached(key); }
  renew(reservation: Reservation): void { renewReservation(this.db, reservation); }
  filterAlive(noteIds: readonly string[]): string[] { return filterAliveNoteIds(this.db, noteIds); }

  /**
   * Rust `record_used`: strong usage signal when the LLM reads a memory in full. One
   * IMMEDIATE transaction; every failure only warns (callers fire and forget).
   */
  recordInjectionPresence(noteIds: readonly string[]): void {
    if (noteIds.length === 0) return;
    const nowMs = Date.now();
    try {
      this.db.transaction(tx => recordInjectionPresenceNotes(this.deps, tx, noteIds, nowMs,
        message => this.warn(message)), { behavior: 'immediate' });
    } catch (error) {
      this.warn(`[Memory] Failed to commit injection presence transaction: ${errorText(error)}`);
    }
  }

  recordUsed(noteIds: readonly string[]): void {
    if (noteIds.length === 0) return;
    const nowMs = Date.now();
    try {
      this.db.transaction(tx => recordUsedNotes(this.deps, tx, noteIds, nowMs, message => this.warn(message)),
        { behavior: 'immediate' });
    } catch (error) {
      this.warn(`[Memory] Failed to commit usage signal transaction: ${errorText(error)}`);
    }
  }
  nextNoteUpdatedAt(current: string): string { return nextUpdatedAt(current); }
  addItem(folderId: string | null, itemType: string, itemId: string): void {
    addItemToFolder(this.deps, this.db, folderId, itemType, itemId);
  }
}

/**
 * Rust `conn.execute("SAVEPOINT memory_*_relation")` after the OCC checks: outside a
 * transaction SQLite opens it like BEGIN DEFERRED, so the write lock is taken by the first
 * write, not up front. ROLLBACK TO + RELEASE on error undoes the first endpoint's write.
 */
function relationSavepoint<T>(db: DatabaseHandle, fn: (scope: TransactionScope) => T): T {
  return db.transaction(tx => tx.savepoint(fn), { behavior: 'deferred' });
}

/** Rust `generate_structured_profile` (BTreeMap ordering: folders sorted). */
function generateStructuredProfile(facts: readonly (readonly [string, string])[]): string {
  const grouped = new Map<string, string[]>();
  for (const [folder, text] of facts) {
    const key = folder === '' ? '其他' : folder;
    const items = grouped.get(key);
    if (items === undefined) grouped.set(key, [text]);
    else items.push(text);
  }
  return [...grouped.keys()].sort()
    .map(key => `## ${key}\n${grouped.get(key)!.map(item => `- ${item}`).join('\n')}`)
    .join('\n\n');
}
