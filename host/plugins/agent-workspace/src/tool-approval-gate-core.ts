/**
 * L05 owner ports consumed by the L04 ChatToolRuntime composition root（纯判定部分）。
 *
 * 这些函数不读写文件系统，移动端也要加载，因此 `portable.ts` 直接发布本模块；桌面 barrel
 * `tool-approval-gate.ts` 再补上需要 runtime root / 同步文件系统的 shell 绑定
 * （`tool-approval-shell.ts`）。
 */
import type { VfsService } from '../../vfs/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { JsonValue, RuntimeRootDeps, SettingsLike, ToolSensitivity, PermissionPreset } from '../api.ts';
import { isShellRuntimeToolForArgs, jsonField, makeRuntimeApprovalScope } from './approval-scope/portable.ts';
import { enforceForCall, applyToSensitivity, SHELL_COMMAND_RULES_KEY } from './tools/shell-policy.ts';
import { resolveEffectiveSensitivity } from './tool-approval-policy.ts';

export interface ApprovalGateCall { name: string; arguments: JsonValue }
export interface LocalShellApprovalDeps extends RuntimeRootDeps {
  /** L04 get_session_authority_state; errors retain the lookup context below. */
  authorityState(sessionId: string): { authorityMode: 'ask' | 'plan' | 'craft'; permissionPreset: PermissionPreset };
  /** L04 session/group lookup, preserving runtime_roots.rs:1429–1499 warn + None branches. */
  preferredRuntimeRootId(sessionId: string): string | null;
  warn(message: string): void;
}
export type LocalShellApprovalResult = { ok: true; value: JsonValue | null } | { ok: false; error: string };

function settingOrNone(settings: Pick<SettingsLike, 'get'>, key: string): string | null {
  try { return settings.get(key); } catch { return null; } // Rust get_setting(...).ok().flatten()
}

/** Typed owner scope -> JSON port, omitting the same optional fields as serde. */
export function runtimeApprovalScope(name: string, args: JsonValue, sensitivity: string): JsonValue {
  const scope = makeRuntimeApprovalScope(name, args, sensitivity);
  if (scope === null) return null;
  const result: { [key: string]: JsonValue } = {};
  const entries: Array<[string, JsonValue | undefined]> = Object.entries(scope);
  for (const [key, value] of entries) if (value !== undefined) result[key] = value;
  return result;
}

/** hooks.rs:454–477; settings errors are absent policy, never an approval bypass. */
export function shellCommandDecision(call: ApprovalGateCall, isLocalShell: boolean, settings: Pick<SettingsLike, 'get'> | null) {
  if (!isShellRuntimeToolForArgs(call.name, call.arguments)) return null;
  const command = jsonField(call.arguments, 'command');
  if (typeof command !== 'string') return null;
  const raw = settings === null ? null : settingOrNone(settings, SHELL_COMMAND_RULES_KEY);
  const decision = enforceForCall(raw, command, isLocalShell);
  return {
    deny: decision.effective_effect === 'deny',
    applyToSensitivity: (sensitivity: ToolSensitivity | null): ToolSensitivity => applyToSensitivity(decision, sensitivity),
  };
}

/** hooks.rs:520–529; no main DB preserves base, while malformed values fall through. */
export function effectiveSensitivity(base: ToolSensitivity | null, name: string, args: JsonValue,
  settings: Pick<SettingsLike, 'get'> | null): ToolSensitivity | null {
  return settings === null ? base : resolveEffectiveSensitivity(base, name, args, key => settingOrNone(settings, key));
}

/** tool_loop.rs:3287–3297: missing VFS skips check, query failures behave as no file. */
export function vfsFileExists(fileId: string, vfs: { database: Pick<VfsService['database'], 'getConnSafe'> } | null,
  repos: Pick<VfsReposService, 'files'>): boolean | null {
  if (vfs === null) return null;
  try { return repos.files.getFile(vfs.database.getConnSafe(), fileId) !== null; }
  catch { return false; }
}
