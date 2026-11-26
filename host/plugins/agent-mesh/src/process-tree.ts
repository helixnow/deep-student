// Safe child-process group spawner and cascading process-tree killer.
// Ensures external coding CLIs and any nested subagents/test runners they spawn
// are terminated cleanly without leaving orphan background processes.

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import path from 'node:path';
import type { McpInjectionSpec } from './adapter-types.ts';

export interface SpawnedProcessLike {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref?(): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (err: Error) => void): this;
}

export type ProcessSpawnPort = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedProcessLike;

export type ProcessSignalSender = (pid: number, signal: NodeJS.Signals | number) => void;

export type WindowsTreeKiller = (pid: number, env: NodeJS.ProcessEnv) => Promise<void>;

export interface CascadeKillTimings {
  readonly sigintGraceMs?: number;
  readonly sigtermGraceMs?: number;
  readonly pollIntervalMs?: number;
}

export interface ProcessTreeSupervisorOptions {
  readonly spawnPort?: ProcessSpawnPort;
  readonly sendSignal?: ProcessSignalSender;
  readonly windowsTreeKiller?: WindowsTreeKiller;
  readonly platform?: NodeJS.Platform;
  readonly timings?: CascadeKillTimings;
  readonly registerExitHook?: boolean;
}

export interface SpawnProcessGroupInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export interface ProcessExitOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError?: Error;
}

export interface ManagedProcessTree {
  readonly pid: number | undefined;
  readonly child: SpawnedProcessLike;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exited: Promise<ProcessExitOutcome>;
  isRunning(): boolean;
  writeStdin(chunk: string): Promise<boolean>;
  endStdin(): void;
  terminate(timingsOverride?: CascadeKillTimings): Promise<void>;
}

const DEFAULT_SIGINT_GRACE_MS = 500;
const DEFAULT_SIGTERM_GRACE_MS = 800;
const DEFAULT_POLL_INTERVAL_MS = 25;

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === code;
}

function isWindowsBatchCommand(command: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false;
  const lower = command.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

function quoteWinBatchArg(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^()%!]/u.test(arg) && !arg.endsWith('\\')) {
    return arg;
  }
  let escaped = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
    } else if (ch === '"') {
      escaped += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      escaped += '\\'.repeat(backslashes);
      if (ch === '%') escaped += '%%cd:~,%';
      escaped += ch;
      backslashes = 0;
    }
  }
  escaped += '\\'.repeat(backslashes * 2) + '"';
  return escaped;
}

export function prepareCrossPlatformSpawn(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (!isWindowsBatchCommand(command, platform)) {
    return { file: command, args: [...args], windowsVerbatimArguments: false };
  }
  const sysRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  const cmdExe = sysRoot ? path.win32.join(sysRoot, 'System32', 'cmd.exe') : (env.ComSpec ?? 'cmd.exe');
  const commandLine = [`"${command}"`, ...args.map(quoteWinBatchArg)].join(' ');
  return {
    file: cmdExe,
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

export function buildInjectedSubprocessEnv(options: {
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly extraEnv?: Readonly<Record<string, string | undefined>>;
  readonly mcp?: McpInjectionSpec;
  readonly platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const delimiter = platform === 'win32' ? ';' : ':';
  const merged: NodeJS.ProcessEnv = {};

  const sourceEnv = options.baseEnv ?? process.env;
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  // Strip parent Claude session markers so nested `claude -p` invocations never refuse startup.
  delete merged.CLAUDECODE;
  delete merged.CLAUDE_CODE_ENTRYPOINT;

  if (options.extraEnv) {
    for (const [key, value] of Object.entries(options.extraEnv)) {
      if (value === undefined) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
  }

  if (options.mcp) {
    merged.DSTU_MESH_URL = options.mcp.httpUrl;
    merged.DSTU_MESH_TOKEN = options.mcp.bearerToken;
    if (options.mcp.envVars) {
      for (const [key, value] of Object.entries(options.mcp.envVars)) {
        merged[key] = value;
      }
    }
    if (options.mcp.shimBinDir && options.mcp.shimBinDir.trim().length > 0) {
      const shimDir = options.mcp.shimBinDir.trim();
      const pathKey =
        Object.keys(merged).find((k) => k.toLowerCase() === 'path') ??
        (platform === 'win32' ? 'Path' : 'PATH');
      const existing = merged[pathKey] ?? '';
      const segments = existing.split(delimiter).filter((seg) => seg.length > 0);
      if (segments[0] !== shimDir) {
        const deduped = [shimDir, ...segments.filter((seg) => seg !== shimDir)];
        merged[pathKey] = deduped.join(delimiter);
      }
    }
  }

  return merged;
}

function defaultSpawnPort(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): SpawnedProcessLike {
  return nodeSpawn(command, [...args], options);
}

function defaultSignalSender(pid: number, signal: NodeJS.Signals | number): void {
  process.kill(pid, signal);
}

async function defaultWindowsTreeKiller(pid: number, env: NodeJS.ProcessEnv): Promise<void> {
  const sysRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  const taskkill = sysRoot
    ? path.win32.join(sysRoot, 'System32', 'taskkill.exe')
    : 'taskkill.exe';
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const killer = nodeSpawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        env,
      });
      killer.once('close', finish);
      killer.once('error', finish);
    } catch (err) {
      if (err instanceof Error) {
        finish();
        return;
      }
      finish();
    }
  });
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

export class ProcessTreeSupervisor {
  private readonly spawnPort: ProcessSpawnPort;
  private readonly sendSignal: ProcessSignalSender;
  private readonly windowsTreeKiller: WindowsTreeKiller;
  private readonly platform: NodeJS.Platform;
  private readonly timings: Required<CascadeKillTimings>;
  private readonly activeTrees = new Set<ManagedProcessTreeImpl>();
  private readonly exitHookListener: (() => void) | null;

  constructor(options: ProcessTreeSupervisorOptions = {}) {
    this.spawnPort = options.spawnPort ?? defaultSpawnPort;
    this.sendSignal = options.sendSignal ?? defaultSignalSender;
    this.windowsTreeKiller = options.windowsTreeKiller ?? defaultWindowsTreeKiller;
    this.platform = options.platform ?? process.platform;
    this.timings = {
      sigintGraceMs: options.timings?.sigintGraceMs ?? DEFAULT_SIGINT_GRACE_MS,
      sigtermGraceMs: options.timings?.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS,
      pollIntervalMs: options.timings?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    };

    if (options.registerExitHook !== false) {
      this.exitHookListener = () => {
        this.forceKillAllSync();
      };
      process.once('exit', this.exitHookListener);
    } else {
      this.exitHookListener = null;
    }
  }

  get activeCount(): number {
    return this.activeTrees.size;
  }

  spawn(input: SpawnProcessGroupInput): ManagedProcessTree {
    const env = input.env ?? { ...process.env };
    const plan = prepareCrossPlatformSpawn(input.command, input.args, this.platform, env);
    const detached = this.platform !== 'win32';

    const child = this.spawnPort(plan.file, plan.args, {
      cwd: input.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });

    const managed = new ManagedProcessTreeImpl({
      child,
      env,
      platform: this.platform,
      sendSignal: this.sendSignal,
      windowsTreeKiller: this.windowsTreeKiller,
      defaultTimings: this.timings,
      onSettled: (tree) => {
        this.activeTrees.delete(tree);
      },
    });

    this.activeTrees.add(managed);

    if (input.signal) {
      if (input.signal.aborted) {
        void managed.terminate();
      } else {
        const onAbort = (): void => {
          void managed.terminate();
        };
        input.signal.addEventListener('abort', onAbort, { once: true });
        void managed.exited.finally(() => {
          input.signal?.removeEventListener('abort', onAbort);
        });
      }
    }

    return managed;
  }

  async terminateAll(timingsOverride?: CascadeKillTimings): Promise<void> {
    const snapshot = [...this.activeTrees];
    await Promise.all(snapshot.map((tree) => tree.terminate(timingsOverride)));
  }

  forceKillAllSync(): void {
    for (const tree of this.activeTrees) {
      tree.forceKillSync();
    }
    this.activeTrees.clear();
  }

  async dispose(): Promise<void> {
    if (this.exitHookListener) {
      process.removeListener('exit', this.exitHookListener);
    }
    await this.terminateAll();
  }
}

class ManagedProcessTreeImpl implements ManagedProcessTree {
  readonly child: SpawnedProcessLike;
  readonly exited: Promise<ProcessExitOutcome>;

  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly sendSignal: ProcessSignalSender;
  private readonly windowsTreeKiller: WindowsTreeKiller;
  private readonly defaultTimings: Required<CascadeKillTimings>;
  private running = true;
  private terminatePromise: Promise<void> | null = null;

  constructor(params: {
    child: SpawnedProcessLike;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    sendSignal: ProcessSignalSender;
    windowsTreeKiller: WindowsTreeKiller;
    defaultTimings: Required<CascadeKillTimings>;
    onSettled: (self: ManagedProcessTreeImpl) => void;
  }) {
    this.child = params.child;
    this.env = params.env;
    this.platform = params.platform;
    this.sendSignal = params.sendSignal;
    this.windowsTreeKiller = params.windowsTreeKiller;
    this.defaultTimings = params.defaultTimings;

    this.exited = new Promise<ProcessExitOutcome>((resolve) => {
      let done = false;
      const finish = (outcome: ProcessExitOutcome): void => {
        if (done) return;
        done = true;
        this.running = false;
        params.onSettled(this);
        resolve(outcome);
      };

      this.child.once('error', (err) => {
        finish({ exitCode: null, signal: null, spawnError: err });
      });

      this.child.once('close', (code, signal) => {
        finish({ exitCode: code, signal });
      });

      // If a custom test double emits 'exit' without 'close', settle cleanly on next tick.
      this.child.once('exit', (code, signal) => {
        this.running = false;
        const timer = setTimeout(() => {
          finish({ exitCode: code, signal });
        }, 10);
        timer.unref?.();
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get stdin(): Writable | null {
    return this.child.stdin;
  }

  get stdout(): Readable | null {
    return this.child.stdout;
  }

  get stderr(): Readable | null {
    return this.child.stderr;
  }

  isRunning(): boolean {
    return this.running && this.child.exitCode === null && this.child.signalCode === null;
  }

  async writeStdin(chunk: string): Promise<boolean> {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return false;
    }
    return new Promise<boolean>((resolve) => {
      try {
        stdin.write(chunk, 'utf8', (err) => {
          resolve(!err);
        });
      } catch (err) {
        resolve(!(err instanceof Error) && false);
      }
    });
  }

  endStdin(): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return;
    try {
      stdin.end();
    } catch (err) {
      if (err instanceof Error) {
        stdin.destroy();
      }
    }
  }

  forceKillSync(): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    if (this.platform !== 'win32') {
      const sentGroup = this.trySendPosixGroupSignal(pid, 'SIGKILL');
      if (!sentGroup) {
        this.tryDirectChildKill('SIGKILL');
      }
      return;
    }
    this.tryDirectChildKill('SIGKILL');
  }

  terminate(timingsOverride?: CascadeKillTimings): Promise<void> {
    if (this.terminatePromise) {
      return this.terminatePromise;
    }
    this.terminatePromise = this.runCascadeTermination(timingsOverride);
    return this.terminatePromise;
  }

  private async runCascadeTermination(timingsOverride?: CascadeKillTimings): Promise<void> {
    const sigintGraceMs = timingsOverride?.sigintGraceMs ?? this.defaultTimings.sigintGraceMs;
    const sigtermGraceMs = timingsOverride?.sigtermGraceMs ?? this.defaultTimings.sigtermGraceMs;
    const pollIntervalMs = timingsOverride?.pollIntervalMs ?? this.defaultTimings.pollIntervalMs;

    this.endStdin();

    const pid = this.child.pid;
    if (pid === undefined) {
      this.tryDirectChildKill('SIGKILL');
      return;
    }

    if (this.platform === 'win32') {
      if (this.isRunning()) {
        this.tryDirectChildKill('SIGINT');
        const exitedGracefully = await this.waitForChildExit(sigintGraceMs);
        if (exitedGracefully) return;
      }
      await this.windowsTreeKiller(pid, this.env);
      if (this.isRunning()) {
        this.tryDirectChildKill('SIGKILL');
        await this.waitForChildExit(sigtermGraceMs);
      }
      return;
    }

    // POSIX Process-Group Cascade: SIGINT -> grace -> SIGTERM -> grace -> SIGKILL on -pid.
    if (this.isPosixGroupAlive(pid) || this.isRunning()) {
      const groupInt = this.trySendPosixGroupSignal(pid, 'SIGINT');
      if (!groupInt && this.isRunning()) {
        this.tryDirectChildKill('SIGINT');
      }
      const goneAfterInt = await this.waitForPosixGroupGone(pid, sigintGraceMs, pollIntervalMs);
      if (goneAfterInt) return;
    } else {
      return;
    }

    if (this.isPosixGroupAlive(pid) || this.isRunning()) {
      const groupTerm = this.trySendPosixGroupSignal(pid, 'SIGTERM');
      if (!groupTerm && this.isRunning()) {
        this.tryDirectChildKill('SIGTERM');
      }
      const goneAfterTerm = await this.waitForPosixGroupGone(pid, sigtermGraceMs, pollIntervalMs);
      if (goneAfterTerm) return;
    } else {
      return;
    }

    if (this.isPosixGroupAlive(pid) || this.isRunning()) {
      const groupKill = this.trySendPosixGroupSignal(pid, 'SIGKILL');
      if (!groupKill && this.isRunning()) {
        this.tryDirectChildKill('SIGKILL');
      }
      await this.waitForPosixGroupGone(pid, Math.max(50, pollIntervalMs * 4), pollIntervalMs);
    }
  }

  private trySendPosixGroupSignal(pid: number, signal: NodeJS.Signals | number): boolean {
    if (pid <= 0) return false;
    try {
      this.sendSignal(-pid, signal);
      return true;
    } catch (err) {
      if (isErrnoCode(err, 'ESRCH')) {
        return true;
      }
      return false;
    }
  }

  private isPosixGroupAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try {
      this.sendSignal(-pid, 0);
      return true;
    } catch (err) {
      if (isErrnoCode(err, 'EPERM')) {
        return true;
      }
      return false;
    }
  }

  private tryDirectChildKill(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch (err) {
      if (err instanceof Error) {
        this.running = false;
      }
    }
  }

  private async waitForChildExit(timeoutMs: number): Promise<boolean> {
    if (!this.isRunning()) return true;
    const race = await Promise.race([
      this.exited.then(() => true),
      waitMs(timeoutMs).then(() => false),
    ]);
    return race || !this.isRunning();
  }

  private async waitForPosixGroupGone(
    pid: number,
    timeoutMs: number,
    pollIntervalMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      if (!this.isRunning() && !this.isPosixGroupAlive(pid)) {
        return true;
      }
      const remaining = deadline - Date.now();
      await waitMs(Math.min(pollIntervalMs, Math.max(1, remaining)));
    }
    return !this.isRunning() && !this.isPosixGroupAlive(pid);
  }
}
