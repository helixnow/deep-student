/**
 * 会话权威档位与本地 shell 运行时契约：移植
 * `chat_v2/types.rs` 的 AuthorityMode / PermissionPreset /
 * HostShellExecutionMode / SessionAuthorityState，
 * `pipeline/authority_mode.rs::requires_tool_approval`，以及
 * `chat_v2/context.rs::local_shell_contract_for_platform`。
 */
import type { ToolSensitivity } from './shared.ts';
import { allowedSkillsBases } from '../skill-packages.ts';

export type AuthorityMode = 'ask' | 'plan' | 'craft';
export type PermissionPreset = 'cautious' | 'relaxed' | 'full_access' | 'danger_full_access';
export type HostShellExecutionMode = 'sandboxed' | 'full_access' | 'unrestricted';

export interface SessionAuthorityState {
  authority_mode: AuthorityMode;
  permission_preset: PermissionPreset;
}

export function craftDefault(): SessionAuthorityState {
  return { authority_mode: 'craft', permission_preset: 'relaxed' };
}

export function hostShellExecutionModeFromAuthority(
  authorityMode: AuthorityMode,
  preset: PermissionPreset,
): HostShellExecutionMode {
  if (authorityMode === 'craft' && preset === 'full_access') return 'full_access';
  if (authorityMode === 'craft' && preset === 'danger_full_access') return 'unrestricted';
  return 'sandboxed';
}

export function hostShellExecutionUnsandboxed(mode: HostShellExecutionMode): boolean {
  return mode === 'full_access' || mode === 'unrestricted';
}

export function hostShellExecutionUnrestricted(mode: HostShellExecutionMode): boolean {
  return mode === 'unrestricted';
}

/** `requires_tool_approval`（隐藏参数固定为 false/false 的调用形态也保留）。 */
export function requiresToolApproval(
  state: SessionAuthorityState,
  baseSensitivity: ToolSensitivity | null,
  effectiveSensitivity: ToolSensitivity | null,
  immutableCommandGuardAsks: boolean,
  externalMcp = false,
  privilegeEscalation = false,
): boolean {
  if (privilegeEscalation) return true;
  const guardAsks = immutableCommandGuardAsks && !externalMcp;
  if (state.authority_mode !== 'craft') {
    if (guardAsks) return true;
    return effectiveSensitivity !== 'low';
  }
  switch (state.permission_preset) {
    case 'cautious':
      if (guardAsks) return true;
      return baseSensitivity !== 'low' || effectiveSensitivity !== 'low';
    case 'relaxed':
      if (guardAsks) return true;
      return baseSensitivity === null
        || effectiveSensitivity === null
        || baseSensitivity === 'high'
        || effectiveSensitivity === 'high';
    case 'full_access':
    case 'danger_full_access':
      return false;
  }
}

export interface LocalShellRuntimeContract {
  os: string;
  sandbox_backend: string;
  shell_path: string | null;
  shell_kind: string;
  invocation: string | null;
  output_encoding: string | null;
  execution_supported: boolean;
}

export function localShellContractForPlatform(platform: string): LocalShellRuntimeContract {
  switch (platform) {
    case 'macos':
      return {
        os: 'macOS', sandbox_backend: 'macos_seatbelt', shell_path: '/bin/sh',
        shell_kind: 'posix_sh', invocation: '/bin/sh -c', output_encoding: 'utf-8',
        execution_supported: true,
      };
    case 'windows':
      return {
        os: 'Windows', sandbox_backend: 'windows_appcontainer_job',
        shell_path: 'Program Files\\PowerShell\\7\\pwsh.exe (preferred), System32\\WindowsPowerShell\\v1.0\\powershell.exe (fallback)',
        shell_kind: 'windows_powershell',
        invocation: 'pwsh.exe -NoProfile -NonInteractive -EncodedCommand; fallback powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand',
        output_encoding: 'utf-8', execution_supported: true,
      };
    case 'linux':
      return {
        os: 'Linux', sandbox_backend: 'linux_bwrap', shell_path: '/bin/sh',
        shell_kind: 'posix_sh', invocation: '/bin/sh -c', output_encoding: 'utf-8',
        execution_supported: true,
      };
    default:
      return {
        os: 'Unsupported', sandbox_backend: 'unavailable', shell_path: null,
        shell_kind: 'unavailable', invocation: null, output_encoding: 'unknown',
        execution_supported: false,
      };
  }
}

const SKILLS_DIR_LITERAL_PATTERNS = [
  '.deep-student/skills',
  '.claude/skills',
  '.agents/skills',
  '.github/skills',
  'skills-cursor',
];

/** `skills::command_mentions_skills_directory`：封侧门的 fail-closed 子串匹配。 */
export function commandMentionsSkillsDirectory(command: string, bases: readonly string[] = []): boolean {
  const normalized = command.replaceAll('\\', '/').toLowerCase();
  if (normalized === '') return false;
  if (SKILLS_DIR_LITERAL_PATTERNS.some(pattern => normalized.includes(pattern))) return true;
  for (const base of bases) {
    const normalizedBase = base.replaceAll('\\', '/').toLowerCase();
    if (normalizedBase.length < 4) continue;
    if (normalized.includes(normalizedBase)) return true;
  }
  return false;
}

/** 便捷封装：使用当前平台允许的技能基目录。 */
export function commandMentionsSkillsDirectoryWithDefaults(
  command: string,
  appDataDir: string,
): boolean {
  return commandMentionsSkillsDirectory(command, allowedSkillsBases({ appDataDir }));
}
