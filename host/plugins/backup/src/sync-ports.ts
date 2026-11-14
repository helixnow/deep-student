/**
 * L20 `SyncCommandPorts` 中由 L21 负责的业务面：
 * - `limiter`：唯一的全局数据治理操作协调器（与备份/恢复/ZIP 共用）；
 * - `loadHydratedCloudConfig`：`load_hydrated_cloud_config_ssot`；
 * - `saveSyncAudit`：`try_save_audit_log` 的 Sync 审计构造与 best-effort 落库。
 *
 * `application` 不在此对象中：文件级同步应用数据库的唯一实现归 L20
 * `repository/apply-databases.ts`，L21 不复制跨所有者表写入。
 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import type { RuntimeCloudStorageConfig } from '../../sync-providers/api.ts';
import type {
  BackupSyncCommandPorts, SyncAuditRequest, SyncMutationPermit,
} from '../api.ts';
import {
  completeAuditLog, failAuditLog, initAuditTable, newAuditLog, saveAuditLog, withAuditDetails,
  type AuditLogEntry,
} from '../repository/audit.ts';
import { loadHydratedCloudConfigSsot } from './cloud-config.ts';
import {
  OperationGuardError, type OperationAcquireOutcome, type OperationGuard, type Operations,
} from './operations.ts';

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

function permitOf(guard: OperationGuard): SyncMutationPermit {
  return { release: () => guard.release() };
}

/** `AuditLog::new(...).with_details(...).complete/fail` 的等价构造。 */
export function syncAuditLog(request: SyncAuditRequest): AuditLogEntry {
  const base = withAuditDetails(
    newAuditLog(
      { type: 'Sync', direction: request.direction, records_affected: request.recordsAffected },
      request.target,
    ),
    request.details,
  );
  switch (request.outcome.kind) {
    case 'started': return base;
    case 'complete': return completeAuditLog(base, request.outcome.durationMs);
    case 'failed': return failAuditLog(base, request.outcome.error);
  }
}

export function createSyncCommandPorts(ctx: Context, operations: Operations): BackupSyncCommandPorts {
  const warn = (message: string): void => { ctx.logger('backup').warn(message); };

  return {
    limiter: {
      tryAcquire(): SyncMutationPermit | null {
        try {
          return permitOf(operations.tryAcquire('sync'));
        } catch (error) {
          if (error instanceof OperationGuardError) {
            // 忙锁（同进程或跨进程）→ Rust sync 命令的“正在进行中”；
            // 锁 IO 不能伪装成忙锁，但 L20 命令契约是 error: string，故保留原文案后
            // 以字符串 CommandError 上抛。L23 直连 `backup.tryAcquireOperation` 仍能拿到
            // 结构化 `OperationGuardError`（FileSystem）。
            if (error.reason === 'busy') return null;
            throw new CommandError(error.message);
          }
          throw error;
        }
      },
      async acquire(timeoutMs: number): Promise<SyncMutationPermit | 'timeout' | 'closed'> {
        let outcome: OperationAcquireOutcome;
        try {
          outcome = await operations.acquireWithTimeout('sync', timeoutMs);
        } catch (error) {
          // L20 `acquire` 只有 `timeout`/`closed` 两个失败哨兵。锁 IO 用 `closed`
          // 让 L20 按既有文案收口；跨进程锁被占用则保留 Rust busy 文案（L20 契约
          // 是 error: string）。超时仍走下面的 `timeout`，由 L20 使用 Rust 原文案。
          if (error instanceof OperationGuardError) {
            if (error.reason === 'lock_io') return 'closed';
            throw new CommandError(error.message);
          }
          throw error;
        }
        return outcome === 'timeout' ? 'timeout' : permitOf(outcome);
      },
    },

    async loadHydratedCloudConfig(): Promise<RuntimeCloudStorageConfig | null> {
      return loadHydratedCloudConfigSsot({
        settings: ctx.settings,
        secrets: ctx.secrets,
        dataDir: ctx.app.dataDir,
        warn,
      });
    },

    saveSyncAudit(request: SyncAuditRequest): void {
      // Rust `try_save_audit_log`：审计失败绝不阻断主流程，只 warn。
      let log: AuditLogEntry;
      try {
        log = syncAuditLog(request);
      } catch (error) {
        warn(`[data_governance] 构造审计日志失败，跳过审计记录: ${messageOf(error)}`);
        return;
      }
      let db;
      try {
        db = ctx.storage.database('audit');
      } catch (error) {
        warn(`[data_governance] 获取审计数据库连接失败: ${messageOf(error)}`);
        return;
      }
      try {
        initAuditTable(db);
      } catch (error) {
        warn(`[data_governance] 初始化审计表失败，跳过审计记录: ${messageOf(error)}`);
        return;
      }
      try {
        saveAuditLog(db, log);
      } catch (error) {
        warn(`[data_governance] 写入审计日志失败: ${messageOf(error)}`);
      }
    },
  };
}
