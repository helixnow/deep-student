/**
 * ACR 4.0（A2）— desktop 虚拟目标注册
 *
 * desktop 是无宿主窗口的单例虚拟目标，不进 appRegistry（避免出现在启动器、
 * 被 open_app 打开成假窗、或进快照），只把 agentManifest 挂到
 * core/agentRuntime 的虚拟目标注册表：
 * - get_capabilities（无 target / typeId=desktop / windowId=desktop）可发现；
 * - observe / act / wait_for / undo 经 agentRuntime 的虚拟解析分支执行；
 * - probe / list_windows / query_state 的 desktop 分支见 agent/{probe,queryProviders}。
 */
import { registerVirtualAgentTarget } from '../../core/agentRuntime';
import { DESKTOP_TYPE_ID, desktopAgentManifest } from './agentManifest';

let registered = false;

/** 幂等注册 desktop 虚拟目标 */
export function registerDesktopAgentTarget(): void {
  if (registered) return;
  registered = true;
  registerVirtualAgentTarget(DESKTOP_TYPE_ID, desktopAgentManifest);
}
