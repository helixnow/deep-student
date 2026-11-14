import type { Context } from '@deepseek-ai/cordis';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { StartupFinalizerRegistration } from '../../../platform/storage/startup-finalizers.ts';
import { recoverStuckDocumentTasks } from '../repository/anki-cards.ts';

export const ANKI_STARTUP_RECOVERY_FINALIZER = 'anki.recover-stuck-document-tasks';

/**
 * `database/mod.rs:7389-7391`：启动路径固定 10 分钟阈值。应用不保证单实例，传 0 会把另一个
 * 实例正在跑的任务误标为 Paused。
 */
const STARTUP_STUCK_TASK_MINUTES = 10;

export interface StartupRecoveryLog {
  info(message: string): void;
  warn(message: string): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `lib.rs:3770-3780`：卡住的制卡任务改为 Paused；取连接与 UPDATE 的失败都只记 warn。 */
export function recoverStuckDocumentTasksAtStartup(db: () => SqlExecutor, log: StartupRecoveryLog): number {
  try {
    const count = recoverStuckDocumentTasks(db(), STARTUP_STUCK_TASK_MINUTES);
    if (count > 0) log.info(`[AppSetup] Recovered ${count} stuck Anki document tasks`);
    return count;
  } catch (error) {
    log.warn(`[AppSetup] Failed to recover stuck Anki tasks: ${messageOf(error)}`);
    return 0;
  }
}

/**
 * Rust 在 build_app_state 里同步执行（ready 之前），这里注册为同步 finalizer。
 * 只在启动时执行：启动后重装跳过（此时 Processing 的任务可能正在跑），卸载时撤回。
 */
export function registerAnkiStartupRecovery(ctx: Context): void {
  const log = ctx.logger('anki');
  const finalizer = new AbortController();
  const options: StartupFinalizerRegistration = { late: 'skip', signal: finalizer.signal };
  try {
    ctx.storage.registerFinalizer(ANKI_STARTUP_RECOVERY_FINALIZER, () => {
      recoverStuckDocumentTasksAtStartup(() => ctx.storage.database('mistakes'), log);
    }, options);
  } catch (error) {
    log.warn(`[AppSetup] Anki startup recovery finalizer not registered: ${messageOf(error)}`);
    return;
  }
  ctx.effect(() => () => finalizer.abort());
}
