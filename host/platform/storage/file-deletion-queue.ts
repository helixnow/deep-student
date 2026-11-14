/**
 * Durable local deletion intents for file-level cloud sync
 * (dstu-storage/src/file_deletion_queue.rs).
 *
 * `prepared` journal row -> physical rename/unlink -> ready-only outbox.  The
 * outbox DELETE trigger advances the journal to `published`, so drain code can
 * never observe a prepared operation.  Journal functions run synchronously on
 * the caller's {@link SqlExecutor} (a `DatabaseHandle` or transaction scope),
 * matching the Rust transaction boundaries.  The table owner is L10-notes; F3
 * only provides the executor/transaction seam and the file-lock primitives.
 *
 * Legacy note call sites still pass a raw better-sqlite3 connection.  The
 * public signature does not mention the driver; an internal adapter accepts
 * that shape until L10 migrates to `SqlExecutor` (D1/D4).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Slot, type Disposer } from '../../kernel/api.ts';
import { renameSyncWithRetry } from './data-space-files.ts';
import { StorageError, type Query, type RunResult, type SqlExecutor, type SqlParam, type SqlParams } from './api.ts';
import { storageLog } from './logging.ts';
import { rfc3339Now } from './time.ts';
import { rustTrim } from '../util/portable.ts';
import { deleteWorkspaceIndexWithOwner } from './workspace-deletion-owner.ts';

const LOG_TARGET = 'dstu_storage::file_deletion_queue';

export type DeletionTargetKind = 'asset' | 'workspace';
export type JournalErrorCode =
  | 'Database'
  | 'Io'
  | 'InvalidPath'
  | 'Conflict'
  | 'DuplicateOperation'
  | 'InvalidState'
  | 'TransactionBoundary'
  | 'ReferencedNoteAsset';

export class DeletionJournalError extends Error {
  override name = 'DeletionJournalError';
  readonly code: JournalErrorCode;
  readonly details: Record<string, unknown> | null;

  constructor(code: JournalErrorCode, message: string, details: Record<string, unknown> | null = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface PreparedDeletionIntent {
  operation_id: string;
  entity_key: string;
  local_path: string;
  expected_hash: string | null;
  size: number | bigint | null;
}

/**
 * Note asset reference guard registered by L10 (`extensions.rs`
 * `register_note_asset_retention`).  The executor is the same transaction scope
 * used by prepare, so "still referenced" and "write intent" see one snapshot.
 */
export interface NoteAssetRetention {
  assetIsReferenced(conn: SqlExecutor, relativePath: string): boolean;
}

/** better-sqlite3 statement shape used by the transitional legacy connection seam. */
export interface LegacyStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  pluck(enabled?: boolean): LegacyStatement;
}

/**
 * Structural better-sqlite3 connection accepted by the D1 journal seam for
 * pre-D1 note call sites. New callers must pass a {@link SqlExecutor}
 * (`DatabaseHandle`/transaction scope); this overload is removed when L10
 * finishes the `SqlExecutor` migration.
 *
 * @deprecated use `SqlExecutor`.
 */
export interface LegacyConnection {
  prepare(sql: string): LegacyStatement;
  exec(sql: string): unknown;
  readonly inTransaction?: boolean;
}

/** @deprecated Compatibility surface for pre-D1 note callbacks; new callers use SqlExecutor. */
interface RetentionConnection extends SqlExecutor {
  prepare(sql: string): LegacyStatement;
}

interface NormalizedExecutor {
  readonly executor: SqlExecutor;
  readonly retention: RetentionConnection;
  readonly inTransaction: boolean;
}

const noteAssetRetention = new Slot<NoteAssetRetention>();

/** file_deletion_queue.rs:35; first registration wins like the Rust Slot. */
export function registerNoteAssetRetention(retention: NoteAssetRetention): Disposer {
  return noteAssetRetention.provide(retention);
}

function databaseError(error: unknown): DeletionJournalError {
  return new DeletionJournalError('Database', `删除意图数据库错误: ${error instanceof Error ? error.message : String(error)}`);
}

function ioError(error: unknown): DeletionJournalError {
  return new DeletionJournalError('Io', `删除意图文件错误: ${error instanceof Error ? error.message : String(error)}`);
}

function invalidPath(message: string): DeletionJournalError {
  return new DeletionJournalError('InvalidPath', `删除意图路径非法: ${message}`);
}

function now(): string {
  return rfc3339Now();
}

function sqlOf(query: Query<any, any> | string): string {
  return typeof query === 'string' ? query : query.sql;
}

/** raw better-sqlite3 的位置参数是展开的，`SqlExecutor` 是数组/对象；两层互转。 */
function spreadParams(params: unknown[]): SqlParams | undefined {
  if (params.length === 0) return undefined;
  if (params.length === 1) {
    const only = params[0];
    if (
      only !== null
      && typeof only === 'object'
      && !Array.isArray(only)
      && !(only instanceof Uint8Array)
      && !Buffer.isBuffer(only)
    ) {
      return only as Readonly<Record<string, SqlParam>>;
    }
    return [only as SqlParam];
  }
  return params as SqlParam[];
}

function legacyStatement(executor: SqlExecutor, sql: string, pluck = false): LegacyStatement {
  const statement: LegacyStatement = {
    get: (...params) => {
      const row = executor.get(sql, spreadParams(params));
      if (!pluck || row === undefined || row === null) return row;
      return Object.values(row)[0];
    },
    all: (...params) => {
      const rows = executor.all(sql, spreadParams(params));
      if (!pluck) return rows;
      return rows.map((row) => Object.values(row as Record<string, unknown>)[0]);
    },
    run: (...params) => {
      const result = executor.run(sql, spreadParams(params));
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    pluck: (enabled = true) => legacyStatement(executor, sql, enabled),
  };
  return statement;
}

/** 给任意 SqlExecutor 补上旧 retention 回调需要的 `prepare()` 形状；不暴露驱动句柄。 */
function retentionView(executor: SqlExecutor, prepare?: (sql: string) => LegacyStatement): RetentionConnection {
  const view = Object.create(null) as Record<string, unknown>;
  const methods = ['get', 'one', 'pluck', 'all', 'iterate', 'run', 'exec'] as const;
  for (const method of methods) {
    const fn = (executor as unknown as Record<string, (...args: unknown[]) => unknown>)[method];
    if (typeof fn === 'function') view[method] = fn.bind(executor);
  }
  Object.defineProperty(view, 'inTransaction', { get: () => executor.inTransaction, enumerable: true });
  view.prepare = prepare ?? ((sql: string) => legacyStatement(executor, sql));
  return view as unknown as RetentionConnection;
}

function legacyParams(params: SqlParams | undefined): unknown[] {
  if (params === undefined) return [];
  if (Array.isArray(params)) {
    return params.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value));
  }
  const named: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    named[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  return [named];
}

/** raw better-sqlite3 连接 -> SqlExecutor；仅用于 L10 迁移前的旧调用方。 */
function executorFromLegacy(conn: LegacyConnection): SqlExecutor {
  const executor: SqlExecutor = {
    get(query: Query<any, any> | string, params?: SqlParams) {
      return conn.prepare(sqlOf(query)).get(...legacyParams(params)) as never;
    },
    one(query: Query<any, any> | string, params?: SqlParams) {
      const row = conn.prepare(sqlOf(query)).get(...legacyParams(params));
      if (row === undefined) throw new StorageError('NO_ROWS', 'Query returned no rows');
      return row as never;
    },
    pluck(query: Query<any, any> | string, params?: SqlParams) {
      const row = conn.prepare(sqlOf(query)).get(...legacyParams(params));
      if (row === undefined || row === null) return undefined as never;
      return Object.values(row as Record<string, unknown>)[0] as never;
    },
    all(query: Query<any, any> | string, params?: SqlParams) {
      return conn.prepare(sqlOf(query)).all(...legacyParams(params)) as never;
    },
    *iterate(query: Query<any, any> | string, params?: SqlParams) {
      for (const row of conn.prepare(sqlOf(query)).all(...legacyParams(params))) yield row as never;
    },
    run(query: Query<any, any> | string, params?: SqlParams): RunResult {
      const result = conn.prepare(sqlOf(query)).run(...legacyParams(params));
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    exec(sql: string): void {
      conn.exec(sql);
    },
  } as SqlExecutor;
  return executor;
}

function isExecutor(value: unknown): value is SqlExecutor {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ['get', 'one', 'pluck', 'all', 'iterate', 'run', 'exec'].every((method) => typeof candidate[method] === 'function');
}

function isLegacyConnection(value: unknown): value is LegacyConnection {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.prepare === 'function' && typeof candidate.exec === 'function';
}

function normalizeExecutor(conn: unknown): NormalizedExecutor {
  if (isExecutor(conn)) {
    return {
      executor: conn,
      retention: retentionView(conn),
      inTransaction: conn.inTransaction === true,
    };
  }
  if (isLegacyConnection(conn)) {
    const executor = executorFromLegacy(conn);
    return {
      executor,
      retention: retentionView(executor, (sql) => conn.prepare(sql)),
      inTransaction: conn.inTransaction === true,
    };
  }
  throw new DeletionJournalError('Database', '删除意图需要 SqlExecutor（DatabaseHandle 或事务作用域）');
}

/** file_deletion_queue.rs:94. Internal connection for path-only helpers. */
function openQueueConnection(file: string): Database.Database {
  let conn: Database.Database;
  try { conn = new Database(file); }
  catch (error) { throw databaseError(error); }
  try {
    conn.pragma('busy_timeout = 5000');
    conn.pragma('synchronous = FULL');
  } catch (error) {
    conn.close();
    throw databaseError(error);
  }
  return conn;
}

/** file_deletion_queue.rs:107. */
export function assetKeyFromRelativePath(relativePath: string): string | null {
  let normalized = rustTrim(relativePath).replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/^\/+/, '');
  if (!normalized) return null;
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..') || /^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.startsWith('active/') || normalized.startsWith('app_data/')) return normalized;
  if (normalized === 'pdf_ocr_sessions' || normalized.startsWith('pdf_ocr_sessions/')) return `app_data/${normalized}`;
  return `active/${normalized}`;
}

/** file_deletion_queue.rs:134. */
export function assetLocalPathFromKey(key: string): string {
  const local = key.startsWith('active/') ? key.slice('active/'.length)
    : key.startsWith('app_data/') ? key.slice('app_data/'.length)
      : null;
  if (local === null) throw invalidPath(`资产 key 不在本地命名空间: ${key}`);
  validateRelativePath(local);
  return local;
}

/** file_deletion_queue.rs:145. Path-only helper: opens its own connection. */
export function deleteAssetWithJournal(activeDir: string, key: string, localPath: string): boolean {
  const conn = openQueueConnection(path.join(activeDir, 'databases', 'vfs.db'));
  try {
    recoverPreparedIntents(normalizeExecutor(conn), 'asset', activeDir);
    const absolutePath = resolveLocalPath(activeDir, localPath);
    if (!fs.existsSync(absolutePath)) return false;
    const ctx = normalizeExecutor(conn);
    const intent = prepareAssetDeletion(ctx, activeDir, key, localPath);
    finishPreparedIntent(ctx, 'asset', activeDir, intent);
    return true;
  } finally {
    conn.close();
  }
}

/**
 * file_deletion_queue.rs:169.
 *
 * 在调用方的 SQLite 事务中持久化资产删除意图。调用方应在同一事务中删除业务元数据，
 * 提交成功后再调用 {@link finishAssetDeletionWithConn} 触碰物理文件；本函数不要求
 * autocommit（Rust 特意支持 SAVEPOINT/transaction 内调用）。
 */
export function prepareAssetDeletionWithConn(
  conn: SqlExecutor,
  activeDir: string,
  key: string,
  localPath: string,
): PreparedDeletionIntent;
/** @deprecated transitional raw-connection overload for pre-D1 note call sites. */
export function prepareAssetDeletionWithConn(
  conn: LegacyConnection,
  activeDir: string,
  key: string,
  localPath: string,
): PreparedDeletionIntent;
export function prepareAssetDeletionWithConn(
  conn: SqlExecutor | LegacyConnection,
  activeDir: string,
  key: string,
  localPath: string,
): PreparedDeletionIntent {
  return prepareAssetDeletion(normalizeExecutor(conn), activeDir, key, localPath);
}

/** file_deletion_queue.rs:213. 必须在 prepare 所在事务提交后调用。 */
export function finishAssetDeletionWithConn(
  conn: SqlExecutor,
  activeDir: string,
  intent: PreparedDeletionIntent,
): void;
/** @deprecated transitional raw-connection overload for pre-D1 note call sites. */
export function finishAssetDeletionWithConn(
  conn: LegacyConnection,
  activeDir: string,
  intent: PreparedDeletionIntent,
): void;
export function finishAssetDeletionWithConn(
  conn: SqlExecutor | LegacyConnection,
  activeDir: string,
  intent: PreparedDeletionIntent,
): void {
  finishPreparedIntent(normalizeExecutor(conn), 'asset', activeDir, intent);
}

/** file_deletion_queue.rs:221. Path-only helper: opens its own connection. */
export function recoverAssetDeletions(activeDir: string): number {
  const conn = openQueueConnection(path.join(activeDir, 'databases', 'vfs.db'));
  try { return recoverPreparedIntents(normalizeExecutor(conn), 'asset', activeDir); }
  finally { conn.close(); }
}

/** file_deletion_queue.rs:227. Caller supplies an autocommit executor (workspace db). */
export function recoverWorkspaceDeletions(conn: SqlExecutor, workspacesDir: string): number {
  const ctx = normalizeExecutor(conn);
  ensureAutocommit(ctx);
  ctx.executor.exec('PRAGMA synchronous = FULL');
  return recoverPreparedIntents(ctx, 'workspace', workspacesDir);
}

/**
 * file_deletion_queue.rs:238. Caller supplies an autocommit executor; the prepared
 * intent and workspace_index removal commit together. The caller deletes the
 * database file only after this returns, then calls {@link finishWorkspaceDeletion}.
 */
export function prepareWorkspaceDeletion(
  conn: SqlExecutor,
  workspacesDir: string,
  workspaceId: string,
): PreparedDeletionIntent {
  const ctx = normalizeExecutor(conn);
  ensureAutocommit(ctx);
  ctx.executor.exec('PRAGMA synchronous = FULL');

  const localPath = `ws_${workspaceId}.db`;
  validateRelativePath(localPath);
  const absolutePath = resolveLocalPath(workspacesDir, localPath);
  let expectedHash: string | null = null;
  let size: number | null = null;
  if (fs.existsSync(absolutePath)) {
    ensureRegularFile(workspacesDir, absolutePath);
    expectedHash = hashFile(absolutePath);
    size = fs.statSync(absolutePath).size;
  }
  const operationId = randomUUID();
  const storedPath = pathToStorage(localPath);

  ctx.executor.exec('SAVEPOINT workspace_deletion_prepare');
  try {
    const intent = insertPreparedIntentIn(ctx, 'workspace', workspaceId, storedPath, expectedHash, size, operationId);
    try { deleteWorkspaceIndexWithOwner(ctx.executor, workspaceId); }
    catch (error) { throw databaseError(error); }
    ctx.executor.exec('RELEASE SAVEPOINT workspace_deletion_prepare');
    return intent;
  } catch (error) {
    try {
      ctx.executor.exec('ROLLBACK TO SAVEPOINT workspace_deletion_prepare');
      ctx.executor.exec('RELEASE SAVEPOINT workspace_deletion_prepare');
    } catch (rollbackError) {
      storageLog(LOG_TARGET, 'warn', `回滚 workspace_deletion_prepare 保存点失败: ${String(rollbackError)}`);
    }
    throw error;
  }
}

/** file_deletion_queue.rs:294. */
export function finishWorkspaceDeletion(
  conn: SqlExecutor,
  workspacesDir: string,
  intent: PreparedDeletionIntent,
): void {
  finishPreparedIntent(normalizeExecutor(conn), 'workspace', workspacesDir, intent);
}

/** file_deletion_queue.rs:305. */
export function cancelReadyWorkspaceDeletion(conn: SqlExecutor, workspaceId: string): void {
  const ctx = normalizeExecutor(conn);
  ensureAutocommit(ctx);
  ctx.executor.exec('SAVEPOINT workspace_deletion_recreated');
  try {
    ctx.executor.run(
      `UPDATE __file_deletion_journal
          SET state = 'cancelled',
              cancelled_at = ?,
              last_error = 'workspace recreated before deletion was published'
        WHERE target_kind = 'workspace'
          AND entity_key = ?
          AND state = 'ready'`,
      [now(), workspaceId],
    );
    ctx.executor.run('DELETE FROM __workspace_deletion_queue WHERE workspace_id = ?', [workspaceId]);
    ctx.executor.exec('RELEASE SAVEPOINT workspace_deletion_recreated');
  } catch (error) {
    try {
      ctx.executor.exec('ROLLBACK TO SAVEPOINT workspace_deletion_recreated');
      ctx.executor.exec('RELEASE SAVEPOINT workspace_deletion_recreated');
    } catch (rollbackError) {
      storageLog(LOG_TARGET, 'warn', `回滚 workspace_deletion_recreated 保存点失败: ${String(rollbackError)}`);
    }
    throw error;
  }
}

/** file_deletion_queue.rs:340. */
function ensureAutocommit(ctx: NormalizedExecutor): void {
  if (ctx.inTransaction) {
    throw new DeletionJournalError('TransactionBoundary', '删除意图必须在独立 SQLite 事务中准备');
  }
}

/**
 * file_deletion_queue.rs:348.
 *
 * Public for L10/L05 transaction seams; prefer {@link prepareAssetDeletionWithConn}
 * or {@link prepareWorkspaceDeletion} unless you are reproducing crash recovery.
 */
export function insertPreparedIntent(
  conn: SqlExecutor,
  targetKind: DeletionTargetKind,
  entityKey: string,
  localPath: string,
  expectedHash: string | null,
  size: number | null,
  operationId: string,
): PreparedDeletionIntent {
  return insertPreparedIntentIn(normalizeExecutor(conn), targetKind, entityKey, localPath, expectedHash, size, operationId);
}

function insertPreparedIntentIn(
  ctx: NormalizedExecutor,
  targetKind: DeletionTargetKind,
  entityKey: string,
  localPath: string,
  expectedHash: string | null,
  size: number | null,
  operationId: string,
): PreparedDeletionIntent {
  const preparedAt = now();
  try {
    ctx.executor.run(
      `INSERT INTO __file_deletion_journal (
           operation_id, target_kind, entity_key, local_path, expected_hash,
           size, state, prepared_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?)
       ON CONFLICT(operation_id) DO NOTHING`,
      [operationId, targetKind, entityKey, localPath, expectedHash, size, preparedAt],
    );

    const existing = ctx.executor.get<{
      target_kind: string;
      entity_key: string;
      local_path: string;
      expected_hash: string | null;
      size: number | null;
    }>(
      `SELECT target_kind, entity_key, local_path, expected_hash, size
         FROM __file_deletion_journal
        WHERE operation_id = ?`,
      [operationId],
    );

    const same = existing !== undefined
      && existing.target_kind === targetKind
      && existing.entity_key === entityKey
      && existing.local_path === localPath
      && existing.expected_hash === expectedHash
      && existing.size === size;
    if (!same) {
      throw new DeletionJournalError('DuplicateOperation', `operation_id 已用于其他删除意图: ${operationId}`);
    }
    return {
      operation_id: operationId,
      entity_key: entityKey,
      local_path: localPath,
      expected_hash: expectedHash,
      size,
    };
  } catch (error) {
    if (error instanceof DeletionJournalError) throw error;
    throw databaseError(error);
  }
}

/** file_deletion_queue.rs:424. */
function recoverPreparedIntents(
  ctx: NormalizedExecutor,
  targetKind: DeletionTargetKind,
  root: string,
): number {
  ensureAutocommit(ctx);
  let intents: PreparedDeletionIntent[];
  try {
    intents = ctx.executor.all<PreparedDeletionIntent>(
      `SELECT operation_id, entity_key, local_path, expected_hash, size
         FROM __file_deletion_journal
        WHERE target_kind = ? AND state = 'prepared'
        ORDER BY prepared_at, operation_id`,
      [targetKind],
    );
  } catch (error) { throw databaseError(error); }

  let recovered = 0;
  for (const intent of intents) {
    finishPreparedIntent(ctx, targetKind, root, intent);
    recovered += 1;
  }
  return recovered;
}

/** file_deletion_queue.rs:458. */
function finishPreparedIntent(
  ctx: NormalizedExecutor,
  targetKind: DeletionTargetKind,
  root: string,
  intent: PreparedDeletionIntent,
): void {
  ensureAutocommit(ctx);
  if (targetKind === 'asset' && intent.local_path.startsWith('notes_assets/')) {
    try { ctx.executor.exec('BEGIN IMMEDIATE'); }
    catch (error) { throw databaseError(error); }
    try {
      if (noteAssetIsReferenced(ctx, intent.local_path)) {
        const absolute = resolveLocalPath(root, intent.local_path);
        const quarantine = deletionQuarantinePath(absolute, intent.operation_id);
        if (!fs.existsSync(absolute) && fs.existsSync(quarantine)) {
          ensureRegularFile(root, quarantine);
          renameSyncWithRetry(quarantine, absolute);
        }
        ctx.executor.run(
          `UPDATE __file_deletion_journal SET state = 'cancelled', cancelled_at = ?,
             last_error = 'retained by note history/current document' WHERE operation_id = ? AND state = 'prepared'`,
          [now(), intent.operation_id],
        );
        ctx.executor.exec('COMMIT');
        return;
      }
      finishPreparedIntentUncommitted(ctx, targetKind, root, intent);
      ctx.executor.exec('COMMIT');
      return;
    } catch (error) {
      try {
        if (error instanceof DeletionJournalError && error.code === 'Conflict') ctx.executor.exec('COMMIT');
        else ctx.executor.exec('ROLLBACK');
      } catch (rollbackError) {
        storageLog(LOG_TARGET, 'warn', `回滚删除意图事务失败: ${String(rollbackError)}`);
      }
      throw error;
    }
  }
  finishPreparedIntentUncommitted(ctx, targetKind, root, intent);
}

function prepareAssetDeletion(
  ctx: NormalizedExecutor,
  activeDir: string,
  key: string,
  localPath: string,
): PreparedDeletionIntent {
  if (noteAssetIsReferenced(ctx, localPath)) {
    throw new DeletionJournalError('ReferencedNoteAsset', `笔记资产仍被当前笔记、回收站或历史版本引用: ${localPath}`);
  }
  const expectedLocalPath = assetLocalPathFromKey(key);
  if (path.normalize(expectedLocalPath) !== path.normalize(localPath)) {
    throw invalidPath(`资产 key 与本地路径不匹配: key=${key}, path=${localPath}`);
  }

  const absolutePath = resolveLocalPath(activeDir, localPath);
  let expectedHash: string | null = null;
  let size: number | null = null;
  if (fs.existsSync(absolutePath)) {
    ensureRegularFile(activeDir, absolutePath);
    expectedHash = hashFile(absolutePath);
    size = fs.statSync(absolutePath).size;
  }
  return insertPreparedIntentIn(ctx, 'asset', key, pathToStorage(localPath), expectedHash, size, randomUUID());
}

/** file_deletion_queue.rs:509. */
function noteAssetIsReferenced(ctx: NormalizedExecutor, relativePath: string): boolean {
  if (!relativePath.startsWith('notes_assets')) return false;
  let hasHistory: boolean;
  try {
    hasHistory = (ctx.executor.get<{ present: number }>(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'note_document_revisions' AND type = 'table') AS present",
    )?.present ?? 0) === 1;
  } catch (error) { throw databaseError(error); }
  if (!hasHistory) return false;
  const retention = noteAssetRetention.get();
  if (!retention) return false;
  try { return retention.assetIsReferenced(ctx.retention, relativePath); }
  catch (error) {
    throw new DeletionJournalError('InvalidState', `删除意图状态错误: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** file_deletion_queue.rs:530. */
function finishPreparedIntentUncommitted(
  ctx: NormalizedExecutor,
  targetKind: DeletionTargetKind,
  root: string,
  intent: PreparedDeletionIntent,
): void {
  const absolutePath = resolveLocalPath(root, intent.local_path);
  const quarantinePath = deletionQuarantinePath(absolutePath, intent.operation_id);

  let deletionPath: string | null = null;
  if (fs.existsSync(quarantinePath)) {
    deletionPath = quarantinePath;
  } else if (fs.existsSync(absolutePath)) {
    ensureRegularFile(root, absolutePath);
    verifyExpectedHash(ctx, intent, absolutePath);
    try { renameSyncWithRetry(absolutePath, quarantinePath); }
    catch (error) { throw ioError(error); }
    deletionPath = quarantinePath;
  }

  if (targetKind === 'workspace') removeWorkspaceSidecars(root, absolutePath);

  if (deletionPath !== null && fs.existsSync(deletionPath)) {
    ensureRegularFile(root, deletionPath);
    verifyExpectedHash(ctx, intent, deletionPath);
    try { fs.unlinkSync(deletionPath); }
    catch (error) { throw ioError(error); }
  }

  markReady(ctx, targetKind, intent);
}

/** file_deletion_queue.rs:569. */
function removeWorkspaceSidecars(root: string, databasePath: string): void {
  for (const extension of ['-wal', '-shm']) {
    const sidecar = `${databasePath}${extension}`;
    if (!fs.existsSync(sidecar)) continue;
    ensureRegularFile(root, sidecar);
    try { fs.unlinkSync(sidecar); }
    catch (error) { throw ioError(error); }
  }
}

/** file_deletion_queue.rs:580. */
function verifyExpectedHash(ctx: NormalizedExecutor, intent: PreparedDeletionIntent, file: string): void {
  const actualHash = hashFile(file);
  if (intent.expected_hash !== null && actualHash === intent.expected_hash) return;
  cancelConflict(ctx, intent, file, intent.expected_hash ?? '<missing baseline>', actualHash);
}

/** file_deletion_queue.rs:593. */
function deletionQuarantinePath(file: string, operationId: string): string {
  const name = path.basename(file);
  if (!name) throw invalidPath(`删除目标缺少文件名: ${file}`);
  return path.join(path.dirname(file), `${name}.deleting-${operationId}`);
}

/** file_deletion_queue.rs:603. */
function markReady(
  ctx: NormalizedExecutor,
  targetKind: DeletionTargetKind,
  intent: PreparedDeletionIntent,
): void {
  const readyAt = now();
  ctx.executor.exec('SAVEPOINT file_deletion_ready');
  try {
    if (targetKind === 'asset') {
      ctx.executor.run(
        `INSERT INTO __asset_deletion_queue (key, size, deleted_at, retry_count)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(key) DO UPDATE SET
             size = excluded.size,
             deleted_at = excluded.deleted_at,
             retry_count = 0`,
        [intent.entity_key, intent.size, readyAt],
      );
    } else {
      ctx.executor.run(
        `INSERT INTO __workspace_deletion_queue (
             workspace_id, size, deleted_at, retry_count
         ) VALUES (?, ?, ?, 0)
         ON CONFLICT(workspace_id) DO UPDATE SET
             size = excluded.size,
             deleted_at = excluded.deleted_at,
             retry_count = 0`,
        [intent.entity_key, intent.size, readyAt],
      );
    }
    const updated = ctx.executor.run(
      `UPDATE __file_deletion_journal
          SET state = 'ready',
              ready_at = ?,
              last_error = NULL
        WHERE operation_id = ?
          AND state IN ('prepared', 'ready')`,
      [readyAt, intent.operation_id],
    );
    if (updated.changes !== 1) {
      throw new DeletionJournalError('InvalidState', `删除意图状态错误: operation ${intent.operation_id} 无法推进到 ready`);
    }
    ctx.executor.exec('RELEASE SAVEPOINT file_deletion_ready');
  } catch (error) {
    try {
      ctx.executor.exec('ROLLBACK TO SAVEPOINT file_deletion_ready');
      ctx.executor.exec('RELEASE SAVEPOINT file_deletion_ready');
    } catch (rollbackError) {
      storageLog(LOG_TARGET, 'warn', `回滚 file_deletion_ready 保存点失败: ${String(rollbackError)}`);
    }
    if (error instanceof DeletionJournalError) throw error;
    throw databaseError(error);
  }
}

/** file_deletion_queue.rs:677. */
function cancelConflict(
  ctx: NormalizedExecutor,
  intent: PreparedDeletionIntent,
  file: string,
  expected: string,
  actual: string,
): never {
  const message = `file content changed after prepare: expected=${expected}, actual=${actual}`;
  try {
    ctx.executor.run(
      `UPDATE __file_deletion_journal
          SET state = 'cancelled',
              cancelled_at = ?,
              last_error = ?
        WHERE operation_id = ? AND state = 'prepared'`,
      [now(), message, intent.operation_id],
    );
  } catch (error) { throw databaseError(error); }
  throw new DeletionJournalError('Conflict', `删除意图内容冲突: operation_id=${intent.operation_id}, path=${file}, expected=${expected}, actual=${actual}`, {
    operation_id: intent.operation_id,
    path: file,
    expected,
    actual,
  });
}

/** file_deletion_queue.rs:704. */
function ensureRegularFile(root: string, file: string): void {
  let canonicalRoot: string;
  let canonicalFile: string;
  try {
    canonicalRoot = fs.realpathSync(root);
    canonicalFile = fs.realpathSync(file);
  } catch (error) { throw ioError(error); }
  if (!containsPath(canonicalRoot, canonicalFile)) {
    throw invalidPath(`${canonicalFile} 越过允许根目录 ${canonicalRoot}`);
  }
  let stat: fs.Stats;
  try { stat = fs.statSync(canonicalFile); }
  catch (error) { throw ioError(error); }
  if (!stat.isFile()) throw invalidPath(`${canonicalFile} 不是普通文件`);
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  const climbs = relative === '..' || relative.startsWith(`..${path.sep}`);
  return relative === '' || (!climbs && !path.isAbsolute(relative));
}

/** file_deletion_queue.rs:723. */
function resolveLocalPath(root: string, localPath: string): string {
  validateRelativePath(localPath);
  return path.join(root, localPath);
}

/** file_deletion_queue.rs:728. */
function validateRelativePath(localPath: string): void {
  const segments = localPath.split(/[/\\]/);
  if (!localPath || path.isAbsolute(localPath) || /^[A-Za-z]:/.test(localPath) || segments.includes('..')) {
    throw invalidPath(localPath);
  }
}

/** file_deletion_queue.rs:745. */
function pathToStorage(localPath: string): string {
  validateRelativePath(localPath);
  return localPath;
}

/** file_deletion_queue.rs:752. */
export function hashFile(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } catch (error) { throw ioError(error); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
