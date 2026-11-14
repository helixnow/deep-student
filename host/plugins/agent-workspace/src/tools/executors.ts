// 工具执行器工厂（供 L04 的 executor roster 消费）。
//
// Rust 的 `AppExecutorRoster` 在 app 层实例化各领域 executor；Host 侧由
// L04 的工具花名册负责注册 descriptor / 审批策略 / headless 策略。本模块只提供
// **构造入口**，不决定策略，也不直接注册工具：谁消费谁实例化，避免本 lane
// 复制 L04 的花名册逻辑。
//
// 所有 executor 的 execute 语义与 Rust 一致；每个方法的上下文类型由调用方
// （L04）按 Rust `ExecutionContext` 子集提供。
import type { JsonValue } from '../../api.ts';
import type { NativeRegex } from '../../../../platform/native/regex/api.ts';
import type { NativeWindowsFiles } from '../../../../platform/native/windows/api.ts';
import type { NativeSandbox } from '../../../../platform/native/sandbox/api.ts';
import type { WorkspaceCoordinator } from '../workspace/coordinator.ts';
import { silentWorkspaceLogger, type WorkspaceLogger } from '../workspace/logger.ts';
import {
  WorkspaceToolExecutor, getWorkspaceToolSchemas, toolNames as workspaceToolNames,
  type WorkspaceExecutorContext,
} from './workspace-executor.ts';
import { GitToolExecutor, type GitRunShell } from './git.ts';
import { LocalShellExecuteExecutor } from './shell-execute.ts';
import { LocalShellPreflightExecutor } from './shell-preflight.ts';
import { FileManagerExecutor } from './file-manager.ts';
import { CodeNavigationExecutor } from './code-navigation.ts';
import { LspNavigationExecutor } from './lsp-navigation.ts';
import { RuntimeRootRequestExecutor } from './runtime-root-request.ts';
import { WorkspaceFsExecutor } from './workspace-fs.ts';

/** Rust `AppExecutorRoster` 中属于本 lane 的 executor 构造面。 */
export interface AgentWorkspaceToolExecutors {
  /** `workspace_*` 的 8 个工具名（与 schema 一一对应）。 */
  readonly workspaceToolNames: readonly string[];
  /** `get_workspace_tool_schemas`：字段顺序与 Rust 一致。 */
  workspaceSchemas(): JsonValue[];
  /** `workspace_executor.rs`：按会话上下文创建。 */
  createWorkspace(context: WorkspaceExecutorContext): WorkspaceToolExecutor;
  /** `git_executor.rs`：语义 git 工具需要注入 shell 通道。 */
  createGit(runShell?: GitRunShell): GitToolExecutor;
  /** `local_shell_execute_executor.rs`。 */
  createShell(): LocalShellExecuteExecutor;
  /** `local_shell_preflight_executor.rs`。 */
  createShellPreflight(): LocalShellPreflightExecutor;
  /** `file_manager_executor.rs`。 */
  createFileManager(): FileManagerExecutor;
  /** `code_navigation_executor.rs`。 */
  createCodeNavigation(): CodeNavigationExecutor;
  /** `lsp_navigation_executor.rs`：缓存的语言服务器由 dispose() 释放。 */
  createLsp(): LspNavigationExecutor;
  /** `runtime_root_request_executor.rs`。 */
  createRuntimeRootRequest(): RuntimeRootRequestExecutor;
  /** `workspace_fs_executor.rs`。 */
  createWorkspaceFs(): WorkspaceFsExecutor;
  /** Rust `Drop`：终止缓存的语言服务器子进程。 */
  dispose(): void;
}

export function createAgentWorkspaceToolExecutors(
  coordinator: WorkspaceCoordinator,
  logger: WorkspaceLogger = silentWorkspaceLogger,
  getNativeRegex?: () => NativeRegex,
  getWindowsFiles?: () => NativeWindowsFiles | undefined,
  getNativeSandbox?: () => NativeSandbox | undefined,
): AgentWorkspaceToolExecutors {
  // LSP executor 持有子进程缓存，必须单例并由 dispose 释放。
  const lsp = new LspNavigationExecutor(getWindowsFiles);
  return {
    workspaceToolNames: Object.values(workspaceToolNames),
    workspaceSchemas: () => getWorkspaceToolSchemas(),
    createWorkspace: context => new WorkspaceToolExecutor(coordinator, {
      ...context,
      // Rust 的 log::warn!/info! 是全局日志；L04 未显式注入时回落到插件 logger。
      warn: context.warn ?? ((message: string) => { logger.warn(message); }),
      info: context.info ?? ((message: string) => { logger.info(message); }),
    }),
    createGit: runShell => (runShell === undefined ? new GitToolExecutor() : new GitToolExecutor(runShell)),
    createShell: () => new LocalShellExecuteExecutor(getWindowsFiles, getNativeSandbox),
    createShellPreflight: () => new LocalShellPreflightExecutor(getWindowsFiles),
    createFileManager: () => new FileManagerExecutor(getWindowsFiles),
    createCodeNavigation: () => new CodeNavigationExecutor(getNativeRegex, getWindowsFiles),
    createLsp: () => lsp,
    createRuntimeRootRequest: () => new RuntimeRootRequestExecutor(getWindowsFiles),
    createWorkspaceFs: () => new WorkspaceFsExecutor(getWindowsFiles),
    dispose: () => { lsp.dispose(); },
  };
}

export type { WorkspaceExecutorContext, GitRunShell };
