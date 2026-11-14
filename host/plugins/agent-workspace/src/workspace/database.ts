// workspace/database.rs —— 动态 `ws_<id>.db` 的创建、迁移、维护屏障与删除。
//
// 连接由 F3 存储服务打开（`OpenFileOptions.profile = 'workspace'`：foreign_keys=ON、
// journal_mode=WAL、busy_timeout=5000）；本模块只做 id 校验、schema 应用、损坏库
// 收敛与物理删除意图日志。
import * as fs from 'node:fs';
import path from 'node:path';
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import { silentWorkspaceLogger, type WorkspaceLogger } from './logger.ts';
import {
  cancelReadyWorkspaceDeletion,
  prepareWorkspaceDeletion, recoverWorkspaceDeletions, finishWorkspaceDeletion,
} from '../../../../platform/storage/file-deletion-queue.ts';
import { readyOrPublishedDeletionExists, workspaceIndexExists } from '../../repository/chat-v2-repository.ts';
import {
  applyWorkspaceSchema, checkpointTruncate, errorMessage, migrateWorkspaceSchema, quickCheck,
  configureDeletionJournal, enableDeletionJournalForeignKeys,
} from '../../repository/schema.ts';
import { chronoStamp, civilTime, nowEpochNanos } from '../../../../platform/time/index.ts';

/** workspace_id 允许的最大长度（`ws_{ULID}` ≈ 29 字符）。 */
export const WORKSPACE_ID_MAX_LEN = 128;

/** 打开数据库文件的注入点（产线 = ctx.storage.openFile，测试 = node:sqlite 适配器）。 */
export interface WorkspaceStoreIo {
  open(dbPath: string): SqlExecutor;
  close?(db: SqlExecutor): void;
}

/**
 * P0 安全：workspace_id 会被直接拼进数据库文件名（`ws_{id}.db`），
 * 必须先做白名单校验（1..=128 个 `[A-Za-z0-9_-]`）。
 */
export function validateWorkspaceId(workspaceId: string): void {
  const length = Buffer.byteLength(workspaceId, 'utf8');
  if (length === 0 || length > WORKSPACE_ID_MAX_LEN) {
    throw new Error(`Invalid workspace_id length ${length} (expected 1..=${WORKSPACE_ID_MAX_LEN})`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) {
    throw new Error(`Invalid workspace_id ${JSON.stringify(workspaceId)}: only [A-Za-z0-9_-] characters are allowed`);
  }
}

function openDeletionJournal(io: WorkspaceStoreIo, workspacesDir: string): SqlExecutor | null {
  const activeDir = path.dirname(workspacesDir);
  if (activeDir === workspacesDir) {
    throw new Error(`工作区目录没有父目录，无法定位删除日志: ${workspacesDir}`);
  }
  const chatDb = path.join(activeDir, 'chat_v2.db');
  if (!fs.existsSync(chatDb)) return null;
  let connection: SqlExecutor;
  try {
    connection = io.open(chatDb);
  } catch (error) {
    throw new Error(`Failed to open workspace deletion journal: ${errorMessage(error)}`);
  }
  try {
    try { configureDeletionJournal(connection); } catch (error) {
      throw new Error(`Failed to configure workspace deletion journal: ${errorMessage(error)}`);
    }
    try { enableDeletionJournalForeignKeys(connection); } catch (error) {
      throw new Error(`Failed to enable workspace deletion foreign keys: ${errorMessage(error)}`);
    }
  } catch (error) {
    io.close?.(connection);
    throw error;
  }
  return connection;
}

export class WorkspaceDatabase {
  private db: SqlExecutor | null;
  private maintenance = false;

  private readonly io: WorkspaceStoreIo;
  private readonly workspaceIdValue: string;
  private readonly dbPathValue: string;
  private readonly logger: WorkspaceLogger;

  private constructor(
    io: WorkspaceStoreIo,
    workspaceIdValue: string,
    dbPathValue: string,
    db: SqlExecutor,
    logger: WorkspaceLogger = silentWorkspaceLogger,
  ) {
    this.io = io;
    this.workspaceIdValue = workspaceIdValue;
    this.dbPathValue = dbPathValue;
    this.logger = logger;
    this.db = db;
  }

  static create(
    io: WorkspaceStoreIo,
    workspacesDir: string,
    workspaceId: string,
    logger: WorkspaceLogger = silentWorkspaceLogger,
  ): WorkspaceDatabase {
    validateWorkspaceId(workspaceId);
    try {
      fs.mkdirSync(workspacesDir, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create workspaces directory: ${errorMessage(error)}`);
    }

    // 在打开/新建同名数据库前先收敛崩溃遗留的 prepared intent；恢复完成后再
    // 创建同 ID 工作区属于显式重建，应取消尚未发布的旧 tombstone。
    const journal = openDeletionJournal(io, workspacesDir);
    if (journal) {
      try {
        try {
          recoverWorkspaceDeletions(journal, workspacesDir);
        } catch (error) {
          throw new Error(`Failed to recover workspace deletion intent: ${errorMessage(error)}`);
        }
        try {
          cancelReadyWorkspaceDeletion(journal, workspaceId);
        } catch (error) {
          throw new Error(`Failed to cancel recreated workspace deletion: ${errorMessage(error)}`);
        }
      } finally {
        io.close?.(journal);
      }
    }

    const dbPath = path.join(workspacesDir, `ws_${workspaceId}.db`);

    if (fs.existsSync(dbPath)) {
      let checkResult: string | null = null;
      try {
        const probe = io.open(dbPath);
        try {
          checkResult = quickCheck(probe);
        } finally {
          io.close?.(probe);
        }
      } catch {
        checkResult = null;
      }
      if (checkResult !== null && checkResult !== 'ok') {
        const timestamp = chronoStamp(civilTime(nowEpochNanos(), false), '', false).replaceAll('-', '').replace('T', '');
        const corruptPath = path.join(workspacesDir, `ws_${workspaceId}.db.corrupt-${timestamp}`);
        try {
          fs.renameSync(dbPath, corruptPath);
        } catch (error) {
          throw new Error(`Failed to move corrupt workspace database: ${errorMessage(error)}`);
        }
        for (const [suffix, target] of [['-wal', `${corruptPath}.wal`], ['-shm', `${corruptPath}.shm`]] as const) {
          const sidecar = path.join(workspacesDir, `ws_${workspaceId}.db${suffix}`);
          if (!fs.existsSync(sidecar)) continue;
          try {
            fs.renameSync(sidecar, target);
          } catch (error) { // boundary-allow empty-catch: 损坏库 sidecar 重命名失败忽略，主库已隔离（Rust 同样忽略）
            void error;
          }
        }
      }
    }

    const db = io.open(dbPath);
    applyWorkspaceSchema(db);
    migrateWorkspaceSchema(db);
    return new WorkspaceDatabase(io, workspaceId, dbPath, db, logger);
  }

  get workspaceId(): string {
    return this.workspaceIdValue;
  }

  get dbPath(): string {
    return this.dbPathValue;
  }

  getConnection(): SqlExecutor {
    if (this.maintenance) {
      throw new Error('Workspace database is in maintenance mode (backup/restore in progress)');
    }
    if (this.db === null) {
      throw new Error('Failed to get connection: database handle is not open');
    }
    return this.db;
  }

  enterMaintenanceMode(): void {
    if (this.maintenance) throw new Error('工作区数据库已经处于维护模式');
    const db = this.getConnection();
    this.maintenance = true;
    try {
      try {
        checkpointTruncate(db);
      } catch (error) {
        throw new Error(`工作区 WAL checkpoint 失败: ${errorMessage(error)}`);
      }
      if (this.io.close) this.io.close(db);
      this.db = null;
      this.logger.info(`[WorkspaceDatabase:${this.workspaceIdValue}] 已进入维护模式`);
    } catch (error) {
      this.maintenance = false;
      throw error;
    }
  }

  isInMaintenanceMode(): boolean {
    return this.maintenance;
  }

  exitMaintenanceMode(): void {
    let db: SqlExecutor;
    try {
      db = this.io.open(this.dbPathValue);
    } catch (error) {
      throw new Error(`重建工作区连接池失败: ${errorMessage(error)}`);
    }
    this.db = db;
    this.maintenance = false;
    this.logger.info(`[WorkspaceDatabase:${this.workspaceIdValue}] 已退出维护模式`);
  }

  close(): void {
    if (this.db !== null) {
      if (this.io.close) this.io.close(this.db);
      this.db = null;
    }
  }

  static deleteDatabase(io: WorkspaceStoreIo, workspacesDir: string, workspaceId: string): void {
    validateWorkspaceId(workspaceId);
    const dbPath = path.join(workspacesDir, `ws_${workspaceId}.db`);
    const journal = openDeletionJournal(io, workspacesDir);
    if (!journal) {
      throw new Error('chat_v2.db 不存在，无法持久化工作区删除意图；已拒绝物理删除');
    }

    try {
      try {
        recoverWorkspaceDeletions(journal, workspacesDir);
      } catch (error) {
        throw new Error(`Failed to recover workspace deletion intent: ${errorMessage(error)}`);
      }

      // 重复调用保持幂等：metadata/文件已消失且 journal ready/published 时，不创建第二个 intent。
      if (!fs.existsSync(dbPath)) {
        let metadataExists: boolean;
        try {
          metadataExists = workspaceIndexExists(journal, workspaceId);
        } catch (error) {
          throw new Error(`Failed to inspect workspace metadata: ${errorMessage(error)}`);
        }
        let journalExists: boolean;
        try {
          journalExists = readyOrPublishedDeletionExists(journal, workspaceId);
        } catch (error) {
          throw new Error(`Failed to inspect workspace deletion journal: ${errorMessage(error)}`);
        }
        if (!metadataExists && journalExists) return;
      }

      // 平台端口同一 SAVEPOINT 准备 intent + 删除 index；返回后才进入物理删除。
      let intent;
      try {
        intent = prepareWorkspaceDeletion(journal, workspacesDir, workspaceId);
      } catch (error) {
        throw new Error(`Failed to prepare workspace deletion: ${errorMessage(error)}`);
      }
      try {
        finishWorkspaceDeletion(journal, workspacesDir, intent);
      } catch (error) {
        throw new Error(`Failed to finish workspace deletion: ${errorMessage(error)}`);
      }
    } finally {
      io.close?.(journal);
    }
  }
}

export class WorkspaceDatabaseManager {
  private readonly databases = new Map<string, WorkspaceDatabase>();
  private maintenance = false;

  private readonly io: WorkspaceStoreIo;
  private readonly workspacesDir: string;
  private readonly logger: WorkspaceLogger;

  constructor(
    io: WorkspaceStoreIo,
    workspacesDir: string,
    logger: WorkspaceLogger = silentWorkspaceLogger,
  ) {
    this.io = io;
    this.workspacesDir = workspacesDir;
    this.logger = logger;
  }

  getOrCreate(workspaceId: string): WorkspaceDatabase {
    if (this.maintenance) throw new Error('Workspace databases are in maintenance mode (backup/restore in progress)');
    const existing = this.databases.get(workspaceId);
    if (existing) return existing;
    const db = WorkspaceDatabase.create(this.io, this.workspacesDir, workspaceId, this.logger);
    this.databases.set(workspaceId, db);
    return db;
  }

  enterMaintenanceMode(): void {
    if (this.maintenance) throw new Error('工作区数据库已经处于维护模式');
    this.maintenance = true;
    const entered: WorkspaceDatabase[] = [];
    try {
      for (const db of this.databases.values()) {
        db.enterMaintenanceMode();
        entered.push(db);
      }
    } catch (error) {
      const failures: unknown[] = [error];
      for (const db of entered) {
        try { db.exitMaintenanceMode(); } catch (rollbackError) { failures.push(rollbackError); }
      }
      this.maintenance = [...this.databases.values()].some(db => db.isInMaintenanceMode());
      throw new Error(`工作区无法进入维护模式: ${failures.map(errorMessage).join('; ')}`);
    }
  }

  exitMaintenanceMode(): void {
    const failures: string[] = [];
    for (const db of this.databases.values()) {
      if (!db.isInMaintenanceMode()) continue;
      try { db.exitMaintenanceMode(); } catch (error) { failures.push(`${db.workspaceId}: ${errorMessage(error)}`); }
    }
    if (failures.length > 0) {
      throw new Error(`工作区无法退出维护模式（失败工作区保持 fail-close）: ${failures.join('; ')}`);
    }
    this.maintenance = false;
  }

  isInMaintenanceMode(): boolean {
    return this.maintenance;
  }

  /** Rust drops the manager's `Arc` and the pool closes with it; an open handle here would block the file delete on Windows. */
  remove(workspaceId: string): WorkspaceDatabase | undefined {
    const db = this.databases.get(workspaceId);
    if (db) {
      this.databases.delete(workspaceId);
      try { db.close(); } catch (error) {
        this.logger.warn(`[WorkspaceDatabase:${workspaceId}] close on remove failed: ${errorMessage(error)}`);
      }
    }
    return db;
  }

  delete(workspaceId: string): void {
    this.remove(workspaceId);
    WorkspaceDatabase.deleteDatabase(this.io, this.workspacesDir, workspaceId);
  }

  /** Plugin unload: Rust drops the manager's pools with the process; here the opener closes its handles. */
  closeAll(): void {
    for (const db of this.databases.values()) {
      try { db.close(); } catch (error) {
        this.logger.warn(`[WorkspaceDatabase:${db.workspaceId}] close on unload failed: ${errorMessage(error)}`);
      }
    }
    this.databases.clear();
  }
}
