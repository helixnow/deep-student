import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { DataGovernanceOperationKind, DataGovernanceOperationSnapshot } from '../../../../contracts/ipc/generated/L21-backup-governance.ts';
import type { DatabaseName, MaintenanceLease } from '../../../platform/storage/api.ts';
import { DATABASE_NAMES, StorageError } from '../../../platform/storage/api.ts';
import {
  acquireProcessOperationLockAt, type ProcessOperationLock,
} from '../../../platform/storage/backup-common.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { AppError } from '../../../platform/errors/api.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { join } from 'node:path';
import {
  OperationBusyError, OperationGuardError, OperationLockBusyError, OperationLockError,
} from './operation-errors.ts';

export {
  OperationBusyError, OperationGuardError, OperationLockBusyError, OperationLockError,
  isOperationGuardError, OPERATION_GUARD_ERROR_CODES,
} from './operation-errors.ts';
export type {
  OperationGuardErrorCode, OperationGuardFailureReason,
} from './operation-errors.ts';

export interface OperationGuard {
  readonly snapshot: DataGovernanceOperationSnapshot;
  operationId(): string;
  release(): void;
}

/** `backup_common::DataGovernanceOperationKind`（serde snake_case，与契约完全一致）。 */
export type OperationKind = DataGovernanceOperationKind;

/** `commands_sync.rs:176`：等待全局数据治理锁的固定超时。 */
export const SYNC_LOCK_TIMEOUT_SECS = 60;
export const SYNC_LOCK_TIMEOUT_MS = SYNC_LOCK_TIMEOUT_SECS * 1_000;

/** `acquire_backup_global_permit` 的固定等待文案（备份/恢复/ZIP 共用）。 */
export const WAITING_FOR_OPERATION_MESSAGE = '正在等待其他备份/恢复任务完成...';
/** 排队期间用户取消的任务文案（commands_backup.rs:999-1016）。 */
export const OPERATION_QUEUED_CANCELLED_MESSAGE = '用户取消任务';
/** 轮询取消的间隔；与 Rust `tokio::time::sleep(200ms)` 一致。 */
export const OPERATION_CANCEL_POLL_MS = 200;

/** 忙锁是业务错误；`reason`/`code`/`app_error` 供消费方稳定映射（L23）。 */
// OperationBusyError / OperationLockError 定义见 operation-errors.ts；此处保留原导出名。

/** 等待型 acquire 的结果；`timeout` 由调用方按 Rust 原文案转成业务错误。 */
export type OperationAcquireOutcome = OperationGuard | 'timeout';

export function operationTimeoutMessage(timeoutMs: number): string {
  const seconds = Math.max(0, Math.round(timeoutMs / 1_000));
  return `等待全局数据治理锁超时（${seconds}秒），可能有其他数据治理操作正在执行，请稍后再试。`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

/** 平台 `AppError` 是 plain object（非 Error）；按 Rust 同形字段识别。 */
function isAppErrorValue(value: unknown): value is AppError {
  return typeof value === 'object' && value !== null
    && typeof (value as { error_type?: unknown }).error_type === 'string'
    && typeof (value as { message?: unknown }).message === 'string';
}

/**
 * `BackupSnapshotBarrier::enter` 的借用分支：启动失败已把主数据库置为维护态，
 * 备份只读借用该屏障，ownership 为空。
 *
 * Host 的 F3 `enterMaintenance` 在第一个库（mistakes = 主库）已被外部持有时抛
 * `Database mistakes is already in maintenance mode`，且此时尚未进入任何库。
 */
export function isMainDatabaseAlreadyInMaintenance(error: unknown): boolean {
  return error instanceof StorageError
    && error.code === 'MAINTENANCE'
    && error.database === 'mistakes'
    && error.message === 'Database mistakes is already in maintenance mode';
}

/** 跨进程锁失败仍是业务错误：Validation=被占用，FileSystem=锁 IO。 */
function guardErrorFromAppError(appError: AppError, cause: unknown): CommandError {
  switch (appError.error_type) {
    case 'Validation': return new OperationLockBusyError(appError.message, cause);
    case 'FileSystem': return new OperationLockError(appError.message, cause);
    // 其它 AppError（如 Rust internal 序列化失败）保留原始 wire，不强行改类型。
    default: return new CommandError(appError);
  }
}

/**
 * 服务层业务错误必须是 `CommandError`，否则跨 lane 的 invoke 会按 panic 永不 settle。
 * 但只有已知的锁失败才转成结构化守卫错误；裸 `Error` 视为未预期异常继续 panic，
 * 不能把编程错误吞成可重试的业务错误。
 */
function operationCommandError(error: unknown): CommandError {
  if (error instanceof OperationGuardError) return error;
  if (error instanceof CommandError) {
    return isAppErrorValue(error.value) ? guardErrorFromAppError(error.value, error) : error;
  }
  if (isAppErrorValue(error)) return guardErrorFromAppError(error, error);
  if (error instanceof Error) throw error;
  return new CommandError(messageOf(error));
}

export interface SnapshotBarrier {
  /** `BackupSnapshotBarrier::release`：任一部分退出失败都抛聚合错误并保持 fail-close。 */
  release(): void;
  /** RAII 等价：仅记录释放失败，不覆盖主错误。 */
  dispose(): void;
}

interface WorkspaceMaintenance {
  enterMaintenanceMode(): Promise<void>;
  exitMaintenanceMode(): void;
}

/**
 * 进程级共享的 `DataGovernanceOperationGuard` 协调器。
 *
 * Rust 用 `BACKUP_GLOBAL_LIMITER`（进程级 semaphore）串行化全部数据治理操作，
 * 并在槽位外持有 advisory lock。Host 侧所有插件实例共享本模块的队列与 active
 * 快照；每个实例只携带自己的锁路径（= 各自 App 数据目录）。
 */
let queueTail: Promise<void> = Promise.resolve();
let activeOperation: DataGovernanceOperationSnapshot | null = null;
let waitingOperations = 0;
let blockedComponents: string[] = [];

const KIND_DEBUG: Readonly<Record<DataGovernanceOperationKind, string>> = {
  backup: 'Backup',
  auto_backup: 'AutoBackup',
  verify: 'Verify',
  zip_export: 'ZipExport',
  zip_import: 'ZipImport',
  restore: 'Restore',
  sync: 'Sync',
  delete_propagation: 'DeletePropagation',
  prune: 'Prune',
};

const BLOCKED_COMPONENT: Partial<Record<DatabaseName, readonly string[]>> = {
  // Host 的 storage 服务同时承担 Rust 的 AppState.database 与 database_manager。
  mistakes: ['main', 'manager'],
  vfs: ['vfs'],
  chat_v2: ['chat_v2'],
  llm_usage: ['llm_usage'],
  audit: ['audit'],
  browser: ['browser'],
  sync_state: ['sync_state'],
};

export interface OperationsOptions {
  readonly ctx: Context;
}

// lib.rs:1375-1407 的进入顺序与错误前缀；Rust 的 database / database_manager 在 Host 同为 mistakes。
const STARTUP_FAIL_CLOSE: ReadonlyArray<readonly [DatabaseName, string]> = [
  ['mistakes', '主数据库'],
  ['vfs', 'VFS'],
  ['chat_v2', 'Chat V2'],
  ['llm_usage', 'LLM Usage'],
];

export class Operations {
  private readonly ctx: Context;
  private startupBlocked: string[] = [];
  private readonly startupLeases: MaintenanceLease[] = [];
  private readonly adoptedStartup = new Set<DatabaseName>();

  constructor(options: OperationsOptions) {
    this.ctx = options.ctx;
  }

  /** 是否有操作正在等待或执行。 */
  get busy(): boolean { return activeOperation !== null || waitingOperations > 0; }

  current(): DataGovernanceOperationSnapshot | null {
    return activeOperation === null ? null : { ...activeOperation };
  }

  blockedComponents(): string[] {
    return [...new Set([...this.startupBlocked, ...blockedComponents])];
  }

  /**
   * 核心恢复启动模式：storage 已在业务插件装配前对这些库进入维护屏障（租约由 storage 持有到卸载）。
   * 这里只登记为启动维护组件，不再重复进入；之后的 {@link enterStartupFailClose} 也跳过它们。
   */
  adoptStartupBarrier(names: readonly DatabaseName[]): void {
    for (const [name] of STARTUP_FAIL_CLOSE) {
      if (!names.includes(name)) continue;
      this.adoptedStartup.add(name);
      this.markStartupBlocked(name);
    }
  }

  private markStartupBlocked(name: DatabaseName): void {
    for (const component of BLOCKED_COMPONENT[name] ?? []) {
      if (!this.startupBlocked.includes(component)) this.startupBlocked.push(component);
    }
  }

  /**
   * lib.rs:1370-1419：数据治理初始化失败后进入全组件维护模式，直到 Host 卸载都不退出。
   * 任一组件失败抛 `无法建立完整数据治理维护屏障: …`，与 Rust setup 返回 Err 一样终止启动。
   */
  async enterStartupFailClose(): Promise<void> {
    for (const [name, label] of STARTUP_FAIL_CLOSE) {
      if (!this.adoptedStartup.has(name)) {
        try { this.startupLeases.push(await this.ctx.storage.enterMaintenance([name])); }
        catch (error) { throw new Error(`无法建立完整数据治理维护屏障: ${label}: ${messageOf(error)}`); }
      }
      this.markStartupBlocked(name);
    }
    const workspace = this.ctx.reflect.get('agentWorkspace') as WorkspaceMaintenance | undefined;
    if (workspace !== undefined && typeof workspace.enterMaintenanceMode === 'function') {
      try { await workspace.enterMaintenanceMode(); }
      catch (error) { throw new Error(`无法建立完整数据治理维护屏障: 工作区: ${messageOf(error)}`); }
      this.startupBlocked.push('workspaces');
    }
  }

  private lockPath(): string {
    return join(this.ctx.app.dataDir, 'recovery', '.data-governance-operation.lock');
  }

  private snapshot(kind: DataGovernanceOperationKind, jobId?: string | null): DataGovernanceOperationSnapshot {
    const id = jobId?.trim() ? jobId : randomUUID();
    return {
      operation_id: id,
      kind,
      started_at: toRfc3339(),
      process_id: process.pid,
    };
  }

  private guard(
    snapshot: DataGovernanceOperationSnapshot,
    processLock: ProcessOperationLock,
    releaseTurn: () => void,
  ): OperationGuard {
    let released = false;
    return {
      snapshot,
      operationId: () => snapshot.operation_id,
      release: () => {
        if (released) return;
        released = true;
        try { processLock.release(); }
        finally {
          if (activeOperation?.operation_id === snapshot.operation_id) activeOperation = null;
          releaseTurn();
        }
      },
    };
  }

  /** Rust `DataGovernanceOperationGuard::acquire`：等待同进程 semaphore 并获取跨进程锁。 */
  async acquire(kind: DataGovernanceOperationKind, jobId?: string | null): Promise<OperationGuard> {
    waitingOperations += 1;
    let releaseTurn!: () => void;
    const previous = queueTail;
    queueTail = new Promise<void>(resolve => { releaseTurn = resolve; });
    try {
      await previous;
    } finally {
      waitingOperations -= 1;
    }
    const snapshot = this.snapshot(kind, jobId);
    let processLock: ProcessOperationLock;
    try {
      processLock = acquireProcessOperationLockAt(this.lockPath(), snapshot);
    } catch (error) {
      releaseTurn();
      throw operationCommandError(error);
    }
    activeOperation = snapshot;
    return this.guard(snapshot, processLock, releaseTurn);
  }

  /**
   * `commands_backup.rs:980-1018 acquire_backup_global_permit`：任务排队时每
   * 200ms 轮询一次取消标志；一旦取消就退出队列，且不会在稍后补授许可时持有它。
   *
   * 返回 `'cancelled'` 时调用方直接 `job.cancelled("用户取消任务")`；排队位置会
   * 在前一持有者释放后自动移除，因此不会提前放行后到的任务。
   */
  async acquireForJob(
    kind: DataGovernanceOperationKind,
    jobId: string,
    isCancelled: () => boolean,
    pollMs: number = OPERATION_CANCEL_POLL_MS,
  ): Promise<OperationGuard | 'cancelled'> {
    waitingOperations += 1;
    let releaseTurn!: () => void;
    const previous = queueTail;
    queueTail = new Promise<void>(resolve => { releaseTurn = resolve; });

    const waitForTurn = async (): Promise<boolean> => {
      for (;;) {
        if (isCancelled()) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const granted = await new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), pollMs);
          void previous.then(() => resolve(true));
        });
        if (timer !== undefined) clearTimeout(timer);
        if (granted) return !isCancelled();
      }
    };

    const granted = await waitForTurn();
    waitingOperations -= 1;
    if (!granted) {
      // 不留下死队列槽：前一个持有者释放后才把“接力棒”传下去。
      void previous.then(() => releaseTurn());
      return 'cancelled';
    }

    const snapshot = this.snapshot(kind, jobId);
    let processLock: ProcessOperationLock;
    try {
      processLock = acquireProcessOperationLockAt(this.lockPath(), snapshot);
    } catch (error) {
      releaseTurn();
      throw operationCommandError(error);
    }
    activeOperation = snapshot;
    return this.guard(snapshot, processLock, releaseTurn);
  }

  /**
   * `commands_sync.rs:2583-2594` 的等待入口：超时后移除自己的排队位置，
   * 之后不会被补授许可；超时本身由调用方转成原文案业务错误。
   *
   * 超时后必须等前一个持有者释放再把“接力棒”传下去。若提前 resolve 自己的
   * turn，后到者会绕过仍在执行的持有者。
   */
  async acquireWithTimeout(
    kind: DataGovernanceOperationKind,
    timeoutMs: number,
    jobId?: string | null,
  ): Promise<OperationAcquireOutcome> {
    waitingOperations += 1;
    let releaseTurn!: () => void;
    const previous = queueTail;
    queueTail = new Promise<void>(resolve => { releaseTurn = resolve; });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), Math.max(0, timeoutMs));
      previous.then(() => resolve(false));
    });
    if (timer !== undefined) clearTimeout(timer);
    waitingOperations -= 1;

    if (timedOut) {
      void previous.then(() => releaseTurn());
      return 'timeout';
    }

    const snapshot = this.snapshot(kind, jobId);
    let processLock: ProcessOperationLock;
    try {
      processLock = acquireProcessOperationLockAt(this.lockPath(), snapshot);
    } catch (error) {
      releaseTurn();
      throw operationCommandError(error);
    }
    activeOperation = snapshot;
    return this.guard(snapshot, processLock, releaseTurn);
  }

  /**
   * Rust `DataGovernanceOperationGuard::try_acquire`：不等待，立即失败。
   * L23 云同步写命令使用；释放必须由调用方显式调用 `release()`（Rust RAII 的等价）。
   */
  tryAcquire(kind: DataGovernanceOperationKind, jobId?: string | null): OperationGuard {
    if (activeOperation !== null || waitingOperations > 0) {
      const holder = activeOperation === null
        ? ''
        : `（当前 ${KIND_DEBUG[activeOperation.kind]}，operation_id=${activeOperation.operation_id}）`;
      throw new OperationBusyError(`已有数据治理操作正在运行${holder}`);
    }
    const snapshot = this.snapshot(kind, jobId);
    let processLock: ProcessOperationLock;
    try {
      processLock = acquireProcessOperationLockAt(this.lockPath(), snapshot);
    } catch (error) {
      throw operationCommandError(error);
    }
    // 与 acquire 共用同一条队列：`tryAcquire` 持有期间，后到的 acquire 必须等待，
    // 对应 Rust semaphore 的 permit 生命周期。
    let releaseTurn!: () => void;
    queueTail = new Promise<void>(resolve => { releaseTurn = resolve; });
    activeOperation = snapshot;
    return this.guard(snapshot, processLock, releaseTurn);
  }

  /**
   * `BackupSnapshotBarrier::enter`：冻结全部注册库与原生活跃工作区。
   * 调用方必须已持有全局操作守卫；成功返回后 blocked_components 反映真实维护态。
   */
  async enterSnapshotBarrier(): Promise<SnapshotBarrier> {
    let storageLease: MaintenanceLease | null = null;
    let workspace: WorkspaceMaintenance | null = null;
    let workspaceEntered = false;
    try {
      try {
        storageLease = await this.ctx.storage.enterMaintenance(DATABASE_NAMES);
      } catch (error) {
        if (isMainDatabaseAlreadyInMaintenance(error)) {
          // Rust `BackupSnapshotBarrier::enter`：启动失败建立的 fail-close 已冻结
          // 业务写入，备份借用该屏障读取磁盘快照；ownership 为空，绝不解除外部
          // 维护模式，也不清理其 blocked_components。
          return { release: () => undefined, dispose: () => undefined };
        }
        throw new Error(`数据库进入备份快照屏障失败: ${messageOf(error)}`);
      }
      const candidate = this.ctx.reflect.get('agentWorkspace') as WorkspaceMaintenance | undefined;
      if (candidate !== undefined && typeof candidate.enterMaintenanceMode === 'function') {
        workspace = candidate;
        try {
          await workspace.enterMaintenanceMode();
          workspaceEntered = true;
        } catch (error) {
          throw new Error(`工作区进入备份快照屏障失败: ${messageOf(error)}`);
        }
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (workspaceEntered && workspace !== null) {
        try { workspace.exitMaintenanceMode(); }
        catch (rollbackError) { rollbackErrors.push(`工作区: ${messageOf(rollbackError)}`); }
      }
      if (storageLease !== null) {
        try { storageLease.release(); }
        catch (rollbackError) { rollbackErrors.push(`数据库: ${messageOf(rollbackError)}`); }
      }
      blockedComponents = [];
      if (rollbackErrors.length > 0) {
        throw new Error(`${messageOf(error)}；且回滚快照屏障失败（应用保持 fail-close）: ${rollbackErrors.join('; ')}`);
      }
      throw error;
    }

    const blocked: string[] = [];
    for (const name of storageLease.databases) {
      for (const component of BLOCKED_COMPONENT[name] ?? []) {
        if (!blocked.includes(component)) blocked.push(component);
      }
    }
    if (workspaceEntered && !blocked.includes('workspaces')) blocked.push('workspaces');
    blockedComponents = blocked;

    let released = false;
    const exitOnce = (): string[] => {
      const errors: string[] = [];
      try { storageLease?.release(); }
      catch (error) { errors.push(`数据库: ${messageOf(error)}`); }
      if (workspaceEntered && workspace !== null) {
        try { workspace.exitMaintenanceMode(); workspaceEntered = false; }
        catch (error) { errors.push(`工作区: ${messageOf(error)}`); }
      }
      return errors;
    };
    const release = (): void => {
      if (released) return;
      const firstErrors = exitOnce();
      if (firstErrors.length === 0) {
        released = true;
        blockedComponents = [];
        return;
      }
      const original = new Error(`退出备份快照屏障失败: ${firstErrors.join('; ')}`);
      // Rust `release(mut self)` 在返回 Err 后立即 Drop，再尝试一次恢复；
      // 调用方仍收到第一次的原始错误，只有第二次失败才保持 fail-close。
      const retryErrors = exitOnce();
      if (retryErrors.length === 0) {
        released = true;
        blockedComponents = [];
      } else {
        this.ctx.logger('backup').error(
          `[data_governance] 备份快照屏障释放失败，应用保持 fail-close: ${retryErrors.join('; ')}`,
        );
      }
      throw original;
    };
    return {
      release,
      dispose: () => {
        try { release(); }
        catch { // boundary-allow empty-catch: release 已在第二次尝试失败时记录 fail-close，RAII 不覆盖主错误。
        }
      },
    };
  }

}
