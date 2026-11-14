/**
 * agent-orchestration 的同步 runtime-root 端口。
 *
 * 执行器读写的 session artifact/temp 根、skill package 根、授权根与不可逆删除都是同步文件系统形状，
 * 移动端没有同步文件 API，因此这一层用端口隔离：桌面入口 `index.ts` 注入 `agent-workspace/api.ts`
 * 的实现，移动端入口 `mobile.ts` 不注入——缺省端口没有本地文件系统，相关工具按“不可用”报错，
 * 会话/待办/自动化等 SQLite 能力不受影响。
 *
 * 语义与 `agent-workspace/api.ts` 的同名导出一致（同一实现对象，不是复制）。
 */
import type { ExecutionContext } from '../../chat/api.ts';
import type { NativeWindowsFiles } from '../../../platform/native/windows/api.ts';
import type {
  CustomProfileSource, RuntimeRoot, RuntimeRootDeps, SettingsLike, StagedFile,
} from '../../agent-workspace/portable.ts';
import type { GroupPreferredRuntimeRoot, SkillPathOptions } from '../../agent-workspace/api.ts';

export interface AgentOrchestrationWorkspaceRuntime {
  /** `sessionRoot(base, sessionId, kind, create)`：artifact / temp 根目录。 */
  sessionRoot(base: string, sessionId: string, kind: 'artifact' | 'temp', create: boolean): RuntimeRoot;
  /** `runtime_roots::skill_package_runtime_root`。 */
  skillPackageRuntimeRoot(skillId: string, rawPath: string, options: SkillPathOptions): RuntimeRoot;
  runtimeRootById(deps: RuntimeRootDeps, sessionId: string,
    skillPackageRoots: ReadonlyMap<string, string> | null | undefined,
    rootId: string | null | undefined, createSessionRoots: boolean): RuntimeRoot;
  runtimeRootsForSession(deps: RuntimeRootDeps, sessionId: string, createArtifactRoot: boolean): RuntimeRoot[];
  revalidateRuntimeRoot(settings: SettingsLike, root: RuntimeRoot, windowsFiles?: NativeWindowsFiles): string;
  /** 不可逆删除一个哈希绑定的 session 文件：不创建任何检查点或备份。 */
  removeSessionFileIrreversible(rootPath: string, relativePath: string, expectedSha256: string,
    windowsFiles?: NativeWindowsFiles): void;
  resolveStagedFileInTempRoot(tempRootPath: string, relativePath: string): StagedFile;
  /** `runtime_roots.rs` 展示路径：home 前缀替换成 `~`。 */
  redactPathForDisplay(value: string): string;
  resolveGroupPreferredRuntimeRoot(context: ExecutionContext): GroupPreferredRuntimeRoot | null;
  /** `custom_agents.rs` 人设来源（含读取 `agents/` 目录）。 */
  customProfileSource(dir: string): CustomProfileSource;
}

export class WorkspaceRuntimeUnavailableError extends Error {
  constructor(operation: string) {
    super(`local runtime roots unavailable: ${operation}`);
    this.name = 'WorkspaceRuntimeUnavailableError';
  }
}

/** 缺省端口：没有本地文件系统（移动端 / 未注入）。 */
const unavailable: AgentOrchestrationWorkspaceRuntime = {
  sessionRoot: (base) => { throw new WorkspaceRuntimeUnavailableError(`session root ${base}`); },
  skillPackageRuntimeRoot: (_skillId, rawPath) => { throw new WorkspaceRuntimeUnavailableError(`skill root ${rawPath}`); },
  runtimeRootById: (_deps, _sessionId, _skills, rootId) => { throw new WorkspaceRuntimeUnavailableError(`runtime root ${rootId ?? 'workspace'}`); },
  runtimeRootsForSession: () => { throw new WorkspaceRuntimeUnavailableError('runtime roots'); },
  revalidateRuntimeRoot: (_settings, root) => { throw new WorkspaceRuntimeUnavailableError(`runtime root ${root.id}`); },
  removeSessionFileIrreversible: (rootPath) => { throw new WorkspaceRuntimeUnavailableError(`delete ${rootPath}`); },
  resolveStagedFileInTempRoot: (_tempRootPath, relativePath) => { throw new WorkspaceRuntimeUnavailableError(`staged file ${relativePath}`); },
  redactPathForDisplay: (value) => value,
  resolveGroupPreferredRuntimeRoot: () => null,
  customProfileSource: () => { throw new WorkspaceRuntimeUnavailableError('custom agent profile'); },
};

let active: AgentOrchestrationWorkspaceRuntime = unavailable;

/** 入口注入平台实现；`null` 恢复缺省（无本地文件系统）。 */
export function setAgentOrchestrationWorkspaceRuntime(port: AgentOrchestrationWorkspaceRuntime | null): void {
  active = port ?? unavailable;
}

/** 当前端口；执行器的所有 runtime-root 本地访问都经它。 */
export function agentOrchestrationWorkspaceRuntime(): AgentOrchestrationWorkspaceRuntime {
  return active;
}
