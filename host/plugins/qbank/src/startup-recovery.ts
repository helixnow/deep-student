import type { Context } from '@deepseek-ai/cordis';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { StartupFinalizerRegistration } from '../../../platform/storage/startup-finalizers.ts';
import { recoverInterruptedTasks } from '../repository/generation-tasks.ts';

export const QBANK_STARTUP_RECOVERY_FINALIZER = 'qbank.recover-interrupted-tasks';

export interface StartupRecoveryLog {
  info(message: string): void;
  warn(message: string): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * `qbank_generation::recover_interrupted_tasks`（`mod.rs:35-39`、`task_repo.rs:321-342`）：
 * queued/running → failed。取连接与 UPDATE 的失败都只记 warn，不中断启动。
 */
export function recoverInterruptedTasksAtStartup(db: () => SqlExecutor, log: StartupRecoveryLog): number {
  try {
    const affected = recoverInterruptedTasks(db());
    if (affected > 0) log.warn(`[QbankGeneration] 启动恢复：${affected} 个中断任务已标记为 failed`);
    return affected;
  } catch (error) {
    log.warn(`[QbankGeneration] 启动恢复中断任务失败: ${messageOf(error)}`);
    return 0;
  }
}

/**
 * `lib.rs:3512-3514`：build_app_state 最先同步执行，早于任何新任务提交。finalizer 在 ready 之前
 * 依次 await，此时 IPC 仍在缓冲、自动化调度尚未开始 tick，因此不会误伤新任务。
 * 只在启动时执行：启动后重装跳过（此时 running 的任务可能正在跑），卸载时撤回。
 */
export function registerQbankStartupRecovery(ctx: Context): void {
  const log = ctx.logger('qbank');
  const finalizer = new AbortController();
  const options: StartupFinalizerRegistration = { late: 'skip', signal: finalizer.signal };
  try {
    ctx.storage.registerFinalizer(QBANK_STARTUP_RECOVERY_FINALIZER, () => {
      recoverInterruptedTasksAtStartup(() => ctx.storage.database('vfs'), log);
    }, options);
  } catch (error) {
    log.warn(`[QbankGeneration] startup recovery finalizer not registered: ${messageOf(error)}`);
    return;
  }
  ctx.effect(() => () => finalizer.abort());
}
