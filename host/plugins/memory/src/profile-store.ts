/**
 * Learner profile + mastery reflux store — TS mirror of
 * `dstu-memory/src/memory/learner_profile.rs` and `mastery_hook.rs`.
 *
 * The memory service owns the transaction/receipt wiring; this store owns the
 * reserved `__learner_profile__` notes, optimistic-concurrency replay and the
 * deterministic mastery weak-point upsert/remove paths.
 */
import type { AuditEntryInput } from '../repository/audit.ts';
import type { MemoryVfsDependencies } from '../repository/vfs.ts';
import {
  createFolder, createNote, findSystemNoteSnapshot, listFoldersByParent, updateNote,
} from '../repository/vfs.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { chronoRfc3339 } from '../../../platform/time/index.ts';
import {
  LEARNER_PROFILE_HISTORY_NOTE_TITLE, LEARNER_PROFILE_MAX_CHARS, LEARNER_PROFILE_NOTE_TITLE,
  PROFILE_HISTORY_KEEP, dedupeProfileVersionsKeepLast, emptyProfile, emptyProfileUpdate,
  enforceProfileCharLimit, learnerProfileFromJson, learnerProfileToJson,
  asciiLower, mergeLearnerProfileUpdate, renderedCharCount,
  type LearnerProfile, type LearnerProfileUpdate, type WeakPoint,
} from './learner-profile.ts';
import type { MemoryConfig } from './config.ts';

export const SYSTEM_FOLDER_TITLE = '__system__';
export const PROFILE_CAS_MAX_RETRIES = 32;
export const WEAK_POINT_SOURCE_MASTERY = 'mastery';
export const MASTERY_WEAK_POINT_SUBJECT = '掌握度';

export type ProfileLimitPolicy = 'reject' | 'enforce';

export interface LearnerProfileApplyOutcome {
  profile: LearnerProfile;
  changed: boolean;
}

export interface ProfileUpdateOptions {
  source: string;
  sessionId?: string | null;
  reason: string;
  limitPolicy: ProfileLimitPolicy;
  isCancelled?: () => boolean;
  beforeFirstCommit?: () => void;
}

/** Deterministic evidence passed by the mastery layer (`MasteryWeakPointEvidence`). */
export interface MasteryWeakPointEvidence {
  score: number;
  total: number;
  wrongCount: number;
  recentWrongSummary: string;
}

/** The subset of `MemoryServiceImpl` this store depends on. */
export interface ProfileStoreHost {
  readonly db: DatabaseHandle;
  readonly deps: MemoryVfsDependencies;
  readonly config: MemoryConfig;
  warn(message: string): void;
  audit(entry: Partial<AuditEntryInput> & Pick<AuditEntryInput, 'operation' | 'success'>): void;
  rootId(): string;
  markDisabledBestEffort(resourceId: string, reason: string): void;
}

export class MemoryProfileStore {
  private readonly host: ProfileStoreHost;
  constructor(host: ProfileStoreHost) { this.host = host; }

  /** Rust `find_system_folder_id_readonly` (never creates structure). */
  private findSystemFolderIdReadonly(rootId: string): string | null {
    return listFoldersByParent(this.host.db, rootId)
      .find(folder => folder.title === SYSTEM_FOLDER_TITLE)?.id ?? null;
  }

  /** Rust `find_note_snapshot_by_title` for the reserved system folder. */
  private profileNoteSnapshot(title: string): { noteId: string; updatedAt: string; content: string } | null {
    const rootId = this.host.config.getRootFolderId();
    if (rootId === null) return null;
    const systemId = this.findSystemFolderIdReadonly(rootId);
    if (systemId === null) return null;
    return findSystemNoteSnapshot(this.host.db, systemId, title) ?? null;
  }

  /** Rust `load_profile`: empty or invalid reserved note means "no profile". */
  loadProfile(): LearnerProfile | null {
    const snapshot = this.profileNoteSnapshot(LEARNER_PROFILE_NOTE_TITLE);
    if (snapshot === null || snapshot.content.trim() === '') return null;
    const profile = learnerProfileFromJson(snapshot.content);
    if (profile === null) {
      this.host.warn('[LearnerProfile] Profile note content is not valid JSON; ignoring');
    }
    return profile;
  }

  /** Rust `load_profile_history`: newest version first. */
  loadProfileHistory(): LearnerProfile[] {
    const snapshot = this.profileNoteSnapshot(LEARNER_PROFILE_HISTORY_NOTE_TITLE);
    if (snapshot === null) return [];
    const versions = snapshot.content.split(/\r\n|\n|\r/)
      .filter(line => line.trim() !== '')
      .map(line => learnerProfileFromJson(line))
      .filter((profile): profile is LearnerProfile => profile !== null);
    return dedupeProfileVersionsKeepLast(versions).reverse();
  }

  /** Exposed for tools/tests that need the raw reserved history note CAS token. */
  profileHistorySnapshot(): { noteId: string; updatedAt: string; content: string } | null {
    return this.profileNoteSnapshot(LEARNER_PROFILE_HISTORY_NOTE_TITLE);
  }

  /** Rust `apply_profile_update` (merge + optimistic concurrency replay). */
  applyProfileUpdate(update: LearnerProfileUpdate,
    options: ProfileUpdateOptions): LearnerProfileApplyOutcome {
    return this.applyProfileUpdateInner(update, undefined, options);
  }

  /** Rust `apply_profile_promotion_update` (exactly-once fingerprint). */
  applyProfilePromotionUpdate(update: LearnerProfileUpdate, fingerprint: string,
    options: ProfileUpdateOptions): LearnerProfileApplyOutcome {
    return this.applyProfileUpdateInner(update, fingerprint, options);
  }

  private applyProfileUpdateInner(update: LearnerProfileUpdate,
    fingerprint: string | undefined, options: ProfileUpdateOptions): LearnerProfileApplyOutcome {
    const isCancelled = options.isCancelled ?? (() => false);
    if (isCancelled()) {
      throw new Error('InvalidOperation(learner_profile_update): cancelled before profile commit');
    }
    let hook = options.beforeFirstCommit;

    for (let attempt = 0; attempt < PROFILE_CAS_MAX_RETRIES; attempt += 1) {
      const snapshot = this.profileNoteSnapshot(LEARNER_PROFILE_NOTE_TITLE);
      const parsedProfile = snapshot === null ? null : learnerProfileFromJson(snapshot.content);
      if (snapshot !== null && parsedProfile === null) {
        this.host.warn('[LearnerProfile] Profile note content is not valid JSON; replacing on next update');
      }
      const profile = parsedProfile ?? emptyProfile();

      if (fingerprint !== undefined && profile.last_promotion_fingerprint === fingerprint) {
        if (profile.version > 0) {
          try { this.appendProfileHistory(profile); }
          catch (error) {
            this.host.warn(`[Memory] Failed to repair learner profile history: ${errorText(error)}`);
          }
        }
        return { profile, changed: false };
      }

      const contentChanged = mergeLearnerProfileUpdate(profile, update);
      const markerChanged = fingerprint !== undefined
        && profile.last_promotion_fingerprint !== fingerprint;
      if (markerChanged) profile.last_promotion_fingerprint = fingerprint;
      if (!contentChanged && !markerChanged) return { profile, changed: false };

      if (contentChanged) {
        profile.version = Math.min(0xffffffff, profile.version + 1);
        profile.updated_at = chronoRfc3339();
      }
      if (options.limitPolicy === 'enforce') {
        enforceProfileCharLimit(profile);
      } else {
        const chars = renderedCharCount(profile);
        if (chars > LEARNER_PROFILE_MAX_CHARS) {
          throw new Error(`Invalid argument 'profile': 合并后画像 ${chars} 字符，超过 ${LEARNER_PROFILE_MAX_CHARS} 字符硬上限。请精炼本次更新。`);
        }
      }
      const json = learnerProfileToJson(profile);

      hook?.();
      hook = undefined;
      if (isCancelled()) {
        throw new Error('InvalidOperation(learner_profile_update): cancelled before profile commit');
      }

      if (snapshot !== null) {
        try {
          updateNote(this.host.deps, this.host.db, snapshot.noteId, { content: json,
            expectedUpdatedAt: snapshot.updatedAt });
        } catch (error) {
          if (isProfileRetryable(error)) continue;
          throw error;
        }
      } else {
        if (this.profileNoteSnapshot(LEARNER_PROFILE_NOTE_TITLE) !== null) continue;
        if (isCancelled()) {
          throw new Error('InvalidOperation(learner_profile_update): cancelled before profile commit');
        }
        const systemId = this.ensureSystemFolderId();
        const note = createNote(this.host.deps, this.host.db, {
          title: LEARNER_PROFILE_NOTE_TITLE, content: json, tags: ['_system'],
        }, systemId);
        this.host.markDisabledBestEffort(note.resourceId, 'system learner profile note');
      }

      if (contentChanged) {
        try { this.appendProfileHistory(profile); }
        catch (error) {
          this.host.warn(`[Memory] Failed to append learner profile history: ${errorText(error)}`);
        }
        this.host.audit({
          source: options.source, operation: 'update', success: true,
          title: LEARNER_PROFILE_NOTE_TITLE, contentPreview: options.reason,
          folder: SYSTEM_FOLDER_TITLE, event: 'PROFILE_UPDATE', reason: options.reason,
          sessionId: options.sessionId ?? null, durationMs: 0,
          extraJson: JSON.stringify({ learner_profile_version: profile.version }),
        });
      }
      return { profile, changed: contentChanged };
    }

    throw new Error('CONFLICT(learner_profile.conflict): The learner profile remained busy after repeated retries.');
  }

  /**
   * Rust `persist_profile_update_from_vfs`: mastery reflux persists the merged
   * profile without writing history/audit rows (unlike `apply_profile_update`).
   */
  private persistProfileUpdateFromVfs(update: LearnerProfileUpdate, reason: string,
    limitPolicy: ProfileLimitPolicy): LearnerProfileApplyOutcome {
    for (let attempt = 0; attempt < PROFILE_CAS_MAX_RETRIES; attempt += 1) {
      const snapshot = this.profileNoteSnapshot(LEARNER_PROFILE_NOTE_TITLE);
      const profile = snapshot === null
        ? emptyProfile() : (learnerProfileFromJson(snapshot.content) ?? emptyProfile());

      const contentChanged = mergeLearnerProfileUpdate(profile, update);
      if (!contentChanged) return { profile, changed: false };

      profile.version = Math.min(0xffffffff, profile.version + 1);
      profile.updated_at = chronoRfc3339();
      if (limitPolicy === 'enforce') {
        enforceProfileCharLimit(profile);
      } else {
        const chars = renderedCharCount(profile);
        if (chars > LEARNER_PROFILE_MAX_CHARS) {
          throw new Error(`Invalid argument 'profile': 合并后画像 ${chars} 字符，超过 ${LEARNER_PROFILE_MAX_CHARS} 字符硬上限。请精炼本次更新。`);
        }
      }
      const json = learnerProfileToJson(profile);

      if (snapshot !== null) {
        try {
          updateNote(this.host.deps, this.host.db, snapshot.noteId, { content: json,
            expectedUpdatedAt: snapshot.updatedAt });
        } catch (error) {
          if (isProfileRetryable(error)) continue;
          throw error;
        }
      } else {
        if (this.profileNoteSnapshot(LEARNER_PROFILE_NOTE_TITLE) !== null) continue;
        const systemId = this.ensureSystemFolderId();
        const note = createNote(this.host.deps, this.host.db, {
          title: LEARNER_PROFILE_NOTE_TITLE, content: json, tags: ['_system'],
        }, systemId);
        this.host.markDisabledBestEffort(note.resourceId, 'system learner profile note');
      }
      return { profile, changed: true };
    }

    throw new Error('CONFLICT(learner_profile.conflict): The learner profile remained busy after mastery upsert retries.');
  }

  /**
   * Rust `upsert_weak_point_from_mastery`: deterministic evidence upsert with
   * `source: mastery`, char limit enforced (no history/audit side effects).
   */
  upsertWeakPointFromMastery(concept: string, evidence: MasteryWeakPointEvidence): void {
    const trimmed = concept.trim();
    if (trimmed === '') {
      throw new Error("Invalid argument 'concept': mastery concept must be non-empty");
    }
    const today = new Date().toISOString().slice(0, 10);
    const errorPattern = `[mastery] score=${formatF64Fixed2(evidence.score)} `
      + `total=${evidence.total} wrongs=${evidence.wrongCount}; ${evidence.recentWrongSummary}`;
    const weakPoint: WeakPoint = {
      subject: MASTERY_WEAK_POINT_SUBJECT,
      knowledge_point: trimmed,
      error_pattern: errorPattern,
      evidence_count: Math.max(1, evidence.wrongCount),
      last_seen: today,
      source: WEAK_POINT_SOURCE_MASTERY,
    };
    this.persistProfileUpdateFromVfs({
      ...emptyProfileUpdate(), weak_points_add: [weakPoint],
    }, 'mastery hard reflux upsert', 'enforce');
  }

  /** Rust `remove_weak_point_from_mastery`: only `source=mastery` entries match. */
  removeWeakPointFromMastery(concept: string): void {
    const trimmed = concept.trim();
    if (trimmed === '') {
      throw new Error("Invalid argument 'concept': mastery concept must be non-empty");
    }
    for (let attempt = 0; attempt < PROFILE_CAS_MAX_RETRIES; attempt += 1) {
      const snapshot = this.profileNoteSnapshot(LEARNER_PROFILE_NOTE_TITLE);
      const profile = snapshot === null
        ? emptyProfile() : (learnerProfileFromJson(snapshot.content) ?? emptyProfile());

      const before = profile.weak_points.length;
      profile.weak_points = profile.weak_points.filter(weakPoint =>
        !(weakPoint.source === WEAK_POINT_SOURCE_MASTERY
          && asciiLower(weakPoint.knowledge_point.trim()) === asciiLower(trimmed)));
      if (profile.weak_points.length === before) return;

      profile.version = Math.min(0xffffffff, profile.version + 1);
      profile.updated_at = chronoRfc3339();
      enforceProfileCharLimit(profile);
      const json = learnerProfileToJson(profile);

      if (snapshot !== null) {
        try {
          updateNote(this.host.deps, this.host.db, snapshot.noteId, { content: json,
            expectedUpdatedAt: snapshot.updatedAt });
        } catch (error) {
          if (isProfileRetryable(error)) continue;
          throw error;
        }
      }
      return;
    }
    throw new Error('CONFLICT(learner_profile.conflict): The learner profile remained busy after mastery recovery retries.');
  }

  private ensureSystemFolderId(): string {
    const rootId = this.host.rootId();
    const existing = this.findSystemFolderIdReadonly(rootId);
    if (existing !== null) return existing;
    return createFolder(this.host.deps, this.host.db, SYSTEM_FOLDER_TITLE, rootId).id;
  }

  /** Rust `append_profile_history` (JSONL, de-duped by version, last 5 kept). */
  private appendProfileHistory(committed: LearnerProfile): void {
    for (let attempt = 0; attempt < PROFILE_CAS_MAX_RETRIES; attempt += 1) {
      const systemId = this.ensureSystemFolderId();
      const snapshot = this.profileNoteSnapshot(LEARNER_PROFILE_HISTORY_NOTE_TITLE);
      const versions = snapshot === null ? [] : snapshot.content.split(/\r\n|\n|\r/)
        .filter(line => line.trim() !== '')
        .map(line => learnerProfileFromJson(line))
        .filter((profile): profile is LearnerProfile => profile !== null);
      versions.push(committed);
      const deduped = dedupeProfileVersionsKeepLast(versions);
      const kept = deduped.slice(Math.max(0, deduped.length - PROFILE_HISTORY_KEEP));
      const content = kept.map(profile => learnerProfileToJson(profile)).join('\n');
      if (snapshot !== null) {
        try {
          updateNote(this.host.deps, this.host.db, snapshot.noteId, { content,
            expectedUpdatedAt: snapshot.updatedAt });
          return;
        } catch (error) {
          if (isProfileRetryable(error)) continue;
          throw error;
        }
      }
      if (this.profileNoteSnapshot(LEARNER_PROFILE_HISTORY_NOTE_TITLE) !== null) continue;
      const note = createNote(this.host.deps, this.host.db, {
        title: LEARNER_PROFILE_HISTORY_NOTE_TITLE, content, tags: ['_system'],
      }, systemId);
      this.host.markDisabledBestEffort(note.resourceId, 'system learner profile history note');
      return;
    }
    throw new Error('CONFLICT(learner_profile_history.conflict): The learner profile history remained busy after repeated retries.');
  }
}

/** Rust `format!("{:.2}", score)` keeps two fractional digits and rounds half away from zero. */
export function formatF64Fixed2(value: number): string {
  return value.toFixed(2);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProfileRetryable(error: unknown): boolean {
  const message = errorText(error);
  return message.includes('CONFLICT(notes.conflict)')
    || message.includes('database is locked')
    || message.includes('SQLITE_BUSY')
    || message.includes(' BUSY');
}
