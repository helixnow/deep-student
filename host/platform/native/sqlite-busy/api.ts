/**
 * `nativeSqliteBusy`: `sqlite3_busy_handler` on the same better-sqlite3 13.0.3
 * connection (D17 / D-022).
 *
 * Test-only.  Production waits on `busy_timeout` (5 s) plus `BEGIN IMMEDIATE`, as
 * Rust production does; the busy handler exists in Rust only under `#[cfg(test)]`.
 * Prebuilds cover the test machines, not every desktop target, and packaged builds
 * cannot `loadExtension` a path inside app.asar.  See host/platform/API.md
 * "sqlite busy"; `tests/sqlite-busy-production.test.ts` rejects new production users.
 *
 * Rust `rusqlite::Connection::busy_handler` (used by dstu-sync `state.rs:626-657`)
 * installs a callback that SQLite calls synchronously inside the `sqlite3_step`
 * that hit the lock, on the connection's own thread.  This service installs the
 * same kind of callback on the exact `sqlite3*` of a better-sqlite3 `Database`
 * through that binding's own `loadExtension` (see `busy_handler.c`).
 *
 * - `true` keeps waiting (SQLite retries the lock), `false` makes the statement
 *   fail with `SQLITE_BUSY`; `priorInvocations` is SQLite's count of earlier
 *   calls for the same lock event (rusqlite passes the same value).
 * - `null` removes the handler: lock contention fails immediately; the previous
 *   `busy_timeout` is not restored.
 * - A later `PRAGMA busy_timeout = N` (or `sqlite3_busy_timeout`) replaces the
 *   handler, as in SQLite; the function reference is then released at the next
 *   `setBusyHandler` or at `close()`.
 * - A handler that throws is treated as `false`, as rusqlite 0.40.1 does with a
 *   panicking callback (`busy.rs:60`, `catch_unwind(..).unwrap_or_default()`):
 *   the native layer clears the JS exception and SQLite continues with its own
 *   result for that step (usually `SQLITE_BUSY`; `PRAGMA wal_checkpoint`
 *   returns its row with `busy = 1`).  The thrown value is not kept or
 *   rethrown.  Any return value other than `true` is `false`.
 * - Replacing the handler, `null`, or `close()` releases the function reference.
 * - Must be called while no statement is running on the connection (the
 *   binding's own `loadExtension` guard: "This database connection is busy
 *   executing a query").
 */
export interface SqliteBusyConnection {
  readonly open: boolean;
  loadExtension(path: string, entryPoint?: string): unknown;
}

export type SqliteBusyHandler = (priorInvocations: number) => boolean;

export interface NativeSqliteBusy {
  setBusyHandler(db: SqliteBusyConnection, handler: SqliteBusyHandler | null): void;
}

declare module '@deepseek-ai/cordis' {
  interface Context { nativeSqliteBusy: NativeSqliteBusy }
}
