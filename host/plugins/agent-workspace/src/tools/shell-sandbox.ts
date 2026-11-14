/**
 * `chat_v2/tools/shell_sandbox.rs` 的 TS 移植：沙箱策略、能力探测、平台契约、
 * macOS Seatbelt profile / Linux bubblewrap 参数构造与 effect report。
 *
 * 与原实现的差异仅限于"进程"层：TS 侧不 spawn 任何真实 shell（本 lane 不注册
 * shell 执行器），`command()` 返回可执行的命令描述符 `{ program, args, cwd }`，
 * 由宿主绑定到实际进程通道。参数向量、顺序、错误文案、limits 与 Rust 一致。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ACTIVE_PROCESS_LIMIT,
  PROCESS_CPU_TIME_LIMIT_SECS,
  HELPER_ARG,
  PROFILE_PREFIX,
  UNSANDBOXED_PROFILE_PREFIX,
  cleanupWindowsPayloadFile,
  gitInstallRootFromBash,
  payloadPathFromCommand,
  powershellKind,
  trustedGitBashPath,
  trustedPowerShellPath,
  trustedPowerShellPaths,
  windowsHasGitBash,
  windowsNativeSandboxAvailable,
  writeWindowsPayload,
} from './shell-sandbox-windows.ts';
import type { WindowsSandboxPayload } from './shell-sandbox-windows.ts';
import type { HostShellExecutionMode } from './shell-authority.ts';
import { ioMessage } from '../runtime-paths.ts';

export const SANDBOX_CPU_TIME_LIMIT_SECS = 130;
export const SANDBOX_FILE_SIZE_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
// RLIMIT_NPROC 在 macOS 上是按用户而非按进程树；保持足够高的上限，
// 同时仍阻止无界 fork 风暴。
export const SANDBOX_PROCESS_LIMIT = 2_048;

export interface SandboxPolicy {
  readable_roots: string[];
  writable_roots: string[];
  protected_read_roots: string[];
  protected_write_roots: string[];
  /** Linux only: 用空 tmpfs 替换宿主根，只重挂可信系统运行时与 policy roots。 */
  restrict_read_to_roots: boolean;
  allow_network: boolean;
}

export function sandboxPolicy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    readable_roots: overrides.readable_roots ?? [],
    writable_roots: overrides.writable_roots ?? [],
    protected_read_roots: overrides.protected_read_roots ?? [],
    protected_write_roots: overrides.protected_write_roots ?? [],
    restrict_read_to_roots: overrides.restrict_read_to_roots ?? false,
    allow_network: overrides.allow_network ?? false,
  };
}

/** `SandboxCapability`（Rust 为 externally tagged enum，这里保留可判别形状）。 */
export type SandboxCapability =
  | { available: true }
  | { available: false; reason: string };

export function capabilityAvailable(capability: SandboxCapability): boolean {
  return capability.available;
}

/** `SandboxEffectReport`（serde 字段名逐字保留）。 */
export interface SandboxEffectReport {
  backend: string;
  shell_kind: string;
  output_encoding: string;
  enforced: boolean;
  network_enforced: boolean;
  process_group_isolated: boolean;
  cpu_time_limit_seconds: number | null;
  file_size_limit_bytes: number | null;
  active_process_limit: number | null;
  readable_roots: number;
  writable_roots: number;
  protected_read_roots: number;
  protected_write_roots: number;
}

export interface SandboxRuntimeContract {
  backend: string;
  shell_kind: string;
  output_encoding: string;
}

export function platformSandboxContract(platform: NodeJS.Platform = process.platform): SandboxRuntimeContract {
  if (platform === 'darwin') {
    return { backend: 'macos_seatbelt', shell_kind: 'posix_sh', output_encoding: 'utf-8' };
  }
  if (platform === 'win32') {
    return { backend: 'windows_appcontainer_job', shell_kind: 'windows_powershell', output_encoding: 'utf-8' };
  }
  if (platform === 'linux') {
    return { backend: 'linux_bwrap', shell_kind: 'posix_sh', output_encoding: 'utf-8' };
  }
  // 其余平台（含 Android，其 target_os 不是 "linux"）保持 fail-closed。
  return { backend: 'unavailable', shell_kind: 'unavailable', output_encoding: 'unknown' };
}

/** `Command` 的可序列化替身；宿主负责 spawn 与 stdio 配置（stdin null、stdout/stderr piped）。 */
export interface SandboxCommand {
  program: string;
  args: string[];
  cwd: string;
}

export interface SandboxBackend {
  capability(): SandboxCapability;
  command(shellCommand: string, cwd: string, policy: SandboxPolicy): SandboxCommand;
  commandForGit(shellCommand: string, cwd: string, policy: SandboxPolicy): SandboxCommand;
  effectReport(policy: SandboxPolicy): SandboxEffectReport;
  effectReportForGit(policy: SandboxPolicy): SandboxEffectReport;
  /** Rust 默认实现为空操作；Windows/Seatbelt 后端释放 profile/payload 资源。 */
  cleanupCommandResources?(command: SandboxCommand): void;
}

function rootCounts(policy: SandboxPolicy): Pick<
  SandboxEffectReport,
  'readable_roots' | 'writable_roots' | 'protected_read_roots' | 'protected_write_roots'
> {
  return {
    readable_roots: policy.readable_roots.length,
    writable_roots: policy.writable_roots.length,
    protected_read_roots: policy.protected_read_roots.length,
    protected_write_roots: policy.protected_write_roots.length,
  };
}

function sandboxCommand(program: string, args: string[], cwd: string): SandboxCommand {
  return { program, args, cwd };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function exists(target: string): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}

// ============================================================ macOS Seatbelt

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const PROFILE_FILE_PREFIX = 'deep-student-seatbelt-';
export const STALE_PROFILE_AGE_MS = 24 * 60 * 60 * 1000;

export function cleanupStaleProfileFiles(
  tempDirectory: string = os.tmpdir(),
  now: number = Date.now(),
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tempDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (!name.startsWith(PROFILE_FILE_PREFIX) || !name.endsWith('.sb')) continue;
    const target = path.join(tempDirectory, name);
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(target);
      // boundary-allow empty-catch: Rust 清理陈旧 profile 时忽略 lstat 失败并继续
    } catch {
      continue;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    if (now - metadata.mtimeMs >= STALE_PROFILE_AGE_MS) {
      try {
        fs.unlinkSync(target);
        // boundary-allow empty-catch: 清理失败不影响新 profile 的创建（Rust 同样忽略）
      } catch (error) {
        void error;
      }
    }
  }
}

export function writeProfileFile(contents: string, tempDirectory: string = os.tmpdir()): string {
  cleanupStaleProfileFiles(tempDirectory);
  const target = path.join(tempDirectory, `${PROFILE_FILE_PREFIX}${randomUUID().replaceAll('-', '')}.sb`);
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, 'wx', 0o600);
  } catch (error) {
    throw new Error(`Failed to create macOS Seatbelt profile: ${ioMessage(error)}`);
  }
  try {
    try {
      fs.fchmodSync(descriptor, 0o600);
    } catch (error) {
      throw new Error(`Failed to secure macOS Seatbelt profile: ${ioMessage(error)}`);
    }
    try {
      fs.writeFileSync(descriptor, contents, { encoding: 'utf8' });
      fs.fsyncSync(descriptor);
    } catch (error) {
      throw new Error(`Failed to persist macOS Seatbelt profile: ${ioMessage(error)}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return target;
}

export function profilePathFromCommand(command: SandboxCommand): string | null {
  for (let index = 0; index < command.args.length; index += 1) {
    if (command.args[index] === '-f') {
      return command.args[index + 1] ?? null;
    }
  }
  return null;
}

export function cleanupProfileFile(command: SandboxCommand, tempDirectory: string = os.tmpdir()): void {
  const profilePath = profilePathFromCommand(command);
  if (profilePath === null) return;
  const name = path.basename(profilePath);
  if (path.dirname(profilePath) === tempDirectory
    && name.startsWith(PROFILE_FILE_PREFIX)
    && name.endsWith('.sb')) {
    try {
      fs.unlinkSync(profilePath);
      // boundary-allow empty-catch: Rust 清理 profile 时忽略 unlink 失败
    } catch (error) {
      // 文件可能已被清理；忽略。
      void error;
    }
  }
}

export function seatbeltLiteral(target: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(target);
  } catch (error) {
    throw new Error(`Failed to canonicalize sandbox policy path '${target}': ${ioMessage(error)}`);
  }
  const escaped = canonical.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${escaped}"`;
}

export function subpathRule(operation: string, target: string): string {
  return `(${operation} (subpath ${seatbeltLiteral(target)}))`;
}

export function literalRule(operation: string, target: string): string {
  return `(${operation} (literal "${target}"))`;
}

/**
 * Read-only access to the existing global git config files for the fixed semantic Git commands.
 * Appended after the policy so it also overrides the protected ~/.config deny for git/config only.
 */
export function gitGlobalConfigReadRules(home: string, xdgConfigHome: string | undefined): string[] {
  if (home === '') return [];
  const candidates = [path.join(home, '.gitconfig'), path.join(home, '.config', 'git', 'config')];
  if (xdgConfigHome !== undefined && path.isAbsolute(xdgConfigHome)) candidates.push(path.join(xdgConfigHome, 'git', 'config'));
  const rules = new Set<string>();
  for (const file of candidates) {
    try { if (!fs.statSync(file).isFile()) continue; }
    catch { continue; }
    rules.add(`(allow file-read* (literal ${seatbeltLiteral(file)}))`);
  }
  return [...rules];
}

export function seatbeltProfile(policy: SandboxPolicy): string {
  const rules: string[] = [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process*)',
    '(allow signal (target self))',
    '(allow signal (target children))',
    '(allow sysctl-read)',
    '(deny mach-lookup)',
    '(allow file-read-metadata)',
  ];

  for (const systemPath of ['/System', '/usr', '/bin', '/sbin', '/Library/Apple']) {
    rules.push(`(allow file-read* (subpath "${systemPath}"))`);
  }
  for (const systemPath of [
    '/private/etc',
    '/private/var/db/timezone',
    '/dev/null',
    '/dev/zero',
    '/dev/random',
    '/dev/urandom',
  ]) {
    rules.push(systemPath.startsWith('/dev/')
      ? literalRule('allow file-read*', systemPath)
      : `(allow file-read* (subpath "${systemPath}"))`);
  }

  for (const root of policy.readable_roots) {
    rules.push(subpathRule('allow file-read*', root));
  }
  for (const root of policy.writable_roots) {
    rules.push(subpathRule('allow file-read*', root));
    rules.push(subpathRule('allow file-write*', root));
  }
  for (const root of policy.protected_write_roots) {
    if (exists(root)) rules.push(subpathRule('deny file-write*', root));
  }
  for (const root of policy.protected_read_roots) {
    if (exists(root)) rules.push(subpathRule('deny file-read*', root));
  }

  rules.push(policy.allow_network ? '(allow network*)' : '(deny network*)');
  return rules.join('\n');
}

export class MacOsSandboxBackend implements SandboxBackend {
  private readonly tempDirectory: string;

  constructor(tempDirectory: string = os.tmpdir()) {
    this.tempDirectory = tempDirectory;
  }

  capability(): SandboxCapability {
    try {
      const metadata = fs.statSync(SANDBOX_EXEC);
      if (metadata.isFile()) return { available: true };
      return { available: false, reason: `${SANDBOX_EXEC} is not a regular file` };
    } catch (error) {
      return { available: false, reason: `macOS Seatbelt launcher is unavailable: ${ioMessage(error)}` };
    }
  }

  command(shellCommand: string, cwd: string, policy: SandboxPolicy): SandboxCommand {
    const capability = this.capability();
    if (capability.available === false) {
      throw new Error(`Local shell sandbox is unavailable; refusing unsandboxed execution: ${capability.reason}`);
    }
    const profile = seatbeltProfile(policy);
    const profilePath = writeProfileFile(profile, this.tempDirectory);
    return sandboxCommand(SANDBOX_EXEC, ['-f', profilePath, '/bin/sh', '-c', shellCommand], cwd);
  }

  commandForGit(shellCommand: string, cwd: string, policy: SandboxPolicy): SandboxCommand {
    const capability = this.capability();
    if (capability.available === false) {
      throw new Error(`Local shell sandbox is unavailable; refusing unsandboxed execution: ${capability.reason}`);
    }
    // RUST-FIX(RF-S01-macos-git-global-config-denied): Rust's (deny default) profile hides ~/.gitconfig, and git aborts on that EPERM, so every git_* tool failed on macOS
    const profile = [seatbeltProfile(policy), ...gitGlobalConfigReadRules(os.homedir(), process.env['XDG_CONFIG_HOME'])].join('\n');
    const profilePath = writeProfileFile(profile, this.tempDirectory);
    return sandboxCommand(SANDBOX_EXEC, ['-f', profilePath, '/bin/sh', '-c', shellCommand], cwd);
  }

  cleanupCommandResources(command: SandboxCommand): void {
    cleanupProfileFile(command, this.tempDirectory);
  }

  effectReport(policy: SandboxPolicy): SandboxEffectReport {
    return {
      backend: 'macos_seatbelt',
      shell_kind: 'posix_sh',
      output_encoding: 'utf-8',
      enforced: this.capability().available,
      network_enforced: true,
      process_group_isolated: true,
      cpu_time_limit_seconds: SANDBOX_CPU_TIME_LIMIT_SECS,
      file_size_limit_bytes: SANDBOX_FILE_SIZE_LIMIT_BYTES,
      active_process_limit: SANDBOX_PROCESS_LIMIT,
      ...rootCounts(policy),
    };
  }

  effectReportForGit(policy: SandboxPolicy): SandboxEffectReport {
    return this.effectReport(policy);
  }
}

// ============================================================ Linux bubblewrap

/** 发行版包管理器安装 bwrap 后的常见落点；再回退到 PATH 逐目录查找（不经 shell）。 */
export const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'] as const;

export function locateBwrap(environmentPath: string | undefined = process.env['PATH']): string {
  for (const candidate of BWRAP_CANDIDATES) {
    if (isFile(candidate)) return candidate;
  }
  if (environmentPath !== undefined) {
    for (const directory of environmentPath.split(path.delimiter)) {
      if (directory === '' || !path.isAbsolute(directory)) continue;
      const candidate = path.join(directory, 'bwrap');
      if (isFile(candidate)) return candidate;
    }
  }
  throw new Error(
    "Linux bubblewrap launcher (bwrap) was not found; install the 'bubblewrap' package to enable the local shell sandbox",
  );
}

export function canonicalPolicyPath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch (error) {
    throw new Error(`Failed to canonicalize sandbox policy path '${target}': ${ioMessage(error)}`);
  }
}

/**
 * 构造 bwrap 参数向量。bwrap 按顺序处理挂载，后面的挂载覆盖前面的，顺序即语义。
 */
export function bwrapArgs(shellCommand: string, cwd: string, policy: SandboxPolicy): string[] {
  const args: string[] = [];
  if (policy.restrict_read_to_roots) {
    // 不得从只读 "/" 起步：那会令"仅 job 目录可读"的脚本策略退化为可读整台主机。
    args.push('--tmpfs', '/');
    for (const systemRoot of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']) {
      if (exists(systemRoot)) args.push('--ro-bind', systemRoot, systemRoot);
    }
  } else {
    args.push('--ro-bind', '/', '/');
  }
  args.push('--dev', '/dev', '--proc', '/proc');

  if (policy.restrict_read_to_roots) {
    for (const root of policy.readable_roots) {
      const canonical = canonicalPolicyPath(root);
      args.push('--ro-bind', canonical, canonical);
    }
  }
  for (const root of policy.writable_roots) {
    const canonical = canonicalPolicyPath(root);
    args.push('--bind', canonical, canonical);
  }
  for (const root of policy.protected_write_roots) {
    if (!exists(root)) continue;
    const canonical = canonicalPolicyPath(root);
    args.push('--ro-bind', canonical, canonical);
  }
  for (const root of policy.protected_read_roots) {
    if (!exists(root)) continue;
    const canonical = canonicalPolicyPath(root);
    if (isDirectory(canonical)) {
      args.push('--tmpfs', canonical);
    } else {      // tmpfs 只能挂在目录上；文件型敏感路径用 /dev/null 覆盖 bind。
      args.push('--ro-bind', '/dev/null', canonical);
    }
  }

  if (!policy.allow_network) args.push('--unshare-net');
  args.push('--unshare-pid');
  args.push('--die-with-parent');
  // --new-session 隔离控制终端，封堵 TIOCSTI 注入宿主终端输入的路径。
  args.push('--new-session');
  args.push('--chdir', cwd);
  args.push('/bin/sh', '-c', shellCommand);
  return args;
}

export class LinuxSandboxBackend implements SandboxBackend {
  private readonly environmentPath: string | undefined;

  constructor(environmentPath: string | undefined = process.env['PATH']) {
    this.environmentPath = environmentPath;
  }

  capability(): SandboxCapability {
    try {
      locateBwrap(this.environmentPath);
      return { available: true };
    } catch (error) {
      return { available: false, reason: messageOf(error) };
    }
  }

  command(shellCommand: string, cwd: string, policy: SandboxPolicy): SandboxCommand {
    let bwrap: string;
    try {
      bwrap = locateBwrap(this.environmentPath);
    } catch (error) {
      throw new Error(`Local shell sandbox is unavailable; refusing unsandboxed execution: ${messageOf(error)}`);
    }
    return sandboxCommand(bwrap, bwrapArgs(shellCommand, cwd, policy), cwd);
  }

  commandForGit(shellCommand: string, cwd: string, policy: SandboxPolicy): SandboxCommand {
    return this.command(shellCommand, cwd, policy);
  }

  effectReport(policy: SandboxPolicy): SandboxEffectReport {
    return {
      backend: 'linux_bwrap',
      shell_kind: 'posix_sh',
      output_encoding: 'utf-8',
      enforced: this.capability().available,
      network_enforced: true,
      process_group_isolated: true,
      cpu_time_limit_seconds: SANDBOX_CPU_TIME_LIMIT_SECS,
      file_size_limit_bytes: SANDBOX_FILE_SIZE_LIMIT_BYTES,
      active_process_limit: SANDBOX_PROCESS_LIMIT,
      ...rootCounts(policy),
    };
  }

  effectReportForGit(policy: SandboxPolicy): SandboxEffectReport {
    return this.effectReport(policy);
  }
}

// ============================================================ fail-closed 平台

export class UnavailableSandboxBackend implements SandboxBackend {
  capability(): SandboxCapability {
    return {
      available: false,
      reason: 'No hard local-shell sandbox backend is implemented for this platform',
    };
  }

  command(): SandboxCommand {
    throw new Error('Local shell sandbox is unavailable; refusing unsandboxed execution');
  }

  commandForGit(): SandboxCommand {
    throw new Error('Local shell sandbox is unavailable; refusing unsandboxed execution');
  }

  effectReport(policy: SandboxPolicy): SandboxEffectReport {
    return {
      backend: 'unavailable',
      shell_kind: 'unavailable',
      output_encoding: 'unknown',
      enforced: false,
      network_enforced: false,
      process_group_isolated: false,
      cpu_time_limit_seconds: null,
      file_size_limit_bytes: null,
      active_process_limit: null,
      ...rootCounts(policy),
    };
  }

  effectReportForGit(policy: SandboxPolicy): SandboxEffectReport {
    return this.effectReport(policy);
  }
}

// ============================================================ Windows 平台后端

function win32Parent(target: string): string | null {
  const parsed = path.win32.parse(target);
  if (parsed.root === target) return null;
  return path.win32.dirname(target);
}

function clonePolicy(policy: SandboxPolicy): SandboxPolicy {
  return {
    readable_roots: [...policy.readable_roots],
    writable_roots: [...policy.writable_roots],
    protected_read_roots: [...policy.protected_read_roots],
    protected_write_roots: [...policy.protected_write_roots],
    restrict_read_to_roots: policy.restrict_read_to_roots,
    allow_network: policy.allow_network,
  };
}

function trustedPowerShellPathOrNull(): string | null {
  try {
    return trustedPowerShellPath();
  } catch {
    return null;
  }
}

function windowsShellKind(): string {
  const powershell = trustedPowerShellPathOrNull();
  return powershell === null ? 'windows_powershell' : powershellKind(powershell);
}

/**
 * Both Windows backends re-exec the app with HELPER_ARG. Without the native runtime nothing
 * handles that argument: the child exits 0 as a second instance and the command never runs.
 */
const WINDOWS_HELPER_UNAVAILABLE =
  'The Windows shell helper (AppContainer and Job Object native runtime) is not available in this build';

/**
 * Windows AppContainer + Job Object 后端。native 部分（profile/ACL/Job/进程创建）
 * 需要 F7 原生运行时；本移植只负责 payload 生命周期与契约字段。
 */
export class WindowsPlatformSandboxBackend implements SandboxBackend {
  private readonly currentExecutable: string;
  private readonly helperAvailable: () => boolean;

  constructor(currentExecutable: string = process.execPath, helperAvailable: () => boolean = windowsNativeSandboxAvailable) {
    this.currentExecutable = currentExecutable;
    this.helperAvailable = helperAvailable;
  }

  capability(): SandboxCapability {
    if (!this.helperAvailable()) return { available: false, reason: WINDOWS_HELPER_UNAVAILABLE };
    try {
      const metadata = fs.statSync(this.currentExecutable);
      if (metadata.isFile()) return { available: true };
      return { available: false, reason: 'The current executable is not a regular file' };
    } catch (error) {
      return { available: false, reason: `Cannot locate the AppContainer launcher: ${ioMessage(error)}` };
    }
  }

  private payloadCommand(payload: WindowsSandboxPayload): SandboxCommand {
    const payloadPath = writeWindowsPayload(payload);
    return sandboxCommand(this.currentExecutable, [HELPER_ARG, payloadPath], path.dirname(payloadPath));
  }

  command(shellCommand: string, cwd: string, policy: SandboxPolicy): SandboxCommand {
    const capability = this.capability();
    if (capability.available === false) {
      throw new Error(`Local shell sandbox is unavailable; refusing unsandboxed execution: ${capability.reason}`);
    }
    const shellPaths = trustedPowerShellPaths();
    const shellPath = shellPaths[0];
    if (shellPath === undefined) throw new Error('No trusted PowerShell executable is available');
    const fallbackShellPath = shellPaths[1] ?? null;
    const effectivePolicy = clonePolicy(policy);
    for (const parent of [win32Parent(shellPath), fallbackShellPath === null ? null : win32Parent(fallbackShellPath)]) {
      if (parent !== null) effectivePolicy.readable_roots.push(parent);
    }
    return this.payloadCommand({
      command: shellCommand,
      cwd,
      policy: effectivePolicy,
      profile_name: `${PROFILE_PREFIX}${randomUUID().replaceAll('-', '')}`,
      prefer_git_bash: false,
      shell_path: shellPath,
      fallback_shell_path: fallbackShellPath,
    });
  }

  commandForGit(shellCommand: string, cwd: string, policy: SandboxPolicy): SandboxCommand {
    const capability = this.capability();
    if (capability.available === false) {
      throw new Error(`Local shell sandbox is unavailable; refusing unsandboxed execution: ${capability.reason}`);
    }
    const gitBash = trustedGitBashPath();
    const preferGitBash = gitBash !== null;
    let shellPath: string;
    let fallbackShellPath: string | null;
    if (gitBash !== null) {
      shellPath = gitBash;
      fallbackShellPath = null;
    } else {
      const shellPaths = trustedPowerShellPaths();
      const first = shellPaths[0];
      if (first === undefined) throw new Error('No trusted PowerShell executable is available');
      shellPath = first;
      fallbackShellPath = shellPaths[1] ?? null;
    }
    const effectivePolicy = clonePolicy(policy);
    if (preferGitBash) {
      const root = gitInstallRootFromBash(shellPath);
      if (root !== null) effectivePolicy.readable_roots.push(root);
    } else {
      for (const parent of [win32Parent(shellPath), fallbackShellPath === null ? null : win32Parent(fallbackShellPath)]) {
        if (parent !== null) effectivePolicy.readable_roots.push(parent);
      }
    }
    return this.payloadCommand({
      command: shellCommand,
      cwd,
      policy: effectivePolicy,
      profile_name: `${PROFILE_PREFIX}${randomUUID().replaceAll('-', '')}`,
      prefer_git_bash: preferGitBash,
      shell_path: shellPath,
      fallback_shell_path: fallbackShellPath,
    });
  }

  cleanupCommandResources(command: SandboxCommand): void {
    const payloadPath = payloadPathFromCommand(command);
    if (payloadPath !== null) cleanupWindowsPayloadFile(payloadPath);
  }

  effectReport(policy: SandboxPolicy): SandboxEffectReport {
    return {
      backend: 'windows_appcontainer_job',
      shell_kind: windowsShellKind(),
      output_encoding: 'utf-8',
      enforced: this.capability().available,
      network_enforced: true,
      process_group_isolated: true,
      cpu_time_limit_seconds: PROCESS_CPU_TIME_LIMIT_SECS,
      file_size_limit_bytes: null,
      active_process_limit: ACTIVE_PROCESS_LIMIT,
      ...rootCounts(policy),
    };
  }

  effectReportForGit(policy: SandboxPolicy): SandboxEffectReport {
    const report = this.effectReport(policy);
    if (trustedGitBashPath() !== null) report.shell_kind = 'git_bash';
    return report;
  }
}

// ============================================================ 完全信任通道

export class UnsandboxedShellBackend implements SandboxBackend {
  private readonly platform: NodeJS.Platform;
  private readonly windowsHelperAvailable: () => boolean;

  constructor(platform: NodeJS.Platform = process.platform, windowsHelperAvailable: () => boolean = windowsNativeSandboxAvailable) {
    this.platform = platform;
    this.windowsHelperAvailable = windowsHelperAvailable;
  }

  private windowsCapability(): SandboxCapability {
    if (!this.windowsHelperAvailable()) return { available: false, reason: WINDOWS_HELPER_UNAVAILABLE };
    let helperIsFile: boolean;
    try {
      helperIsFile = fs.statSync(process.execPath).isFile();
    } catch (error) {
      return { available: false, reason: `Cannot locate the Windows Job Object helper: ${ioMessage(error)}` };
    }
    if (!helperIsFile) {
      return { available: false, reason: 'The current executable is not a regular file' };
    }
    try {
      trustedPowerShellPath();
      return { available: true };
    } catch (error) {
      return { available: false, reason: messageOf(error) };
    }
  }

  capability(): SandboxCapability {
    if (this.platform === 'win32') return this.windowsCapability();
    // Rust `cfg(unix)` 覆盖 darwin/linux/bsd/android 等全部非 Windows 目标。
    try {
      const metadata = fs.statSync('/bin/sh');
      if (metadata.isFile()) return { available: true };
      return { available: false, reason: '/bin/sh is not a regular file' };
    } catch (error) {
      return { available: false, reason: `/bin/sh is unavailable: ${ioMessage(error)}` };
    }
  }

  private windowsCommand(shellCommand: string, cwd: string, policy: SandboxPolicy): SandboxCommand {
    const shellPaths = trustedPowerShellPaths();
    const shellPath = shellPaths[0];
    if (shellPath === undefined) throw new Error('No trusted PowerShell executable is available');
    const payloadPath = writeWindowsPayload({
      command: shellCommand,
      cwd,
      policy: clonePolicy(policy),
      profile_name: `${UNSANDBOXED_PROFILE_PREFIX}${randomUUID().replaceAll('-', '')}`,
      prefer_git_bash: false,
      shell_path: shellPath,
      fallback_shell_path: shellPaths[1] ?? null,
    });
    return sandboxCommand(process.execPath, [HELPER_ARG, payloadPath], path.dirname(payloadPath));
  }

  private windowsCommandForGit(shellCommand: string, cwd: string, policy: SandboxPolicy): SandboxCommand {
    const gitBash = trustedGitBashPath();
    const preferGitBash = gitBash !== null;
    let shellPath: string;
    let fallbackShellPath: string | null;
    if (gitBash !== null) {
      shellPath = gitBash;
      fallbackShellPath = null;
    } else {
      const shellPaths = trustedPowerShellPaths();
      const first = shellPaths[0];
      if (first === undefined) throw new Error('No trusted PowerShell executable is available');
      shellPath = first;
      fallbackShellPath = shellPaths[1] ?? null;
    }
    const payloadPath = writeWindowsPayload({
      command: shellCommand,
      cwd,
      policy: clonePolicy(policy),
      profile_name: `${UNSANDBOXED_PROFILE_PREFIX}${randomUUID().replaceAll('-', '')}`,
      prefer_git_bash: preferGitBash,
      shell_path: shellPath,
      fallback_shell_path: fallbackShellPath,
    });
    return sandboxCommand(process.execPath, [HELPER_ARG, payloadPath], path.dirname(payloadPath));
  }

  command(shellCommand: string, cwd: string, policy: SandboxPolicy): SandboxCommand {
    const capability = this.capability();
    if (capability.available === false) {
      throw new Error(`Full Access shell backend is unavailable: ${capability.reason}`);
    }
    if (this.platform === 'win32') return this.windowsCommand(shellCommand, cwd, policy);
    return sandboxCommand('/bin/sh', ['-c', shellCommand], cwd);
  }

  commandForGit(shellCommand: string, cwd: string, policy: SandboxPolicy): SandboxCommand {
    const capability = this.capability();
    if (capability.available === false) {
      throw new Error(`Full Access shell backend is unavailable: ${capability.reason}`);
    }
    if (this.platform === 'win32') return this.windowsCommandForGit(shellCommand, cwd, policy);
    return this.command(shellCommand, cwd, policy);
  }

  cleanupCommandResources(command: SandboxCommand): void {
    if (this.platform !== 'win32') return;
    const payloadPath = payloadPathFromCommand(command);
    if (payloadPath !== null) cleanupWindowsPayloadFile(payloadPath);
  }

  effectReport(policy: SandboxPolicy): SandboxEffectReport {
    if (this.platform === 'win32') {
      return {
        backend: 'unsandboxed_job',
        shell_kind: windowsShellKind(),
        output_encoding: 'utf-8',
        enforced: false,
        network_enforced: false,
        process_group_isolated: true,
        // 完全信任通道的 Job 仅设置 KILL_ON_JOB_CLOSE，不施加资源限制。
        cpu_time_limit_seconds: null,
        file_size_limit_bytes: null,
        active_process_limit: null,
        ...rootCounts(policy),
      };
    }
    return {
      backend: 'unsandboxed',
      shell_kind: 'posix_sh',
      output_encoding: 'utf-8',
      enforced: false,
      network_enforced: false,
      process_group_isolated: true,
      cpu_time_limit_seconds: null,
      file_size_limit_bytes: null,
      active_process_limit: null,
      ...rootCounts(policy),
    };
  }

  effectReportForGit(policy: SandboxPolicy): SandboxEffectReport {
    const report = this.effectReport(policy);
    if (this.platform === 'win32' && trustedGitBashPath() !== null) report.shell_kind = 'git_bash';
    return report;
  }
}

// ============================================================ 后端选择

export function createPlatformSandboxBackend(platform: NodeJS.Platform = process.platform): SandboxBackend {
  if (platform === 'darwin') return new MacOsSandboxBackend();
  if (platform === 'linux') return new LinuxSandboxBackend();
  if (platform === 'win32') return new WindowsPlatformSandboxBackend();
  return new UnavailableSandboxBackend();
}

export function createUnsandboxedBackend(platform: NodeJS.Platform = process.platform): SandboxBackend {
  return new UnsandboxedShellBackend(platform);
}

/** `local_shell_execute_executor.rs:1952-1968`: the backend for a session's host shell execution mode. */
export function shellBackendForExecutionMode(mode: HostShellExecutionMode, platform: NodeJS.Platform = process.platform): SandboxBackend {
  if (mode === 'sandboxed') return createPlatformSandboxBackend(platform);
  // RUST-FIX(RF-S01-windows-unrestricted-job-backend): Rust runs Windows `unrestricted` through an in-process DirectHostShellBackend (backend `direct_host_unrestricted`); Node cannot create a suspended child itself, so it keeps the helper's kill-on-close Job backend (`unsandboxed_job`), which binds the Job before the shell runs just the same
  return createUnsandboxedBackend(platform);
}

/** 便于调用方在 spawn 前做与 Rust `configure_stdio` 相同的 stdio 约定。 */
export function configureStdio(command: SandboxCommand): SandboxCommand & {
  stdin: 'ignore';
  stdout: 'pipe';
  stderr: 'pipe';
  kill_on_drop: true;
} {
  return { ...command, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', kill_on_drop: true };
}

/** `maybe_run_helper` 的入口判定（Windows helper payload 协议）。 */
export function isWindowsShellHelperInvocation(argv: readonly string[]): boolean {
  return argv[1] === HELPER_ARG;
}

export { windowsHasGitBash };
