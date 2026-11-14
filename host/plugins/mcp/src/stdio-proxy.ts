// Port of dstu-mcp/src/mcp/stdio_proxy.rs and global.rs ProcessStdioTransport.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { decodeUtf8Strict, rustTrim, rustTrimEnd, Utf8DecodeError } from '../../../platform/util/index.ts';
import { rustDebugString } from '../../../kernel/api.ts';
import { normalizeCommandPath } from './stdio-validation.ts';
import { buildKillTreePlan, buildSpawnPlan, SpawnInputError, type KillTreePlan, type SpawnPlan } from './spawn-plan.ts';
import { parseUsizeText, usizeErrorMessage } from './usize-text.ts';

export const STDIO_UNSUPPORTED_ON_MOBILE_MSG = 'Stdio MCP transport is not supported on this platform';
const MAX_MESSAGE_SIZE = 100 * 1024 * 1024;

const WINDOWS_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'PUBLIC', 'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS', 'OS', 'PSMODULEPATH', 'NODE_PATH', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG', 'NVM_HOME', 'NVM_SYMLINK', 'VOLTA_HOME', 'FNM_DIR', 'FNM_LOGLEVEL', 'FNM_MULTISHELL_PATH', 'FNM_NODE_DIST_MIRROR', 'FNM_COREPACK_ENABLED', 'FNM_RESOLVE_ENGINES', 'FNM_VERSION_FILE_STRATEGY', 'SCOOP', 'CHOCOLATEYINSTALL', 'PYTHONHOME', 'PYTHONPATH', 'PIP_CONFIG_FILE', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_MIRROR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy'];
const POSIX_KEYS = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'SHELL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'NODE_PATH', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_CACHE', 'NVM_DIR', 'VOLTA_HOME', 'FNM_DIR', 'FNM_MULTISHELL_PATH', 'PYTHONHOME', 'PYTHONPATH', 'PIP_CONFIG_FILE', 'UV_CACHE_DIR', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GPG_AGENT_INFO', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy'];
export function minimalChildEnvKeys(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === 'win32' ? WINDOWS_KEYS : POSIX_KEYS;
}
function windowsEnvValue(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const exact = env[key];
  if (exact !== undefined) return exact;
  const folded = key.toUpperCase();
  const name = Object.keys(env).find(candidate => candidate.toUpperCase() === folded);
  return name === undefined ? undefined : env[name];
}
/**
 * global.rs:493-504: `env_clear()`, the minimal inherited keys, then the configured env. On Windows
 * `CommandEnv` keys compare ignoring case, so a later `Path` replaces the value of an earlier `PATH`
 * and keeps its spelling; Node would otherwise sort both into the block and let `PATH` win.
 */
export function mergeChildEnv(platform: string, inherited: Readonly<Record<string, string | undefined>>,
  user: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  if (platform !== 'win32') {
    for (const key of POSIX_KEYS) { const value = inherited[key]; if (value !== undefined) env[key] = value; }
    for (const [key, value] of Object.entries(user)) env[key] = value;
    return env;
  }
  const spelling = new Map<string, string>();
  const set = (key: string, value: string): void => {
    const folded = key.toUpperCase();
    const name = spelling.get(folded) ?? key;
    spelling.set(folded, name);
    env[name] = value;
  };
  for (const key of WINDOWS_KEYS) { const value = windowsEnvValue(inherited, key); if (value !== undefined) set(key, value); }
  for (const [key, value] of Object.entries(user)) set(key, value);
  return env;
}
export function framingFromStr(value: string | null | undefined): 'jsonl' | 'content_length' {
  // Rust does not trim here; only lowercases.
  return ['content_length', 'content-length', 'contentlength'].includes(value?.toLowerCase() ?? '') ? 'content_length' : 'jsonl';
}
export function formatContentLengthFrame(message: string): string {
  return `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
}
export type ContentLengthRead = { kind: 'frame'; message: string } | { kind: 'jsonl'; line: string } | { kind: 'eof' };
export class LineReader {
  _buffer = Buffer.alloc(0);
  _ended = false;
  private readonly _read: (size: number) => Promise<Buffer | null>;

  constructor(_read: (size: number) => Promise<Buffer | null>) {
    this._read = _read;
  }
  async readLine(): Promise<string | null> {
    const bytes = await this.readLineBytes();
    if (bytes === null) return null;
    try { return decodeUtf8Strict(bytes); }
    catch (error) {
      if (error instanceof Utf8DecodeError) throw new Error('stream did not contain valid UTF-8');
      throw error;
    }
  }
  async readLineBytes(): Promise<Buffer | null> {
    for (;;) {
      if (this._ended) return null;
      const index = this._buffer.indexOf(0x0a);
      if (index >= 0) {
        const line = this._buffer.subarray(0, index);
        this._buffer = this._buffer.subarray(index + 1);
        return line;
      }
      const chunk = await this._read(64 * 1024);
      if (chunk === null) {
        this._ended = true;
        const finalLine = this._buffer;
        this._buffer = Buffer.alloc(0);
        return finalLine.length ? finalLine : null;
      }
      this._buffer = Buffer.concat([this._buffer, chunk]);
    }
  }
  async readExact(length: number | bigint): Promise<Buffer | null> {
    const wanted = BigInt(length);
    while (BigInt(this._buffer.length) < wanted) {
      const remaining = wanted - BigInt(this._buffer.length);
      // An I/O chunk, not a frame admission cap; the declared length stays exact.
      const chunk = await this._read(Number(remaining > 65536n ? 65536n : remaining));
      if (chunk === null) return null;
      this._buffer = Buffer.concat([this._buffer, chunk]);
    }
    // Only convert once the complete payload already fits in the actual Node Buffer.
    const size = Number(wanted);
    const out = this._buffer.subarray(0, size);
    this._buffer = this._buffer.subarray(size);
    return out;
  }
  async *lines(): AsyncGenerator<string> {
    for (;;) {
      const line = await this.readLine();
      if (line === null) return;
      yield line;
    }
  }
}
export async function readContentLengthMessage(reader: LineReader): Promise<ContentLengthRead> {
  const headers: string[] = [];
  for (;;) {
    const line = await reader.readLine();
    if (line === null) return { kind: 'eof' };
    const trimmed = rustTrim(line);
    if (trimmed === '') break;
    if (!headers.length && (trimmed.startsWith('{') || trimmed.startsWith('['))) return { kind: 'jsonl', line: trimmed };
    headers.push(trimmed);
  }
  let length = 0n;
  for (const header of headers) {
    if (header.startsWith('Content-Length: ')) {
      const parsed = parseUsizeText(rustTrim(header.slice('Content-Length: '.length)));
      if (parsed.ok === false) throw new Error(`Invalid Content-Length value: ${usizeErrorMessage(parsed.kind)}`);
      length = parsed.value;
      break;
    }
  }
  if (length === 0n) throw new Error('Missing or invalid Content-Length header');
  if (length > BigInt(MAX_MESSAGE_SIZE)) throw new Error(`Message size ${length} exceeds maximum allowed size ${MAX_MESSAGE_SIZE}`);
  const body = await reader.readExact(length);
  if (body === null) throw new Error('early eof');
  try { return { kind: 'frame', message: decodeUtf8Strict(body) }; }
  catch (error) {
    if (error instanceof Utf8DecodeError) throw new Error(`Invalid UTF-8 in message body: ${error.message}`);
    throw error;
  }
}
export class McpError extends Error {
  kind: 'transport' | 'connection' | 'timeout';
  constructor(kind: 'transport' | 'connection' | 'timeout', message: string) { super(message); this.kind = kind; this.name = 'McpError'; }
  override toString(): string { return this.message; }
}
export async function runContentLengthReadLoop(
  reader: LineReader,
  emit: (message: string) => void,
  log: (level: 'info' | 'warn' | 'error', message: string) => void = () => {},
): Promise<void> {
  for (;;) {
    let read: ContentLengthRead;
    try { read = await readContentLengthMessage(reader); }
    catch (e) { log('error', `Error reading from MCP stdout (Content-Length): ${e instanceof Error ? e.message : String(e)}`); return; }
    if (read.kind === 'eof') return;
    if (read.kind === 'frame') { emit(read.message); continue; }
    log('warn', 'MCP stdout emitted raw JSON while configured Content-Length → fallback to JSONL framing');
    emit(read.line);
    for (;;) {
      let raw: string | null;
      try { raw = await reader.readLine(); }
      catch (error) { log('error', `Error reading from MCP stdout (JSONL fallback): ${errorText(error)}`); break; }
      if (raw === null) break;
      const trimmed = rustTrimEnd(raw);
      if (trimmed === '') continue;
      emit(trimmed);
    }
    return;
  }
}

/** global.rs:560-684: both frontend sessions and backend clients use this producer. */
export async function readStdioStdout(
  stdout: Readable, framing: 'jsonl' | 'content_length', command: string,
  emit: (message: string) => void, log: StdioLog = () => undefined,
): Promise<void> {
  const chunks = stdout[Symbol.asyncIterator]();
  const reader = new LineReader(async () => {
    const next = await chunks.next();
    return next.done ? null : next.value;
  });
  let sawMessage = false;
  let preview = '';
  let previewBytes = 0;
  try {
    if (framing === 'content_length') {
      await runContentLengthReadLoop(reader, emit, log);
      // Rust sets this even when the configured Content-Length loop reports an error.
      sawMessage = true;
    } else {
      for (;;) {
        let raw: string | null;
        try { raw = await reader.readLine(); }
        catch (error) { log('error', `Error reading from MCP stdout (JSONL): ${errorText(error)}`); break; }
        if (raw === null) break;
        const trimmed = rustTrimEnd(raw);
        if (trimmed === '') continue;
        if (!sawMessage) {
          previewBytes += Buffer.byteLength(trimmed);
          if (preview.length < 1024) preview += trimmed.slice(0, 1024 - preview.length);
        }
        if (trimmed.startsWith('Content-Length:')) {
          log('warn', 'MCP stdout indicates Content-Length framing while configured JSONL → fallback to Content-Length framing');
          const value = rustTrim(trimmed.slice('Content-Length:'.length));
          const length = parseUsizeText(value);
          if (!length.ok || length.value === 0n) {
            log('error', `Invalid Content-Length in fallback first line: ${rustDebugString(value)}`);
            break;
          }
          let headersOk = true;
          for (;;) {
            let line: string | null;
            try { line = await reader.readLine(); }
            catch (error) { log('error', `Error reading fallback header: ${errorText(error)}`); headersOk = false; break; }
            if (line === null) { headersOk = false; break; }
            if (rustTrim(line) === '') break;
          }
          if (!headersOk) break;
          let body: Buffer | null;
          try { body = await reader.readExact(length.value); }
          catch (error) { log('error', `Error reading fallback body: ${errorText(error)}`); break; }
          if (body === null) { log('error', 'Error reading fallback body: early eof'); break; }
          let message: string;
          try { message = decodeUtf8Strict(body); }
          catch (error) {
            if (!(error instanceof Utf8DecodeError)) throw error;
            log('error', `Invalid UTF-8 in fallback body: ${error.message}`);
            break;
          }
          emit(message);
          await runContentLengthReadLoop(reader, emit, log);
          sawMessage = true;
          break;
        }
        emit(trimmed);
        sawMessage = true;
      }
    }
    if (!sawMessage) {
      log('warn', `MCP stdout EOF before any message: command=${rustDebugString(command)} pre_first_message_bytes=${previewBytes} preview=${rustDebugString(preview)}`);
    }
  } finally {
    await chunks.return?.();
    log('info', 'MCP stdout reader terminated');
  }
}
export interface StdioTransport {
  send(message: string): void;
  close(): Promise<void>;
  readonly child: ChildProcessWithoutNullStreams;
  readonly framing: 'jsonl' | 'content_length';
  readonly command: string;
}

export type StdioLog = (level: 'info' | 'warn' | 'error', message: string) => void;

/** global.rs:721-742: one stderr reader per transport, shared by probes and frontend sessions. */
export async function monitorStderr(stderr: Readable, log: StdioLog): Promise<void> {
  const chunks = stderr[Symbol.asyncIterator]();
  const reader = new LineReader(async () => {
    const next = await chunks.next();
    return next.done ? null : next.value;
  });
  try {
    for (;;) {
      const bytes = await reader.readLineBytes();
      if (bytes === null) break;
      const line = rustTrimEnd(decodeUtf8Strict(bytes));
      if (line !== '') log('warn', `MCP stderr: ${line}`);
    }
  } catch (error) {
    // Tokio BufReader::read_line reports InvalidData rather than FromUtf8Error's byte-index text.
    const message = error instanceof Utf8DecodeError ? 'stream did not contain valid UTF-8' : errorText(error);
    log('error', `Error reading from MCP stderr: ${message}`);
  } finally {
    // Drop the native reader on both EOF and read error, like the Rust task's BufReader.
    await chunks.return?.();
    log('info', 'MCP stderr reader terminated');
  }
}

export interface StdioCloseTiming {
  /** `global.rs`: wait after stdin EOF before SIGTERM. */
  gracefulMs: number;
  /** `global.rs`: wait after SIGTERM before SIGKILL (Unix only). */
  sigtermMs: number;
  /** Bounded wait after SIGKILL so close() always settles. */
  sigkillMs: number;
}

export const DEFAULT_STDIO_CLOSE_TIMING: StdioCloseTiming = {
  gracefulMs: 3_000,
  sigtermMs: 5_000,
  sigkillMs: 5_000,
};

/** `spawn` reports ENOENT asynchronously; bound the wait like the Rust fork/exec step. */
export const STDIO_SPAWN_WAIT_MS = 10_000;

export interface StdioTransportOptions {
  closeTiming?: Partial<StdioCloseTiming>;
  log?: StdioLog;
  /** Test seams: Windows spawn rules are pure functions of these two. */
  platform?: NodeJS.Platform;
  parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Test seam: runs the `taskkill` plan; rejects when the tree could not be ended. */
  killTree?: (plan: KillTreePlan) => Promise<void>;
}

function runKillTree(plan: KillTreePlan, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(plan.file, plan.args, { windowsHide: true, timeout: timeoutMs }, error => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : '';
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let settled = false;
    const onExit = (): void => { done(true); };
    const done = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    child.on('exit', onExit);
    const timer = setTimeout(() => { done(false); }, timeoutMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
    // Attach before checking: an exit between check and listener would otherwise hang.
    if (child.exitCode !== null || child.signalCode !== null) done(true);
  });
}

function killChild(
  child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals, log: StdioLog, context: string,
): void {
  try { child.kill(signal); }
  catch (error) {
    if (errorCode(error) !== 'ESRCH') log('warn', `${context}: ${errorText(error)}`);
  }
}

async function awaitSpawn(
  child: ChildProcessWithoutNullStreams, command: string, log: StdioLog,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: McpError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('spawn', onSpawn);
      child.off('error', onError);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onSpawn = (): void => { finish(); };
    const onError = (error: NodeJS.ErrnoException): void => {
      finish(new McpError('transport', spawnFailureMessage(command, error)));
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off('spawn', onSpawn);
      child.off('error', onError);
      killChild(child, 'SIGKILL', log, 'MCP child spawn acknowledgement timeout');
      reject(new McpError(
        'transport',
        `Failed to spawn process "${command}": spawn acknowledgement timed out after ${STDIO_SPAWN_WAIT_MS}ms`,
      ));
    }, STDIO_SPAWN_WAIT_MS);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
  });
}

export async function createStdioTransport(
  command: string, args: string[], framing: 'jsonl' | 'content_length',
  env: Record<string, string>, cwd: string | null, options: StdioTransportOptions = {},
): Promise<StdioTransport> {
  const log = options.log ?? (() => undefined);
  const timing: StdioCloseTiming = { ...DEFAULT_STDIO_CLOSE_TIMING, ...options.closeTiming };
  const platform = options.platform ?? process.platform;
  const parentEnv = options.parentEnv ?? process.env;
  const normalized = normalizeCommandPath(command);
  if (normalized.startsWith('\\\\?\\')) throw new McpError('transport', `Command path uses an unsupported extended-length form and cannot be spawned: ${normalized}`);
  const childEnv = mergeChildEnv(platform, parentEnv, env);
  let plan: SpawnPlan;
  try { plan = buildSpawnPlan(platform, normalized, args, parentEnv); }
  catch (e) {
    if (!(e instanceof SpawnInputError)) throw e;
    throw new McpError('transport', `Failed to spawn process "${normalized}": ${e.message} (kind=InvalidInput, os_error=none)`);
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(plan.file, plan.args, {
      cwd: cwd ?? undefined, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      ...(plan.argv0 === undefined ? {} : { argv0: plan.argv0 }),
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new McpError('transport', spawnFailureMessage(normalized, err));
  }
  await awaitSpawn(child, normalized, log);
  child.on('error', error => { log('warn', `MCP child process error: ${errorText(error)}`); });
  child.stdin.on('error', error => { log('warn', `MCP stdin write error: ${errorText(error)}`); });
  void monitorStderr(child.stderr, log);
  let closed = false;
  return {
    child, framing, command: normalized,
    send(message: string): void { child.stdin.write(framing === 'content_length' ? formatContentLengthFrame(message) : `${message}\n`); },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // global.rs close(): stdin EOF -> wait 3s -> SIGTERM -> wait 5s -> SIGKILL.
      try { child.stdin.end(); }
      catch (error) { log('warn', `MCP child stdin close error: ${errorText(error)}`); }
      if (await waitForChildExit(child, timing.gracefulMs)) {
        log('info', 'MCP child process exited gracefully on close()');
        return;
      }
      log('info', `MCP child process did not exit within ${timing.gracefulMs}ms, sending SIGTERM`);
      if (platform !== 'win32') {
        killChild(child, 'SIGTERM', log, 'Failed to send SIGTERM to MCP child process');
        if (await waitForChildExit(child, timing.sigtermMs)) {
          log('info', 'MCP child process exited after SIGTERM');
          return;
        }
        log('warn', `MCP child process did not exit after SIGTERM within ${timing.sigtermMs}ms, sending SIGKILL`);
      }
      // RUST-FIX(RF-W21-windows-stdio-kill-tree): Rust kill_on_drop only TerminateProcess-es the direct child, orphaning the server behind a cmd.exe / npx.cmd wrapper.
      const treePlan = buildKillTreePlan(platform, child.pid, parentEnv);
      let treeKilled = false;
      if (treePlan !== null) {
        try {
          await (options.killTree ?? (plan => runKillTree(plan, timing.sigkillMs)))(treePlan);
          treeKilled = true;
        } catch (error) {
          log('warn', `Failed to kill MCP process tree, terminating the direct child only: ${errorText(error)}`);
        }
      }
      if (!treeKilled) killChild(child, 'SIGKILL', log, 'Failed to kill MCP child process');
      if (await waitForChildExit(child, timing.sigkillMs)) {
        log('info', 'MCP child process terminated (forced) on close()');
      } else {
        log('warn', `MCP child process did not exit after SIGKILL within ${timing.sigkillMs}ms`);
      }
    },
  };
}

function strerrorName(code: string): string | null {
  switch (code) {
    case 'ENOENT': return 'No such file or directory';
    case 'EACCES': return 'Permission denied';
    case 'EPERM': return 'Operation not permitted';
    case 'EINVAL': return 'Invalid argument';
    default: return null;
  }
}

function rustOsErrorNumber(code: string): number | null {
  switch (code) {
    case 'ENOENT': return 2;
    case 'EACCES': return process.platform === 'win32' ? 5 : 13;
    case 'EPERM': return 1;
    case 'EINVAL': return 22;
    default: return null;
  }
}

export function spawnFailureMessage(command: string, error: NodeJS.ErrnoException): string {
  const code = error.code ?? '';
  const kind = { ENOENT: 'NotFound', EACCES: 'PermissionDenied', EPERM: 'PermissionDenied', EINVAL: 'InvalidInput' }[code] ?? 'Uncategorized';
  const canonicalErrno = rustOsErrorNumber(code);
  const osError = canonicalErrno !== null
    ? String(canonicalErrno)
    : error.errno === undefined ? 'none' : String(Math.abs(error.errno));
  const detail = canonicalErrno !== null
    ? `${strerrorName(code)} (os error ${canonicalErrno})`
    : error.message;
  let message = `Failed to spawn process "${command}": ${detail} (kind=${kind}, os_error=${osError})`;
  if (kind === 'NotFound') message += ' — ensure the executable exists and is reachable via PATH. If you rely on Node.js tooling, install it and run "npm install -g @modelcontextprotocol/server-filesystem".';
  return message;
}

export type StdioEventSink = (event: string, payload: unknown) => void;
interface Session { transport: StdioTransport; aborted: boolean }
export class StdioSessionManager {
  _sessions = new Map<string, Session>();
  _closed = new Set<string>();
  private readonly _emit: StdioEventSink;
  private readonly _log: (level: 'info' | 'warn' | 'error', message: string) => void;

  constructor(_emit: StdioEventSink, _log: (level: 'info' | 'warn' | 'error', message: string) => void = () => {}) {
    this._emit = _emit;
    this._log = _log;
  }
  async start(command: string, args: string[], env: Record<string, string>, framing: string | null, cwd: string | null): Promise<string> {
    if (command.trim() === '') throw new McpError('transport', 'Stdio MCP 需要指定 command');
    const mode = framingFromStr(framing);
    // start_stdio_session keeps non-empty args verbatim (no trim).
    const normalizedArgs = args.filter(arg => arg !== '');
    const transport = await createStdioTransport(
      command, normalizedArgs, mode, env, cwd, { log: this._log },
    );
    const sessionId = randomUUID(), prefix = `mcp-stdio-${sessionId}`;
    const session: Session = { transport, aborted: false };
    this._sessions.set(sessionId, session);
    void this._readLoop(sessionId, prefix, session);
    return sessionId;
  }
  _take(sessionId: string): Session | undefined {
    const session = this._sessions.get(sessionId);
    if (session) this._sessions.delete(sessionId);
    return session;
  }
  async _readLoop(sessionId: string, prefix: string, session: Session): Promise<void> {
    try {
      await readStdioStdout(session.transport.child.stdout, session.transport.framing, session.transport.command,
        message => this._emit(`${prefix}-message`, { message }), this._log);
    } catch (e) {
      this._log('error', `Error reading from MCP stdout: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (session.aborted) return;
    // Rust logs framing/read errors and then drops the channel sender, so the
    // reader task always reports `Transport error: Channel closed`.
    this._emit(`${prefix}-error`, { error: 'Transport error: Channel closed' });
    const handle = this._take(sessionId);
    if (handle) await handle.transport.close();
    this._log('info', `MCP stdio session ${sessionId} auto-cleaned after reader exit`);
    this._emit(`${prefix}-closed`, {});
    this._closed.add(sessionId);
  }
  async send(sessionId: string, message: string): Promise<void> {
    const session = this._sessions.get(sessionId);
    if (!session) throw new McpError('transport', `Transport error: Unknown session: ${sessionId}`);
    try { session.transport.send(message); }
    catch (e) { throw new McpError('transport', `Send failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  async close(sessionId: string): Promise<void> {
    const session = this._take(sessionId);
    if (session) {
      // close_stdio_session closes the transport and aborts the reader task;
      // no `-error`/`-closed` events are emitted on this path.
      session.aborted = true;
      await session.transport.close();
    }
    // Session may already have been auto-cleaned by the reader task; Rust returns Ok.
  }
  async dispose(): Promise<void> {
    for (const [id, session] of this._sessions) { this._sessions.delete(id); session.aborted = true; await session.transport.close(); }
  }
}
