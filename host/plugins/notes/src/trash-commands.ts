// cmd/notes.rs::notes_hard_delete / notes_empty_trash.
//
// Rust prepares asset-deletion intents inside the same transaction as the row
// purge, then finishes them after commit:
//   SAVEPOINT notes_hard_delete_with_assets
//     VfsNoteRepo::purge_note_with_conn(&conn, ..)
//     prepare_asset_deletion_with_conn(&conn, ..)   // same &Connection
//   RELEASE
//   finish_asset_deletion_with_conn(&conn, ..)      // only after commit
//
// The journal seam takes the same platform SqlExecutor, so purge and prepared
// intents commit or roll back together inside the caller's SAVEPOINT.
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { PreparedDeletionIntent, SqlExecutor } from '../../../platform/storage/api.ts';
import {
  AssetError, collectNoteAssetDeletionDirForNote, collectNoteAssetDeletionDirsForNotes,
  normalizeSubject, removeEmptyAssetDirectory,
} from '../repository/assets.ts';
import type { NoteAssetDeletionDir } from '../repository/assets.ts';
import { noteRepository } from '../repository/notes.ts';
import { noteRevisionRepository } from '../repository/revisions.ts';
import { notesLog } from '../repository/log.ts';
import { errorMessage } from './command-utils.ts';
import { notesLocalRuntime } from './local-runtime.ts';
import { vfsErrorDisplay } from '../repository/errors.ts';

/** cmd/notes.rs: `let _ = conn.execute_batch("ROLLBACK TO SAVEPOINT x; RELEASE SAVEPOINT x;")`. */
function rollbackSavepoint(conn: SqlExecutor, name: string): void {
  try {
    conn.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`);
  } catch (rollbackError) {
    // Rust ignores rollback failures and returns the original error.
    notesLog.debugError(`[notes] ${name} rollback failed`, rollbackError);
  }
}

/** Run `work` between SAVEPOINT/RELEASE with cmd/notes.rs error prefixes. */
function withSavepoint<T>(conn: SqlExecutor, name: string, begin: string, commit: string, work: () => T): T {
  try {
    conn.exec(`SAVEPOINT ${name}`);
  } catch (error) {
    throw new CommandError(AppError.database(`${begin}: ${errorMessage(error)}`));
  }
  let result: T;
  try {
    result = work();
  } catch (error) {
    rollbackSavepoint(conn, name);
    throw error;
  }
  try {
    conn.exec(`RELEASE SAVEPOINT ${name}`);
  } catch (error) {
    // Rust maps the RELEASE failure and returns without ROLLBACK TO.
    throw new CommandError(AppError.database(`${commit}: ${errorMessage(error)}`));
  }
  return result;
}

function purgeFailure(prefix: string, error: unknown): never {
  throw new CommandError(AppError.database(`${prefix}: ${vfsErrorDisplay(error)}`));
}

function recoverPending(activeDir: string): void {
  try {
    notesLocalRuntime().recoverAssetDeletions(activeDir);
  } catch (error) {
    throw new CommandError(AppError.file_system(`恢复未完成资产删除失败: ${errorMessage(error)}`));
  }
}

function retainedAssets(conn: SqlExecutor): Set<string> {
  try {
    return noteRevisionRepository.retainedAssetPaths(conn);
  } catch (error) {
    throw new CommandError(AppError.database(vfsErrorDisplay(error)));
  }
}

/** Discovery/validation failures happen before the purge, like Rust. */
function assetCollectFailure(error: unknown): never {
  if (error instanceof AssetError) {
    if (error.kind === 'validation') throw new CommandError(AppError.validation(error.message));
    if (error.kind === 'database') throw new CommandError(AppError.database(error.message));
    throw new CommandError(AppError.file_system(error.message));
  }
  throw new CommandError(AppError.file_system(errorMessage(error)));
}

export function hardDelete(
  baseDir: string,
  conn: SqlExecutor,
  id: string,
  subject: string | null | undefined,
): boolean {
  recoverPending(baseDir);
  let assetDir: NoteAssetDeletionDir;
  try {
    assetDir = collectNoteAssetDeletionDirForNote(baseDir, normalizeSubject(subject), id);
  } catch (error) {
    assetCollectFailure(error);
  }
  let note;
  try {
    note = noteRepository.getNoteIncludingDeleted(id, conn);
  } catch (error) {
    throw new CommandError(AppError.database(`读取待硬删除笔记失败: ${vfsErrorDisplay(error)}`));
  }
  if (note === null) return false;

  // cmd/notes.rs:1515-1551: metadata purge and every prepared intent commit together.
  const intents = withSavepoint(conn, 'notes_hard_delete_with_assets',
    '开启笔记硬删除事务失败', '提交笔记硬删除事务失败', () => {
      try {
        noteRepository.purgeNoteWithConn(conn, id);
      } catch (error) {
        purgeFailure('硬删除笔记失败', error);
      }
      const retained = retainedAssets(conn);
      const prepared: PreparedDeletionIntent[] = [];
      for (const file of assetDir.files) {
        if (retained.has(file.localPath)) continue;
        try {
          prepared.push(notesLocalRuntime().prepareAssetDeletion(conn, baseDir, file.key, file.localPath));
        } catch (error) {
          throw new CommandError(AppError.file_system(`准备笔记资产删除意图失败: ${errorMessage(error)}`));
        }
      }
      return prepared;
    });
  // Only after RELEASE committed the purge may physical files be touched.
  for (const intent of intents) {
    try {
      notesLocalRuntime().finishAssetDeletion(conn, baseDir, intent);
    } catch (error) {
      throw new CommandError(AppError.file_system(`完成笔记资产删除安全链失败: ${errorMessage(error)}`));
    }
  }
  removeEmptyAssetDirectory(assetDir.dir);
  return true;
}

export function emptyTrash(baseDir: string, conn: SqlExecutor): number {
  recoverPending(baseDir);
  let ids: string[];
  try {
    ids = noteRepository.deletedNoteIds(conn);
  } catch (error) {
    throw new CommandError(AppError.database(`准备回收站查询失败: ${vfsErrorDisplay(error)}`));
  }
  let assetDirs: NoteAssetDeletionDir[];
  try {
    assetDirs = collectNoteAssetDeletionDirsForNotes(baseDir, ids);
  } catch (error) {
    assetCollectFailure(error);
  }

  // cmd/notes.rs:1697-1741.
  const { deleted, intents } = withSavepoint(conn, 'notes_empty_trash_with_assets',
    '开启清空回收站事务失败', '提交清空回收站事务失败', () => {
      let count: number;
      try {
        count = noteRepository.purgeDeletedNotesWithConn(conn);
      } catch (error) {
        purgeFailure('VFS 清空回收站失败', error);
      }
      const retained = retainedAssets(conn);
      const prepared: PreparedDeletionIntent[] = [];
      for (const { files } of assetDirs) {
        for (const file of files) {
          if (retained.has(file.localPath)) continue;
          try {
            prepared.push(notesLocalRuntime().prepareAssetDeletion(conn, baseDir, file.key, file.localPath));
          } catch (error) {
            throw new CommandError(AppError.file_system(
              `准备清空回收站资产删除意图失败: ${errorMessage(error)}`));
          }
        }
      }
      return { deleted: count, intents: prepared };
    });
  for (const intent of intents) {
    try {
      notesLocalRuntime().finishAssetDeletion(conn, baseDir, intent);
    } catch (error) {
      throw new CommandError(AppError.file_system(
        `完成清空回收站资产删除安全链失败: ${errorMessage(error)}`));
    }
  }
  for (const { dir } of assetDirs) removeEmptyAssetDirectory(dir);
  return deleted;
}
