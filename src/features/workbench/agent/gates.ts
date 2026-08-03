/**
 * ACR 权限闸门 — R2-08
 * 三档：off / background / follow（见 docs/dev/acr/ERRORS.md）
 */
import i18n from 'i18next';
import { ACR_COMMAND_ACCESS, ACR_ERROR_CODES, type AcrCommandAccess } from './types';

export type AgentControlMode = 'off' | 'background' | 'follow';

/** 运行时缓存（由 StageManager 热更新）；未读到设置前按产品默认 follow */
let currentMode: AgentControlMode = 'follow';

export function getAgentControlMode(): AgentControlMode {
  return currentMode;
}

export function setAgentControlMode(mode: AgentControlMode): void {
  currentMode = mode;
}

/** ACR 4.0：单一真相源派生（types.ts ACR_COMMAND_ACCESS），消灭手写平行清单 */
function commandsByAccess(access: AcrCommandAccess): Set<string> {
  return new Set(
    Object.entries(ACR_COMMAND_ACCESS)
      .filter(([, value]) => value === access)
      .map(([command]) => command),
  );
}

/**
 * 只读：off 仍允许。从 ACR_COMMAND_ACCESS 派生——`act` 为 dynamic
 * （按 isAgentActRequestReadOnly 判定），不在两个静态集合中。
 */
export const ACR_READONLY_COMMANDS: ReadonlySet<string> =
  commandsByAccess('read-only');

/** 写与导航：off 拒绝。从 ACR_COMMAND_ACCESS 派生。 */
export const ACR_MUTATING_COMMANDS: ReadonlySet<string> =
  commandsByAccess('mutating');

/** 未设置 / 空 → follow（开箱可用）；显式 off|background|follow 照认；其它 → off */
export function parseAgentControlMode(raw: string | null | undefined): AgentControlMode {
  if (raw == null) return 'follow';
  const v = String(raw).trim();
  if (!v) return 'follow';
  if (v === 'off' || v === 'background' || v === 'follow') return v;
  return 'off';
}

export function isReadonlyCommand(command: string): boolean {
  return ACR_READONLY_COMMANDS.has(command);
}

export function isMutatingCommand(command: string): boolean {
  return ACR_MUTATING_COMMANDS.has(command);
}

/** off 档是否允许该桥命令 */
export function isCommandAllowedWhenOff(command: string): boolean {
  return isReadonlyCommand(command);
}

export interface GateErrorParts {
  code: string;
  message: string;
  hint: string;
  retryable: boolean;
}

function tErr(key: string, fallback: string, vars?: Record<string, string>): string {
  return i18n.t(`workbench:agent.errors.${key}`, { defaultValue: fallback, ...vars });
}

/** control=off 拒写/导航 */
export function gateDisabledOff(): GateErrorParts {
  return {
    code: ACR_ERROR_CODES.WORKBENCH_DISABLED,
    message: tErr(
      'controlOff',
      'Agent 桌面操控已关闭（desktop.workbenchAgentControl=off）',
    ),
    hint: tErr(
      'controlOffHint',
      '将设置「AI 助手操控」改为后台或跟随即可；数据修改也可改用领域工具',
    ),
    retryable: false,
  };
}

/** OS / workbenchBus 未开 */
export function gateDisabledOs(): GateErrorParts {
  return {
    code: ACR_ERROR_CODES.WORKBENCH_DISABLED,
    message: tErr('osDisabled', '桌面模式未开启'),
    hint: tErr(
      'osDisabledHint',
      '请先开启 OS/桌面模式；数据修改请改用领域工具',
    ),
    retryable: false,
  };
}

export function gateDisabledLaunchFailed(): GateErrorParts {
  return {
    code: ACR_ERROR_CODES.WORKBENCH_DISABLED,
    message: tErr('launchFailed', '无法打开应用窗口'),
    hint: tErr(
      'launchFailedHint',
      '桌面模式未就绪或应用未注册',
    ),
    retryable: false,
  };
}
