/**
 * 本地 shell 审批绑定的运行时端口。
 *
 * `resolveLocalShellApprovalArguments`（hooks.rs:1169–1258）解析 runtime root、skill package 根与
 * env 计划，并读取原生 Windows 身份——全是同步文件系统/原生命令形状，移动端没有。因此这一层用端口
 * 隔离：桌面入口 `index.ts` 注入 `agent-workspace/api.ts` 的实现，移动端入口 `mobile.ts` 不注入——
 * 缺省端口对本地 shell 调用 fail-closed（移动端也没有 `local_shell_execute` 执行器）。
 */
import type { ChatV2Emitter } from '../../chat/api.ts';
import type {
  ApprovalGateCall, LocalShellApprovalDeps, LocalShellApprovalResult,
} from '../../agent-workspace/portable.ts';

export interface ChatPipelineApprovalRuntime {
  /** `hooks.rs:1169–1258`：原 ToolCall 不变，返回值带 root/env 审批绑定。 */
  resolveLocalShellApprovalArguments(call: ApprovalGateCall, emitter: Pick<ChatV2Emitter, 'tryWindow'>,
    sessionId: string, skillPackageRoots: Readonly<Record<string, string>> | null,
    deps: LocalShellApprovalDeps): LocalShellApprovalResult;
}

/** 缺省端口：没有本地文件系统（移动端 / 未注入）。 */
const unavailable: ChatPipelineApprovalRuntime = {
  resolveLocalShellApprovalArguments: () => ({
    ok: false, error: 'windowless runtime: local shell approval binding requires a local filesystem',
  }),
};

let active: ChatPipelineApprovalRuntime = unavailable;

/** 入口注入平台实现；`null` 恢复缺省（无本地文件系统）。 */
export function setChatPipelineApprovalRuntime(port: ChatPipelineApprovalRuntime | null): void {
  active = port ?? unavailable;
}

/** 当前端口；本地 shell 审批绑定只经它。 */
export function chatPipelineApprovalRuntime(): ChatPipelineApprovalRuntime {
  return active;
}
