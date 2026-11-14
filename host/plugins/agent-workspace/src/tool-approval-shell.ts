/**
 * 本地 shell 审批的运行时绑定：解析 root、env 计划与 approval binding，全部要求同步文件系统
 * （runtime roots / skill packages / 原生 Windows 身份）。因此只由桌面入口 `api.ts` 发布；
 * 移动端从 `portable.ts` 取 `tool-approval-gate.ts` 的纯判定部分。
 */
import path from 'node:path';
import os from 'node:os';
import type { ChatV2Emitter } from '../../chat/api.ts';
import type { JsonValue } from '../api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import {
  isLocalShellExecuteTool, immutableShellCommandGuard, jsonField, normalizedShellRuntimeLocation,
  attachRuntimeRootApprovalBinding, attachShellEnvPolicyFacts, type ShellCommandGuardDecision,
} from './approval-scope/portable.ts';
import { explicitRuntimeRootIdFromArgs } from './runtime-paths.ts';
import { runtimeRootById } from './runtime-roots.ts';
import { shellRuntimeApprovalBinding } from './runtime-root-approval.ts';
import { envPolicyFacts } from './tools/shell-env.ts';
import { runtimeSupportReadRoots } from './tools/shell-execute/context.ts';
import { cloneAgentJson } from '../../../kernel/agent-api.ts';
import type { ApprovalGateCall, LocalShellApprovalDeps, LocalShellApprovalResult } from './tool-approval-gate-core.ts';

/** hooks.rs:171–195; only local shell gets the immutable parser, with HOME protected. */
export function immutableCommandGuardForToolCall(call: ApprovalGateCall): ShellCommandGuardDecision | null {
  if (!isLocalShellExecuteTool(call.name, call.arguments)) return null;
  const command = jsonField(call.arguments, 'command');
  if (typeof command !== 'string') return null;
  const home = os.homedir();
  return immutableShellCommandGuard(command, null, home === '' ? [] : [home]);
}

/** hooks.rs:1169–1258; original ToolCall stays untouched. */
export function resolveLocalShellApprovalArguments(call: ApprovalGateCall, emitter: Pick<ChatV2Emitter, 'tryWindow'>,
  sessionId: string, skillPackageRoots: Readonly<Record<string, string>> | null, deps: LocalShellApprovalDeps): LocalShellApprovalResult {
  if (!isLocalShellExecuteTool(call.name, call.arguments)) return { ok: true, value: null };
  if (emitter.tryWindow() == null) return { ok: false, error: 'windowless runtime: local shell approval binding requires a Tauri window' };
  try {
    let authority: ReturnType<LocalShellApprovalDeps['authorityState']>;
    try { authority = deps.authorityState(sessionId); }
    catch (error) { throw new Error(`Failed to resolve shell authority: ${error instanceof Error ? error.message : String(error)}`); }
    const allowAbsolute = authority.authorityMode === 'craft'
      && (authority.permissionPreset === 'full_access' || authority.permissionPreset === 'danger_full_access');
    const [, requestedCwd] = normalizedShellRuntimeLocation(call.arguments);
    const usesHost = allowAbsolute && rustTrim(requestedCwd) !== '.' && path.isAbsolute(rustTrim(requestedCwd));
    const explicit = explicitRuntimeRootIdFromArgs(call.arguments);
    const skills = skillPackageRoots === null ? null : new Map(Object.entries(skillPackageRoots));
    let effectiveRoot = usesHost ? 'host' : explicit;
    if (effectiveRoot === null) {
      const preferred = deps.preferredRuntimeRootId(sessionId);
      if (preferred !== null) {
        try { runtimeRootById(deps, sessionId, skills, preferred, false); effectiveRoot = preferred; }
        catch {
          deps.warn(`[runtime_roots] group preferred runtime root '${preferred}' for session '${sessionId}' is not resolvable on this device; falling back to workspace`);
        }
      }
      effectiveRoot ??= 'workspace';
    }
    const args = cloneAgentJson(call.arguments);
    if ((usesHost || explicit === null) && args !== null && typeof args === 'object' && !Array.isArray(args)) args.root_id = effectiveRoot;
    const [rootId, cwd] = normalizedShellRuntimeLocation(args);
    const support = usesHost ? [] : runtimeSupportReadRoots(args);
    const binding = shellRuntimeApprovalBinding(deps, sessionId, skills, rootId, cwd, support, allowAbsolute);
    const scoped = attachRuntimeRootApprovalBinding(args, binding);
    const facts = envPolicyFacts(args);
    return { ok: true, value: attachShellEnvPolicyFacts(scoped, {
      planHash: facts.plan_hash, inheritParentEnv: facts.inherit_parent_env,
      inheritedKeys: facts.inherited_keys, explicitKeys: facts.explicit_keys,
    }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type { ApprovalGateCall, LocalShellApprovalDeps, LocalShellApprovalResult } from './tool-approval-gate-core.ts';
