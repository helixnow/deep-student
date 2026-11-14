import type { Context } from '@deepseek-ai/cordis';
export { createBackgroundTasks, BACKGROUND_SHUTDOWN_GRACE_MS } from './background-tasks.ts';
export type { Context };
export interface PackageManagerInfo {
  manager_type: string; is_available: boolean; version: string | null;
  install_command: string | null; install_hints: string[];
}
export interface PackageInstallResult { success: boolean; message: string; installed_version: string | null }
export interface DiagnosticsService {
  checkPackageManager(command: string): Promise<PackageManagerInfo | null>;
  checkAllPackageManagers(): Promise<Record<string, unknown>>;
  autoInstallPackageManager(manager: string): Promise<PackageInstallResult>;
}
export interface BackgroundTaskOptions {
  /**
   * 任务归属。缺省为调用方上下文：经 `ctx.backgroundTasks` 调用时即提交方插件的 fiber。
   * 归属 fiber 卸载时任务的 signal 被 abort，任务立即移出集合（shutdown 不再等它）。
   * 根上下文与 diagnostics 自身的上下文不算归属，任务活到 shutdown。
   */
  owner?: Context;
  /** 额外的取消来源：它 abort 时任务的 signal 跟着 abort（任务仍按正常结束移出集合）。 */
  signal?: AbortSignal;
  /** 日志里的任务名。 */
  name?: string;
}
export interface BackgroundTasks {
  readonly size: number;
  /**
   * 提交后台任务。`task` 收到的 signal 在归属卸载、`options.signal` abort 或 shutdown 时 abort；
   * 返回任务自身的 Promise（abort 不会替任务 reject）。shutdown 开始后、或归属 fiber 正在卸载时拒绝准入并返回 `null`。
   */
  spawn<T>(task: (signal: AbortSignal) => Promise<T>, options?: BackgroundTaskOptions): Promise<T> | null;
  /** 关闭准入 → abort 全部任务 → 最多等 {@link BACKGROUND_SHUTDOWN_GRACE_MS}；超时不取消（任务已收到 abort），只记 warn。 */
  shutdown(): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context { diagnostics: DiagnosticsService; backgroundTasks: BackgroundTasks }
}
