/**
 * `chat_v2/tools/shell_sandbox/windows.rs` 的 TS 移植（纯契约部分）。
 *
 * 已移植：payload 校验/序列化/生命周期、Windows 路径比较、PowerShell /
 * git-bash 命令行构造、Job Object limits、取消事件与 helper 协议编排。
 *
 * F7 原生缺口（不伪造）：AppContainer profile、ACL 保护/授权、Job Object
 * 创建与绑定、进程创建（CreateProcessW）都需要原生运行时；本 host 不提供
 * 这些接口，`requireWindowsSandboxRuntime()` 会明确报错而不是假装成功。
 * 因此依赖真实 AppContainer 的测试在非 Windows（以及当前 TS host）上跳过。
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SandboxCommand, SandboxPolicy } from './shell-sandbox.ts';

export const HELPER_ARG = '--deep-student-shell-sandbox-helper';
export const PAYLOAD_PREFIX = 'deep-student-shell-sandbox-';
export const PROFILE_PREFIX = 'DeepStudent.LocalShell.';
export const UNSANDBOXED_PROFILE_PREFIX = 'DeepStudent.DangerShell.';
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
export const MAX_POLICY_ROOTS = 128;
export const ACTIVE_PROCESS_LIMIT = 128;
export const PROCESS_CPU_TIME_LIMIT_SECS = 130;
export const STALE_PAYLOAD_AGE_MS = 24 * 60 * 60 * 1000;

export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
export const JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x0000_0008;
export const JOB_OBJECT_LIMIT_PROCESS_TIME = 0x0000_0002;

export interface WindowsSandboxPayload {
  command: string;
  cwd: string;
  policy: SandboxPolicy;
  profile_name: string;
  prefer_git_bash: boolean;
  shell_path: string | null;
  fallback_shell_path: string | null;
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

function exists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

export function jobName(pid: number): string {
  return `Local\\DeepStudentShellJob-${pid}`;
}

export function cancellationName(pid: number): string {
  return `Local\\DeepStudentShellCancel-${pid}`;
}

/** `windows_comparable_path_text`（dstu-vfs/pdf_protocol.rs）。 */
export function windowsComparablePathText(target: string): string {
  const unified = target.replaceAll('/', '\\');
  let stripped: string;
  if (unified.startsWith('\\\\?\\UNC\\')) {
    stripped = `\\\\${unified.slice('\\\\?\\UNC\\'.length)}`;
  } else if (unified.startsWith('\\\\?\\')) {
    stripped = unified.slice('\\\\?\\'.length);
  } else {
    stripped = unified;
  }
  return stripped.replace(/\\+$/u, '').toLowerCase();
}

export function windowsPathsEqual(left: string, right: string): boolean {
  return windowsComparablePathText(left) === windowsComparablePathText(right);
}

export function canonicalPolicyPath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch (error) {
    throw new Error(`Failed to canonicalize Windows sandbox path: ${messageOf(error)}`);
  }
}

// ------------------------------------------------------------------ payload

function normalizePolicy(policy: SandboxPolicy): SandboxPolicy {
  return {
    readable_roots: [...policy.readable_roots],
    writable_roots: [...policy.writable_roots],
    protected_read_roots: [...policy.protected_read_roots],
    protected_write_roots: [...policy.protected_write_roots],
    restrict_read_to_roots: policy.restrict_read_to_roots ?? false,
    allow_network: policy.allow_network ?? false,
  };
}

function trustedShellPathsFor(payload: WindowsSandboxPayload): string[] {
  if (payload.prefer_git_bash) {
    const bash = trustedGitBashPath();
    return bash === null ? [] : [bash];
  }
  return trustedPowerShellPaths();
}

export function validateWindowsSandboxPayload(payload: WindowsSandboxPayload): void {
  if (payload.command === '' || payload.command.includes('\0')) {
    throw new Error('Sandbox command is empty or contains NUL');
  }
  const profileName = payload.profile_name;
  if (!(profileName.startsWith(PROFILE_PREFIX) || profileName.startsWith(UNSANDBOXED_PROFILE_PREFIX))
    || Buffer.byteLength(profileName, 'utf8') > 96
    || !/^[A-Za-z0-9.]*$/u.test(profileName)) {
    throw new Error('Invalid AppContainer profile name');
  }
  const totalRoots = payload.policy.readable_roots.length
    + payload.policy.writable_roots.length
    + payload.policy.protected_read_roots.length
    + payload.policy.protected_write_roots.length;
  if (totalRoots > MAX_POLICY_ROOTS) {
    throw new Error('Windows sandbox policy has too many roots');
  }
  payload.policy = normalizePolicy(payload.policy);
  payload.cwd = canonicalPolicyPath(payload.cwd);
  let cwdMetadata: fs.Stats;
  try {
    cwdMetadata = fs.statSync(payload.cwd);
  } catch (error) {
    throw new Error(`Failed to canonicalize Windows sandbox path: ${messageOf(error)}`);
  }
  if (!cwdMetadata.isDirectory()) {
    throw new Error('Windows sandbox cwd is not a directory');
  }
  for (const field of ['shell_path', 'fallback_shell_path'] as const) {
    const selected = payload[field];
    if (selected === null) continue;
    const canonical = canonicalPolicyPath(selected);
    const trusted = trustedShellPathsFor(payload)
      .map(candidate => {
        try {
          return fs.realpathSync.native(candidate);
        } catch {
          return null;
        }
      })
      .some(candidate => candidate === canonical);
    if (!trusted) {
      throw new Error('Windows sandbox payload selected an untrusted shell path');
    }
    payload[field] = canonical;
  }
  for (const roots of [
    payload.policy.readable_roots,
    payload.policy.writable_roots,
    payload.policy.protected_read_roots,
    payload.policy.protected_write_roots,
  ]) {
    for (let index = 0; index < roots.length; index += 1) {
      roots[index] = canonicalPolicyPath(roots[index] as string);
    }
  }
  const firstWritable = payload.policy.writable_roots[0];
  if (payload.policy.writable_roots.length > 1
    || (firstWritable !== undefined && firstWritable !== payload.cwd)) {
    throw new Error('Windows sandbox may write only to its selected cwd');
  }
}

export function payloadRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const localAppData = environment['LOCALAPPDATA'];
  if (localAppData === undefined || localAppData === '') {
    throw new Error('Failed to locate LocalAppData for Windows shell payloads');
  }
  const root = path.win32.join(localAppData, 'com.deepstudent.app', 'shell-payloads');
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to create Windows shell payload directory: ${messageOf(error)}`);
  }
  try {
    return fs.realpathSync.native(root);
  } catch (error) {
    throw new Error(`Failed to resolve Windows shell payload directory: ${messageOf(error)}`);
  }
}

function payloadFile(environment: NodeJS.ProcessEnv = process.env): string {
  const file = `${PAYLOAD_PREFIX}${randomUUID().replaceAll('-', '')}.json`;
  return path.win32.join(payloadRoot(environment), file);
}

export function cleanupStalePayloads(
  environment: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): void {
  let root: string;
  try {
    root = payloadRoot(environment);
  } catch {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(PAYLOAD_PREFIX) || !entry.name.endsWith('.json')) continue;
    const target = path.win32.join(root, entry.name);
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(target);
    } catch {
      continue;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    if (now - metadata.mtimeMs >= STALE_PAYLOAD_AGE_MS) {
      try {
        fs.unlinkSync(target);
        // boundary-allow empty-catch: Rust 清理陈旧 payload 时忽略 unlink 失败
      } catch (error) {
        // 清理失败不影响后续 payload。
        void error;
      }
    }
  }
}

export function cleanupWindowsPayloadFile(
  target: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  let root: string;
  try {
    root = payloadRoot(environment);
  } catch {
    return;
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(target);
  } catch {
    return;
  }
  const name = path.win32.basename(canonical);
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(canonical);
  } catch {
    return;
  }
  if (windowsPathsEqual(path.win32.dirname(canonical), root)
    && name.startsWith(PAYLOAD_PREFIX)
    && name.endsWith('.json')
    && metadata.isFile()
    && !metadata.isSymbolicLink()) {
    try {
      fs.unlinkSync(canonical);
      // boundary-allow empty-catch: Rust 清理已消费 payload 时忽略 unlink 失败
    } catch (error) {
      // 文件可能已被消费；忽略。
      void error;
    }
  }
}

export function payloadPathFromCommand(command: SandboxCommand): string | null {
  if (command.args[0] !== HELPER_ARG) return null;
  return command.args[1] ?? null;
}

export function writeWindowsPayload(
  payload: WindowsSandboxPayload,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  cleanupStalePayloads(environment);
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new Error('Windows sandbox payload is too large');
  }
  const target = payloadFile(environment);
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, 'wx');
  } catch (error) {
    throw new Error(`Failed to create Windows sandbox payload: ${messageOf(error)}`);
  }
  try {
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } catch (error) {
      try {
        fs.unlinkSync(target);
        // boundary-allow empty-catch: 保留原始写入错误，忽略清理失败（Rust 同样忽略）
      } catch (cleanupError) {
        // 清理失败时保留原始写入错误。
        void cleanupError;
      }
      throw new Error(`Failed to persist Windows sandbox payload: ${messageOf(error)}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return target;
}

function decodeWindowsSandboxPayload(bytes: Uint8Array): WindowsSandboxPayload {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new Error(`Failed to decode Windows sandbox payload: ${messageOf(error)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Failed to decode Windows sandbox payload: expected a JSON object');
  }
  const record = value as Record<string, unknown>;
  const policyValue = record['policy'];
  if (typeof record['command'] !== 'string'
    || typeof record['cwd'] !== 'string'
    || typeof record['profile_name'] !== 'string'
    || policyValue === null || typeof policyValue !== 'object' || Array.isArray(policyValue)) {
    throw new Error('Failed to decode Windows sandbox payload: missing required fields');
  }
  const policyRecord = policyValue as Record<string, unknown>;
  const rootField = (name: string): string[] => {
    const raw = policyRecord[name];
    if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string')) {
      throw new Error(`Failed to decode Windows sandbox payload: invalid ${name}`);
    }
    return raw as string[];
  };
  const shellPath = record['shell_path'];
  const fallbackShellPath = record['fallback_shell_path'];
  return {
    command: record['command'],
    cwd: record['cwd'],
    policy: {
      readable_roots: rootField('readable_roots'),
      writable_roots: rootField('writable_roots'),
      protected_read_roots: rootField('protected_read_roots'),
      protected_write_roots: rootField('protected_write_roots'),
      restrict_read_to_roots: policyRecord['restrict_read_to_roots'] === true,
      allow_network: policyRecord['allow_network'] === true,
    },
    profile_name: record['profile_name'],
    prefer_git_bash: record['prefer_git_bash'] === true,
    shell_path: typeof shellPath === 'string' ? shellPath : null,
    fallback_shell_path: typeof fallbackShellPath === 'string' ? fallbackShellPath : null,
  };
}

export function readWindowsPayload(
  target: string,
  environment: NodeJS.ProcessEnv = process.env,
): WindowsSandboxPayload {
  // TEMP/TMP 会被重写到命令的可写 cwd，因此授权必须使用独立的 OS 根。
  const root = payloadRoot(environment);
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(target);
  } catch (error) {
    throw new Error(`Failed to resolve Windows sandbox payload: ${messageOf(error)}`);
  }
  const fileName = path.win32.basename(canonical);
  if (!windowsPathsEqual(path.win32.dirname(canonical), root)
    || !fileName.startsWith(PAYLOAD_PREFIX)
    || !fileName.endsWith('.json')) {
    throw new Error('Windows sandbox payload path is not authorized');
  }
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(canonical);
  } catch (error) {
    throw new Error(`Failed to inspect Windows sandbox payload: ${messageOf(error)}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PAYLOAD_BYTES) {
    throw new Error('Windows sandbox payload is not a safe regular file');
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(canonical);
  } catch (error) {
    throw new Error(`Failed to read Windows sandbox payload: ${messageOf(error)}`);
  }
  try {
    fs.unlinkSync(canonical);
  } catch (error) {
    throw new Error(`Failed to consume Windows sandbox payload: ${messageOf(error)}`);
  }
  return decodeWindowsSandboxPayload(bytes);
}

// ------------------------------------------------------- trusted executables

export function trustedWindowsPowerShellPath(environment: NodeJS.ProcessEnv = process.env): string {
  const systemDirectory = environment['SystemRoot'] ?? environment['windir'];
  if (systemDirectory === undefined || systemDirectory === '') {
    throw new Error('Failed to resolve the trusted Windows system directory');
  }
  const powershell = path.win32.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!isFile(powershell)) {
    throw new Error(`Trusted Windows PowerShell executable is unavailable: ${powershell}`);
  }
  return powershell;
}

export function trustedPowerShellPaths(environment: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = [];
  for (const key of ['ProgramW6432', 'ProgramFiles']) {
    const root = environment[key];
    if (root === undefined || root === '') continue;
    const pwsh = path.win32.join(root, 'PowerShell', '7', 'pwsh.exe');
    if (isFile(pwsh) && !paths.includes(pwsh)) {
      paths.push(pwsh);
      break;
    }
  }
  paths.push(trustedWindowsPowerShellPath(environment));
  return paths;
}

export function trustedPowerShellPath(environment: NodeJS.ProcessEnv = process.env): string {
  const first = trustedPowerShellPaths(environment)[0];
  if (first === undefined) throw new Error('No trusted PowerShell executable is available');
  return first;
}

export function powershellKind(target: string): string {
  return path.win32.basename(target).toLowerCase() === 'pwsh.exe'
    ? 'windows_powershell_7'
    : 'windows_powershell_5_1';
}

export function trustedGitBashPath(environment: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    const root = environment[key];
    if (root === undefined || root === '') continue;
    for (const relative of ['Git\\bin\\bash.exe', 'Git\\usr\\bin\\bash.exe']) {
      const bash = path.win32.join(root, relative);
      if (isFile(bash)) return bash;
    }
  }
  return null;
}

export function windowsHasGitBash(environment: NodeJS.ProcessEnv = process.env): boolean {
  return trustedGitBashPath(environment) !== null;
}

function win32Parent(target: string): string | null {
  const parsed = path.win32.parse(target);
  if (parsed.root === target) return null;
  return path.win32.dirname(target);
}

export function gitInstallRootFromBash(bash: string): string | null {
  const bin = win32Parent(bash);
  if (bin === null) return null;
  const parent = win32Parent(bin);
  if (parent === null) return null;
  if (path.win32.basename(parent).toLowerCase() === 'usr') return win32Parent(parent);
  return parent;
}

// ------------------------------------------------------- command line contract

export function encodedPowerShellCommand(command: string): string {
  const script = `$utf8 = [System.Text.UTF8Encoding]::new($false)\n\
try { [Console]::InputEncoding = $utf8 } catch {}\n\
try { [Console]::OutputEncoding = $utf8 } catch {}\n\
$OutputEncoding = $utf8\n\
$ProgressPreference = 'SilentlyContinue'\n\
$deepStudentShellKind = if ($PSVersionTable.PSVersion.Major -ge 6) { 'windows_powershell_7' } else { 'windows_powershell_5_1' }\n\
[Console]::Error.WriteLine('__DEEP_STUDENT_SHELL_KIND__=' + $deepStudentShellKind)\n\
$global:LASTEXITCODE = 0\n\
& {\n${command}\n}\n\
$deepStudentSucceeded = $?\n\
$deepStudentExitCode = $global:LASTEXITCODE\n\
if (-not $deepStudentSucceeded -and $deepStudentExitCode -eq 0) { exit 1 }\n\
exit $deepStudentExitCode`;
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function windowsCommandLineArg(value: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1);
      quoted += '"';
    } else {
      quoted += '\\'.repeat(backslashes);
      quoted += ch;
    }
    backslashes = 0;
  }
  quoted += '\\'.repeat(backslashes * 2);
  quoted += '"';
  return quoted;
}

export interface WindowsCommandLine {
  application: string;
  command_line: string;
}

export function windowsCommandLine(
  command: string,
  preferGitBash: boolean,
  selectedShell: string | null,
  environment: NodeJS.ProcessEnv = process.env,
): WindowsCommandLine {
  if (preferGitBash) {
    const bash = selectedShell ?? trustedGitBashPath(environment);
    if (bash !== null) {
      // Direct bash.exe startup bypasses git-bash.exe's PATH setup.
      const updated = `export PATH="/cmd:/usr/bin:$PATH"; ${command}`;
      return {
        application: bash,
        command_line: `"${bash}" --noprofile --norc -c ${windowsCommandLineArg(updated)}`,
      };
    }
  }
  const powershell = selectedShell ?? trustedPowerShellPath(environment);
  const encoded = encodedPowerShellCommand(command);
  return {
    application: powershell,
    command_line: `"${powershell}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
  };
}

// ------------------------------------------------------- Job Object limits

export interface JobObjectBasicLimitInformation {
  LimitFlags: number;
  ActiveProcessLimit: number;
  PerProcessUserTimeLimit: number;
}

export interface JobObjectExtendedLimitInformation {
  BasicLimitInformation: JobObjectBasicLimitInformation;
}

export function jobLimitInformation(): JobObjectExtendedLimitInformation {
  return {
    BasicLimitInformation: {
      LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_PROCESS_TIME,
      ActiveProcessLimit: ACTIVE_PROCESS_LIMIT,
      PerProcessUserTimeLimit: PROCESS_CPU_TIME_LIMIT_SECS * 10_000_000,
    },
  };
}

/** 完全信任通道的 Job：仅 KILL_ON_JOB_CLOSE（进程树回收），无资源上限。 */
export function relaxedJobLimitInformation(): JobObjectExtendedLimitInformation {
  return {
    BasicLimitInformation: {
      LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      ActiveProcessLimit: 0,
      PerProcessUserTimeLimit: 0,
    },
  };
}

// ------------------------------------------------------- cancellation contract

export interface WindowsCancellationEvent {
  isSignaled(): boolean;
}

export function isCancelled(event: WindowsCancellationEvent | null): boolean {
  return event !== null && event.isSignaled();
}

export interface WindowsAclGuard {
  release(): void;
}

export interface WindowsProfileHandle {
  readonly profile_name: string;
}

export interface WindowsGrantedPolicy {
  readonly granted_paths: readonly string[];
  readonly protected_paths: readonly string[];
}

export interface WindowsSandboxRuntime {
  createCancellationEvent(): WindowsCancellationEvent;
  acquireAclMutex(cancellation: WindowsCancellationEvent | null): WindowsAclGuard | null;
  createProfile(profileName: string, allowNetwork: boolean): WindowsProfileHandle;
  grantPolicy(policy: SandboxPolicy, profile: WindowsProfileHandle): WindowsGrantedPolicy;
  revokePolicy(granted: WindowsGrantedPolicy, profile: WindowsProfileHandle): void;
  runUnsandboxedJobProcess(
    payload: WindowsSandboxPayload,
    cancellation: WindowsCancellationEvent | null,
  ): number;
  runAppContainerProcess(
    payload: WindowsSandboxPayload,
    profile: WindowsProfileHandle,
    cancellation: WindowsCancellationEvent | null,
  ): number;
  writeStderr(line: string): void;
}

/**
 * F7：AppContainer / Job Object / ACL / 进程创建需要原生运行时。当前 host
 * 不提供该接口，因此这里显式失败，绝不伪造 AppContainer 行为。
 */
export function requireWindowsSandboxRuntime(): WindowsSandboxRuntime {
  throw new Error(
    'Windows AppContainer shell sandbox requires the F7 native runtime, which this host does not provide',
  );
}

export function windowsNativeSandboxAvailable(): boolean {
  return false;
}

function formatExitCode(code: number): string {
  return `0x${(code >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
}

export function runPayload(
  payload: WindowsSandboxPayload,
  cancellationEvent: WindowsCancellationEvent | null,
  runtime?: WindowsSandboxRuntime,
): number {
  validateWindowsSandboxPayload(payload);
  const execution = runtime ?? requireWindowsSandboxRuntime();

  if (payload.profile_name.startsWith(UNSANDBOXED_PROFILE_PREFIX)) {
    if (isCancelled(cancellationEvent)) return 124;
    if (!payload.prefer_git_bash) {
      let probe: WindowsSandboxPayload = { ...payload, command: '$null' };
      let probeExit = execution.runUnsandboxedJobProcess(probe, cancellationEvent);
      if (probeExit !== 0) {
        if (isCancelled(cancellationEvent)) return 124;
        const fallback = payload.fallback_shell_path;
        if (fallback === null) {
          execution.writeStderr(`PowerShell failed its startup probe with exit code ${formatExitCode(probeExit)}`);
          return probeExit;
        }
        execution.writeStderr(`Preferred PowerShell failed its startup probe; retrying with ${fallback}`);
        payload.fallback_shell_path = null;
        payload.shell_path = fallback;
        probe = { ...payload, command: '$null' };
        probeExit = execution.runUnsandboxedJobProcess(probe, cancellationEvent);
        if (probeExit !== 0) {
          if (isCancelled(cancellationEvent)) return 124;
          execution.writeStderr(`Fallback PowerShell failed its startup probe with exit code ${formatExitCode(probeExit)}`);
          return probeExit;
        }
      }
    }
    if (isCancelled(cancellationEvent)) return 124;
    return execution.runUnsandboxedJobProcess(payload, cancellationEvent);
  }

  const aclGuard = execution.acquireAclMutex(cancellationEvent);
  if (aclGuard === null) return 124;
  try {
    if (isCancelled(cancellationEvent)) return 124;
    const profile = execution.createProfile(payload.profile_name, payload.policy.allow_network);
    const granted = execution.grantPolicy(payload.policy, profile);
    try {
      if (!payload.prefer_git_bash) {
        let probe: WindowsSandboxPayload = { ...payload, command: '$null' };
        let probeExit = execution.runAppContainerProcess(probe, profile, cancellationEvent);
        if (probeExit !== 0) {
          if (isCancelled(cancellationEvent)) return 124;
          const fallback = payload.fallback_shell_path;
          if (fallback === null) {
            execution.writeStderr(`PowerShell failed its AppContainer startup probe with exit code ${formatExitCode(probeExit)}`);
            return probeExit;
          }
          execution.writeStderr(`Preferred PowerShell failed its AppContainer startup probe; retrying with ${fallback}`);
          payload.fallback_shell_path = null;
          payload.shell_path = fallback;
          probe = { ...payload, command: '$null' };
          probeExit = execution.runAppContainerProcess(probe, profile, cancellationEvent);
          if (probeExit !== 0) {
            if (isCancelled(cancellationEvent)) return 124;
            execution.writeStderr(`Fallback PowerShell failed its AppContainer startup probe with exit code ${formatExitCode(probeExit)}`);
            return probeExit;
          }
        }
      }
      if (isCancelled(cancellationEvent)) return 124;
      return execution.runAppContainerProcess(payload, profile, cancellationEvent);
    } finally {
      execution.revokePolicy(granted, profile);
    }
  } finally {
    aclGuard.release();
  }
}

export function maybeRunHelper(
  argv: readonly string[],
  runtime?: WindowsSandboxRuntime,
): number | null {
  if (argv[1] !== HELPER_ARG) return null;
  const execution = runtime ?? requireWindowsSandboxRuntime();
  try {
    const cancellationEvent = execution.createCancellationEvent();
    const payloadPath = argv[2];
    if (payloadPath === undefined) throw new Error('Windows sandbox helper payload path is missing');
    const payload = readWindowsPayload(payloadPath);
    return runPayload(payload, cancellationEvent, execution);
  } catch (error) {
    execution.writeStderr(`Windows local shell sandbox failed: ${messageOf(error)}`);
    return 126;
  }
}

// ------------------------------------------------------- helper termination

export interface WindowsChildState {
  /** `Some(_)` → true；`None` → false。 */
  tryWait(): boolean | null;
}

export interface WindowsJobControl {
  openCancellationEvent(pid: number): string | null;
  signalEvent(handle: string): void;
  openJobObject(pid: number): string | null;
  terminateJobObject(handle: string): void;
  killProcess(): void;
  lastErrorNotFound(): boolean;
  sleep(milliseconds: number): void;
}

/**
 * 等待 helper 建立取消事件并终止其 Job；顺序与原实现一致：先等取消事件，
 * 100 次未出现则改为等 Job Object，最后回退到直接 kill helper。
 */
export function terminateJobForChild(
  pid: number,
  child: WindowsChildState,
  control: WindowsJobControl,
): void {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.tryWait() !== null) return;
    const handle = control.openCancellationEvent(pid);
    if (handle !== null) {
      try {
        control.signalEvent(handle);
      } catch (error) {
        throw new Error(`Failed to signal the Windows shell cancellation event: ${messageOf(error)}`);
      }
      const jobHandle = control.openJobObject(pid);
      if (jobHandle !== null) {
        try {
          control.terminateJobObject(jobHandle);
        } catch (error) {
          throw new Error(`Failed to terminate the Windows shell Job Object: ${messageOf(error)}`);
        }
      }
      return;
    }
    if (!control.lastErrorNotFound()) {
      throw new Error('Failed to open the Windows shell cancellation event: file not found');
    }
    control.sleep(10);
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.tryWait() !== null) return;
    const jobHandle = control.openJobObject(pid);
    if (jobHandle !== null) {
      try {
        control.terminateJobObject(jobHandle);
      } catch (error) {
        throw new Error(`Failed to terminate the Windows shell Job Object: ${messageOf(error)}`);
      }
      return;
    }
    if (!control.lastErrorNotFound()) {
      throw new Error('Failed to open the Windows shell Job Object: file not found');
    }
    control.sleep(10);
  }

  try {
    control.killProcess();
  } catch (error) {
    throw new Error(`Failed to terminate the Windows shell helper: ${messageOf(error)}`);
  }
}

/** `maybe_run_helper` 的入口判定。 */
export function isWindowsShellHelperInvocation(argv: readonly string[]): boolean {
  return argv[1] === HELPER_ARG;
}

/** payload 文件是否仍在（测试与诊断用）。 */
export function windowsPayloadExists(target: string): boolean {
  return exists(target);
}
