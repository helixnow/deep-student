// dstu-storage/src/file_deletion_queue.rs journal SQL (D1: deletion journal owned by L10).
// F3 keeps the file orchestration (hashing, rename/unlink, autocommit checks,
// BEGIN IMMEDIATE around finish) and calls these on the same SqlExecutor.
// SQL errors propagate unchanged; F3 maps them and builds its own error kinds.
import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { notesLog } from './log.ts';
import type { BlobDeletionJournalRepository, DeletionJournalIntent, DeletionJournalRepository, DeletionTargetKind } from '../api.ts';

interface JournalTupleRow {
  target_kind: string;
  entity_key: string;
  local_path: string;
  expected_hash: string | null;
  size: bigint | null;
}

const journalTupleQuery = defineQuery<readonly [string], JournalTupleRow>(
  `SELECT target_kind, entity_key, local_path, expected_hash, size
     FROM __file_deletion_journal
    WHERE operation_id = ?1`,
  { name: 'notes.deletionJournal.tuple', options: { safeIntegers: true } },
);

const preparedIntentsQuery = defineQuery<readonly [string], {
  operation_id: string; entity_key: string; local_path: string; expected_hash: string | null; size: bigint | null;
}>(
  `SELECT operation_id, entity_key, local_path, expected_hash, size
     FROM __file_deletion_journal
    WHERE target_kind = ?1 AND state = 'prepared'
    ORDER BY prepared_at, operation_id`,
  { name: 'notes.deletionJournal.prepared', options: { safeIntegers: true } },
);

/** file_deletion_queue.rs:766 `chrono::Utc::now().to_rfc3339()`. */
function now(): string {
  return toRfc3339();
}

/** Rust `size.map(|value| value as i64)`: u64 → i64 two's complement. */
function storedSize(size: bigint | null): bigint | null {
  return size === null ? null : BigInt.asIntN(64, size);
}

/** Rust `ROLLBACK TO SAVEPOINT x; RELEASE SAVEPOINT x;` with the result ignored. */
function rollbackTo(conn: SqlExecutor, name: string): void {
  try {
    conn.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`);
  } catch (rollbackError) {
    // `let _ = conn.execute_batch(..)`: the original error is returned.
    notesLog.debugError(`[notes] ${name} rollback failed`, rollbackError);
  }
}

export const deletionJournalRepository: DeletionJournalRepository = {
  /** file_deletion_queue.rs:348-422. `null` = DuplicateOperation (F3 builds the error). */
  insertPreparedIntent(conn, input) {
    const size = storedSize(input.size);
    conn.run(
      `INSERT INTO __file_deletion_journal (
           operation_id, target_kind, entity_key, local_path, expected_hash,
           size, state, prepared_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'prepared', ?7)
       ON CONFLICT(operation_id) DO NOTHING`,
      [input.operationId, input.targetKind, input.entityKey, input.localPath, input.expectedHash, size, now()],
    );
    const existing = conn.get(journalTupleQuery, [input.operationId]);
    if (existing === undefined
      || existing.target_kind !== input.targetKind
      || existing.entity_key !== input.entityKey
      || existing.local_path !== input.localPath
      || existing.expected_hash !== input.expectedHash
      || existing.size !== size) {
      return null;
    }
    return {
      operation_id: input.operationId,
      entity_key: input.entityKey,
      local_path: input.localPath,
      expected_hash: input.expectedHash,
      size: input.size,
    };
  },

  /** file_deletion_queue.rs:430-447; negative stored sizes fail `u64::try_from` and become None. */
  listPreparedIntents(conn, targetKind) {
    return conn.all(preparedIntentsQuery, [targetKind]).map((row) => ({
      operation_id: row.operation_id,
      entity_key: row.entity_key,
      local_path: row.local_path,
      expected_hash: row.expected_hash,
      size: row.size === null || row.size < 0n ? null : row.size,
    }));
  },

  /** file_deletion_queue.rs:479-484. */
  cancelRetainedIntent(conn, operationId) {
    conn.run(
      `UPDATE __file_deletion_journal SET state = 'cancelled', cancelled_at = ?2,
       last_error = 'retained by note history/current document' WHERE operation_id = ?1 AND state = 'prepared'`,
      [operationId, now()],
    );
  },

  /** file_deletion_queue.rs:688-697; `message` is built by F3 (expected/actual hashes). */
  cancelConflictIntent(conn, operationId, message) {
    conn.run(
      `UPDATE __file_deletion_journal
          SET state = 'cancelled',
              cancelled_at = ?2,
              last_error = ?3
        WHERE operation_id = ?1 AND state = 'prepared'`,
      [operationId, now(), message],
    );
  },

  /** file_deletion_queue.rs:603-675. `false` = InvalidState (F3 builds the error). */
  markReady(conn, targetKind, intent) {
    const readyAt = now();
    conn.exec('SAVEPOINT file_deletion_ready');
    let updated: number;
    try {
      if (targetKind === 'asset') {
        conn.run(
          `INSERT INTO __asset_deletion_queue (key, size, deleted_at, retry_count)
           VALUES (?1, ?2, ?3, 0)
           ON CONFLICT(key) DO UPDATE SET
               size = excluded.size,
               deleted_at = excluded.deleted_at,
               retry_count = 0`,
          [intent.entity_key, storedSize(intent.size), readyAt],
        );
      } else {
        conn.run(
          `INSERT INTO __workspace_deletion_queue (
               workspace_id, size, deleted_at, retry_count
           ) VALUES (?1, ?2, ?3, 0)
           ON CONFLICT(workspace_id) DO UPDATE SET
               size = excluded.size,
               deleted_at = excluded.deleted_at,
               retry_count = 0`,
          [intent.entity_key, storedSize(intent.size), readyAt],
        );
      }
      updated = conn.run(
        `UPDATE __file_deletion_journal
            SET state = 'ready',
                ready_at = ?2,
                last_error = NULL
          WHERE operation_id = ?1
            AND state IN ('prepared', 'ready')`,
        [intent.operation_id, readyAt],
      ).changes;
    } catch (error) {
      rollbackTo(conn, 'file_deletion_ready');
      throw error;
    }
    if (updated !== 1) {
      rollbackTo(conn, 'file_deletion_ready');
      return false;
    }
    // Rust `?` on RELEASE: the error is returned without ROLLBACK TO.
    conn.exec('RELEASE SAVEPOINT file_deletion_ready');
    return true;
  },

  /** file_deletion_queue.rs:305-338 (F3 runs ensure_autocommit first). */
  cancelReadyWorkspaceDeletion(conn, workspaceId) {
    conn.exec('SAVEPOINT workspace_deletion_recreated');
    try {
      conn.run(
        `UPDATE __file_deletion_journal
            SET state = 'cancelled',
                cancelled_at = ?2,
                last_error = 'workspace recreated before deletion was published'
          WHERE target_kind = 'workspace'
            AND entity_key = ?1
            AND state = 'ready'`,
        [workspaceId, now()],
      );
      conn.run('DELETE FROM __workspace_deletion_queue WHERE workspace_id = ?1', [workspaceId]);
    } catch (error) {
      rollbackTo(conn, 'workspace_deletion_recreated');
      throw error;
    }
    conn.exec('RELEASE SAVEPOINT workspace_deletion_recreated');
  },
};

export type { DeletionJournalIntent, DeletionTargetKind };

/** blob_repo.rs: L11 keeps the original savepoints, blob row and outbox operations. */
export const blobDeletionJournalRepository: BlobDeletionJournalRepository = {
  cancelBlobDeletionsForRecreatedBlob(conn, hash, cancelledAt) {
    conn.run(
      `UPDATE __file_deletion_journal
          SET state = 'cancelled',
              cancelled_at = ?2,
              last_error = 'blob recreated before deletion was published'
        WHERE target_kind = 'blob'
          AND entity_key = ?1
          AND state IN ('prepared', 'ready')`,
      [hash, cancelledAt],
    );
  },

  insertPreparedBlobDeletion(conn, input) {
    conn.run(
      `INSERT INTO __file_deletion_journal (
           operation_id, target_kind, entity_key, local_path,
           expected_hash, size, state, prepared_at
       ) VALUES (?1, 'blob', ?2, ?3, ?4, ?5, 'prepared', ?6)`,
      [input.operationId, input.hash, input.relativePath, input.expectedHash, input.size, input.preparedAt],
    );
  },

  cancelPreparedBlobDeletion(conn, operationId, cancelledAt, lastError) {
    conn.run(
      `UPDATE __file_deletion_journal
          SET state = 'cancelled',
              cancelled_at = ?2,
              last_error = ?3
        WHERE operation_id = ?1 AND state = 'prepared'`,
      [operationId, cancelledAt, lastError],
    );
  },

  markBlobDeletionReady(conn, operationId, readyAt) {
    return conn.run(
      `UPDATE __file_deletion_journal
          SET state = 'ready',
              ready_at = ?2,
              last_error = NULL
        WHERE operation_id = ?1
          AND state IN ('prepared', 'ready')`,
      [operationId, readyAt],
    ).changes;
  },
};
