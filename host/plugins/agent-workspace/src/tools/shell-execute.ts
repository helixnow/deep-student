/** local_shell_execute_executor.rs: authority-checked execution and audit output.
 * Runtime policy, snapshots and process/stream lifecycle live in shell-execute/.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import type { RuntimeRoot } from '../../api.ts';
import { analyzeShellCommand, immutableShellCommandGuard, normalizedShellRuntimeLocationWithDefault,
  redactToolArgumentsForDisplay, shellCommandToolSensitivity } from '../approval-scope.ts';
import { explicitRuntimeRootIdFromArgs, ioMessage, normalizeRuntimeRelativePath } from '../runtime-paths.ts';
import { hostCwdRuntimeRoot, revalidateRuntimeRoot, runtimeRootById, runtimeRootsForSession, tempRoot } from '../runtime-roots.ts';
import { allowedSkillsBases } from '../skill-packages.ts';
import { recordExternalChanges } from '../workspace-change-set.ts';
import { commandMentionsSkillsDirectory, hostShellExecutionModeFromAuthority,
  hostShellExecutionUnsandboxed, hostShellExecutionUnrestricted } from './shell-authority.ts';
import { buildEnvPlanUnrestricted, buildEnvPlanWithInheritDefault, envFromPlan, envPolicyJson } from './shell-env.ts';
import { decodeShellOutput, failureErrorForLlm, normalizePlatformShellStderr, platformExitDetails } from './shell-output.ts';
import { enforceForCall } from './shell-policy.ts';
import { shellBackendForExecutionMode,
  type SandboxBackend, type SandboxEffectReport, type SandboxPolicy } from './shell-sandbox.ts';
import type { JsonValue, ToolCall, ToolResultInfo, ToolSensitivity } from './shared.ts';
import { stripToolNamespace } from './shared.ts';
import { rustTrim } from '../../../../platform/util/index.ts';
import { toolNames, UNRESTRICTED_DEFAULT_TIMEOUT_MS, UNRESTRICTED_DEFAULT_MAX_OUTPUT_BYTES,
  UNRESTRICTED_MAX_OUTPUT_BYTES_HARD_CAP, asStr, asBool, asU64, field, homeDirectory, runtimeDeps,
  readShellCommandPolicy, rootJson, commandAudit, commandAppearsWriteCapable, looksNetworkCapable,
  networkPolicyJsonForMode, shellSecurityFingerprint, authoritativeShellAuthority,
  resolvePreferredRuntimeRootId, resolveCwd, resolveSkillDir, ensureRootWritableForCommand,
  buildSandboxPolicy, defaultShellExecuteOptions, type ShellExecuteContext, type ShellExecuteOptions } from './shell-execute/context.ts';
import { collectFileSnapshotBlocking, externalSnapshot, fileChangeSummaryJson, type FileSnapshot } from './shell-execute/snapshots.ts';
import { launchShellCommand, cleanupBackendResources, boundedPipeOutput, drainBounded, finishDrainTask, spawnSandboxCommand,
  appendStderrNotice, type LaunchedShell, type ShellResourceLimiter, type ShellWaitOutcome, type SpawnProcess } from './shell-execute/process.ts';
import { ShellEnvironmentFailure, errnoCode, sandboxSetupFailure } from './shell-execute/environment-failure.ts';
import type { NativeSandbox } from '../../../../platform/native/sandbox/api.ts';
export * from './shell-execute/context.ts';
export * from './shell-execute/snapshots.ts';
export * from './shell-execute/process.ts';
export * from './shell-execute/environment-failure.ts';

/** Sandbox backends whose Rust launcher applies RLIMIT_CPU/FSIZE/NPROC in pre_exec. */
const RLIMIT_BACKENDS = new Set(['macos_seatbelt', 'linux_bwrap']);

export class LocalShellExecuteExecutor {
  private readonly getWindowsFiles?: () => ShellExecuteContext['windowsFiles'];
  private readonly getNativeSandbox?: () => NativeSandbox | undefined;
  private readonly spawnProcess: SpawnProcess;
  private readonly lifetime = new AbortController();
  private readonly running = new Set<Promise<JsonValue>>();
  constructor(getWindowsFiles?: () => ShellExecuteContext['windowsFiles'], getNativeSandbox?: () => NativeSandbox | undefined,
    spawnProcess: SpawnProcess = spawnSandboxCommand) {
    this.getWindowsFiles = getWindowsFiles;
    this.getNativeSandbox = getNativeSandbox;
    this.spawnProcess = spawnProcess;
  }
  /**
   * Cancels every running command (its process group is terminated like a run cancellation) and waits for those
   * calls to settle; later calls refuse to spawn.
   */
  // RUST-FIX(RF-S01-shell-orphaned-on-unload): Rust only sets kill_on_drop on the shell and exits without dropping it, so the process group outlives the app
  async dispose(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.running]);
  }
  private assertLive(): void {
    if (this.lifetime.signal.aborted) throw new Error('Local shell executor was disposed with its plugin; command not started');
  }
  canHandle(toolName: string): boolean {
    return stripToolNamespace(toolName) === toolNames.SHELL_EXECUTE;
  }
  sensitivityLevel(_toolName: string): ToolSensitivity { return 'high'; }
  sensitivityLevelForCall(_toolName: string, args: JsonValue): ToolSensitivity {
    const command = asStr(field(args, 'command'));
    return command === null ? 'high' : shellCommandToolSensitivity(command);
  }
  hasDynamicSensitivity(_toolName: string): boolean { return true; }
  managesCancellation(_toolName: string): boolean { return true; }
  name(): string { return 'LocalShellExecuteExecutor'; }

  async execute(call: ToolCall, ctx: ShellExecuteContext): Promise<ToolResultInfo> {
    const start = performance.now();
    const redactedArguments = redactToolArgumentsForDisplay(call.name, call.arguments);
    ctx.emitToolCallStart?.(call.name, redactedArguments, call.id);
    let output: JsonValue;
    try { output = await this.executeShell(call.arguments, ctx); }
    catch (error) {
      const durationMs = Math.trunc(performance.now() - start);
      const message = ioMessage(error);
      ctx.emitToolCallError?.(message);
      const failed = failureToolResult(call.id, ctx.blockId ?? null, call.name, redactedArguments, message, durationMs);
      this.saveBlock(ctx, failed);
      return failed;
    }
    const durationMs = Math.trunc(performance.now() - start);
    const success = asBool(field(output, 'success')) ?? false;
    ctx.emitToolCallEnd?.({ result: output, durationMs });
    const result: ToolResultInfo = { toolName: call.name, input: redactedArguments, output, success, durationMs };
    if (call.id !== '') result.toolCallId = call.id;
    if (ctx.blockId) result.blockId = ctx.blockId;
    if (!success) result.error = failureErrorForLlm(output);
    this.saveBlock(ctx, result);
    return result;
  }
  /** Rust fails the spawn when setrlimit fails; a sandboxed command never runs without its limits. */
  private resourceLimiter(backend: string): ShellResourceLimiter {
    const sandbox = this.getNativeSandbox?.();
    if (sandbox === undefined) {
      throw new ShellEnvironmentFailure('resource_limits',
        'Local shell resource limits are unavailable (nativeSandbox service missing); refusing to run without RLIMIT CPU/FSIZE/NPROC', null);
    }
    return { sandbox, backend: backend === 'linux_bwrap' ? 'linux_bwrap' : 'macos_seatbelt' };
  }
  private saveBlock(ctx: ShellExecuteContext, result: ToolResultInfo): void {
    if (!ctx.saveToolBlock) return;
    try { ctx.saveToolBlock(result); }
    catch (error) { ctx.warn?.(`[LocalShellExecuteExecutor] Failed to save tool block: ${ioMessage(error)}`); }
  }
  async executeShell(args: JsonValue, ctx: ShellExecuteContext): Promise<JsonValue> {
    return this.executeShellWithOptions(args, ctx, defaultShellExecuteOptions());
  }

  /** Trusted internal options only; never constructed from model JSON arguments. */
  async executeShellWithOptions(args: JsonValue, ctx: ShellExecuteContext, options: ShellExecuteOptions): Promise<JsonValue> {
    const run = this.runShell(args, ctx, options);
    this.running.add(run);
    try { return await run; } finally { this.running.delete(run); }
  }

  private async runShell(args: JsonValue, ctx: ShellExecuteContext, options: ShellExecuteOptions): Promise<JsonValue> {
    this.assertLive();
    if (this.getWindowsFiles) ctx = { ...ctx, windowsFiles: this.getWindowsFiles() };
    const rawCommand = asStr(field(args, 'command')) ?? '';
    const command = rustTrim(rawCommand);
    if (command === '') throw new Error('command is required');
    if (Buffer.byteLength(command, 'utf8') > 8192) throw new Error('command is too long for local shell execution');
    const shellAuthority = authoritativeShellAuthority(ctx);
    const expectedAuthority = ctx.shellAuthorityAdmission ?? ctx.authority;
    if (!expectedAuthority) throw new Error('Local shell is missing backend authority admission evidence');
    if (expectedAuthority[0] !== shellAuthority.authority_mode || expectedAuthority[1] !== shellAuthority.permission_preset) {
      throw new Error('Session authority or permission preset changed before local shell execution');
    }
    const executionMode = hostShellExecutionModeFromAuthority(shellAuthority.authority_mode, shellAuthority.permission_preset);
    const unsandboxed = hostShellExecutionUnsandboxed(executionMode);
    const unrestricted = hostShellExecutionUnrestricted(executionMode);
    const rawCommandPolicy = readShellCommandPolicy(ctx);
    const commandPolicy = enforceForCall(rawCommandPolicy, command, true);
    if (!unrestricted && commandPolicy.effective_effect === 'deny') {
      throw new Error('Command is denied by the configured terminal command rules');
    }
    const [displayCommand, commandHash, commandRedacted] = commandAudit(command);
    if (!unsandboxed && commandMentionsSkillsDirectory(command, allowedSkillsBases({ appDataDir: ctx.dataDir }))) {
      throw new Error('Command touches a skill package directory, which is blocked for local shell. '
        + 'Use skill_scan first, then skill_install with expected_sha256 from the scan result, '
        + 'or ask the user to manage skills in the Skills management UI.');
    }

    const explicitRootId = explicitRuntimeRootIdFromArgs(args);
    const [, requestedCwd] = normalizedShellRuntimeLocationWithDefault(args, null);
    const cwdAbsoluteInput = unsandboxed ? absoluteCwdInput(requestedCwd) : null;
    const preferredDefault = explicitRootId === null && cwdAbsoluteInput === null ? resolvePreferredRuntimeRootId(ctx) : null;
    const [rootId, cwdInput] = normalizedShellRuntimeLocationWithDefault(args, preferredDefault);
    const cwdRelative = cwdAbsoluteInput === null ? normalizeRuntimeRelativePath(cwdInput) : '';
    let cwdDisplay: string;
    if (cwdAbsoluteInput !== null) cwdDisplay = cwdAbsoluteInput;
    else if (cwdRelative === '') cwdDisplay = '.';
    else cwdDisplay = cwdRelative;

    let timeoutMs: number;
    if (unrestricted) {
      timeoutMs = Math.max(asU64(field(args, 'timeout_ms', 'timeoutMs')) ?? UNRESTRICTED_DEFAULT_TIMEOUT_MS, 1_000);
    } else {
      const requested = asU64(field(args, 'timeout_ms', 'timeoutMs')) ?? 30_000;
      timeoutMs = Math.min(Math.max(requested, 1_000), 600_000);
    }
    let maxOutputBytes: number;
    if (unrestricted) {
      const requested = asU64(field(args, 'max_output_bytes', 'maxOutputBytes')) ?? UNRESTRICTED_DEFAULT_MAX_OUTPUT_BYTES;
      maxOutputBytes = Math.min(Math.max(requested, 1_024), UNRESTRICTED_MAX_OUTPUT_BYTES_HARD_CAP);
    } else {
      const requested = asU64(field(args, 'max_output_bytes', 'maxOutputBytes')) ?? 64 * 1024;
      maxOutputBytes = Math.min(Math.max(requested, 1_024), 1024 * 1024);
    }
    const trackFileChanges = asBool(field(args, 'track_file_changes', 'trackFileChanges')) ?? true;
    const requestedAllowNetwork = asBool(field(args, 'allow_network', 'allowNetwork')) ?? false;
    const allowNetwork = unsandboxed || requestedAllowNetwork;
    const networkCapable = looksNetworkCapable(command);
    const networkPolicy = networkPolicyJsonForMode(requestedAllowNetwork, allowNetwork, networkCapable, !unsandboxed);
    const rawSkillRootId = asStr(field(args, 'skill_root_id', 'skillRootId'));
    const skillRootIdValue = rawSkillRootId == null ? undefined : rustTrim(rawSkillRootId);
    const skillRootIdInput = skillRootIdValue === '' || skillRootIdValue === undefined ? null : skillRootIdValue;

    let root: RuntimeRoot;
    if (cwdAbsoluteInput !== null) root = hostCwdRuntimeRoot(cwdAbsoluteInput);
    else root = runtimeRootById(runtimeDeps(ctx), ctx.sessionId, ctx.skillPackageRoots ?? null, rootId, true);
    if (cwdAbsoluteInput === null) root.path = revalidateRuntimeRoot(ctx.settings, root, ctx.windowsFiles);
    const cwdAbs = cwdAbsoluteInput !== null ? root.path : resolveCwd(root, cwdRelative, unsandboxed);
    if (!unsandboxed) ensureRootWritableForCommand(root, cwdAbs, command);
    if (!unsandboxed && root.kind === 'workspace' && root.access === 'read_write'
      && commandAppearsWriteCapable(command) && !trackFileChanges) {
      throw new Error('Workspace-mutating shell commands require track_file_changes=true');
    }
    const skillDirInjection = skillRootIdInput === null ? null : resolveSkillDir(skillRootIdInput, ctx);
    let rootAbsForSnapshot: string;
    try { rootAbsForSnapshot = fs.realpathSync.native(root.path); }
    catch { rootAbsForSnapshot = root.path; }
    const analysis = analyzeShellCommand(command);
    const envPlan = unrestricted ? buildEnvPlanUnrestricted(args) : buildEnvPlanWithInheritDefault(args, unsandboxed);
    const envPolicy = envPolicyJson(envPlan, skillDirInjection);
    const sandboxPolicyValue: SandboxPolicy = unsandboxed
      ? { readable_roots: [], writable_roots: [], protected_read_roots: [], protected_write_roots: [],
        restrict_read_to_roots: false, allow_network: true }
      : buildSandboxPolicy(ctx, root, cwdAbs, skillDirInjection, envPlan, allowNetwork, options);
    const sandboxBackend: SandboxBackend = shellBackendForExecutionMode(executionMode);
    const effectReport = options.allowGitMetadataWrite || options.forceReadOnly
      ? sandboxBackend.effectReportForGit(sandboxPolicyValue) : sandboxBackend.effectReport(sandboxPolicyValue);
    const securityFingerprint = shellSecurityFingerprint(commandHash, shellAuthority, executionMode);
    const captureWorkspaceChangeSet = trackFileChanges && root.kind === 'workspace' && root.access === 'read_write'
      && (commandAppearsWriteCapable(command) || options.allowGitMetadataWrite);

    let beforeSnapshot: FileSnapshot | null = null;
    let beforeSnapshotError: string | null = null;
    if (trackFileChanges) {
      try { beforeSnapshot = await collectFileSnapshotBlocking(rootAbsForSnapshot, cwdAbs, captureWorkspaceChangeSet); }
      catch (error) { beforeSnapshotError = ioMessage(error); }
    }
    this.assertLive();
    if (ctx.signal?.aborted === true) throw new Error('Tool execution cancelled before local shell spawn');
    const currentAuthority = authoritativeShellAuthority(ctx);
    if (currentAuthority.authority_mode !== shellAuthority.authority_mode || currentAuthority.permission_preset !== shellAuthority.permission_preset) {
      throw new Error('Session authority or permission preset changed before shell spawn; retry required');
    }
    const immutableGuardBypassed = unrestricted;
    let immutableGuardJson: JsonValue;
    if (unrestricted) {
      immutableGuardJson = { effect: 'bypassed', reason: 'unrestricted_execution_mode' };
    } else {
      const guardRoots = unsandboxed ? [] : runtimeRootsForSession(runtimeDeps(ctx), ctx.sessionId, true).map(item => item.path);
      const home = homeDirectory();
      if (home !== null) guardRoots.push(home);
      const immutableGuard = immutableShellCommandGuard(command, cwdAbs, guardRoots);
      if (immutableGuard.effect === 'deny') throw new Error(`Command denied by immutable catastrophe guard: ${immutableGuard.reason}`);
      if (immutableGuard.effect === 'ask' && ctx.shellGuardApproved !== true && !options.structuredCommandApproved) {
        throw new Error(`Command requires a fresh immutable-guard approval before spawn: ${immutableGuard.reason}`);
      }
      const currentPolicy = enforceForCall(readShellCommandPolicy(ctx), command, true);
      if (currentPolicy.effective_effect === 'deny') throw new Error('Command is denied by terminal command rules at the final spawn check');
      immutableGuardJson = { effect: immutableGuard.effect, reason: immutableGuard.reason };
    }

    // RUST-FIX(RF-S01-shell-environment-failure): Rust reports a failed spawn, sandbox setup or missing limiter as a bare string, so the model cannot tell it from a command error and retries the same command
    const limiter = RLIMIT_BACKENDS.has(effectReport.backend) ? this.resourceLimiter(effectReport.backend) : null;
    const startedAt = performance.now();
    let spec: ReturnType<SandboxBackend['command']>;
    try {
      spec = options.allowGitMetadataWrite || options.forceReadOnly
        ? sandboxBackend.commandForGit(command, cwdAbs, sandboxPolicyValue) : sandboxBackend.command(command, cwdAbs, sandboxPolicyValue);
    } catch (error) {
      throw sandboxSetupFailure(error);
    }
    const spawnEnv = envFromPlan(envPlan);
    if (skillDirInjection !== null) spawnEnv['SKILL_DIR'] = skillDirInjection.path;
    if (root.access === 'read_write') {
      spawnEnv['TMPDIR'] = cwdAbs;
      spawnEnv['TEMP'] = cwdAbs;
      spawnEnv['TMP'] = cwdAbs;
    }
    let child: LaunchedShell;
    try { child = await launchShellCommand(spec, spawnEnv, limiter, this.spawnProcess); }
    catch (error) {
      cleanupBackendResources(sandboxBackend, spec);
      throw new ShellEnvironmentFailure('spawn', `Failed to execute local shell command: ${ioMessage(error)}`, errnoCode(error), error);
    }
    if (child.processId === undefined) {
      await child.terminate(ctx.warn);
      cleanupBackendResources(sandboxBackend, spec);
      throw new ShellEnvironmentFailure('process_io', 'Sandboxed local shell process has no process id', null);
    }
    const stdoutReader = child.stdout;
    if (stdoutReader === null) {
      await child.terminate(ctx.warn);
      cleanupBackendResources(sandboxBackend, spec);
      throw new ShellEnvironmentFailure('process_io', 'Failed to capture local shell stdout', null);
    }
    const stderrReader = child.stderr;
    if (stderrReader === null) {
      await child.terminate(ctx.warn);
      cleanupBackendResources(sandboxBackend, spec);
      throw new ShellEnvironmentFailure('process_io', 'Failed to capture local shell stderr', null);
    }
    const stdoutCapture = boundedPipeOutput();
    const stderrCapture = boundedPipeOutput();
    const stdoutTask = drainBounded(stdoutReader, stdoutCapture, maxOutputBytes);
    const stderrTask = drainBounded(stderrReader, stderrCapture, maxOutputBytes);
    let waitOutcome: ShellWaitOutcome | null = null;
    let waitFailure: string | null = null;
    const waitSignal = ctx.signal ? AbortSignal.any([ctx.signal, this.lifetime.signal]) : this.lifetime.signal;
    try { waitOutcome = await child.wait({ timeoutMs, signal: waitSignal, warn: ctx.warn }); }
    catch (error) { waitFailure = ioMessage(error); }
    cleanupBackendResources(sandboxBackend, spec);
    const stdoutDrainWarning = await finishDrainTask(stdoutTask, 'stdout');
    const stderrDrainWarning = await finishDrainTask(stderrTask, 'stderr');
    if (waitOutcome === null) throw new Error(waitFailure ?? 'Failed to wait for local shell command');
    const auditWarnings: string[] = [];
    if (stdoutDrainWarning !== null) auditWarnings.push(stdoutDrainWarning);
    if (stderrDrainWarning !== null) auditWarnings.push(stderrDrainWarning);
    const outputDrainIncomplete = auditWarnings.length > 0;
    const exited = waitOutcome.kind === 'exited' ? waitOutcome : null;
    const timedOut = waitOutcome.kind === 'timed_out';
    const cancelled = waitOutcome.kind === 'cancelled';
    const durationMs = Math.trunc(performance.now() - startedAt);
    const stdoutBytes = stdoutCapture.total_bytes;
    const stderrBytes = stderrCapture.total_bytes;
    const stdout = decodeShellOutput(stdoutCapture.visible);
    let [stderr, actualShellKind] = normalizePlatformShellStderr(decodeShellOutput(stderrCapture.visible));
    if (timedOut) stderr = appendStderrNotice(stderr, maxOutputBytes, `Command timed out after ${timeoutMs}ms`);
    else if (cancelled) stderr = appendStderrNotice(stderr, maxOutputBytes, 'Command cancelled; sandbox process tree was terminated');
    const stdoutTruncated = stdoutBytes > stdoutCapture.visible.length;
    const stderrTruncated = stderrBytes > stderrCapture.visible.length;
    const exitCode = exited === null ? null : exited.exitCode;
    const [exitCodeUnsigned, exitCodeHex, shellStartupFailure] = platformExitDetails(exitCode);
    const success = exited !== null && exited.success;

    let afterSnapshot: FileSnapshot | null = null;
    let afterSnapshotError: string | null = null;
    if (trackFileChanges) {
      try { afterSnapshot = await collectFileSnapshotBlocking(rootAbsForSnapshot, cwdAbs, captureWorkspaceChangeSet); }
      catch (error) { afterSnapshotError = ioMessage(error); }
    }
    const snapshotError = beforeSnapshotError ?? afterSnapshotError;
    const fileChangeSummary = fileChangeSummaryJson(root, beforeSnapshot, afterSnapshot, snapshotError);
    const changeSetComplete = captureWorkspaceChangeSet && beforeSnapshot !== null && afterSnapshot !== null
      && !beforeSnapshot.truncated && !afterSnapshot.truncated && beforeSnapshot.skipped === 0 && afterSnapshot.skipped === 0;
    let changeSet: JsonValue = null;
    let changeSetError: string | null = null;
    if (captureWorkspaceChangeSet) {
      if (beforeSnapshot !== null && afterSnapshot !== null) {
        let checkpointPath: string;
        try { checkpointPath = tempRoot(ctx.dataDir, ctx.sessionId, true).path; }
        catch (error) { throw new Error(ioMessage(error)); }
        try {
          changeSet = recordExternalChanges(checkpointPath, root.id,
            externalSnapshot(beforeSnapshot), externalSnapshot(afterSnapshot)) as unknown as JsonValue;
        } catch (error) { changeSetError = ioMessage(error); }
      } else { changeSetError = 'workspace snapshots were unavailable'; }
    }
    const sandboxReport: SandboxEffectReport = { ...effectReport };
    if (actualShellKind !== null) sandboxReport.shell_kind = actualShellKind;
    const resourceLimits: JsonValue = unrestricted
      ? { timeout: 'none', output_bound_bytes: maxOutputBytes, output_bound_reason: 'crash_protection_high_water_mark' }
      : { timeout: timeoutMs, output_bound_bytes: maxOutputBytes };
    return {
      command: displayCommand,
      command_hash: commandHash,
      command_redacted: commandRedacted,
      command_prefix: analysis.commandPrefix,
      shell_security_fingerprint: securityFingerprint,
      authority_mode: shellAuthority.authority_mode,
      permission_preset: shellAuthority.permission_preset,
      execution_mode: executionMode,
      shell_security_mode: unsandboxed ? 'unsandboxed' : 'sandboxed',
      runtime_roots_enforced: !unsandboxed,
      command_policy_bypassed: unrestricted,
      immutable_guard_bypassed: immutableGuardBypassed,
      environment_mode: unrestricted ? 'inherit_all' : 'filtered',
      resource_limits: resourceLimits,
      immutable_command_guard: immutableGuardJson,
      root: rootJson(root),
      root_id: root.id,
      skill_root_id: skillDirInjection === null ? null : skillDirInjection.root_id,
      cwd: cwdDisplay,
      timeout_ms: timeoutMs,
      duration_ms: durationMs,
      timed_out: timedOut,
      cancelled,
      exit_code: exitCode,
      exit_code_unsigned: exitCodeUnsigned,
      exit_code_hex: exitCodeHex,
      shell_startup_failure: shellStartupFailure,
      success,
      stdout,
      stderr,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      stdout_truncated: stdoutTruncated,
      stderr_truncated: stderrTruncated,
      output_drain_incomplete: outputDrainIncomplete,
      audit_warnings: auditWarnings,
      max_output_bytes: maxOutputBytes,
      env_policy: envPolicy,
      network_policy: networkPolicy,
      sandbox: sandboxReport as unknown as JsonValue,
      file_change_summary: fileChangeSummary,
      change_set: changeSet,
      change_set_complete: changeSetComplete,
      change_set_error: changeSetError,
      has_shell_operators: analysis.hasShellOperators,
      uses_script_runner: analysis.usesScriptRunner,
    };
  }
}
function failureToolResult(toolCallId: string | null, blockId: string | null, toolName: string,
  input: JsonValue, error: string, durationMs: number): ToolResultInfo {
  const result: ToolResultInfo = { toolName, input, output: null, success: false, error, durationMs };
  if (toolCallId !== null && toolCallId !== '') result.toolCallId = toolCallId;
  if (blockId !== null && blockId !== '') result.blockId = blockId;
  return result;
}
function absoluteCwdInput(requestedCwd: string): string | null {
  const trimmed = rustTrim(requestedCwd);
  if (trimmed === '' || trimmed === '.' || !path.isAbsolute(trimmed)) return null;
  return trimmed;
}
