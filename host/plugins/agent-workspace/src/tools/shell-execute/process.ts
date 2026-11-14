/** Shell process lifecycle and bounded output drainage (local_shell_execute_executor.rs). */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { NativeSandbox, SandboxBackend as NativeSandboxBackend, SandboxedProcess } from '../../../../../platform/native/sandbox/api.ts';
import { ioMessage } from '../../runtime-paths.ts';
import type { SandboxBackend, SandboxCommand } from '../shell-sandbox.ts';

const PROCESS_CLEANUP_GRACE_MS = 10_000;
const WINDOWS_PROCESS_CLEANUP_HARD_LIMIT_MS = 30_000;
const DRAIN_CLOSE_TIMEOUT_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
export interface BoundedPipeOutput { visible: Buffer; total_bytes: number }
export function boundedPipeOutput(): BoundedPipeOutput { return { visible: Buffer.alloc(0), total_bytes: 0 }; }
export type ShellWaitOutcome =
  | { kind: 'exited'; exitCode: number | null; signalCode: NodeJS.Signals | null; success: boolean }
  | { kind: 'timed_out' } | { kind: 'cancelled' };
export interface BoundedDrainTask { promise: Promise<void>; cancel(): void }

export type ShellOutputStream = AsyncIterable<unknown> & { destroy?(): void };

export function drainBounded(reader: ShellOutputStream, capture: BoundedPipeOutput, maxBytes: number): BoundedDrainTask {
  let cancelled = false;
  let backing = Buffer.alloc(0);
  const iterate = async (): Promise<void> => {
    try {
      for await (const chunk of reader) {
        if (cancelled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk
          : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), 'utf8');
        capture.total_bytes += bytes.length;
        const length = capture.visible.length;
        const take = Math.min(bytes.length, Math.max(0, maxBytes - length));
        if (take > 0) {
          // Doubling growth keeps the copy linear; one concat per chunk is quadratic up to the 256 MiB cap.
          if (length + take > backing.length) {
            const grown = Buffer.alloc(Math.min(maxBytes, Math.max(length + take, backing.length * 2)));
            capture.visible.copy(grown);
            backing = grown;
          }
          bytes.copy(backing, length, 0, take);
          capture.visible = backing.subarray(0, length + take);
        }
      }
    } catch (error) { throw new Error(`Failed to read local shell output: ${ioMessage(error)}`); }
  };
  const guarded = iterate();
  // Retain the original rejection for finishDrainTask while attaching a handler immediately.
  guarded.then(() => undefined, () => undefined);
  return { promise: guarded, cancel: () => { cancelled = true; reader.destroy?.(); } };
}
export async function finishDrainTaskWithTimeout(task: BoundedDrainTask, timeoutMs: number, streamName: string): Promise<string | null> {
  let timer: NodeJS.Timeout | null = null;
  const timedOut = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  const settled = task.promise.then(() => ({ kind: 'done' as const }),
    (error: unknown) => ({ kind: 'failed' as const, message: ioMessage(error) }));
  const result = await Promise.race([settled, timedOut]);
  if (timer !== null) clearTimeout(timer);
  if (result === 'timeout') {
    task.cancel();
    await task.promise.then(() => undefined, () => undefined);
    return `Local shell ${streamName} drain was incomplete: output pipe did not close after process cleanup`;
  }
  if (result.kind === 'done') return null;
  return `Local shell ${streamName} drain was incomplete: ${result.message}`;
}
export function finishDrainTask(task: BoundedDrainTask, streamName: string): Promise<string | null> {
  return finishDrainTaskWithTimeout(task, DRAIN_CLOSE_TIMEOUT_MS, streamName);
}
function isMissingProcess(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
export function terminateProcessGroup(processId: number, child: ChildProcess): string | null {
  if (process.platform === 'win32') {
    try { child.kill(); return null; }
    catch (error) { return `Failed to terminate sandbox process group: ${ioMessage(error)}`; }
  }
  try { process.kill(-processId, 'SIGKILL'); return null; }
  catch (error) {
    if (isMissingProcess(error)) return null;
    return `Failed to terminate sandbox process group: ${ioMessage(error)}`;
  }
}
export function cleanupFinishedProcessGroup(processId: number): void {
  if (process.platform === 'win32') return;
  try { process.kill(-processId, 'SIGKILL'); }
  catch (error) {
    if (isMissingProcess(error)) return;
    throw new Error(`Failed to clean up sandbox background process group: ${ioMessage(error)}`);
  }
}
export type SpawnProcess = (spec: SandboxCommand, env: Record<string, string>) => ChildProcess;
export function spawnSandboxCommand(spec: SandboxCommand, env: Record<string, string>): ChildProcess {
  return spawn(spec.program, spec.args, { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
}
export async function spawnShellCommand(spec: SandboxCommand, env: Record<string, string>,
  spawnProcess: SpawnProcess = spawnSandboxCommand): Promise<ChildProcess> {
  const child = spawnProcess(spec, env);
  // waitForExit owns error reporting; keep an error listener across the spawn/exit handoff.
  child.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => { child.removeListener('error', onError); resolve(); };
    const onError = (error: NodeJS.ErrnoException): void => {
      child.removeListener('spawn', onSpawn);
      // RUST-FIX(RF-S01-shell-environment-failure): keep the errno code so a transient EAGAIN is told apart from a missing shell
      reject(Object.assign(new Error(error.message), error.code === undefined ? {} : { code: error.code },
        error.errno === undefined ? {} : { errno: error.errno }));
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
  return child;
}
type ExitResult = { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null } | { kind: 'error'; message: string };
function waitForExit(child: ChildProcess): Promise<ExitResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ kind: 'exited', code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<ExitResult>(resolve => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      child.removeListener('error', onError);
      resolve({ kind: 'exited', code, signal });
    };
    const onError = (error: Error): void => {
      child.removeListener('exit', onExit);
      resolve({ kind: 'error', message: error.message });
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}
type WaitResult = ExitResult | { kind: 'timed_out' } | { kind: 'cancelled' };
function waitWithTimeout(exit: Promise<ExitResult>, timeoutMs: number, signal: AbortSignal | null): Promise<WaitResult> {
  return new Promise<WaitResult>(resolve => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (value: WaitResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish({ kind: 'cancelled' });
    timer = setTimeout(() => finish({ kind: 'timed_out' }), Math.min(timeoutMs, MAX_TIMER_DELAY_MS));
    if (signal?.aborted === true) { finish({ kind: 'cancelled' }); return; }
    signal?.addEventListener('abort', onAbort);
    exit.then(result => finish(result));
  });
}
export async function terminateAndReap(child: ChildProcess, processId: number | null, warn?: (message: string) => void): Promise<void> {
  const terminateError = processId === null ? null : terminateProcessGroup(processId, child);
  const grace = await waitWithTimeout(waitForExit(child), PROCESS_CLEANUP_GRACE_MS, null);
  if (grace.kind === 'exited') {
    if (terminateError !== null) warn?.(`[LocalShellExecuteExecutor] Process tree exited after termination warning: ${terminateError}`);
    return;
  }
  if (grace.kind === 'error') throw new Error(`Failed to wait for local shell process cleanup: ${grace.message}`);
  if (process.platform === 'win32') {
    const retryError = processId === null ? null : terminateProcessGroup(processId, child);
    if (retryError !== null) warn?.(`[LocalShellExecuteExecutor] Windows cleanup retry warning: ${retryError}`);
    const hard = await waitWithTimeout(waitForExit(child), WINDOWS_PROCESS_CLEANUP_HARD_LIMIT_MS, null);
    if (hard.kind === 'exited') return;
    if (hard.kind === 'error') throw new Error(`Failed to reap Windows local shell sandbox helper: ${hard.message}`);
    try { child.kill('SIGKILL'); }
    catch (error) { throw new Error(`Windows sandbox helper cleanup timed out and forced termination failed: ${ioMessage(error)}`); }
    const forced = await waitWithTimeout(waitForExit(child), PROCESS_CLEANUP_GRACE_MS, null);
    if (forced.kind === 'timed_out') throw new Error('Windows sandbox helper did not exit after forced termination');
    if (forced.kind === 'error') throw new Error(`Failed to reap forced Windows sandbox helper: ${forced.message}`);
    return;
  }
  child.kill('SIGKILL');
  const reaped = await waitForExit(child);
  if (reaped.kind === 'error') throw new Error(`Failed to reap local shell process after forced kill: ${reaped.message}`);
}
export async function waitForShellProcess(request: {
  child: ChildProcess; processId: number; timeoutMs: number; signal?: AbortSignal | null; warn?: (message: string) => void;
}): Promise<ShellWaitOutcome> {
  const { child, processId, timeoutMs, signal, warn } = request;
  const initial = await waitWithTimeout(waitForExit(child), timeoutMs, signal ?? null);
  if (initial.kind === 'exited') {
    cleanupFinishedProcessGroup(processId);
    return { kind: 'exited', exitCode: initial.code, signalCode: initial.signal, success: initial.code === 0 };
  }
  if (initial.kind === 'timed_out') { await terminateAndReap(child, processId, warn); return { kind: 'timed_out' }; }
  if (initial.kind === 'cancelled') { await terminateAndReap(child, processId, warn); return { kind: 'cancelled' }; }
  try { await terminateAndReap(child, processId, warn); }
  catch (cleanupError) { throw new Error(`${initial.message}; cleanup failed: ${ioMessage(cleanupError)}`); }
  throw new Error(initial.message);
}
/** shell_sandbox.rs isolate_process_group(command, true) through the native sandbox launcher. */
export interface ShellResourceLimiter {
  sandbox: NativeSandbox;
  backend: NativeSandboxBackend;
}

/** A spawned shell with the lifecycle the executor drives, whichever launcher started it. */
export interface LaunchedShell {
  readonly processId: number | undefined;
  readonly stdout: ShellOutputStream | null;
  readonly stderr: ShellOutputStream | null;
  wait(request: { timeoutMs: number; signal?: AbortSignal | null; warn?: (message: string) => void }): Promise<ShellWaitOutcome>;
  terminate(warn?: (message: string) => void): Promise<void>;
}

async function waitForLimitedProcess(handle: SandboxedProcess, timeoutMs: number, signal: AbortSignal | null): Promise<ShellWaitOutcome> {
  const exit = handle.wait().then(
    (code): ExitResult => ({ kind: 'exited', code, signal: null }),
    (error: unknown): ExitResult => ({ kind: 'error', message: ioMessage(error) }));
  const initial = await waitWithTimeout(exit, timeoutMs, signal);
  if (initial.kind === 'exited') {
    await handle.cleanupFinishedProcessGroup();
    return { kind: 'exited', exitCode: initial.code, signalCode: null, success: initial.code === 0 };
  }
  if (initial.kind === 'timed_out' || initial.kind === 'cancelled') {
    await handle.terminateProcessGroup();
    return { kind: initial.kind };
  }
  try { await handle.cleanupResources(); }
  catch (cleanupError) { throw new Error(`${initial.message}; cleanup failed: ${ioMessage(cleanupError)}`); }
  throw new Error(initial.message);
}

/**
 * Spawns `spec` in its own process group. With a limiter the native sandbox wraps the platform
 * launcher in prlimit (Linux) or `ulimit` (macOS) before exec; without one only setpgid applies.
 */
export async function launchShellCommand(spec: SandboxCommand, env: Record<string, string>,
  limiter: ShellResourceLimiter | null, spawnProcess: SpawnProcess = spawnSandboxCommand): Promise<LaunchedShell> {
  if (limiter === null) {
    const child = await spawnShellCommand(spec, env, spawnProcess);
    return {
      processId: child.pid, stdout: child.stdout, stderr: child.stderr,
      wait: ({ timeoutMs, signal, warn }) => waitForShellProcess({ child, processId: child.pid!, timeoutMs, signal, warn }),
      terminate: warn => terminateAndReap(child, child.pid ?? null, warn),
    };
  }
  const handle = await limiter.sandbox.spawn({ backend: limiter.backend, program: spec.program, args: spec.args, cwd: spec.cwd, env });
  return {
    processId: handle.pid, stdout: handle.stdout, stderr: handle.stderr,
    wait: ({ timeoutMs, signal }) => waitForLimitedProcess(handle, timeoutMs, signal ?? null),
    terminate: () => handle.terminateProcessGroup(),
  };
}
export function cleanupBackendResources(backend: SandboxBackend, spec: SandboxCommand): void {
  const manager = backend as SandboxBackend & { cleanupCommandResources?: (command: SandboxCommand) => void };
  manager.cleanupCommandResources?.(spec);
}
export function appendStderrNotice(stderr: string, maxBytes: number, message: string): string {
  if (stderr === '') return message;
  const byteLength = Buffer.byteLength(stderr, 'utf8');
  if (byteLength >= maxBytes) return stderr;
  const remaining = maxBytes - byteLength;
  const suffix = Buffer.from(`\n${message}`, 'utf8');
  return stderr + suffix.subarray(0, Math.min(suffix.length, remaining)).toString('utf8');
}
