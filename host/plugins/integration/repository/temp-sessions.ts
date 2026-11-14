/**
 * `temp_sessions` repository (dstu-storage database/mod.rs:4169-4216). The only Rust
 * callers are commands.rs `persist_temp_session_to_db` / `modify_temp_session`
 * (L22 `temp_sessions` state, see BLOCKERS.md for the table-owner ruling request).
 *
 * Errors mirror anyhow Display (outermost context only): serde failures surface as
 * the `.context(...)` text, SQLite / maintenance failures as the storage message.
 */
import type { StorageService } from '../../../platform/storage/api.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import {
  dateTimeEpochNanos,
  decodeStreamContext,
  encodeStreamContext,
  type StreamContext,
} from '../src/stream-context.ts';

export class TempSessionRepositoryError extends Error {}

/** rusqlite `types::Type` Display. */
function sqliteTypeName(value: unknown): string {
  if (value === null) return 'Null';
  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) return 'Integer';
  if (typeof value === 'number') return 'Real';
  return 'Blob';
}

/** mod.rs:4170-4194 `upsert_temp_session`. */
export function upsertTempSession(storage: StorageService, session: StreamContext): void {
  const db = storage.database('mistakes');
  let sessionJson: string;
  try {
    sessionJson = encodeStreamContext(session);
  } catch (error) {
    throw new TempSessionRepositoryError('Failed to serialize stream context', { cause: error });
  }
  db.run(
    `INSERT INTO temp_sessions (temp_id, session_data, stream_state, created_at, updated_at, last_error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(temp_id) DO UPDATE SET
                session_data=excluded.session_data,
                stream_state=excluded.stream_state,
                updated_at=excluded.updated_at,
                last_error=excluded.last_error`,
    [
      session.temp_id,
      sessionJson,
      session.stream_state,
      toRfc3339(dateTimeEpochNanos(session.created_at)),
      toRfc3339(),
      session.last_error,
    ],
  );
}

/** mod.rs:4197-4216 `get_temp_session_record`. */
export function getTempSessionRecord(storage: StorageService, tempId: string): StreamContext | null {
  const db = storage.database('mistakes');
  const raw = db.pluck<unknown>('SELECT session_data FROM temp_sessions WHERE temp_id = ?1', [tempId]);
  if (raw === undefined) return null;
  // rusqlite `row.get::<_, String>(0)`: non-TEXT storage classes fail with InvalidColumnType.
  if (typeof raw !== 'string') {
    throw new TempSessionRepositoryError(`Invalid column type ${sqliteTypeName(raw)} at index: 0, name: session_data`);
  }
  try {
    return decodeStreamContext(raw);
  } catch (error) {
    throw new TempSessionRepositoryError('Failed to deserialize stream context', { cause: error });
  }
}
