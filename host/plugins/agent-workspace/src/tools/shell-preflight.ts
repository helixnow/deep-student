/**
 * `local_shell_preflight_executor.rs` 的 TS 移植：
 * `local_shell_preflight` 只做「会不会被执行 / 需不需要审批 / 风险等级」的
 * 只读预检，绝不 spawn 进程（`would_execute` 恒为 false）。
 *
 * 分支顺序、默认值、钳制、错误文案与输出 JSON 字段名（snake_case）逐条对齐
 * Rust；Tauri `ExecutionContext` / `Window` / `State<Database>` 由
 * `ShellPreflightContext` 注入，DB 派生值（preferred runtime root）由调用方
 * 通过 `preferredRuntimeRootId` 提供。
 */
import * as fs from 'node:fs';
import path from 'node:path';
import type { RuntimeRoot } from '../../api.ts';
import {
  analyzeShellCommand, immutableShellCommandGuard, redactShellCommandForDisplay,
  redactToolArgumentsForDisplay, shellCommandToolSensitivity, validateShellPathOperandsWithinRoot,
  ShellCommandGuardEffect,
} from '../approval-scope.ts';
import type { ShellCommandAnalysis } from '../approval-scope.ts';
import {
  SHELL_COMMAND_RULES_KEY, applyToSensitivity, enforceForCall,
} from './shell-policy.ts';
import type { ShellPolicyDecision } from './shell-policy.ts';
import {
  commandMentionsSkillsDirectoryWithDefaults, hostShellExecutionModeFromAuthority,
  hostShellExecutionUnsandboxed, hostShellExecutionUnrestricted, localShellContractForPlatform,
  requiresToolApproval,
} from './shell-authority.ts';
import type { AuthorityMode, HostShellExecutionMode, PermissionPreset } from './shell-authority.ts';
import {
  hostCwdRuntimeRoot, runtimeRootById,
} from '../runtime-roots.ts';
import type { RuntimeRootDeps, SettingsLike } from '../runtime-roots.ts';
import {
  asciiLower, explicitRuntimeRootIdFromArgs, ioMessage, isWithin, normalizeRuntimeRelativePath,
  sha256Hex,
} from '../runtime-paths.ts';
import { resolveEffectiveRuntimeRootIdForSession } from './workspace-fs.ts';
import {
  stripToolNamespace, successResult,
  type JsonValue, type ToolCall, type ToolResultInfo, type ToolSensitivity,
} from './shared.ts';
import { isRustWhitespace, rustTrim } from '../../../../platform/util/index.ts';
import { createPlatformSandboxBackend, createUnsandboxedBackend, type SandboxBackend } from './shell-sandbox.ts';

export const toolNames = {
  SHELL_PREFLIGHT: 'local_shell_preflight',
} as const;

/** `MAX_PREFLIGHT_COMMAND_BYTES`：Rust `command.len() > 8192`（字节）。 */
const MAX_COMMAND_BYTES = 8_192;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const UNRESTRICTED_OUTPUT_BOUND_BYTES = 33_554_432;
const SANDBOXED_OUTPUT_BOUND_BYTES = 65_536;

type JsonObject = { [key: string]: JsonValue };

/** 工具执行的宿主上下文：Rust `ExecutionContext` 中本模块实际用到的部分。 */
export interface ShellPreflightContext {
  windowsFiles?: RuntimeRootDeps['windowsFiles'];
  dataDir: string;
  settings: SettingsLike;
  sessionId: string;
  /** `ctx.shell_authority_admission`；null / 缺省表示会话未确认权威档位。 */
  authority?: [AuthorityMode, PermissionPreset] | null;
  skillPackageRoots?: ReadonlyMap<string, string> | null;
  preferredRuntimeRootId?: string | null;
  blockId?: string | null;
  emitToolCallStart?: (toolName: string, args: JsonValue, toolCallId: string | null) => void;
  emitToolCallEnd?: (payload: JsonValue) => void;
  emitToolCallError?: (error: string) => void;
  saveToolBlock?: (result: ToolResultInfo) => void;
  warn?: (message: string) => void;
}

function rustSplitWhitespace(value: string): string[] {
  const words: string[] = [];
  let current = '';
  for (const ch of value) {
    if (isRustWhitespace(ch.codePointAt(0) ?? 0)) {
      if (current !== '') { words.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current !== '') words.push(current);
  return words;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Rust `std::env::consts::OS` 的等价命名（`local_shell_contract_for_platform` 的入参）。 */
function rustOsName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return platform;
}

/** Rust `Path::join`：第二参数为绝对路径时替换整个路径。 */
function rustJoin(base: string, relative: string): string {
  return path.isAbsolute(relative) ? relative : path.join(base, relative);
}

function argPresent(args: JsonValue, keys: readonly string[]): JsonValue | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const object = args as { [key: string]: JsonValue };
  for (const key of keys) if (Object.hasOwn(object, key)) return object[key];
  return undefined;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** serde_json `as_u64`：非负整数（u64 语义）才取值。 */
function u64Value(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function runtimeDeps(ctx: ShellPreflightContext): RuntimeRootDeps {
  return { settings: ctx.settings, dataDir: ctx.dataDir, windowsFiles: ctx.windowsFiles };
}

function failureResult(
  toolCallId: string | null,
  blockId: string | null,
  toolName: string,
  input: JsonValue,
  error: string,
  durationMs: number,
): ToolResultInfo {
  const result: ToolResultInfo = { toolName, input, output: null, success: false, error, durationMs };
  if (toolCallId !== null && toolCallId !== '') result.toolCallId = toolCallId;
  if (blockId !== null && blockId !== '') result.blockId = blockId;
  return result;
}

/** `LocalShellExecuteExecutor::command_appears_write_capable`。 */
export function commandAppearsWriteCapable(command: string): boolean {
  return analyzeShellCommand(command).writeCapable;
}

/**
 * `LocalShellExecuteExecutor::ensure_root_writable_for_command`：
 * 只读 root 拒绝一切写入类命令；可写 root 仍拒绝解析到 root 之外的显式
 * 绝对路径 / `..` / shell 展开操作数。
 */
export function ensureRootWritableForCommand(root: RuntimeRoot, cwd: string, command: string): void {
  const analysis = analyzeShellCommand(command);
  if (root.access === 'read_only' && analysis.writeCapable) {
    throw new Error(
      `Runtime root '${root.id}' is read-only for the agent runtime, but this command looks `
      + 'write-capable. Run writes inside root_id=artifacts or root_id=temp, or ask the '
      + 'user to perform this change manually.',
    );
  }
  try {
    validateShellPathOperandsWithinRoot(root.path, cwd, command);
  } catch (error) {
    throw new Error(
      `Write-capable command violates runtime root '${root.id}': ${messageOf(error)}. `
      + 'Keep every input/output path relative to the selected root; do not use /tmp, /dev/null, '
      + "'..', or $OLDPWD. Copy inputs into a child directory and write outputs in the root when repackaging.",
    );
  }
}

export interface PreflightSandboxBackends {
  platform: () => SandboxBackend;
  unsandboxed: () => SandboxBackend;
}

const EXECUTE_SANDBOX_BACKENDS: PreflightSandboxBackends = {
  platform: createPlatformSandboxBackend, unsandboxed: createUnsandboxedBackend,
};

export class LocalShellPreflightExecutor {
  private readonly getWindowsFiles?: () => ShellPreflightContext['windowsFiles'];
  private readonly backends: PreflightSandboxBackends;
  constructor(getWindowsFiles?: () => ShellPreflightContext['windowsFiles'], backends: PreflightSandboxBackends = EXECUTE_SANDBOX_BACKENDS) {
    this.getWindowsFiles = getWindowsFiles;
    this.backends = backends;
  }
  canHandle(toolName: string): boolean {
    return stripToolNamespace(toolName) === toolNames.SHELL_PREFLIGHT;
  }

  name(): string {
    return 'LocalShellPreflightExecutor';
  }

  sensitivityLevel(_toolName: string): ToolSensitivity {
    return 'low';
  }

  static order(): string[] {
    return Object.values(toolNames);
  }

  static sha256Hex(input: string): string {
    return sha256Hex(input);
  }

  /** `root_json`：运行时 root 的对外投影（不泄露真实路径）。 */
  static rootJson(root: RuntimeRoot): JsonObject {
    return {
      id: root.id,
      kind: root.kind,
      access: root.access,
      label: root.label,
      description: root.description,
      sessionScoped: root.session_scoped,
      configured: root.configured,
      path: `runtime-root://${root.id}`,
    };
  }

  /** 取前三个 token，去掉引号/反引号壳后转小写。 */
  static commandTokensLower(command: string): string[] {
    const tokens: string[] = [];
    for (const token of rustSplitWhitespace(command)) {
      tokens.push(asciiLower(token.replace(/^["'`]+/, '').replace(/["'`]+$/, '')));
      if (tokens.length === 3) break;
    }
    return tokens;
  }

  static hasDangerousCommandPrefix(command: string): boolean {
    const tokens = LocalShellPreflightExecutor.commandTokensLower(command);
    const first = tokens[0] ?? '';
    const second = tokens[1] ?? '';

    if (new Set([
      'rm', 'del', 'erase', 'rmdir', 'rd', 'mv', 'move', 'cp', 'copy', 'remove-item', 'move-item',
      'copy-item', 'set-content', 'add-content', 'new-item', 'start-process', 'curl', 'wget',
    ]).has(first)) {
      return true;
    }
    if (first === 'git'
      && new Set(['push', 'reset', 'checkout', 'clean', 'rebase', 'merge', 'commit']).has(second)) {
      return true;
    }
    return ['npm', 'pnpm', 'yarn'].includes(first) && second === 'install';
  }

  static isLowRiskReadonlyPrefix(command: string): boolean {
    const tokens = LocalShellPreflightExecutor.commandTokensLower(command);
    const first = tokens[0] ?? '';
    const second = tokens[1] ?? '';

    if (['pwd', 'ls', 'dir', 'rg', 'grep', 'cat', 'type'].includes(first)) return true;
    return first === 'git' && ['status', 'diff', 'log'].includes(second);
  }

  /**
   * 预检能否承诺「未来执行无需审批」：没有已确认的会话权威档位时必须
   * fail-closed 返回 true（不得宣称可绕过审批）。
   */
  static requiresApprovalBeforeExecute(
    command: string,
    commandPolicy: ShellPolicyDecision,
    authorityAdmission: [AuthorityMode, PermissionPreset] | null | undefined,
  ): boolean {
    if (authorityAdmission === null || authorityAdmission === undefined) return true;
    const [authorityMode, permissionPreset] = authorityAdmission;
    const authority = { authority_mode: authorityMode, permission_preset: permissionPreset };
    const sensitivity = shellCommandToolSensitivity(command);
    const effectiveSensitivity = applyToSensitivity(commandPolicy, sensitivity);
    const immutableGuardAsks = immutableShellCommandGuard(command, null, []).effect
      === ShellCommandGuardEffect.Ask;

    return requiresToolApproval(authority, sensitivity, effectiveSensitivity, immutableGuardAsks, false, false);
  }

  /** 后端权威执行档（模型参数不可选）：preflight 与 execute 侧同源派生。 */
  static hostExecutionMode(
    authorityAdmission: [AuthorityMode, PermissionPreset] | null | undefined,
  ): HostShellExecutionMode {
    if (authorityAdmission === null || authorityAdmission === undefined) return 'sandboxed';
    const [authorityMode, permissionPreset] = authorityAdmission;
    return hostShellExecutionModeFromAuthority(authorityMode, permissionPreset);
  }

  /**
   * `inspect_cwd`：cwd 必须存在、经 canonicalize 后仍在 root 内，并且是目录。
   * 返回 `[display, valid, reasons]`。
   */
  static inspectCwd(root: RuntimeRoot, cwd: string): [string, boolean, string[]] {
    const target = rustJoin(root.path, cwd);
    const display = cwd === '' ? '.' : cwd;
    const reasons: string[] = [];

    if (!fs.existsSync(root.path)) {
      reasons.push('runtime root does not exist yet');
      return [display, false, reasons];
    }
    if (!fs.existsSync(target)) {
      reasons.push('cwd does not exist');
      return [display, false, reasons];
    }

    let rootCanon: string;
    try {
      rootCanon = fs.realpathSync.native(root.path);
    } catch (error) {
      reasons.push(`failed to canonicalize runtime root: ${ioMessage(error)}`);
      return [display, false, reasons];
    }
    let targetCanon: string;
    try {
      targetCanon = fs.realpathSync.native(target);
    } catch (error) {
      reasons.push(`failed to canonicalize cwd: ${ioMessage(error)}`);
      return [display, false, reasons];
    }
    if (!isWithin(rootCanon, targetCanon)) {
      reasons.push('cwd escapes the selected runtime root');
      return [display, false, reasons];
    }
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(targetCanon).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      reasons.push('cwd is not a directory');
      return [display, false, reasons];
    }
    return [display, true, reasons];
  }

  async executePreflight(args: JsonValue, ctx: ShellPreflightContext): Promise<JsonObject> {
    if (this.getWindowsFiles) ctx = { ...ctx, windowsFiles: this.getWindowsFiles() };
    const command = rustTrim(stringValue(argPresent(args, ['command'])) ?? '');
    const explicitRootId = explicitRuntimeRootIdFromArgs(args);
    const skillRootRaw = argPresent(args, ['skill_root_id', 'skillRootId']);
    const skillRootTrimmed = typeof skillRootRaw === 'string' ? rustTrim(skillRootRaw) : '';
    const skillRootIdInput = skillRootTrimmed !== '' ? skillRootTrimmed : null;
    const cwdInput = stringValue(argPresent(args, ['cwd', 'working_dir', 'workingDir']));
    // 后端权威执行档（模型参数不可选）：preflight 与 execute 侧同源派生。
    const executionMode = LocalShellPreflightExecutor.hostExecutionMode(ctx.authority);
    const unsandboxed = hostShellExecutionUnsandboxed(executionMode);
    const unrestricted = hostShellExecutionUnrestricted(executionMode);
    const rawTimeout = u64Value(argPresent(args, ['timeout_ms', 'timeoutMs']));
    const timeoutMs = unrestricted
      ? (rawTimeout === null ? DEFAULT_TIMEOUT_MS : Math.max(rawTimeout, MIN_TIMEOUT_MS))
      // 与执行侧 clamp 保持一致（上限 10 分钟）。
      : Math.min(Math.max(rawTimeout ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
    const purposeRaw = stringValue(argPresent(args, ['purpose']));
    const purposeTrimmed = purposeRaw === null ? '' : rustTrim(purposeRaw);
    const purpose = purposeTrimmed !== '' ? purposeTrimmed : null;

    const reasons: string[] = [];
    const platform = rustOsName(process.platform);
    const shell = localShellContractForPlatform(platform);
    if (!shell.execution_supported) {
      reasons.push(`local shell execution is unsupported on platform '${platform}'`);
    }
    // 🔒 运行时执行能力探测：受限档位检查平台沙箱，完全访问检查无沙箱后端
    //（如 Linux 桌面未安装 bubblewrap）时，预检直接标 blocked，并把安装指引
    // 透传给模型/用户，避免 execute 阶段才失败。
    // 与 shell-execute.ts 选同一个后端（Rust :275-289 同样直接问后端），execute 会拒绝的这里必须先报出来。
    const capability = (unsandboxed || unrestricted ? this.backends.unsandboxed() : this.backends.platform()).capability();
    const sandboxAvailable = capability.available;
    if (shell.execution_supported && capability.available === false) {
      reasons.push(`local shell sandbox is unavailable: ${capability.reason}`);
    }
    // 🆓 完全信任（unsandboxed）档：cwd 允许宿主机绝对路径，与 execute 侧
    // host_cwd_runtime_root 语义对齐——不 join runtime root、不做逃逸检查，
    // 仅校验存在且为目录。沙箱档维持相对路径约束不变。
    let cwdAbsoluteInput: string | null = null;
    if (unsandboxed && cwdInput !== null) {
      const trimmed = rustTrim(cwdInput);
      if (trimmed !== '' && trimmed !== '.' && path.isAbsolute(trimmed)) cwdAbsoluteInput = trimmed;
    }
    const effectiveRootId = cwdAbsoluteInput !== null
      ? 'host'
      : resolveEffectiveRuntimeRootIdForSession(ctx, explicitRootId);
    const rootIdInput: string = effectiveRootId;

    let root: RuntimeRoot | null = null;
    let rootError: string | null = null;
    try {
      root = cwdAbsoluteInput !== null
        ? hostCwdRuntimeRoot(cwdAbsoluteInput)
        : runtimeRootById(
          runtimeDeps(ctx),
          ctx.sessionId,
          ctx.skillPackageRoots ?? null,
          rootIdInput,
          true,
        );
    } catch (error) {
      rootError = messageOf(error);
      root = null;
    }

    let cwdResult: { cwd: string; error: string | null };
    if (cwdAbsoluteInput !== null) {
      cwdResult = { cwd: cwdAbsoluteInput, error: null };
    } else {
      try {
        cwdResult = { cwd: normalizeRuntimeRelativePath(cwdInput), error: null };
      } catch (error) {
        cwdResult = { cwd: '.', error: messageOf(error) };
      }
    }

    const analysis: ShellCommandAnalysis = analyzeShellCommand(command);
    const [displayCommand, commandRedacted] = redactShellCommandForDisplay(command);
    const displayAnalysis = analyzeShellCommand(displayCommand);
    let rawCommandPolicy: string | null = null;
    try {
      rawCommandPolicy = ctx.settings.get(SHELL_COMMAND_RULES_KEY);
    } catch {
      // Rust `get_setting(...).ok().flatten()`：读取失败按未配置处理。
      rawCommandPolicy = null;
    }
    const commandPolicy = enforceForCall(rawCommandPolicy, command, true);

    if (command === '') {
      reasons.push('command is required');
    }
    // 🛡️ 不可降级的灾难命令守卫：preflight 必须与 pipeline/tool_loop 的拦截
    // 判定一致地暴露 Deny——否则模型会依据 preflight 的
    // submit_execute_directly/medium 结论去提交一条必然被 pipeline 拦的命令。
    const immutableGuardDecision = immutableShellCommandGuard(command, null, []);
    if (immutableGuardDecision.effect === ShellCommandGuardEffect.Deny) {
      if (unrestricted) {
        reasons.push(
          'immutable command guard would deny this command '
          + `(reason=${immutableGuardDecision.reason}); it is bypassed in the unrestricted tier`,
        );
      } else {
        reasons.push(
          'immutable command guard denies this command '
          + `(reason=${immutableGuardDecision.reason}); it can never be executed in any preset`,
        );
      }
    }
    if (byteLength(command) > MAX_COMMAND_BYTES) {
      reasons.push('command is too long for local shell preflight');
    }
    // 🔒 封侧门：命令正文命中技能包目录 → 直接标 blocked，指引改用
    // skill_install（scan → install）或技能管理 UI。
    const touchesSkillsDirectory = commandMentionsSkillsDirectoryWithDefaults(command, ctx.dataDir);
    if (touchesSkillsDirectory && !unsandboxed) {
      reasons.push(
        'command touches a skill package directory; local shell is blocked here — '
        + 'use skill_scan first, then skill_install with expected_sha256, or the Skills management UI',
      );
    }
    if (analysis.hasShellOperators) {
      reasons.push('command contains shell operators or redirection');
    }
    if (analysis.usesScriptRunner) {
      reasons.push('command uses a script/code runner');
    }
    if (LocalShellPreflightExecutor.hasDangerousCommandPrefix(command)) {
      reasons.push('command prefix is write-capable or externally effectful');
    }
    if (!unrestricted && commandPolicy.effective_effect === 'deny') {
      reasons.push('command is denied by the configured terminal command rules');
    } else if (!unrestricted
      && commandPolicy.configured_effect === 'allow'
      && commandPolicy.effective_effect !== 'allow') {
      reasons.push('matching allow rule cannot bypass approval for a protected command');
    } else if (unrestricted && commandPolicy.effective_effect === 'deny') {
      reasons.push('command matches deny rules but the unrestricted tier bypasses terminal command rules');
    }

    if (rootError !== null) reasons.push(rootError);
    const skillCwdBlocked = !unsandboxed && root !== null && root.kind === 'skill_package';
    if (skillCwdBlocked) {
      reasons.push(
        'shell execution cannot run directly inside skill package roots; '
        + 'use skill_root_id for SKILL_DIR injection',
      );
    }
    // 🔒 与 execute 侧一致：只读 root（workspace / authorized）不放行写入类命令。
    const readonlyWriteBlocked = !unsandboxed
      && root !== null
      && root.access === 'read_only'
      && commandAppearsWriteCapable(command);
    if (readonlyWriteBlocked) {
      reasons.push(
        'runtime root is read-only for the agent runtime and the command looks write-capable; '
        + 'use root_id=artifacts or root_id=temp for writes',
      );
    }

    let cwdRelative = '.';
    let cwdValid = false;
    let cwdError: string | null = null;
    if (cwdResult.error !== null) {
      reasons.push(cwdResult.error);
      cwdRelative = '.';
      cwdValid = false;
      cwdError = cwdResult.error;
    } else if (cwdAbsoluteInput !== null) {
      // 绝对路径 cwd（完全信任档）：直接对宿主机路径做存在性/目录校验。
      cwdRelative = cwdResult.cwd;
      let isDirectory = false;
      try {
        const canonical = fs.realpathSync.native(cwdResult.cwd);
        isDirectory = fs.statSync(canonical).isDirectory();
        if (!isDirectory) reasons.push('cwd is not a directory');
      } catch (error) {
        reasons.push(`failed to canonicalize cwd: ${ioMessage(error)}`);
      }
      cwdValid = isDirectory;
    } else if (root !== null) {
      const [display, valid, cwdReasons] = LocalShellPreflightExecutor.inspectCwd(root, cwdResult.cwd);
      reasons.push(...cwdReasons);
      cwdRelative = display;
      cwdValid = valid;
    } else {
      cwdRelative = cwdResult.cwd === '' ? '.' : cwdResult.cwd;
      cwdValid = false;
    }

    let pathOperandBlocked: string | null = null;
    if (!unsandboxed && !readonlyWriteBlocked && cwdValid && root !== null) {
      const cwdAbs = rustJoin(root.path, cwdRelative);
      try {
        ensureRootWritableForCommand(root, cwdAbs, command);
      } catch (error) {
        pathOperandBlocked = messageOf(error);
      }
    }
    if (pathOperandBlocked !== null) reasons.push(pathOperandBlocked);

    // skill_root_id only plans a SKILL_DIR env injection at execute time;
    // it never relaxes the cwd restriction on skill package roots.
    let skillDirRootId: string | null = null;
    if (skillRootIdInput !== null) {
      try {
        const resolved = runtimeRootById(
          runtimeDeps(ctx),
          ctx.sessionId,
          ctx.skillPackageRoots ?? null,
          skillRootIdInput,
          true,
        );
        if (resolved.kind === 'skill_package') {
          skillDirRootId = resolved.id;
        } else {
          reasons.push(
            'skill_root_id must reference a skill package root (skill:<skillId>); '
            + `'${resolved.id}' is not a skill package root`,
          );
        }
      } catch (error) {
        reasons.push(`Failed to resolve skill_root_id '${skillRootIdInput}': ${messageOf(error)}`);
      }
    }
    const skillRootInvalid = skillRootIdInput !== null && skillDirRootId === null;

    const blocked = command === ''
      || byteLength(command) > MAX_COMMAND_BYTES
      || !shell.execution_supported
      || !sandboxAvailable
      || (!unrestricted && immutableGuardDecision.effect === ShellCommandGuardEffect.Deny)
      || (!unrestricted && commandPolicy.effective_effect === 'deny')
      || (touchesSkillsDirectory && !unsandboxed)
      || skillCwdBlocked
      || readonlyWriteBlocked
      || pathOperandBlocked !== null
      || rootError !== null
      || cwdError !== null
      || !cwdValid
      || skillRootInvalid
      || reasons.some(reason => reason.includes('escapes the selected runtime root'));
    const riskLevel = blocked
      ? 'blocked'
      : (analysis.hasShellOperators
        || analysis.usesScriptRunner
        || LocalShellPreflightExecutor.hasDangerousCommandPrefix(command))
        ? 'high'
        : (cwdValid && LocalShellPreflightExecutor.isLowRiskReadonlyPrefix(command))
          ? 'low'
          : 'medium';
    const requiresApprovalBeforeExecute = LocalShellPreflightExecutor.requiresApprovalBeforeExecute(
      command,
      commandPolicy,
      ctx.authority,
    );

    return {
      command: displayCommand,
      command_hash: LocalShellPreflightExecutor.sha256Hex(analysis.trimmed),
      command_redacted: commandRedacted,
      command_prefix: displayAnalysis.commandPrefix,
      first_token: displayAnalysis.firstToken,
      execution_mode: executionMode,
      command_policy_bypassed: unrestricted,
      immutable_guard_bypassed: unrestricted,
      environment_mode: unrestricted ? 'inherit_all' : 'filtered',
      resource_limits: unrestricted
        ? {
          timeout: 'none',
          output_bound_bytes: UNRESTRICTED_OUTPUT_BOUND_BYTES,
          output_bound_reason: 'crash_protection_high_water_mark',
        }
        : {
          timeout: timeoutMs,
          output_bound_bytes: SANDBOXED_OUTPUT_BOUND_BYTES,
        },
      root: root === null ? null : LocalShellPreflightExecutor.rootJson(root),
      root_id: root !== null ? root.id : rootIdInput,
      skill_root_id: skillRootIdInput,
      skill_dir_injection: skillDirRootId === null
        ? null
        : { variable: 'SKILL_DIR', root_id: skillDirRootId },
      cwd: cwdRelative,
      cwd_valid: cwdValid,
      timeout_ms: timeoutMs,
      purpose,
      risk_level: riskLevel,
      reasons,
      command_policy: { ...commandPolicy } as JsonValue,
      has_shell_operators: analysis.hasShellOperators,
      uses_script_runner: analysis.usesScriptRunner,
      would_execute: false,
      platform,
      os: shell.os,
      shell_path: shell.shell_path,
      sandbox_backend: unrestricted
        ? 'direct_host_unrestricted'
        : unsandboxed
          ? 'unsandboxed'
          : shell.sandbox_backend,
      sandbox_available: sandboxAvailable,
      shell_kind: shell.shell_kind,
      shell_invocation: shell.invocation,
      output_encoding: shell.output_encoding,
      non_interactive: true,
      pty_available: false,
      persistent_shell_session: false,
      network_default: unsandboxed ? 'allow' : 'deny',
      runtime_roots_enforced: !unsandboxed,
      execution_supported: shell.execution_supported,
      requires_approval_before_execute: requiresApprovalBeforeExecute,
      approval_flow: 'backend_managed',
      submit_execute_directly: !blocked,
    };
  }

  async execute(call: ToolCall, ctx: ShellPreflightContext): Promise<ToolResultInfo> {
    const start = performance.now();
    const redactedArguments = redactToolArgumentsForDisplay(call.name, call.arguments);

    ctx.emitToolCallStart?.(call.name, redactedArguments, call.id);

    let output: JsonObject;
    try {
      output = await this.executePreflight(call.arguments, ctx);
    } catch (error) {
      const durationMs = Math.trunc(performance.now() - start);
      const message = messageOf(error);
      ctx.emitToolCallError?.(message);
      const failed = failureResult(
        call.id,
        ctx.blockId ?? null,
        call.name,
        redactedArguments,
        message,
        durationMs,
      );
      this.saveToolBlock(ctx, failed);
      return failed;
    }

    const durationMs = Math.trunc(performance.now() - start);
    ctx.emitToolCallEnd?.({ result: output, durationMs });
    const succeeded = successResult(
      call.id,
      ctx.blockId ?? null,
      call.name,
      redactedArguments,
      output,
      durationMs,
    );
    this.saveToolBlock(ctx, succeeded);
    return succeeded;
  }

  private saveToolBlock(ctx: ShellPreflightContext, result: ToolResultInfo): void {
    if (!ctx.saveToolBlock) return;
    try {
      ctx.saveToolBlock(result);
    } catch (error) {
      ctx.warn?.(`[LocalShellPreflightExecutor] Failed to save tool block: ${ioMessage(error)}`);
    }
  }
}

export const localShellPreflightExecutor = new LocalShellPreflightExecutor();
