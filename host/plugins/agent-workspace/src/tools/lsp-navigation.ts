/**
 * `chat_v2/tools/lsp_navigation_executor.rs` 的移植：workspace_lsp_definition /
 * references / hover / document_symbols。
 *
 * 该模块是 LSP 协议/格式层：语言映射、URI 转换、1-based → UTF-16 位置、结果
 * URI 归一化，以及基于 stdio 的 JSON-RPC 会话（initialize / didOpen /
 * didChange / request）。测试只覆盖纯映射与格式契约，不启动真实语言服务器。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Readable, Writable } from 'node:stream';
import type { JsonValue, ToolCall, ToolResultInfo } from './shared.ts';
import { stripToolNamespace } from './shared.ts';
import { ioMessage, isWithin } from '../runtime-paths.ts';
import type { RuntimeRootDeps, SettingsLike } from '../runtime-roots.ts';
import {
  argumentsObject, ensureAllowedKeys, resolveCodeNavigationWorkspace, resolveExistingPathAsync,
} from './code-navigation.ts';

export const LSP_NAVIGATION_TOOL_NAMES = {
  DEFINITION: 'workspace_lsp_definition',
  REFERENCES: 'workspace_lsp_references',
  HOVER: 'workspace_lsp_hover',
  DOCUMENT_SYMBOLS: 'workspace_lsp_document_symbols',
} as const;

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_LSP_MESSAGE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

/** `dstu_core::APP_VERSION`（由根 Cargo.toml 在构建期注入）。 */
const APP_VERSION = '0.11.0';

/** 注入的执行上下文（替代 Rust `ExecutionContext` 的 window/DB 依赖）。 */
export interface LspNavigationContext {
  windowsFiles?: RuntimeRootDeps['windowsFiles'];
  sessionId: string;
  dataDir: string;
  settings: SettingsLike;
  skillPackageRoots?: ReadonlyMap<string, string> | null;
  appVersion?: string;
  blockId?: string | null;
  emitToolCallStart?: (toolName: string, args: JsonValue, toolCallId: string | null) => void;
  emitToolCallEnd?: (payload: JsonValue) => void;
  emitToolCallError?: (error: string) => void;
  saveToolBlock?: (result: ToolResultInfo) => void;
  /** Rust `log::warn!` 出口；生产注入 kernel `ctx.logger`。 */
  warn?: (message: string) => void;
  /** 可选取消信号（Rust `CancellationToken`）。 */
  signal?: AbortSignal;
}

export type LspLanguage = 'rust' | 'typescript' | 'python';

export function languageForPath(target: string): LspLanguage {
  const extension = path.extname(target).slice(1).toLowerCase();
  if (extension === 'rs') return 'rust';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(extension)) return 'typescript';
  if (extension === 'py' || extension === 'pyi') return 'python';
  throw new Error(
    `No supported LSP mapping for extension '${extension}'. `
    + 'Supported: Rust, TypeScript/JavaScript, Python',
  );
}

export function serverName(language: LspLanguage): string {
  if (language === 'rust') return 'rust-analyzer';
  if (language === 'typescript') return 'typescript-language-server';
  return 'pyright-langserver';
}

export function languageId(language: LspLanguage, target: string): string {
  if (language === 'rust') return 'rust';
  if (language === 'python') return 'python';
  const extension = path.extname(target).slice(1);
  if (extension === 'tsx') return 'typescriptreact';
  if (extension === 'js' || extension === 'mjs' || extension === 'cjs') return 'javascript';
  if (extension === 'jsx') return 'javascriptreact';
  return 'typescript';
}

export function languageArguments(language: LspLanguage): string[] {
  return language === 'rust' ? [] : ['--stdio'];
}

export function initializationOptions(language: LspLanguage): JsonValue {
  if (language !== 'rust') return null;
  return {
    cargo: { buildScripts: { enable: false } },
    procMacro: { enable: false },
    diagnostics: { enable: false },
    checkOnSave: false,
  };
}

// ---------------------------------------------------------------------------
// file URI 转换
// ---------------------------------------------------------------------------

const UNRESERVED_SEGMENT = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]$/;

function encodePathSegment(segment: string): string {
  let encoded = '';
  for (const character of segment) {
    if (UNRESERVED_SEGMENT.test(character)) {
      encoded += character;
      continue;
    }
    for (const byte of Buffer.from(character, 'utf8')) {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return encoded;
}

export function fileUri(target: string, directory: boolean): string {
  if (!path.isAbsolute(target)) {
    throw new Error(`Failed to convert '${target}' to a file URI`);
  }
  const normalized = target.replaceAll('\\', '/');
  let prefix: string;
  let body: string;
  if (process.platform === 'win32' && normalized.startsWith('//')) {
    prefix = 'file:';
    body = normalized;
  } else if (process.platform === 'win32' && /^[A-Za-z]:/.test(normalized)) {
    prefix = 'file:///';
    body = normalized;
  } else {
    prefix = 'file://';
    body = normalized;
  }
  const encoded = body.split('/').map(encodePathSegment).join('/');
  const uri = `${prefix}${encoded}`;
  return directory && !uri.endsWith('/') ? `${uri}/` : uri;
}

export function filePathFromUri(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch (error) {
    void error;
    return null;
  }
  if (url.protocol !== 'file:') return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    void error;
    return null;
  }
  if (process.platform === 'win32') {
    const local = pathname.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\');
    return url.hostname ? `\\\\${url.hostname}${local}` : local;
  }
  if (url.hostname && url.hostname !== 'localhost') return `//${url.hostname}${pathname}`;
  return pathname;
}

function asRecord(value: JsonValue): { [key: string]: JsonValue } | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function relativeInside(root: string, target: string): string | null {
  if (!isWithin(root, target)) return null;
  return path.relative(root, target).replaceAll('\\', '/');
}

/** `normalize_result_uris`：`uri`/`targetUri` 改为 root 相对路径；root 外的定位删除。 */
export function normalizeResultUris(value: JsonValue, root: string): JsonValue {
  if (Array.isArray(value)) {
    const kept: JsonValue[] = [];
    for (const item of value) {
      const normalized = normalizeResultUris(item, root);
      if (normalized !== null) kept.push(normalized);
    }
    return kept;
  }
  if (typeof value === 'object' && value !== null) {
    for (const key of ['uri', 'targetUri']) {
      const uri = value[key];
      if (typeof uri !== 'string') continue;
      const target = filePathFromUri(uri);
      if (target === null) continue;
      const relative = relativeInside(root, target);
      if (relative === null) return null;
      value[key] = relative;
    }
    for (const key of Object.keys(value)) {
      value[key] = normalizeResultUris(value[key] as JsonValue, root);
    }
    return value;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 位置映射
// ---------------------------------------------------------------------------

export type LspPosition = {
  line: number;
  character: number;
};

/** `str::lines`：按 `\n` 切分、去掉行尾 `\r`，末尾换行不产生空行。 */
function rustLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

export function sourcePosition(text: string, line: number, column: number): LspPosition {
  if (line === 0 || column === 0) {
    throw new Error('line and column are 1-based and must be at least 1');
  }
  const lines = rustLines(text);
  const sourceLine = lines[line - 1];
  if (sourceLine === undefined) throw new Error(`line ${line} is outside the source file`);
  const prefix = [...sourceLine].slice(0, column - 1);
  if (prefix.length !== column - 1) {
    throw new Error(`column ${column} is outside line ${line}`);
  }
  return { line: line - 1, character: prefix.join('').length };
}

// ---------------------------------------------------------------------------
// 服务器定位与启动
// ---------------------------------------------------------------------------

export function executableNames(base: string): string[] {
  if (process.platform === 'win32') {
    return [`${base}.exe`, `${base}.cmd`, `${base}.bat`, base];
  }
  return [base];
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch (error) {
    void error;
    return false;
  }
}

export function locateServer(language: LspLanguage): string {
  const names = executableNames(serverName(language));
  const directories: string[] = [];
  const pathValue = process.env['PATH'];
  if (pathValue !== undefined) {
    for (const entry of pathValue.split(path.delimiter)) {
      if (entry !== '') directories.push(entry);
    }
  }
  const home = os.homedir();
  if (home !== '') {
    directories.push(path.join(home, '.cargo', 'bin'));
    directories.push(path.join(home, '.local', 'bin'));
    if (process.platform === 'win32') {
      directories.push(path.join(home, 'AppData', 'Roaming', 'npm'));
    }
  }
  if (process.platform === 'darwin') {
    directories.push('/opt/homebrew/bin');
    directories.push('/usr/local/bin');
  }
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (isFile(candidate)) return candidate;
    }
  }
  throw new Error(`${serverName(language)} is not installed or was not found on PATH`);
}

export interface ServerCommand {
  command: string;
  args: string[];
}

export function serverCommand(executable: string, args: readonly string[]): ServerCommand {
  if (process.platform === 'win32') {
    const extension = path.extname(executable).toLowerCase();
    if (extension === '.cmd' || extension === '.bat') {
      return { command: 'cmd.exe', args: ['/D', '/S', '/C', executable, ...args] };
    }
  }
  return { command: executable, args: [...args] };
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class LspByteReader {
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;

  constructor(stream: Readable) {
    stream.on('data', (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.notify();
    });
    stream.on('end', () => {
      this.ended = true;
      this.notify();
    });
    stream.on('error', (error: Error) => {
      this.failure = error;
      this.notify();
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private waitForData(): Promise<void> {
    return new Promise<void>(resolve => { this.wake = resolve; });
  }

  abort(error: Error): void {
    if (this.failure === null) this.failure = error;
    this.notify();
  }

  private async ensureBuffered(length: number): Promise<boolean> {
    while (this.buffer.length < length) {
      if (this.failure !== null) throw this.failure;
      if (this.ended) return false;
      await this.waitForData();
    }
    return true;
  }

  async readLine(): Promise<Buffer | null> {
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline >= 0) {
        const line = this.buffer.subarray(0, newline + 1);
        this.buffer = this.buffer.subarray(newline + 1);
        return line;
      }
      if (this.ended) {
        if (this.buffer.length === 0) return null;
        const remainder = this.buffer;
        this.buffer = Buffer.alloc(0);
        return remainder;
      }
      if (this.failure !== null) throw this.failure;
      await this.waitForData();
    }
  }

  async readExact(length: number): Promise<Buffer> {
    const ready = await this.ensureBuffered(length);
    if (!ready) throw new Error('unexpected end of stream');
    const payload = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return payload;
  }
}

interface OpenDocument {
  version: number;
  text: string;
}

interface LspSessionOptions {
  root: string;
  language: LspLanguage;
  appVersion: string;
  signal?: AbortSignal;
}

export class LspSession {
  private readonly child: ChildProcess;
  private readonly stdin: Writable;
  private readonly reader: LspByteReader;
  private nextId = 1;
  private readonly rootUri: string;
  private readonly serverNameValue: string;
  private readonly openDocuments = new Map<string, OpenDocument>();

  private constructor(
    child: ChildProcess,
    stdin: Writable,
    reader: LspByteReader,
    rootUri: string,
    server: string,
  ) {
    this.child = child;
    this.stdin = stdin;
    this.reader = reader;
    this.rootUri = rootUri;
    this.serverNameValue = server;
  }

  static async start(options: LspSessionOptions): Promise<LspSession> {
    const { root, language, appVersion, signal } = options;
    if (signal?.aborted) throw new Error('LSP navigation cancelled');
    const executable = locateServer(language);
    const command = serverCommand(executable, languageArguments(language));
    const child = spawn(command.command, command.args, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        child.removeListener('error', onError);
        child.removeListener('spawn', onSpawn);
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new Error(
          `Failed to start ${serverName(language)} at '${executable}': ${error.message}`,
        ));
      };
      const onSpawn = (): void => {
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        try { child.kill('SIGKILL'); } catch (error) { void error; }
        reject(new Error('LSP navigation cancelled'));
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    child.on('error', (error: Error) => { void error; });
    if (child.stdin === null) throw new Error('Language server stdin is unavailable');
    if (child.stdout === null) throw new Error('Language server stdout is unavailable');
    child.stdin.on('error', (error: Error) => { void error; });
    const rootUri = fileUri(root, true);
    const reader = new LspByteReader(child.stdout);
    const session = new LspSession(
      child,
      child.stdin,
      reader,
      rootUri,
      serverName(language),
    );
    const onStartupAbort = (): void => {
      reader.abort(new Error('LSP navigation cancelled'));
      try { child.stdin?.destroy(); } catch (error) { void error; }
      try { child.kill('SIGKILL'); } catch (error) { void error; }
    };
    if (signal !== undefined) {
      if (signal.aborted) onStartupAbort();
      else signal.addEventListener('abort', onStartupAbort, { once: true });
    }
    try {
      const initialize: JsonValue = {
        processId: null,
        rootUri,
        workspaceFolders: [{
          uri: session.rootUri,
          name: path.basename(root) || 'workspace',
        }],
        capabilities: {
          textDocument: {
            definition: { linkSupport: true },
            references: {},
            hover: { contentFormat: ['markdown', 'plaintext'] },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            synchronization: { didSave: false, dynamicRegistration: false },
          },
          workspace: { workspaceFolders: true },
        },
        initializationOptions: initializationOptions(language),
        clientInfo: { name: 'Deep Student', version: appVersion },
      };
      await session.request('initialize', initialize);
      await session.notify('initialized', {});
      return session;
    } catch (error) {
      await session.kill();
      throw error;
    } finally {
      if (signal !== undefined) signal.removeEventListener('abort', onStartupAbort);
    }
  }

  isRunning(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }

  async kill(): Promise<void> {
    this.reader.abort(new Error('LSP session closed'));
    try { this.stdin.destroy(); } catch (error) { void error; }
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const finished = (): void => {
        this.child.removeListener('exit', finished);
        resolve();
      };
      this.child.once('exit', finished);
      try {
        if (!this.child.kill('SIGKILL')) finished();
      } catch (error) {
        void error;
        // Rust callers ignore Child::kill errors; still release the waiter.
        finished();
      }
    });
  }

  private writeChunk(data: Buffer, label: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.stdin.write(data, error => {
        if (error) reject(new Error(`${label}: ${error.message}`));
        else resolve();
      });
    });
  }

  private async writeMessage(value: JsonValue): Promise<void> {
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    const header = `Content-Length: ${payload.length}\r\n\r\n`;
    await this.writeChunk(Buffer.from(header, 'utf8'), 'Failed to write LSP header');
    await this.writeChunk(payload, 'Failed to write LSP payload');
    if (this.stdin.writableNeedDrain) {
      await new Promise<void>(resolve => { this.stdin.once('drain', () => resolve()); });
    }
  }

  private async readMessage(): Promise<JsonValue> {
    let contentLength: number | null = null;
    for (;;) {
      const lineBuffer = await this.reader.readLine();
      if (lineBuffer === null) {
        throw new Error(`${this.serverNameValue} exited before responding`);
      }
      const line = lineBuffer.toString('utf8').replace(/[\r\n]+$/, '');
      if (line === '') break;
      if (line.startsWith('Content-Length:')) {
        const value = line.slice('Content-Length:'.length).trim();
        if (!/^[0-9]+$/.test(value)) throw new Error('Invalid LSP Content-Length header');
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed)) throw new Error('Invalid LSP Content-Length header');
        contentLength = parsed;
      }
    }
    if (contentLength === null) throw new Error('LSP response omitted Content-Length');
    if (contentLength > MAX_LSP_MESSAGE_BYTES) {
      throw new Error(`LSP response exceeds the ${MAX_LSP_MESSAGE_BYTES} byte limit`);
    }
    let payload: Buffer;
    try {
      payload = await this.reader.readExact(contentLength);
    } catch (error) {
      throw new Error(`Failed to read LSP response: ${ioMessage(error)}`);
    }
    let message: JsonValue;
    try {
      message = JSON.parse(payload.toString('utf8')) as JsonValue;
    } catch (error) {
      throw new Error(`Language server returned invalid JSON: ${(error as Error).message}`);
    }
    return message;
  }

  private async respondToServerRequest(message: JsonValue): Promise<void> {
    const record = asRecord(message);
    if (record === null) return;
    const id = record['id'];
    if (id === undefined) return;
    let result: JsonValue = null;
    const method = record['method'];
    if (method === 'workspace/configuration') {
      const params = asRecord(record['params'] ?? null);
      const items = params === null ? null : params['items'];
      const count = Array.isArray(items) ? items.length : 0;
      result = Array.from({ length: count }, () => null);
    } else if (method === 'workspace/workspaceFolders') {
      result = [{ uri: this.rootUri, name: 'workspace' }];
    }
    await this.writeMessage({ jsonrpc: '2.0', id, result });
  }

  async request(method: string, params: JsonValue): Promise<JsonValue> {
    const id = this.nextId;
    this.nextId += 1;
    await this.writeMessage({ jsonrpc: '2.0', id, method, params });
    for (;;) {
      const message = asRecord(await this.readMessage());
      if (message === null) continue;
      const messageId = message['id'];
      const hasResult = message['result'] !== undefined;
      const hasError = message['error'] !== undefined;
      if (typeof messageId === 'number' && messageId === id && (hasResult || hasError)) {
        if (hasError) {
          throw new Error(
            `${this.serverNameValue} returned an LSP error: ${JSON.stringify(message['error'])}`,
          );
        }
        return message['result'] ?? null;
      }
      if (messageId !== undefined && message['method'] !== undefined) {
        await this.respondToServerRequest(message);
      }
    }
  }

  async notify(method: string, params: JsonValue): Promise<void> {
    await this.writeMessage({ jsonrpc: '2.0', method, params });
  }

  async syncDocument(uri: string, languageIdValue: string, text: string): Promise<void> {
    const document = this.openDocuments.get(uri);
    if (document !== undefined) {
      if (document.text === text) return;
      document.version += 1;
      document.text = text;
      await this.notify('textDocument/didChange', {
        textDocument: { uri, version: document.version },
        contentChanges: [{ text }],
      });
      return;
    }
    await this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: languageIdValue, version: 1, text },
    });
    this.openDocuments.set(uri, { version: 1, text });
  }
}

// ---------------------------------------------------------------------------
// 超时 / 取消
// ---------------------------------------------------------------------------

class RequestTimer {
  readonly promise: Promise<never>;
  private readonly handle: ReturnType<typeof setTimeout>;
  private readonly onAbort: (() => void) | null;
  private readonly signal: AbortSignal | undefined;

  constructor(timeoutMs: number, timeoutMessage: string, signal?: AbortSignal) {
    let rejectPromise: (error: Error) => void = () => undefined;
    this.promise = new Promise<never>((_resolve, reject) => { rejectPromise = reject; });
    this.promise.catch(error => { void error; });
    this.handle = setTimeout(() => { rejectPromise(new Error(timeoutMessage)); }, timeoutMs);
    this.signal = signal;
    this.onAbort = signal === undefined
      ? null
      : () => { rejectPromise(new Error('LSP navigation cancelled')); };
    if (this.onAbort !== null && signal !== undefined) {
      if (signal.aborted) this.onAbort();
      else signal.addEventListener('abort', this.onAbort, { once: true });
    }
  }

  dispose(): void {
    clearTimeout(this.handle);
    if (this.onAbort !== null && this.signal !== undefined) {
      this.signal.removeEventListener('abort', this.onAbort);
    }
  }
}

async function withTimeoutAndCancellation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  operation.catch(error => { void error; });
  if (signal?.aborted) throw new Error('LSP navigation cancelled');
  const timer = new RequestTimer(timeoutMs, timeoutMessage, signal);
  try {
    return await Promise.race([operation, timer.promise]);
  } finally {
    timer.dispose();
  }
}

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

interface SessionKey {
  root: string;
  language: LspLanguage;
}

interface SessionEntry {
  mutex: AsyncMutex;
  session: LspSession;
}

function sessionKeyId(key: SessionKey): string {
  return `${key.language}\u0000${key.root}`;
}

export class LspNavigationExecutor {
  private readonly getWindowsFiles?: () => LspNavigationContext['windowsFiles'];
  constructor(getWindowsFiles?: () => LspNavigationContext['windowsFiles']) { this.getWindowsFiles = getWindowsFiles; }
  private readonly sessions = new Map<string, SessionEntry>();

  canHandle(toolName: string): boolean {
    const bare = stripToolNamespace(toolName);
    return bare === LSP_NAVIGATION_TOOL_NAMES.DEFINITION
      || bare === LSP_NAVIGATION_TOOL_NAMES.REFERENCES
      || bare === LSP_NAVIGATION_TOOL_NAMES.HOVER
      || bare === LSP_NAVIGATION_TOOL_NAMES.DOCUMENT_SYMBOLS;
  }

  sensitivityLevel(_toolName?: string): 'low' | 'medium' | 'high' {
    // 查询本身只读，但启动外部语言服务器属于进程执行，因此不是 Low。
    return 'medium';
  }

  concurrencyClass(_toolName?: string): 'read_only' | 'safe_parallel' | 'serial' {
    return 'serial';
  }

  managesCancellation(): boolean {
    return true;
  }

  /** Rust `Drop` 释放所有缓存的语言服务器子进程。 */
  dispose(): void {
    for (const entry of this.sessions.values()) entry.session.kill();
    this.sessions.clear();
  }

  name(): string { return 'LspNavigationExecutor'; }

  private async session(
    key: SessionKey,
    appVersion: string,
    signal?: AbortSignal,
  ): Promise<SessionEntry> {
    if (signal?.aborted) throw new Error('LSP navigation cancelled');
    const id = sessionKeyId(key);
    const existing = this.sessions.get(id);
    if (existing !== undefined) {
      let running: boolean;
      try {
        running = await withTimeoutAndCancellation(
          existing.mutex.run(async () => existing.session.isRunning()),
          REQUEST_TIMEOUT_MS,
          `${serverName(key.language)} session wait timed out`,
          signal,
        );
      } catch (error) {
        this.removeSession(key);
        throw error;
      }
      if (running) return existing;
      this.sessions.delete(id);
    }
    const initializer = new AbortController();
    const forwardAbort = (): void => { initializer.abort(); };
    if (signal !== undefined) {
      if (signal.aborted) initializer.abort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }
    let session: LspSession;
    try {
      session = await withTimeoutAndCancellation(
        LspSession.start({
          root: key.root,
          language: key.language,
          appVersion,
          signal: initializer.signal,
        }),
        REQUEST_TIMEOUT_MS,
        `${serverName(key.language)} initialization timed out`,
        signal,
      );
    } catch (error) {
      initializer.abort();
      throw error;
    } finally {
      if (signal !== undefined) signal.removeEventListener('abort', forwardAbort);
    }
    const entry: SessionEntry = { mutex: new AsyncMutex(), session };
    this.sessions.set(id, entry);
    return entry;
  }

  private removeSession(key: SessionKey): void {
    const id = sessionKeyId(key);
    const entry = this.sessions.get(id);
    if (entry === undefined) return;
    this.sessions.delete(id);
    void entry.session.kill();
  }

  private async executeQuery(
    toolName: string,
    args: { [key: string]: JsonValue },
    ctx: LspNavigationContext,
  ): Promise<JsonValue> {
    if (ctx.signal?.aborted) throw new Error('LSP navigation cancelled');
    const positionRequired = toolName !== LSP_NAVIGATION_TOOL_NAMES.DOCUMENT_SYMBOLS;
    const allowed = toolName === LSP_NAVIGATION_TOOL_NAMES.REFERENCES
      ? ['path', 'line', 'column', 'include_declaration']
      : positionRequired
        ? ['path', 'line', 'column']
        : ['path'];
    ensureAllowedKeys(args, allowed);
    const rawPath = args['path'];
    if (typeof rawPath !== 'string') throw new Error('path is required and must be a string');
    const root = resolveCodeNavigationWorkspace(ctx);
    const resolved = await resolveExistingPathAsync(root, rawPath);
    const sourcePath = resolved.canonical;
    let metadata: fs.Stats;
    try {
      metadata = await fs.promises.stat(sourcePath);
    } catch (error) {
      throw new Error(`Failed to inspect source file: ${ioMessage(error)}`);
    }
    if (!metadata.isFile()) throw new Error('LSP navigation path must be a source file');
    if (metadata.size > MAX_SOURCE_BYTES) {
      throw new Error(`Source file exceeds the ${MAX_SOURCE_BYTES} byte limit`);
    }
    let text: string;
    try {
      const bytes = await fs.promises.readFile(sourcePath);
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`Source file must be UTF-8 text: ${(error as Error).message}`);
    }
    if (ctx.signal?.aborted) throw new Error('LSP navigation cancelled');
    const language = languageForPath(sourcePath);
    const uri = fileUri(sourcePath, false);
    let position: LspPosition | null = null;
    if (positionRequired) {
      const lineValue = args['line'];
      if (typeof lineValue !== 'number' || !Number.isInteger(lineValue) || lineValue < 0) {
        throw new Error('line is required and must be a positive integer');
      }
      const columnValue = args['column'];
      if (typeof columnValue !== 'number' || !Number.isInteger(columnValue) || columnValue < 0) {
        throw new Error('column is required and must be a positive integer');
      }
      position = sourcePosition(text, lineValue, columnValue);
    }
    const key: SessionKey = { root, language };
    const entry = await this.session(key, ctx.appVersion ?? APP_VERSION, ctx.signal);
    const includeDeclaration = typeof args['include_declaration'] === 'boolean'
      ? args['include_declaration']
      : true;
    const query = entry.mutex.run(async () => {
      if (ctx.signal?.aborted) throw new Error('LSP navigation cancelled');
      await entry.session.syncDocument(uri, languageId(language, sourcePath), text);
      const textDocument: JsonValue = { uri };
      let method: string;
      let params: JsonValue;
      if (toolName === LSP_NAVIGATION_TOOL_NAMES.DEFINITION) {
        method = 'textDocument/definition';
        params = { textDocument, position };
      } else if (toolName === LSP_NAVIGATION_TOOL_NAMES.REFERENCES) {
        method = 'textDocument/references';
        params = {
          textDocument,
          position,
          context: { includeDeclaration },
        };
      } else if (toolName === LSP_NAVIGATION_TOOL_NAMES.HOVER) {
        method = 'textDocument/hover';
        params = { textDocument, position };
      } else if (toolName === LSP_NAVIGATION_TOOL_NAMES.DOCUMENT_SYMBOLS) {
        method = 'textDocument/documentSymbol';
        params = { textDocument };
      } else {
        throw new Error(`Unknown LSP navigation tool: ${toolName}`);
      }
      if (ctx.signal?.aborted) throw new Error('LSP navigation cancelled');
      const rawResult = await entry.session.request(method, params);
      const result = normalizeResultUris(rawResult, root);
      return {
        root_id: 'workspace',
        path: resolved.relative.replaceAll('\\', '/'),
        server: serverName(language),
        method,
        result,
      };
    });
    try {
      return await withTimeoutAndCancellation(
        query,
        REQUEST_TIMEOUT_MS,
        `${serverName(language)} request timed out`,
        ctx.signal,
      );
    } catch (error) {
      this.removeSession(key);
      throw error;
    }
  }

  async execute(call: ToolCall, ctx: LspNavigationContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart?.(call.name, call.arguments, call.id);
    let result: JsonValue = null;
    let error: string | null = null;
    try {
      if (this.getWindowsFiles) ctx = { ...ctx, windowsFiles: this.getWindowsFiles() };
      const args = argumentsObject(call.arguments);
      result = await this.executeQuery(stripToolNamespace(call.name), args, ctx);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      result = null;
    }
    const durationMs = Math.trunc(performance.now() - started);
    let info: ToolResultInfo;
    if (error !== null) {
      ctx.emitToolCallError?.(error);
      info = {
        toolCallId: call.id,
        blockId: ctx.blockId ?? undefined,
        toolName: call.name,
        input: call.arguments,
        output: null,
        success: false,
        error,
        durationMs,
      };
    } else {
      ctx.emitToolCallEnd?.({ result, durationMs });
      info = {
        toolCallId: call.id,
        blockId: ctx.blockId ?? undefined,
        toolName: call.name,
        input: call.arguments,
        output: result,
        success: true,
        durationMs,
      };
    }
    this.saveToolBlock(ctx, info);
    return info;
  }

  private saveToolBlock(ctx: LspNavigationContext, result: ToolResultInfo): void {
    if (ctx.saveToolBlock === undefined) return;
    try {
      ctx.saveToolBlock(result);
    } catch (error) {
      // Rust 仅 warn，工具结果仍返回。
      ctx.warn?.(`[LspNavigationExecutor] Failed to persist tool block: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function createLspNavigationExecutor(): LspNavigationExecutor {
  return new LspNavigationExecutor();
}
