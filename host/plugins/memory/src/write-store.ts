/**
 * Memory note writes + smart writes — TS mirror of
 * `MemoryService::{read, write, append_by_id, update_by_id, delete,
 * update_tags, restore_stale, restore_archived, move_to_folder, batch_*,
 * write_smart, write_batch}`.
 *
 * The facade remains on `MemoryServiceImpl`; this store owns the write logic.
 */
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type {
  BatchOperationResult, MemoryPurpose, MemoryReadOutput, MemoryType, MemoryWriteOutput,
  SmartWriteOutput,
} from '../api.ts';
import type { MemoryVfsDependencies, VfsNote } from '../repository/vfs.ts';
import {
  addItemToFolder, createNote, deleteNoteWithFolderItem, findNoteByTitle, getNote,
  getNoteContent, listFoldersByParent, moveItemToFolder, nextUpdatedAt, removeIncomingRefs,
  updateNote,
} from '../repository/vfs.ts';
import {
  cacheResult, clearReservation, finalizeResult, getCachedResult, renewReservation, tryReserve, type Reservation,
} from '../repository/idempotency.ts';
import { markPending, markDisabled } from '../repository/vfs.ts';
import { planFactWrite, type FactDecisionHost, type SmartWriteSource } from './fact-decision.ts';
import type { MemoryDecisionResponse } from './llm-decision.ts';
import type { VfsIndexService } from '../../vfs-index/api.ts';
import { containsSensitivePattern } from './json.ts';
import type { MemoryConfig } from './config.ts';
import {
  CONTENT_LIMITS, MAX_BATCH_ITEMS, TAG_ARCHIVED, TAG_IMPORTANT, TAG_LAST_HIT_PREFIX,
  TAG_LAST_INJECTED_PREFIX, TAG_NEEDS_DEDUP_REVIEW, TAG_PURPOSE_PREFIX, TAG_STALE,
  TAG_TYPE_PREFIX, TAG_REF_PREFIX, errorText, factHardRejectReason, isReservedSystemName,
  memoryTags, memoryTypeFromTags, parseMemoryPurpose, parseMemoryType, purposeMatches, sameText,
  shouldDowngradeSmartMutation, typeTag, validateExpectedVersion, ctxGet,
} from './memory-utils.ts';

export type WriteMode = 'create' | 'update' | 'append';

/** Rust `OpTimer::elapsed_ms`: monotonic `Instant`, whole milliseconds. */
function elapsedMs(startedAt: number): number {
  return Math.trunc(performance.now() - startedAt);
}

export interface WriteStoreHost {
  readonly db: DatabaseHandle;
  readonly hostContext: import('@deepseek-ai/cordis').Context;
  readonly deps: MemoryVfsDependencies;
  readonly config: MemoryConfig;
  readonly vfsDatabase: DatabaseHandle;
  rootId(): string;
  warn(message: string): void;
  info(message: string): void;
  audit(entry: Partial<import('../repository/audit.ts').AuditEntryInput>
    & Pick<import('../repository/audit.ts').AuditEntryInput, 'operation' | 'success'>): void;
  auditWriteSmart(source: 'handler' | 'tool_call' | 'auto_extract', title: string,
    content: string, folder: string | null | undefined, output: SmartWriteOutput,
    sessionId: string | null, durationMs: number): void;
  markPendingBestEffort(resourceId: string): void;
  markDisabledBestEffort(resourceId: string, reason: string): void;
  ensureNoteInMemoryRoot(noteId: string): VfsNote;
  noteRelativeFolderPath(noteId: string): string;
  resolveWriteTargetFolderId(folderPath: string | null | undefined, strictMissing: boolean): string;
  validateFolderPath(path: string | null | undefined): void;
  isNoteInMemoryRoot(noteId: string, rootId: string): boolean;
  ensureFolder(rootId: string, path: string): string;
  withDbOverride<T>(db: DatabaseHandle, fn: () => T): T;
}

export class MemoryWriteStore {
  private readonly host: FactDecisionHost;
  constructor(host: FactDecisionHost) { this.host = host; }
  read(noteId: string): MemoryReadOutput | null {
    const rootId = this.host.rootId();
    const note = getNote(this.host.deps, this.host.db, noteId);
    if (note === undefined || !this.host.isNoteInMemoryRoot(noteId, rootId)) return null;
    return {
      noteId: note.id, title: note.title, content: getNoteContent(this.host.deps, this.host.db, noteId),
      folderPath: this.host.noteRelativeFolderPath(noteId), updatedAt: note.updatedAt,
    };
  }

  write(folderPath: string | null | undefined, title: string, content: string,
    mode: WriteMode): MemoryWriteOutput {
    if (title.trim().length === 0) throw new Error("Invalid argument 'title': 标题不能为空");
    this.validateUserTitle(title);
    this.host.validateFolderPath(folderPath);
    if (containsSensitivePattern(title) || containsSensitivePattern(content)) {
      throw new Error("Invalid argument 'title/content': 包含敏感信息（手机号/身份证/银行卡/邮箱/密码）");
    }
    const maxChars = CONTENT_LIMITS.fact;
    if (Array.from(content).length > maxChars) {
      throw new Error(`Invalid argument 'content': 内容超过 ${maxChars} 字限制（类型: fact）`);
    }
    const folderId = this.host.resolveWriteTargetFolderId(folderPath, true);
    if (mode === 'create') {
      const note = createNote(this.host.deps, this.host.db, { title, content, tags: [] }, folderId);
      this.host.markPendingBestEffort(note.resourceId);
      return { noteId: note.id, isNew: true, resourceId: note.resourceId };
    }
    const existing = findNoteByTitle(this.host.db, folderId, title);
    if (existing !== undefined) {
      const finalContent = mode === 'append'
        ? `${getNoteContent(this.host.deps, this.host.db, existing.id)}\n\n${content}` : content;
      const updated = updateNote(this.host.deps, this.host.db, existing.id, {
        title, content: finalContent, expectedUpdatedAt: existing.updatedAt,
      });
      this.host.markPendingBestEffort(updated.resourceId);
      return { noteId: existing.id, isNew: false, resourceId: updated.resourceId };
    }
    const note = createNote(this.host.deps, this.host.db, { title, content, tags: [] }, folderId);
    this.host.markPendingBestEffort(note.resourceId);
    return { noteId: note.id, isNew: true, resourceId: note.resourceId };
  }

  appendById(noteId: string, title: string, content: string): MemoryWriteOutput {
    const current = getNoteContent(this.host.deps, this.host.db, noteId);
    const finalContent = current.length === 0 ? content : `${current}\n\n${content}`;
    return this.updateById(noteId, title, finalContent);
  }

  updateById(noteId: string, title: string | null, content: string | null,
    source: SmartWriteSource | 'semantic_dedup' = 'handler', sessionId: string | null = null): MemoryWriteOutput {
    if (title === null && content === null) {
      throw new Error("Invalid argument 'title/content': 至少需要提供 title 或 content 之一");
    }
    // Rust OpTimer (Instant) starts here, service.rs:3323.
    const startedAt = performance.now();
    const note = this.host.ensureNoteInMemoryRoot(noteId);
    const memoryType = memoryTypeFromTags(note.tags);
    if (title !== null) {
      if (title.trim().length === 0) throw new Error("Invalid argument 'title': 标题不能为空");
      this.validateUserTitle(title);
      if (containsSensitivePattern(title)) {
        throw new Error("Invalid argument 'title': 标题包含敏感信息（手机号/身份证/银行卡/邮箱/密码）");
      }
    }
    if (content !== null) {
      if (containsSensitivePattern(content)) {
        throw new Error("Invalid argument 'content': 内容包含敏感信息（手机号/身份证/银行卡/邮箱/密码）");
      }
      const maxChars = CONTENT_LIMITS[memoryType];
      if (Array.from(content).length > maxChars) {
        throw new Error(`Invalid argument 'content': 内容超过 ${maxChars} 字限制（类型: ${memoryType}）`);
      }
    }
    const updated = updateNote(this.host.deps, this.host.db, noteId, {
      ...(title === null ? {} : { title }),
      ...(content === null ? {} : { content }),
      expectedUpdatedAt: note.updatedAt,
    });
    this.host.markPendingBestEffort(updated.resourceId);
    this.host.audit({ source, operation: 'update', success: true, noteId: note.id, title,
      contentPreview: content, event: 'UPDATE', sessionId, durationMs: elapsedMs(startedAt) });
    return { noteId: note.id, isNew: false, resourceId: updated.resourceId };
  }

  async delete(noteId: string, source: SmartWriteSource | 'semantic_dedup' = 'handler',
    sessionId: string | null = null): Promise<void> {
    const startedAt = performance.now();
    const note = this.host.ensureNoteInMemoryRoot(noteId);
    deleteNoteWithFolderItem(this.host.deps, this.host.db, noteId);
    // Rust deletes the main storage first, then the index side, so a vector
    // failure cannot strand a note whose vectors were already gone.
    const index = ctxGet(this.host.hostContext, 'vfsIndex') as VfsIndexService | undefined;
    if (index === undefined) {
      this.host.warn('[Memory] vfsIndex is not available; deleted note index cleanup skipped');
    } else {
      try {
        await index.lance.deleteByResource('text', note.resourceId);
      } catch (error) {
        this.host.warn(`[Memory] Failed to delete lance index for ${note.resourceId} (will rely on disabled state): ${errorText(error)}`);
      }
    }
    // Rust service.rs:3438: purge runs even when the direct Lance delete failed;
    // queued lance_row_ids let the orphan drain clean the vectors later.
    try { this.host.deps.repos.embeddingUnits.purgeIndexArtifactsByResource(this.host.db, note.resourceId); }
    catch (error) { this.host.warn(`[Memory] Failed to purge index artifacts for ${note.resourceId}: ${errorText(error)}`); }
    this.host.markDisabledBestEffort(note.resourceId, 'note deleted');
    try { removeIncomingRefs(this.host.deps, this.host.db, noteId, message => this.host.info(message)); }
    catch (error) { this.host.warn(`[Memory] Failed to clean incoming _ref tags for ${noteId}: ${errorText(error)}`); }
    this.host.info(`[Memory] Deleted note: ${noteId}`);
    this.host.audit({ source, operation: 'delete', success: true, noteId, title: note.title, event: 'DELETE',
      sessionId, durationMs: elapsedMs(startedAt) });
  }

  updateTags(noteId: string, userTags: readonly string[]): void {
    const note = this.host.ensureNoteInMemoryRoot(noteId);
    this.updateTagsWithOcc(noteId, note.updatedAt, userTags);
  }

  updateTagsWithOcc(noteId: string, expectedUpdatedAt: string,
    userTags: readonly string[], source: SmartWriteSource = 'handler',
    sessionId: string | null = null): [VfsNote, VfsNote] {
    const note = this.host.ensureNoteInMemoryRoot(noteId);
    validateExpectedVersion(note, expectedUpdatedAt);
    const systemTags = note.tags.filter(tag => tag.startsWith('_'));
    const merged = [...systemTags, ...userTags.filter(tag => !tag.startsWith('_'))];
    const updated = updateNote(this.host.deps, this.host.db, noteId, { tags: merged, expectedUpdatedAt: expectedUpdatedAt.trim() });
    this.host.audit({ source, operation: 'update_tags', success: true, noteId, sessionId });
    return [note, updated];
  }

  /**
   * memory_executor.rs `remove_stale_tag`: second OCC write on the version returned by
   * `update_tags_with_occ`, dropping `_stale` plus stale `_last_hit:`/`_last_injected:` stamps.
   */
  removeStaleTag(note: VfsNote, sessionId: string | null): VfsNote {
    const tags = note.tags.filter(tag => tag !== TAG_STALE
      && !tag.startsWith(TAG_LAST_HIT_PREFIX) && !tag.startsWith(TAG_LAST_INJECTED_PREFIX));
    const updated = updateNote(this.host.deps, this.host.db, note.id, { tags, expectedUpdatedAt: note.updatedAt });
    this.host.audit({ source: 'tool_call', operation: 'update_tags', success: true, noteId: note.id,
      reason: '移除 _stale 标记（用户确认记忆仍然有效）', sessionId });
    return updated;
  }

  getTags(noteId: string): string[] { return this.host.ensureNoteInMemoryRoot(noteId).tags; }

  restoreStale(noteId: string): boolean {
    const note = this.host.ensureNoteInMemoryRoot(noteId);
    if (!note.tags.includes(TAG_STALE)) return false;
    const tags = note.tags.filter(tag => tag !== TAG_STALE
      && !tag.startsWith(TAG_LAST_HIT_PREFIX) && !tag.startsWith(TAG_LAST_INJECTED_PREFIX));
    updateNote(this.host.deps, this.host.db, noteId, { tags, expectedUpdatedAt: note.updatedAt });
    this.host.audit({ operation: 'update_tags', success: true, noteId, title: note.title,
      event: 'STALE_RESTORE', reason: '用户在记忆界面手动恢复过时标记' });
    return true;
  }

  restoreArchived(noteId: string): boolean {
    const note = this.host.ensureNoteInMemoryRoot(noteId);
    if (!note.tags.includes(TAG_ARCHIVED)) return false;
    const tags = note.tags.filter(tag => tag !== TAG_ARCHIVED && tag !== TAG_STALE
      && !tag.startsWith(TAG_LAST_HIT_PREFIX) && !tag.startsWith(TAG_LAST_INJECTED_PREFIX));
    const updated = updateNote(this.host.deps, this.host.db, noteId, { tags, expectedUpdatedAt: note.updatedAt });
    this.host.markPendingBestEffort(updated.resourceId);
    this.host.audit({ operation: 'update_tags', success: true, noteId, title: note.title,
      event: 'ARCHIVE_RESTORE', reason: '用户在记忆界面手动恢复归档记忆，已重新排队建立索引' });
    return true;
  }

  moveToFolder(noteId: string, targetFolderPath: string): void {
    const note = this.host.ensureNoteInMemoryRoot(noteId);
    this.moveToFolderWithOcc(noteId, note.updatedAt, targetFolderPath);
  }

  moveToFolderWithOcc(noteId: string, expectedUpdatedAt: string,
    targetFolderPath: string, source: SmartWriteSource = 'handler',
    sessionId: string | null = null): [VfsNote, string] {
    this.host.validateFolderPath(targetFolderPath);
    const rootId = this.host.rootId();
    const note = this.host.ensureNoteInMemoryRoot(noteId);
    validateExpectedVersion(note, expectedUpdatedAt);
    const previousFolderPath = this.host.noteRelativeFolderPath(noteId);
    const targetId = targetFolderPath === '' ? rootId : this.host.ensureFolder(rootId, targetFolderPath);
    const updated = this.host.db.transaction(scope => {
      const current = getNote(this.host.deps, scope, noteId);
      if (current === undefined) throw new Error(`MemoryNote not found: ${noteId}`);
      const result = updateNote(this.host.deps, scope, noteId, { expectedUpdatedAt: expectedUpdatedAt.trim() });
      moveItemToFolder(this.host.deps, scope, 'note', noteId, targetId);
      return result;
    }, { behavior: 'immediate' });
    this.host.audit({ source, operation: 'move', success: true, noteId, folder: targetFolderPath, sessionId });
    return [updated, previousFolderPath];
  }

  async batchDelete(noteIds: readonly string[]): Promise<BatchOperationResult & { changedIds: string[] }> {
    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];
    const changedIds: string[] = [];
    for (const noteId of noteIds) {
      try { await this.delete(noteId); succeeded += 1; changedIds.push(noteId); }
      catch (error) {
        failed += 1;
        if (errors.length < 5) errors.push(`${noteId}: ${errorText(error)}`);
      }
    }
    return { total: noteIds.length, succeeded, failed, errors, changedIds };
  }

  batchMove(noteIds: readonly string[], targetFolderPath: string): BatchOperationResult & { changedIds: string[] } {
    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];
    const changedIds: string[] = [];
    for (const noteId of noteIds) {
      try { this.moveToFolder(noteId, targetFolderPath); succeeded += 1; changedIds.push(noteId); }
      catch (error) {
        failed += 1;
        if (errors.length < 5) errors.push(`${noteId}: ${errorText(error)}`);
      }
    }
    return { total: noteIds.length, succeeded, failed, errors, changedIds };
  }

  async writeSmart(folderPath: string | null | undefined, title: string, content: string,
    memoryType: MemoryType, purpose: MemoryPurpose | null, idempotencyKey: string | null | undefined,
    source: 'handler' | 'tool_call' | 'auto_extract' = 'handler',
    sessionId: string | null = null): Promise<SmartWriteOutput> {
    // Rust OpTimer starts before ensure_root_folder_id (service.rs:1750).
    const startedAt = performance.now();
    this.host.rootId();
    if (title.trim().length === 0) throw new Error("Invalid argument 'title': 标题不能为空");
    this.validateUserTitle(title);
    this.host.validateFolderPath(folderPath);
    // Rust returns before acquiring an idempotency reservation for empty internal writes.
    if (content.trim().length === 0) {
      return { noteId: '', event: 'NONE', isNew: false, confidence: 1,
        reason: '内容为空，跳过写入', resourceId: null, downgraded: false };
    }
    const key = idempotencyKey?.trim();
    let reservation: Reservation | undefined;
    if (key !== undefined && key !== '') {
      // Rust service.rs:1784-1795: allow the in-flight writer to finish, without holding a tx.
      for (let attempt = 0; attempt <= 20; attempt += 1) {
        const cached = getCachedResult(this.host.db, key);
        if (cached !== undefined) return cached;
        reservation = tryReserve(this.host.db, key);
        if (reservation !== undefined) break;
        if (attempt < 20) await new Promise<void>(resolve => setTimeout(resolve, 50));
      }
      if (reservation === undefined) {
        throw new Error('CONFLICT(memory.idempotency.in_progress): 同一幂等键请求正在处理中，请稍后重试');
      }
    }
    try {
      // The fact path must await retrieval/decision before opening the SQLite transaction.
      // Earlier filtering/explicit/privacy branches retain their Rust order and do no search.
      if (memoryType === 'fact' && content.trim().length > 0
        && !containsSensitivePattern(content) && !containsSensitivePattern(title)
        && Array.from(content).length <= CONTENT_LIMITS.fact
        && factHardRejectReason(title, content) === null && !this.host.config.isPrivacyMode()) {
        return await this.writeFactSmart(folderPath, title, content, purpose, source, sessionId,
          startedAt, reservation);
      }
      if (reservation === undefined) {
        return this.writeSmartInner(folderPath, title, content, memoryType, purpose, source, sessionId,
          startedAt);
      }
      // Rust commits the note mutation and the receipt in one transaction; a
      // receipt write failure must roll the note back rather than leave an
      // untracked duplicate for the retry.
      return this.host.vfsDatabase.transaction(tx => {
        // Rust `commit_idempotent_smart_mutation` renews the lease first (service.rs:1151).
        renewReservation(tx, reservation);
        const run = () => {
          const output = this.writeSmartInner(folderPath, title, content, memoryType, purpose, source, sessionId,
          startedAt);
          cacheResult(tx, reservation, output);
          return output;
        };
        return this.host.withDbOverride(tx as unknown as DatabaseHandle, run);
      }, { behavior: 'immediate' });
    } catch (error) {
      if (reservation !== undefined) clearReservation(this.host.vfsDatabase, reservation);
      throw error;
    }
  }

  replayCached(key: string): SmartWriteOutput | undefined {
    const cached = getCachedResult(this.host.db, key);
    return cached;
  }

  private writeSmartInner(folderPath: string | null | undefined, title: string, content: string,
    memoryType: MemoryType, purpose: MemoryPurpose | null,
    source: 'handler' | 'tool_call' | 'auto_extract', sessionId: string | null,
    startedAt: number): SmartWriteOutput {
    if (content.trim().length === 0) {
      return { noteId: '', event: 'NONE', isNew: false, confidence: 1,
        reason: '内容为空，跳过写入', resourceId: null, downgraded: false };
    }
    if (containsSensitivePattern(content) || containsSensitivePattern(title)) {
      const reason = '内容包含敏感信息（手机号/身份证/银行卡/邮箱/密码），已拦截。';
      this.host.audit({ source, operation: 'write_smart', success: false, title, contentPreview: content,
        event: 'FILTERED', reason, durationMs: 0 });
      return { noteId: '', event: 'FILTERED', isNew: false, confidence: 1, reason,
        resourceId: null, downgraded: false };
    }
    const maxChars = CONTENT_LIMITS[memoryType];
    if (Array.from(content).length > maxChars) {
      const reason = `内容超过 ${maxChars} 字限制（类型: ${memoryType}）`;
      this.host.audit({ source, operation: 'write_smart', success: false, title, contentPreview: content,
        event: 'FILTERED', reason, durationMs: 0 });
      return { noteId: '', event: 'FILTERED', isNew: false, confidence: 1, reason,
        resourceId: null, downgraded: false };
    }
    if (memoryType === 'note' || memoryType === 'study') {
      const output = this.writeExplicit(folderPath, title, content, memoryType, purpose);
      this.host.auditWriteSmart(source, title, content, folderPath, output, sessionId, elapsedMs(startedAt));
      return output;
    }
    if (memoryType === 'fact') {
      const reject = factHardRejectReason(title, content);
      if (reject !== null) {
        this.host.audit({ source, operation: 'write_smart', success: false, title, contentPreview: content,
          event: 'FILTERED', reason: reject, durationMs: 0 });
        return { noteId: '', event: 'FILTERED', isNew: false, confidence: 1, reason: reject,
          resourceId: null, downgraded: false };
      }
    }
    if (this.host.config.isPrivacyMode()) {
      const targetId = this.host.resolveWriteTargetFolderId(folderPath, false);
      const existing = findNoteByTitle(this.host.db, targetId, title);
      if (existing !== undefined) {
        const output: SmartWriteOutput = { noteId: existing.id, event: 'NONE', isNew: false,
          confidence: 1, reason: '隐私模式：同名记忆已存在（本地标题去重）',
          resourceId: null, downgraded: false };
        return output;
      }
      const created = this.createSmartMemory(folderPath, title, content, memoryType, purpose,
        'ADD', 1, '隐私模式已启用，跳过 LLM 决策并安全降级为新增');
      return created;
    }
    throw new Error('Fact writes must use the asynchronous dedup/decision path');
  }

  /** Rust service.rs:1968-2429. Search/LLM outside the note+receipt transaction. */
  private async writeFactSmart(folderPath: string | null | undefined, title: string, content: string,
    purpose: MemoryPurpose | null, source: SmartWriteSource, sessionId: string | null,
    startedAt: number, reservation: Reservation | undefined): Promise<SmartWriteOutput> {
    const plan = await planFactWrite(this.host, title, content, folderPath, source, sessionId);
    if (plan.kind === 'skip') {
      finalizeResult(this.host.db, reservation, plan.output);
      this.host.auditWriteSmart(source, title, content, folderPath, plan.output, sessionId, elapsedMs(startedAt));
      return plan.output;
    }
    const { decision, similar } = plan;
    if (shouldDowngradeSmartMutation(decision.event, decision.confidence)) {
      const output: SmartWriteOutput = { noteId: similar[0]?.noteId ?? '', event: 'NONE',
        isNew: false, confidence: decision.confidence, resourceId: null, downgraded: true,
        reason: `${decision.reason}（置信度 ${decision.confidence.toFixed(2)} 低于阈值 0.65，降级为 NONE）` };
      finalizeResult(this.host.db, reservation, output);
      return output; // Rust deliberately has no write_smart audit on the low-confidence return.
    }
    if (reservation !== undefined) renewReservation(this.host.db, reservation);
    let output: SmartWriteOutput;
    try {
      output = await this.applyFactDecision(folderPath, title, content, purpose, source,
        sessionId, decision, new Set(similar.map(hit => hit.noteId)), similar[0]?.noteId ?? '', reservation);
    } catch (error) {
      this.host.audit({ source, operation: 'write_smart', success: false, title, contentPreview: content,
        folder: folderPath ?? null, reason: errorText(error), sessionId, durationMs: elapsedMs(startedAt) });
      throw error;
    }
    finalizeResult(this.host.db, reservation, output);
    this.host.auditWriteSmart(source, title, content, folderPath, output, sessionId, elapsedMs(startedAt));
    if (plan.needsDedupReview && output.event === 'ADD' && output.noteId !== '') {
      try {
        const note = this.host.ensureNoteInMemoryRoot(output.noteId);
        if (!note.tags.includes(TAG_NEEDS_DEDUP_REVIEW)) {
          updateNote(this.host.deps, this.host.db, note.id, {
            tags: [...note.tags, TAG_NEEDS_DEDUP_REVIEW], expectedUpdatedAt: note.updatedAt,
          });
        }
        this.host.audit({ source, operation: 'update_tags', success: true, noteId: note.id,
          event: 'NEEDS_DEDUP_REVIEW', sessionId,
          reason: '去重索引未就绪时的显式写入，已照常 ADD 并标记待复核' });
      } catch (error) {
        this.host.warn(`[Memory] 待复核标签写入失败 note_id=${output.noteId} source=${source}: ${errorText(error)}`);
      }
    }
    return output;
  }

  /** Rust commit_idempotent_smart_mutation (1140-1181): sync mutation and receipt, one conn. */
  private commitFact(reservation: Reservation | undefined, mutation: () => SmartWriteOutput): SmartWriteOutput {
    if (reservation === undefined) return mutation();
    return this.host.vfsDatabase.transaction(tx => {
      renewReservation(tx, reservation);
      return this.host.withDbOverride(tx as unknown as DatabaseHandle, () => {
        const output = mutation();
        cacheResult(tx, reservation, output);
        return output;
      });
    }, { behavior: 'immediate' });
  }

  private async applyFactDecision(folderPath: string | null | undefined, title: string, content: string,
    purpose: MemoryPurpose | null, source: SmartWriteSource, sessionId: string | null,
    decision: MemoryDecisionResponse, candidates: ReadonlySet<string>, firstNoteId: string,
    reservation: Reservation | undefined): Promise<SmartWriteOutput> {
    const create = (event: string, reason: string): SmartWriteOutput => {
      // Rust resolves folders before the idempotent mutation transaction (service.rs:1224).
      const folderId = this.host.resolveWriteTargetFolderId(folderPath, true);
      return this.commitFact(reservation, () => {
        const note = createNote(this.host.deps, this.host.db,
          { title, content, tags: memoryTags('fact', purpose) }, folderId);
        if (reservation !== undefined) markPending(this.host.deps, this.host.db, note.resourceId);
        else this.host.markPendingBestEffort(note.resourceId);
        return { noteId: note.id, resourceId: note.resourceId, isNew: true, event,
          confidence: decision.confidence, reason, downgraded: false };
      });
    };
    if (decision.event === 'ADD') return create('ADD', decision.reason);
    if (decision.event === 'NONE') {
      return { noteId: firstNoteId, event: 'NONE', isNew: false, confidence: decision.confidence,
        reason: decision.reason, resourceId: null, downgraded: false };
    }
    const target = decision.target_note_id;
    if (target === null) return create('ADD', `${decision.event} 决策但无目标 ID，降级为 ADD`);
    if (!candidates.has(target)) return create('ADD', `${decision.reason}（target_note_id 不在候选集中，降级为 ADD）`);
    if (decision.event === 'DELETE') {
      if (reservation === undefined) {
        await this.delete(target, source, sessionId);
        return create('DELETE', `${decision.reason}（已删除矛盾记忆 ${target}）`);
      }
      let deletedResourceId = '';
      // Rust resolves the destination before the idempotent transaction.
      this.host.ensureNoteInMemoryRoot(target);
      const replacementFolderId = this.host.resolveWriteTargetFolderId(folderPath, true);
      const output = this.commitFact(reservation, () => {
        const note = this.host.ensureNoteInMemoryRoot(target);
        deletedResourceId = note.resourceId;
        deleteNoteWithFolderItem(this.host.deps, this.host.db, target);
        this.host.deps.repos.embeddingUnits.purgeIndexArtifactsByResource(this.host.db, note.resourceId);
        markDisabled(this.host.deps, this.host.db, note.resourceId, 'note deleted');
        const replacement = createNote(this.host.deps, this.host.db,
          { title, content, tags: memoryTags('fact', purpose) }, replacementFolderId);
        markPending(this.host.deps, this.host.db, replacement.resourceId);
        return { noteId: replacement.id, resourceId: replacement.resourceId, event: 'DELETE',
          isNew: true, confidence: decision.confidence,
          reason: `${decision.reason}（已删除矛盾记忆 ${target}）`, downgraded: false };
      });
      const index = ctxGet(this.host.hostContext, 'vfsIndex') as VfsIndexService | undefined;
      if (index === undefined) throw new Error('vfsIndex is not available for atomic replacement cleanup');
      try { await index.indexing.deleteResourceIndex(deletedResourceId); }
      catch (error) {
        this.host.warn(`[Memory] Failed to delete Lance rows for ${deletedResourceId} after atomic replacement: ${errorText(error)}`);
      }
      return output;
    }
    try {
      return this.commitFact(reservation, () => {
        const note = this.host.ensureNoteInMemoryRoot(target);
        const finalContent = decision.event === 'APPEND'
          ? `${getNoteContent(this.host.deps, this.host.db, target)}\n\n${content}` : content;
        let result: MemoryWriteOutput;
        if (reservation === undefined) {
          result = this.updateById(target, decision.event === 'UPDATE' ? title : null,
            finalContent, source, sessionId);
          try { this.syncNoteSystemTags(target, 'fact', purpose); }
          catch (error) {
            this.host.warn(`[Memory] Failed to sync system tags after ${decision.event} ${target}: ${errorText(error)}`);
          }
        } else {
          if (containsSensitivePattern(finalContent)) {
            throw new Error("Invalid argument 'content': 内容包含敏感信息（手机号/身份证/银行卡/邮箱/密码）");
          }
          const existingType = memoryTypeFromTags(note.tags);
          const maxChars = CONTENT_LIMITS[existingType];
          if (Array.from(finalContent).length > maxChars) {
            throw new Error(`Invalid argument 'content': 内容超过 ${maxChars} 字限制（类型: ${existingType}）`);
          }
          const updated = updateNote(this.host.deps, this.host.db, target, {
            ...(decision.event === 'UPDATE' ? { title } : {}), content: finalContent,
            tags: [...note.tags.filter(tag => !tag.startsWith(TAG_TYPE_PREFIX)
              && !tag.startsWith(TAG_PURPOSE_PREFIX)), ...memoryTags('fact', purpose)],
            expectedUpdatedAt: note.updatedAt,
          });
          markPending(this.host.deps, this.host.db, updated.resourceId);
          result = { noteId: updated.id, resourceId: updated.resourceId, isNew: false };
        }
        return { ...result, event: decision.event, confidence: decision.confidence,
          reason: decision.reason, downgraded: false };
      });
    } catch (error) {
      // Rust degrades only VfsError::NotFound, not a CAS/SQL/content-validation error.
      if (error instanceof Error && /^(Note|MemoryNote) not found: /u.test(error.message)) {
        return create('ADD', `${decision.reason}（target_note_id 无效，降级为 ADD）`);
      }
      throw error;
    }
  }

  writeExplicit(folderPath: string | null | undefined, title: string, content: string,
    memoryType: MemoryType, purpose: MemoryPurpose | null): SmartWriteOutput {
    const normalizedPurpose = memoryType === 'fact' ? purpose
      : purpose === 'systemic' ? 'memorized' : purpose;
    if (memoryType === 'note') {
      const result = this.writeTyped(folderPath, title, content, 'create', 'note', normalizedPurpose);
      return { noteId: result.noteId, event: 'ADD', isNew: true, confidence: 1,
        reason: '经验笔记类型，直接写入', resourceId: result.resourceId, downgraded: false };
    }
    if (memoryType === 'study') {
      const targetId = this.host.resolveWriteTargetFolderId(folderPath, true);
      const existing = findNoteByTitle(this.host.db, targetId, title);
      if (existing !== undefined && memoryTypeFromTags(existing.tags) === 'study') {
        const existingContent = getNoteContent(this.host.deps, this.host.db, existing.id);
        if (sameText(existingContent, content) && purposeMatches(existing.tags, normalizedPurpose)) {
          return { noteId: existing.id, event: 'NONE', isNew: false, confidence: 1,
            reason: '同名学习记忆已存在，内容一致，跳过写入', resourceId: null, downgraded: false };
        }
        const updated = this.updateById(existing.id, title, content);
        this.syncNoteSystemTags(existing.id, 'study', normalizedPurpose);
        return { noteId: updated.noteId, event: 'UPDATE', isNew: false, confidence: 1,
          reason: '同名学习记忆已存在，已更新内容', resourceId: updated.resourceId, downgraded: false };
      }
      const result = this.writeTyped(folderPath, title, content, 'create', 'study', normalizedPurpose);
      return { noteId: result.noteId, event: 'ADD', isNew: true, confidence: 1,
        reason: '学习记忆类型，已写入', resourceId: result.resourceId, downgraded: false };
    }
    throw new Error("Invalid argument 'memory_type': fact 不是显式学习内容写入类型");
  }

  private writeTyped(folderPath: string | null | undefined, title: string, content: string,
    _mode: WriteMode, memoryType: MemoryType, purpose: MemoryPurpose | null): MemoryWriteOutput {
    if (title.trim().length === 0) throw new Error("Invalid argument 'title': 标题不能为空");
    this.validateUserTitle(title);
    this.host.validateFolderPath(folderPath);
    if (containsSensitivePattern(title) || containsSensitivePattern(content)) {
      throw new Error("Invalid argument 'title/content': 包含敏感信息（手机号/身份证/银行卡/邮箱/密码）");
    }
    const maxChars = CONTENT_LIMITS[memoryType];
    if (Array.from(content).length > maxChars) {
      throw new Error(`Invalid argument 'content': 内容超过 ${maxChars} 字限制（类型: ${memoryType}）`);
    }
    const folderId = this.host.resolveWriteTargetFolderId(folderPath, true);
    const note = createNote(this.host.deps, this.host.db, { title, content, tags: memoryTags(memoryType, purpose) }, folderId);
    this.host.markPendingBestEffort(note.resourceId);
    return { noteId: note.id, isNew: true, resourceId: note.resourceId };
  }

  private createSmartMemory(folderPath: string | null | undefined, title: string, content: string,
    memoryType: MemoryType, purpose: MemoryPurpose | null, event: string, confidence: number,
    reason: string): SmartWriteOutput {
    const result = this.writeTyped(folderPath, title, content, 'create', memoryType, purpose);
    return { noteId: result.noteId, event, isNew: true, confidence, reason,
      resourceId: result.resourceId, downgraded: false };
  }

  private syncNoteSystemTags(noteId: string, memoryType: MemoryType,
    purpose: MemoryPurpose | null): void {
    const note = this.host.ensureNoteInMemoryRoot(noteId);
    const merged = note.tags.filter(tag => !tag.startsWith(TAG_TYPE_PREFIX)
      && !tag.startsWith(TAG_PURPOSE_PREFIX));
    const tag = typeTag(memoryType);
    if (tag !== null) merged.push(tag);
    if (purpose !== null) merged.push(`${TAG_PURPOSE_PREFIX}${purpose}`);
    updateNote(this.host.deps, this.host.db, noteId, { tags: merged, expectedUpdatedAt: note.updatedAt });
  }

  async writeBatch(items: readonly {
    title: string; content: string; folderPath?: string | null; memoryType?: string | null;
    memoryPurpose?: string | null; idempotencyKey?: string | null;
  }[], defaultFolderPath: string | null | undefined, defaultMemoryType: string | null | undefined,
  defaultMemoryPurpose: string | null | undefined): Promise<{
    total: number; succeeded: number; failed: number; added: number; updated: number;
    skipped: number; filtered: number;
    results: ({ title: string } & SmartWriteOutput)[];
    noteIds: string[];
  }> {
    if (items.length > MAX_BATCH_ITEMS) {
      throw new Error(`批量写入一次最多 ${MAX_BATCH_ITEMS} 条（收到 ${items.length} 条）`);
    }
    if (items.length === 0) {
      return { total: 0, succeeded: 0, failed: 0, added: 0, updated: 0, skipped: 0,
        filtered: 0, results: [], noteIds: [] };
    }
    const defaultType = defaultMemoryType === null || defaultMemoryType === undefined
      ? 'study' : parseMemoryType(defaultMemoryType);
    const defaultPurpose = parseMemoryPurpose(defaultMemoryPurpose);
    let added = 0; let updated = 0; let skipped = 0; let filtered = 0;
    const results: ({ title: string } & SmartWriteOutput)[] = [];
    const noteIds: string[] = [];
    for (const item of items) {
      const type = item.memoryType === null || item.memoryType === undefined
        ? defaultType : parseMemoryType(item.memoryType);
      const purpose = parseMemoryPurpose(item.memoryPurpose) ?? defaultPurpose;
      const output = type === 'fact'
        ? await this.writeSmart(item.folderPath ?? defaultFolderPath, item.title, item.content,
          type, purpose, item.idempotencyKey, 'handler')
        : this.writeExplicit(item.folderPath ?? defaultFolderPath, item.title, item.content,
          type, purpose);
      if (output.event === 'ADD') added += 1;
      else if (output.event === 'UPDATE' || output.event === 'APPEND' || output.event === 'DELETE') updated += 1;
      else if (output.event === 'FILTERED') filtered += 1;
      else skipped += 1;
      if (output.resourceId !== null && output.event !== 'NONE' && output.event !== 'FILTERED') {
        noteIds.push(output.noteId);
      }
      results.push({ title: item.title, ...output });
    }
    return { total: results.length, succeeded: added + updated, failed: filtered, added,
      updated, skipped, filtered, results, noteIds };
  }

  private validateUserTitle(title: string): void {
    if (isReservedSystemName(title)) {
      throw new Error("Invalid argument 'title': 标题使用系统保留前缀 '__'，请更换标题");
    }
  }
}
