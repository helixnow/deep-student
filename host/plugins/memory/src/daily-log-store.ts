/**
 * Daily-log append store — TS mirror of `dstu-memory/src/memory/daily_log.rs`.
 * The service keeps the public facade; this store owns the CAS replay loop.
 */
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { MemoryVfsDependencies } from '../repository/vfs.ts';
import {
  createFolder, createNote, findSystemNoteSnapshot, getNoteContent, listDailyLogNotesSince, listFoldersByParent,
  updateNote,
} from '../repository/vfs.ts';
import { DAILY_LOG_CAS_MAX_RETRIES, isDailyLogRetryable, memoryTags } from './memory-utils.ts';
import {
  DAILY_LOG_FOLDER_TITLE, DAILY_LOG_TAG, TAG_DAILY_LOG_DATE_PREFIX, dailyLogNoteTitle,
  enforceLogCharLimit, formatDailyLogEntry, linesContainEntry, localDate, localTimeHm,
  parseDateFromTitle, stripEntryPrefix,
} from './daily-log.ts';
import type { DailyLogRecord } from './evolution.ts';

export interface DailyLogAppendOutcome {
  noteId: string;
  resourceId: string | null;
  appended: boolean;
  reason: string;
}

export interface DailyLogStoreHost {
  readonly db: DatabaseHandle;
  readonly deps: MemoryVfsDependencies;
  rootId(): string;
  getRootFolderId(): string | null;
  markPendingBestEffort(resourceId: string): void;
}

export class MemoryDailyLogStore {
  private readonly host: DailyLogStoreHost;
  constructor(host: DailyLogStoreHost) { this.host = host; }

  /** Rust `daily_log::find_log_folder_id`. */
  findDailyLogFolderId(): string | null {
    return listFoldersByParent(this.host.db, this.host.rootId())
      .find(folder => folder.title === DAILY_LOG_FOLDER_TITLE)?.id ?? null;
  }

  /** Rust `daily_log::find_log_note` (CAS snapshot: id, updated_at, content). */
  dailyLogSnapshot(date: string): { noteId: string; updatedAt: string; content: string } | null {
    const folderId = this.findDailyLogFolderId();
    if (folderId === null) return null;
    return findSystemNoteSnapshot(this.host.db, folderId, dailyLogNoteTitle(date)) ?? null;
  }

  /**
   * Rust `daily_log::append_entry_for_date`: append one line to the dated
   * `__daily_log_<date>__` note, deduplicating on the entry body and retrying
   * on optimistic-concurrency conflicts.
   */
  appendDailyLog(date: string, entry: string,
    beforeFirstCommit?: () => void): DailyLogAppendOutcome {
    const trimmed = entry.trim();
    if (trimmed === '') {
      return { noteId: '', resourceId: null, appended: false, reason: '空条目，跳过' };
    }
    const rootId = this.host.rootId();
    const folderId = this.ensureDailyLogFolder(rootId);
    const title = dailyLogNoteTitle(date);
    const time = localTimeHm();
    const newLine = formatDailyLogEntry(trimmed, time);
    const entryBody = stripEntryPrefix(newLine);
    let hook = beforeFirstCommit;

    for (let attempt = 0; attempt < DAILY_LOG_CAS_MAX_RETRIES; attempt += 1) {
      const note = findSystemNoteSnapshot(this.host.db, folderId, title);
      if (note !== undefined) {
        const snapshotContent = note.content;
        if (linesContainEntry(snapshotContent, entryBody)) {
          return { noteId: note.noteId, resourceId: null, appended: false,
            reason: '当日已有相同条目，跳过' };
        }
        const lines = snapshotContent.split(/\r\n|\n|\r/)
          .filter(line => line.trim() !== '');
        lines.push(newLine);
        const content = enforceLogCharLimit(lines);
        hook?.();
        hook = undefined;
        try {
          const updated = updateNote(this.host.deps, this.host.db, note.noteId, {
            content, expectedUpdatedAt: note.updatedAt,
          });
          this.host.markPendingBestEffort(updated.resourceId);
          return { noteId: note.noteId, resourceId: updated.resourceId, appended: true,
            reason: '已追加' };
        } catch (error) {
          if (isDailyLogRetryable(error)) continue;
          throw error;
        }
      }

      hook?.();
      hook = undefined;
      if (findSystemNoteSnapshot(this.host.db, folderId, title) !== undefined) continue;
      const created = createNote(this.host.deps, this.host.db, {
        title, content: newLine,
        tags: [DAILY_LOG_TAG, `${TAG_DAILY_LOG_DATE_PREFIX}${date}`,
          ...memoryTags('study', 'systemic')],
      }, folderId);
      this.host.markPendingBestEffort(created.resourceId);
      return { noteId: created.id, resourceId: created.resourceId, appended: true,
        reason: '已创建当日日志并写入首条' };
    }

    throw new Error('CONFLICT(daily_log.conflict): The daily log remained busy after repeated retries.');
  }

  /** Rust `daily_log::list_recent`: non-empty dated logs from the last `days` local dates, oldest first. */
  listRecent(days: number): DailyLogRecord[] {
    const rootId = this.host.getRootFolderId();
    if (rootId === null) return [];
    const folderId = listFoldersByParent(this.host.db, rootId)
      .find(folder => folder.title === DAILY_LOG_FOLDER_TITLE)?.id;
    if (folderId === undefined) return [];
    const cutoff = localDate(new Date(Date.now() - (Math.max(days, 1) - 1) * 86_400_000));
    const records: DailyLogRecord[] = [];
    for (const row of listDailyLogNotesSince(this.host.db, folderId, dailyLogNoteTitle(cutoff))) {
      const date = parseDateFromTitle(row.title);
      if (date === null) continue;
      const content = getNoteContent(this.host.deps, this.host.db, row.id);
      if (content.trim() === '') continue;
      records.push({ date, noteId: row.id, content });
    }
    return records;
  }

  private ensureDailyLogFolder(rootId: string): string {
    const existing = listFoldersByParent(this.host.db, rootId)
      .find(folder => folder.title === DAILY_LOG_FOLDER_TITLE);
    if (existing !== undefined) return existing.id;
    return createFolder(this.host.deps, this.host.db, DAILY_LOG_FOLDER_TITLE, rootId).id;
  }
}
