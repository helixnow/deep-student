/**
 * chat 插件的同步 runtime-root 端口。
 *
 * session artifact/temp 根目录的解析（`agent-workspace` 的 `sessionRoot` / `cleanupSessionRuntimeRoots`）
 * 与自定义人设文件列表都是同步文件系统形状，移动端没有同步文件 API，因此这一层用端口隔离：
 * 桌面入口 `index.ts` 注入 `node:fs` 实现的 `agent-workspace/api.ts`（`runtime-roots.node.ts`），
 * 移动端入口 `mobile.ts` 不注入——缺省端口没有本地文件系统，附件暂存/解包与人设文件列表按“不可用”降级。
 *
 * 语义与 `agent-workspace/api.ts` 的同名导出一致：根目录不存在且 `create=false` 时返回词法路径
 * 或抛原错误，`cleanupSessionRuntimeRoots` 汇总失败文案。
 */
import type { CustomAgentFileInfo, RuntimeRoot } from '../../agent-workspace/portable.ts';

export type SessionRootKind = 'artifact' | 'temp';

/** `agent-workspace` `WorkspaceLogger` 的消费面（`Pick<Logger, 'warn' | 'info'>`）。 */
export interface ChatWorkspaceLogger {
  warn(message: string): void;
  info(message: string): void;
}

export interface ChatWorkspaceRuntime {
  /** `sessionRoot(base, sessionId, kind, create)`：artifact / temp 根目录。 */
  sessionRoot(dataDir: string, sessionId: string, kind: SessionRootKind, create: boolean): RuntimeRoot;
  /** `cleanupSessionRuntimeRoots(base, sessionId)`：删除两个 session 根目录，失败时汇总抛错。 */
  cleanupSessionRuntimeRoots(dataDir: string, sessionId: string): void;
  /** `listCustomAgentFiles(dir, logger)`：人设文件摘要（排序与 fail-closed 解析归 L05）。 */
  listCustomAgentFiles(dir: string, logger?: ChatWorkspaceLogger): CustomAgentFileInfo[];
}

export class WorkspaceRuntimeUnavailableError extends Error {
  constructor(operation: string) {
    super(`local runtime roots unavailable: ${operation}`);
    this.name = 'WorkspaceRuntimeUnavailableError';
  }
}

/** 缺省端口：没有本地文件系统（移动端 / 未注入）。 */
const unavailable: ChatWorkspaceRuntime = {
  sessionRoot: (dataDir) => { throw new WorkspaceRuntimeUnavailableError(`session root ${dataDir}`); },
  cleanupSessionRuntimeRoots: () => undefined,
  listCustomAgentFiles: () => [],
};

let active: ChatWorkspaceRuntime = unavailable;

/** 入口注入平台实现；`null` 恢复缺省（无本地文件系统）。 */
export function setChatWorkspaceRuntime(port: ChatWorkspaceRuntime | null): void {
  active = port ?? unavailable;
}

/** 当前端口；session root 与自定义人设文件列表的所有本地访问都经它。 */
export function chatWorkspaceRuntime(): ChatWorkspaceRuntime {
  return active;
}
