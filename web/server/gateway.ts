/**
 * WebUI Server Gateway: pairs `ShellRuntime` (`electron/shell/runtime.ts`) + `assetResponse` +
 * `fsPlugin` / `httpPlugin` / `eventPlugin` with an in-process `serveHost` (`host/kernel/connection.ts`),
 * exposing multi-tab WebSocket IPC, HTTP 206 Range custom-protocol streaming, and browser file staging/export.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { getAppVersion } from '../../electron/build-info.ts';
import { optString, raw, reqInteger, reqString, reqStringArray, type InvokeInput } from '../../electron/shell/args.ts';
import { assetResponse } from '../../electron/shell/asset-protocol.ts';
import { checkRendererMessage, MAX_LOCAL_INVOKE_PAYLOAD, type MainToRenderer } from '../../electron/shell/bridge-messages.ts';
import { deriveScopes, type DerivedScopes } from '../../electron/shell/capabilities.ts';
import { invalidArgs, missingKey, ShellCommandError } from '../../electron/shell/errors.ts';
import type { PendingInvoke, ProtocolSink } from '../../electron/shell/host.ts';
import { resolveHostProfile } from '../../electron/shell/host-profile.ts';
import { hostPathEnv, resolveShellOsDirs, type ShellOsDirMap } from '../../electron/shell/os-dirs.ts';
import * as pathOps from '../../electron/shell/path-ops.ts';
import { BaseDirectory, UnknownPathError, type PathEnvironment, type PathResolver } from '../../electron/shell/paths.ts';
import { createPluginFileResolver } from '../../electron/shell/plugin-lock.ts';
import { PluginUiRegistry, servePluginUiRequest } from '../../electron/shell/plugin-ui-protocol.ts';
import { eventPlugin } from '../../electron/shell/plugins/event.ts';
import { fsPlugin } from '../../electron/shell/plugins/fs.ts';
import { httpPlugin } from '../../electron/shell/plugins/http.ts';
import { ShellRuntime, unsupported, type BuiltinPlugin } from '../../electron/shell/runtime.ts';

const TAURI_VERSION = '2.11.5';
import { FsScope, fsScopeFromPatterns } from '../../electron/shell/scope.ts';
import { resolveShellOp } from '../../electron/shell/shell-ops.ts';
import { loadTauriConfig, type EffectiveTauriConfig, type ShellPlatform } from '../../electron/shell/tauri-config.ts';

import { CapabilityAcl } from '../../host/kernel/acl.ts';
import { serveHost, type HostSession, type HostTransport } from '../../host/kernel/connection.ts';
import { ContractSet } from '../../host/kernel/contracts.ts';
import { envConfigOverrides, hostCallCallerMode } from '../../host/kernel/env-config.ts';
import {
  HOST_PROTOCOL_VERSION,
  type BackendEvent,
  type Handshake,
  type HostToMain,
  type MainToHostMessage,
  type ShellRequest,
} from '../../host/kernel/protocol.ts';

import { decodeRendererMessage, encodeMainMessage } from '../shared/wire.ts';
import type { WebSocketConnection } from './ws.ts';

const DEFAULT_MAX_STAGE_UPLOAD_BYTES = 200 * 1024 * 1024;
const EXPORT_TTL_MS = 30 * 60 * 1000;
const HOST_INSTANCE_LOCK_FILE = '.host-instance.lock';

/**
 * `<appDataDir>/.host-instance.lock` 的持有者记录。
 * `startedAt` 让同一进程里的前后两个实例互不误删对方的锁。
 */
interface HostInstanceLockRecord {
  pid: number;
  role: string;
  startedAt: string;
  origin?: string;
}

const errorCode = (error: unknown): string | null =>
  typeof error === 'object' && error !== null && 'code' in error ? String((error as NodeJS.ErrnoException).code) : null;

/**
 * 与 `host/platform/storage/backup-common.ts` 相同的 PID 存活探测：
 * `process.kill(pid, 0)` 抛 `ESRCH` 才算进程已消失；`EPERM` 说明进程存在但属主不同，
 * 仍按存活处理（宁可拒绝启动，也不和别人的数据库并写）。
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function readHostInstanceLock(lockPath: string): Partial<HostInstanceLockRecord> | null {
  let text: string;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch (error) {
    // 文件不存在或不可读：都按"无法确认持有者"处理，交给接管路径
    void error;
    return null;
  }
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as Partial<HostInstanceLockRecord>;
  } catch (error) {
    void error;
    return {};
  }
}

function hostInstanceBusyError(appDataDir: string, holder: Partial<HostInstanceLockRecord>): Error {
  return new Error(
    `appDataDir "${appDataDir}" is already in use by another Deep Student host process`
    + ` (pid=${holder.pid}, role=${holder.role ?? 'unknown'}).`
    + ' Close the other instance or set a separate DS_APP_DATA_DIR.',
  );
}

/**
 * 跨进程单实例排他锁：同一 `appDataDir` 上第二个 `serveHost` 会同时打开 SQLite 数据库、
 * WebUI 暂存目录与同步租约，互相踩写。用 `wx` 原子创建锁文件；文件已存在时读其中的 PID：
 * 外部存活进程 → 立刻拒绝启动；本进程旧锁或崩溃残留 → 安全接管。
 */
function acquireHostInstanceLock(appDataDir: string, record: HostInstanceLockRecord): string {
  const lockPath = join(appDataDir, HOST_INSTANCE_LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw new Error(
          `cannot create WebUI host instance lock ${JSON.stringify(lockPath)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const holder = readHostInstanceLock(lockPath) ?? {};
      const holderPid = typeof holder.pid === 'number' ? holder.pid : null;
      if (holderPid !== null && holderPid !== process.pid && isProcessAlive(holderPid)) {
        throw hostInstanceBusyError(appDataDir, holder);
      }
      // 本进程自己的旧锁（同进程重建 gateway）或崩溃残留：删掉后以 `wx` 重建，
      // 重建失败说明另一个进程刚好抢先，下一轮会按存活判定拒绝。
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== 'ENOENT') {
          throw new Error(
            `cannot remove stale WebUI host instance lock ${JSON.stringify(lockPath)}: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`,
          );
        }
      }
      continue;
    }
    try {
      writeFileSync(fd, JSON.stringify(record));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return lockPath;
  }
  throw hostInstanceBusyError(appDataDir, readHostInstanceLock(lockPath) ?? {});
}

/**
 * 只在锁仍属于本次启动时删除：`pid` + `startedAt` 都对上才 unlink，
 * 避免同一进程里后启动的实例的锁被先退出的实例顺走。
 */
function releaseHostInstanceLock(lockPath: string, record: HostInstanceLockRecord, log: (message: string) => void): void {
  const holder = readHostInstanceLock(lockPath);
  if (holder === null || holder.pid !== record.pid || holder.startedAt !== record.startedAt) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      log(`[web-host] cannot remove host instance lock ${JSON.stringify(lockPath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Host 启动后确认根目录的锁仍是自己的。
 *
 * `DataSpaceManager.ensureLayout()` 在首次启动时会把 `appDataDir` 根目录里所有非白名单
 * 条目（锁文件也在内）搬进 `slots/slotA`，于是排他锁会在"首次启动"这段窗口里失效。
 * 启动完成后重新核对：根目录锁缺失 → 重建；被外部存活进程持有 → 立刻报同一个占用错误。
 */
function reassertHostInstanceLock(lockPath: string, appDataDir: string, record: HostInstanceLockRecord): void {
  const holder = readHostInstanceLock(lockPath);
  if (holder !== null && holder.pid === record.pid) return;
  if (holder !== null && typeof holder.pid === 'number' && holder.pid !== record.pid && isProcessAlive(holder.pid)) {
    throw hostInstanceBusyError(appDataDir, holder);
  }
  acquireHostInstanceLock(appDataDir, record);
}

export interface WebGatewayOptions {
  repoRoot?: string;
  appDataDir?: string;
  localOrigin: string;
  debug?: boolean;
  safeMode?: boolean;
  /** 单次暂存上传上限（字节），默认 200 MiB。 */
  maxStageUploadBytes?: number;
  log?: (message: string) => void;
}

interface ConnectedTab {
  readonly id: string;
  readonly ws: WebSocketConnection;
}

interface PreparedExport {
  path: string;
  fileName: string;
  expiresAt: number;
}

function sanitizeUploadFileName(rawName: string): string {
  const base = basename(rawName.trim().replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*\u007f]/g, '_').replace(/[. ]+$/, '');
  if (!base || base === '.' || base === '..') return 'file.bin';
  // 文件系统按 UTF-8 字节限制单个文件名，不能按 JS UTF-16 字符数截断。
  const suffix = extname(base);
  const extension = Buffer.byteLength(suffix, 'utf8') < 200 ? suffix : '';
  let result = '';
  const stem = extension ? base.slice(0, -extension.length) : base;
  for (const char of stem) {
    if (Buffer.byteLength(result + char + extension, 'utf8') > 200) break;
    result += char;
  }
  return result + extension;
}

function createPurePathPlugin(): BuiltinPlugin {
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof UnknownPathError) throw new ShellCommandError(error.message);
      if (
        error instanceof Error &&
        (error.message === pathOps.NO_PARENT || error.message === pathOps.NO_EXTENSION || error.message === pathOps.NO_BASENAME)
      ) {
        throw new ShellCommandError(error.message);
      }
      throw error;
    }
  };
  const directoryArg = (input: InvokeInput): number => {
    const v = raw(input, 'directory');
    if (v === undefined) throw missingKey(input.command, 'directory');
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 23) {
      throw invalidArgs(input.command, 'directory', `invalid value: ${JSON.stringify(v)}, expected one of 1..=23`);
    }
    return v;
  };
  return {
    resolve_directory: (input, ctx) => {
      const directory = directoryArg(input);
      const p = optString(input, 'path');
      return wrap(() => ctx.runtime.paths.resolve(directory, p));
    },
    resolve: (input, ctx) => pathOps.resolve(reqStringArray(input, 'paths'), process.cwd(), ctx.runtime.platform),
    normalize: (input, ctx) => pathOps.normalize(reqString(input, 'path'), ctx.runtime.platform),
    join: (input, ctx) => pathOps.join(reqStringArray(input, 'paths'), ctx.runtime.platform),
    dirname: (input, ctx) => wrap(() => pathOps.dirname(reqString(input, 'path'), ctx.runtime.platform)),
    extname: (input, ctx) => wrap(() => pathOps.extname(reqString(input, 'path'), ctx.runtime.platform)),
    basename: (input, ctx) => wrap(() => pathOps.basename(reqString(input, 'path'), optString(input, 'ext'), ctx.runtime.platform)),
    is_absolute: (input, ctx) => pathOps.isAbsolute(reqString(input, 'path'), ctx.runtime.platform),
  };
}

function createPureAppPlugin(): BuiltinPlugin {
  const no = (command: string, reason: string) => unsupported('app', command, reason);
  return {
    version: (_input, ctx) => ctx.runtime.appVersion,
    name: (_input, ctx) => ctx.runtime.config.productName,
    tauri_version: () => TAURI_VERSION,
    identifier: (_input, ctx) => ctx.runtime.config.identifier,
    bundle_type: () => 'web',
    supports_multiple_windows: () => false,
    app_show: () => null,
    app_hide: () => null,
    set_app_theme: () => null,
    set_dock_visibility: () => null,
    default_window_icon: no('default_window_icon', 'image rids are unavailable in WebUI'),
    fetch_data_store_identifiers: no('fetch_data_store_identifiers', 'unavailable in WebUI'),
    remove_data_store: no('remove_data_store', 'unavailable in WebUI'),
  };
}

function createPureResourcesPlugin(): BuiltinPlugin {
  return {
    close: async (input, ctx) => {
      await ctx.runtime.closeResource(ctx.webviewLabel, reqInteger(input, 'rid'));
      return null;
    },
  };
}

function createNoopNotificationPlugin(): BuiltinPlugin {
  return {
    is_permission_granted: () => false,
    request_permission: () => 'denied',
    notify: () => null,
  };
}

function createNoopUpdaterPlugin(): BuiltinPlugin {
  return {
    check: () => null,
    download_and_install: unsupported('updater', 'download_and_install', 'WebUI updates are deployed on the server'),
    download: unsupported('updater', 'download', 'WebUI updates are deployed on the server'),
    install: unsupported('updater', 'install', 'WebUI updates are deployed on the server'),
  };
}

function createNoopShortcutPlugin(): BuiltinPlugin {
  return {
    register: () => null,
    register_all: () => null,
    unregister: () => null,
    unregister_all: () => null,
    is_registered: () => false,
  };
}

/**
 * WebUI 下的 `plugin:process` 适配器：
 * 浏览器会话共享同一个 HTTP/WS 网关进程，不能直接 `process.exit()` 杀掉服务或断开端口；
 * `restart` / `relaunch` 改为异步触发进程内 Host 热重建并同步状态，然后向前端广播 `host://webui-reload`。
 */
function createWebProcessPlugin(onRestart: () => void): BuiltinPlugin {
  return {
    exit: () => null,
    relaunch: () => {
      onRestart();
      return null;
    },
    restart: () => {
      onRestart();
      return null;
    },
  };
}

class InProcessHostBridge {
  private readonly listeners: Array<(message: unknown) => void> = [];
  private readonly pendingInvokes = new Map<string, PendingInvoke>();
  private readonly pendingProtocols = new Map<string, ProtocolSink>();
  private queue: MainToHostMessage[] = [];
  private isReady = false;
  private nextSeq = 1;
  private readonly onEvent: (event: BackendEvent) => void;
  private readonly onShellRequest: (request: ShellRequest) => Promise<unknown>;
  private readonly onFatal?: (reason: string) => void;
  private readonly log: (message: string) => void;

  constructor(deps: {
    onEvent: (event: BackendEvent) => void;
    onShellRequest: (request: ShellRequest) => Promise<unknown>;
    onFatal?: (reason: string) => void;
    log: (message: string) => void;
  }) {
    this.onEvent = deps.onEvent;
    this.onShellRequest = deps.onShellRequest;
    this.onFatal = deps.onFatal;
    this.log = deps.log;
  }

  private failAllPending(reason: string): void {
    for (const [, pending] of this.pendingInvokes) {
      pending.resolve({ ok: false, error: reason });
    }
    this.pendingInvokes.clear();
    for (const [, sink] of this.pendingProtocols) {
      sink.fail(reason);
    }
    this.pendingProtocols.clear();
  }

  dispose(reason: string): void {
    this.isReady = false;
    this.queue = [];
    this.failAllPending(reason);
  }

  get readyState(): boolean {
    return this.isReady;
  }

  createTransport(): HostTransport {
    return {
      send: (message: HostToMain) => this.handleFromHost(message),
      onMessage: (listener: (message: unknown) => void) => {
        this.listeners.push(listener);
      },
      onClose: () => undefined,
      close: () => undefined,
    };
  }

  deliverHandshake(handshake: Handshake): void {
    this.deliverToHost(handshake);
  }

  private deliverToHost(message: MainToHostMessage): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  sendMessage(message: MainToHostMessage): void {
    if (!this.isReady) {
      this.queue.push(message);
      return;
    }
    this.deliverToHost(message);
  }

  invoke(
    req: { cmd: string; args: unknown; argsJson?: string; source: { window: string; webview: string; origin?: string }; headers?: Record<string, string> },
    pending: PendingInvoke,
  ): void {
    const id = `web-inv-${this.nextSeq++}`;
    this.pendingInvokes.set(id, pending);
    this.sendMessage({
      kind: 'invoke',
      id,
      cmd: req.cmd,
      args: req.args,
      ...(req.argsJson !== undefined ? { argsJson: req.argsJson } : {}),
      source: req.source,
      ...(req.headers !== undefined ? { headers: req.headers } : {}),
    });
  }

  protocol(
    req: { scheme: string; url: string; method: string; headers: Record<string, string>; body?: Uint8Array },
    sink: ProtocolSink,
  ): void {
    const id = `web-proto-${this.nextSeq++}`;
    this.pendingProtocols.set(id, sink);
    this.sendMessage({
      kind: 'protocol',
      id,
      scheme: req.scheme,
      url: req.url,
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
  }

  abandonWebview(label: string, reason: 'window-closed' | 'reloaded'): void {
    for (const [id, pending] of this.pendingInvokes) {
      if (pending.webview === label) {
        this.pendingInvokes.delete(id);
        this.sendMessage({ kind: 'abandon', id, reason });
      }
    }
  }

  private handleFromHost(message: HostToMain): void {
    switch (message.kind) {
      case 'ready': {
        this.isReady = true;
        const queued = this.queue;
        this.queue = [];
        for (const item of queued) this.deliverToHost(item);
        return;
      }
      case 'fatal': {
        this.log(`[web-host] fatal: ${message.message}${message.stack ? `\n${message.stack}` : ''}`);
        this.onFatal?.(message.message);
        this.failAllPending(message.message);
        return;
      }
      case 'result': {
        const pending = this.pendingInvokes.get(message.id);
        if (!pending) return;
        this.pendingInvokes.delete(message.id);
        if (message.ok) {
          pending.resolve({ ok: true, value: message.value, ...(message.json !== undefined ? { json: message.json } : {}) });
        } else {
          pending.resolve({ ok: false, error: message.error, ...(message.json !== undefined ? { json: message.json } : {}) });
        }
        return;
      }
      case 'event': {
        this.onEvent(message);
        return;
      }
      case 'shell-request': {
        void this.onShellRequest(message).then(
          (value) => this.deliverToHost({ kind: 'shell-result', id: message.id, ok: true, value: value ?? null }),
          (error: unknown) =>
            this.deliverToHost({
              kind: 'shell-result',
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
        return;
      }
      case 'protocol-result': {
        const sink = this.pendingProtocols.get(message.id);
        if (!sink) return;
        if (message.final) this.pendingProtocols.delete(message.id);
        sink.head(message);
        return;
      }
      case 'protocol-chunk': {
        const sink = this.pendingProtocols.get(message.id);
        if (!sink) return;
        if (message.final) this.pendingProtocols.delete(message.id);
        sink.chunk(message);
        return;
      }
    }
  }
}

export interface WebHostGateway {
  readonly appDataDir: string;
  readonly config: EffectiveTauriConfig;
  readonly ready: Promise<void>;
  isReady(): boolean;
  attachWebSocket(ws: WebSocketConnection): void;
  handleProtocolHttp(
    scheme: string,
    rawPath: string,
    req: IncomingMessage,
    res: ServerResponse,
    extraQuery?: string,
  ): Promise<void>;
  handleStageUpload(fileName: string, req: IncomingMessage, res: ServerResponse): Promise<void>;
  handlePrepareSave(bodyJson: string, res: ServerResponse): Promise<void>;
  handleDownloadExport(exportId: string, res: ServerResponse): Promise<void>;
  shutdown(): Promise<void>;
}

export function createWebHostGateway(options: WebGatewayOptions): WebHostGateway {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const tauriDir = join(repoRoot, 'resources/app');
  const platform: ShellPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const debug = options.debug ?? true;
  const safeMode = options.safeMode ?? false;
  const maxStageUploadBytes = options.maxStageUploadBytes ?? DEFAULT_MAX_STAGE_UPLOAD_BYTES;
  const log = options.log ?? ((msg: string) => process.stdout.write(`[dstu-web] ${msg}\n`));

  const config = loadTauriConfig(tauriDir, platform);
  const migrationsDir = process.env.DS_MIGRATIONS_DIR ?? join(tauriDir, 'migrations');
  process.env.DS_MIGRATIONS_DIR = migrationsDir;

  const appDataOverride = options.appDataDir ?? process.env.DS_APP_DATA_DIR;
  const pathEnv: PathEnvironment = {
    platform,
    env: { ...process.env },
    fallbackHome: homedir(),
    identifier: config.identifier,
    tempDir: tmpdir(),
    resourceDir: tauriDir,
    windowsKnownFolders: {},
  };
  const osResolved = resolveShellOsDirs(pathEnv, appDataOverride);
  const paths: PathResolver = osResolved.paths;
  const osDirs: ShellOsDirMap = osResolved.dirs;
  const resolvedAppDataDir = paths.appDataDir();
  if (resolvedAppDataDir === null) {
    throw new Error('cannot resolve WebUI appDataDir');
  }
  const appDataDir: string = resolvedAppDataDir;
  mkdirSync(appDataDir, { recursive: true });

  // 单实例排他锁必须早于任何数据库/暂存目录/租约的打开：第二个 host 进程
  // 一旦进到 `serveHost` 就会与前者并写同一个 SQLite 与同步租约。
  const instanceLockRecord: HostInstanceLockRecord = {
    pid: process.pid,
    role: 'web',
    startedAt: new Date().toISOString(),
    origin: options.localOrigin,
  };
  const instanceLockPath = acquireHostInstanceLock(appDataDir, instanceLockRecord);

  for (const [k, v] of Object.entries(hostPathEnv(osDirs, config.identifier))) {
    process.env[k] = v;
  }

  const userDataDir = join(appDataDir, '.web-userdata');
  const derived: DerivedScopes = deriveScopes(join(tauriDir, 'capabilities'), platform);
  const assetScope = fsScopeFromPatterns(paths, platform, config.assetScope.allow, config.assetScope.deny, userDataDir);
  const fsGlobal = fsScopeFromPatterns(paths, platform, derived.fsAllow, derived.fsDeny, userDataDir);
  const fsRuntime = new FsScope({ platform });

  const stagingRoot = join(appDataDir, 'web-staging');
  const exportsRoot = join(appDataDir, 'web-exports');
  mkdirSync(stagingRoot, { recursive: true });
  mkdirSync(exportsRoot, { recursive: true });
  fsRuntime.allowDirectory(stagingRoot, true);
  fsRuntime.allowDirectory(exportsRoot, true);
  assetScope.allowDirectory(stagingRoot, true);
  assetScope.allowDirectory(exportsRoot, true);

  const runtime = new ShellRuntime({
    platform,
    debug,
    config,
    paths,
    assetScope,
    fsScope: fsRuntime,
    appVersion: config.version,
    localOrigin: options.localOrigin,
    userDataDir,
    log,
  });

  runtime.registerPlugin('event', eventPlugin());
  runtime.registerPlugin('path', createPurePathPlugin());
  runtime.registerPlugin('app', createPureAppPlugin());
  runtime.registerPlugin('resources', createPureResourcesPlugin());
  runtime.registerPlugin('fs', fsPlugin({ global: fsGlobal, runtime: fsRuntime }));
  runtime.registerPlugin('http', httpPlugin({ allow: derived.httpAllow, deny: derived.httpDeny }));
  runtime.registerPlugin('notification', createNoopNotificationPlugin());
  runtime.registerPlugin('updater', createNoopUpdaterPlugin());
  runtime.registerPlugin('global-shortcut', createNoopShortcutPlugin());
  let shuttingDown = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restartInFlight: Promise<void> | null = null;
  const scheduleHostRestart = () => {
    if (shuttingDown || restartTimer !== null) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void restartHost();
    }, 20);
    restartTimer.unref?.();
  };
  runtime.registerPlugin('process', createWebProcessPlugin(scheduleHostRestart));

  const pluginUi = new PluginUiRegistry(safeMode);
  const pluginFiles = createPluginFileResolver(join(appDataDir, 'plugins'));

  // Multi-tab multiplexer backing the canonical `'main'` ShellWindow
  const tabs = new Map<string, ConnectedTab>();
  let tabSeq = 1;
  let startupReadyMarked = false;

  const sendToTab = (tab: ConnectedTab, message: MainToRenderer) => {
    if (!tab.ws.open) return;
    tab.ws.send(encodeMainMessage(message));
  };

  const dispatchFromRuntimeToTabs = (message: MainToRenderer, sourceTab?: ConnectedTab) => {
    if (sourceTab) {
      sendToTab(sourceTab, message);
      return;
    }
    switch (message.type) {
      case 'result':
      case 'listen-js':
      case 'emit-js':
      case 'callback':
      case 'channel': {
        // Tab-local messages must never be broadcast if their webview has gone away.
        return;
      }
      default: {
        for (const tab of tabs.values()) sendToTab(tab, message);
      }
    }
  };

  const virtualMainWindow = {
    label: 'main',
    webContents: {
      id: 1,
      isDestroyed: () => false,
      getURL: () => `${options.localOrigin}/`,
      send: (_channel: string, message: MainToRenderer) => dispatchFromRuntimeToTabs(message),
    },
    browserWindow: {
      isDestroyed: () => false,
      isFocused: () => tabs.size > 0,
      isVisible: () => tabs.size > 0,
      isMinimized: () => false,
      setVibrancy: () => undefined,
    },
  };

  runtime.windows = {
    get: (label: string) => {
      if (label === 'main') return virtualMainWindow as never;
      const tab = tabs.get(label);
      if (!tab) return undefined;
      return {
        ...virtualMainWindow,
        webContents: {
          ...virtualMainWindow.webContents,
          isDestroyed: () => !tab.ws.open,
          send: (_channel: string, message: MainToRenderer) => dispatchFromRuntimeToTabs(message, tab),
        },
      } as never;
    },
    labels: () => ['main', ...tabs.keys()],
    listWindows: () => [{ label: 'main', focused: tabs.size > 0, visible: tabs.size > 0, minimized: false }],
    getMainWindow: () => ({ label: 'main', focused: tabs.size > 0, visible: tabs.size > 0, minimized: false }),
    byWebContents: () => undefined,
  } as never;

  const withId = (base: string | null) => (base === null ? null : join(base, config.identifier));

  const handleWebShellRequest = async (request: ShellRequest): Promise<unknown> => {
    const args = (request.args ?? {}) as Record<string, unknown>;
    if (request.op === 'app.fullVersion') return getAppVersion();
    if (request.op === 'app.startupReady') {
      startupReadyMarked = true;
      return null;
    }
    if (request.op === 'app.migrationsDir') return migrationsDir;
    if (request.op === 'window.listWindows') return [{ label: 'main', focused: tabs.size > 0, visible: tabs.size > 0, minimized: false }];
    if (request.op === 'window.getMainWindow') return { label: 'main', focused: tabs.size > 0, visible: tabs.size > 0, minimized: false };
    if (request.op === 'app.mainWindowActive') return tabs.size > 0;
    if (request.op === 'app.dataDirs') {
      return {
        data: appDataDir,
        localData: withId(osDirs.dataLocal),
        cache: withId(osDirs.cache),
        dataLocalDir: osDirs.dataLocal,
      };
    }
    if (
      request.op === 'window.setVibrancy' ||
      request.op === 'window.setAppearance' ||
      request.op === 'window.syncTitlebarSidebarMaterial'
    ) {
      return request.op === 'window.setVibrancy' ? false : null;
    }
    if (request.op === 'app.pdfStreamAllowedDirs') {
      const dirs = new Set<string>();
      const add = (dir: string | null) => {
        if (dir !== null && dir !== '') dirs.add(dir);
      };
      add(appDataDir);
      add(stagingRoot);
      add(exportsRoot);
      add(withId(osDirs.dataLocal));
      add(withId(osDirs.cache));
      for (const directory of [
        BaseDirectory.Document,
        BaseDirectory.Download,
        BaseDirectory.Temp,
        BaseDirectory.Resource,
        BaseDirectory.Desktop,
        BaseDirectory.Picture,
      ]) {
        try {
          add(paths.resolveDirectory(directory));
        } catch (error) {
          if (!(error instanceof UnknownPathError)) throw error;
        }
      }
      return [...dirs];
    }
    if (request.op.startsWith('browser.')) {
      throw new Error(`embedded native browser surface (${request.op}) is unavailable in WebUI mode`);
    }
    const windowLabel = typeof args.__window === 'string' ? args.__window : 'main';
    const builtin = runtime.runBuiltin(
      resolveShellOp(request.op),
      { json: args, raw: null, headers: {} },
      { runtime, windowLabel, webviewLabel: windowLabel },
    );
    if (builtin === undefined) {
      throw new Error(`unknown shell op in WebUI: ${request.op}`);
    }
    try {
      return await builtin;
    } catch (error) {
      if (error instanceof ShellCommandError) {
        throw new Error(typeof error.value === 'string' ? error.value : JSON.stringify(error.value));
      }
      throw error;
    }
  };

  const parseEventPayload = (event: BackendEvent): unknown => {
    if (event.payload !== undefined) return event.payload;
    if (event.payloadJson !== undefined) return JSON.parse(event.payloadJson);
    return undefined;
  };

  const syncPluginUiFromEvent = (event: BackendEvent): void => {
    if (event.event === 'host://ui-manifest') {
      try {
        pluginUi.update(parseEventPayload(event));
      } catch (error) {
        pluginUi.invalidate();
        log(`[web-host] invalid UI manifest: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (event.event === 'host://ui-manifest-v2') {
      try {
        const payload = parseEventPayload(event) as { version?: unknown; plugins?: unknown } | null;
        if (payload && typeof payload === 'object' && payload.version === 2 && Array.isArray(payload.plugins)) {
          const community = payload.plugins
            .filter((item): item is { id: string; origin: string; file: string; version?: string } =>
              typeof item === 'object' &&
              item !== null &&
              (item as { origin?: unknown }).origin === 'community' &&
              typeof (item as { id?: unknown }).id === 'string' &&
              typeof (item as { file?: unknown }).file === 'string' &&
              (item as { file: string }).file.length > 0,
            )
            .map((item) => ({
              id: item.id,
              file: item.file,
              ...(typeof item.version === 'string' ? { version: item.version } : {}),
            }));
          pluginUi.update(community);
        } else {
          pluginUi.invalidate();
        }
      } catch (error) {
        pluginUi.invalidate();
        log(`[web-host] invalid UI manifest v2: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const hostEntry = join(repoRoot, 'host', 'kernel', 'main.ts');
  let activeBridge!: InProcessHostBridge;
  let activeSession!: HostSession;

  const startHostSession = () => {
    const bridge = new InProcessHostBridge({
      onEvent: (event) => {
        syncPluginUiFromEvent(event);
        const payloadJson =
          event.payloadJson !== undefined
            ? event.payloadJson
            : (() => {
                try {
                  return JSON.stringify(event.payload ?? null);
                } catch (error) {
                  log(`[web-host] dropped non-JSON event "${event.event}": ${String(error)}`);
                  return null;
                }
              })();
        if (payloadJson !== null) {
          runtime.emitTo(event.target, event.event, payloadJson);
        }
      },
      onShellRequest: handleWebShellRequest,
      onFatal: () => {
        pluginUi.invalidate();
      },
      log,
    });
    activeBridge = bridge;
    runtime.host = bridge as never;

    const hostProfile = resolveHostProfile({
      safeMode,
      override: process.env.DS_HOST_PROFILE,
      appDataDir,
      hostEntry,
      exists: existsSync,
    });

    const session = serveHost(bridge.createTransport(), {
      acl: (app) => CapabilityAcl.fromDirectory(app.platform, tauriDir),
      profile: hostProfile,
      contracts: () => ContractSet.fromDirectory(join(repoRoot, 'contracts', 'ipc')),
      configOverrides: envConfigOverrides(process.env),
      hostCallCaller: hostCallCallerMode(process.env),
      ...(safeMode ? { safeMode: true } : {}),
      exit: (code) => {
        log(`[web-host] host session exited with code ${code}`);
      },
    });
    activeSession = session;

    bridge.deliverHandshake({
      kind: 'handshake',
      protocol: HOST_PROTOCOL_VERSION,
      appDataDir,
      appVersion: config.version,
      platform,
      debug,
      profile: hostProfile,
    });

    return { bridge, session };
  };

  const invokeHostCommand = (cmd: string, args: unknown): Promise<unknown> =>
    new Promise<unknown>((resolveInvoke, rejectInvoke) => {
      activeBridge.invoke(
        { cmd, args, source: { window: 'main', webview: 'main' } },
        {
          webview: 'main',
          resolve: (result) => {
            if (result.ok) {
              resolveInvoke(result.value);
              return;
            }
            const error = result.error;
            rejectInvoke(
              new Error(typeof error === 'string' ? error : error === undefined ? 'Host command failed' : JSON.stringify(error)),
            );
          },
        },
      );
    });

  const syncHostStateAfterRestart = async (): Promise<void> => {
    const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T | undefined> =>
      Promise.race([
        promise.catch((error) => {
          log(`[web-host] post-restart ${label} skipped: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }),
        new Promise<undefined>((resolveTimeout) => {
          const timer = setTimeout(() => resolveTimeout(undefined), 1500);
          timer.unref?.();
        }),
      ]);

    const [manifestV2, degraded] = await Promise.all([
      withTimeout(invokeHostCommand('plugin:ui|manifest', { version: 2 }), 'plugin:ui|manifest'),
      withTimeout(invokeHostCommand('plugin:host|status', {}), 'plugin:host|status'),
    ]);

    if (manifestV2 !== undefined) {
      if (Array.isArray(manifestV2)) {
        try {
          pluginUi.update(manifestV2);
        } catch {
          pluginUi.invalidate();
        }
        runtime.emitTo({ kind: 'Any' }, 'host://ui-manifest', JSON.stringify(manifestV2));
      } else if (
        typeof manifestV2 === 'object' &&
        manifestV2 !== null &&
        (manifestV2 as { version?: unknown }).version === 2 &&
        Array.isArray((manifestV2 as { plugins?: unknown }).plugins)
      ) {
        const v2 = manifestV2 as { plugins: Array<{ id: string; origin?: string; file?: string; version?: string }> };
        const community = v2.plugins
          .filter((p) => p.origin === 'community' && typeof p.file === 'string' && p.file.length > 0)
          .map((p) => ({
            id: p.id,
            file: p.file!,
            ...(typeof p.version === 'string' ? { version: p.version } : {}),
          }));
        try {
          pluginUi.update(community);
        } catch {
          pluginUi.invalidate();
        }
        runtime.emitTo({ kind: 'Any' }, 'host://ui-manifest', JSON.stringify(community));
        runtime.emitTo({ kind: 'Any' }, 'host://ui-manifest-v2', JSON.stringify(manifestV2));
      }
    }

    if (Array.isArray(degraded)) {
      runtime.emitTo({ kind: 'Any' }, 'host://plugins-degraded', JSON.stringify(degraded));
    }
  };

  async function restartHost(): Promise<void> {
    if (shuttingDown) return;
    if (restartInFlight) return restartInFlight;
    restartInFlight = (async () => {
      log('[web-host] restarting Host session in-process...');
      pluginUi.invalidate();
      const previousBridge = activeBridge;
      const previousSession = activeSession;
      previousBridge.dispose('WebUI Host restarting');
      await previousSession.shutdown();
      if (shuttingDown) return;

      const next = startHostSession();
      const rt = await next.session.ready;
      if (!rt) throw new Error('WebUI Host failed to become ready after restart');
      if (shuttingDown) return;
      reassertHostInstanceLock(instanceLockPath, appDataDir, instanceLockRecord);
      await syncHostStateAfterRestart();
      if (!shuttingDown) {
        runtime.emitTo({ kind: 'Any' }, 'host://webui-reload', JSON.stringify({ reason: 'process-restart' }));
      }
      log('[web-host] Host session restarted');
    })()
      .catch((error) => {
        log(`[web-host] Host restart failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        restartInFlight = null;
      });
    return restartInFlight;
  }

  const initial = startHostSession();
  const ready = initial.session.ready.then((rt) => {
    if (!rt) throw new Error('WebUI Host failed to become ready');
    // 首次启动的 legacy 根目录迁移会把锁文件搬进 slots/slotA，这里在 Host 真正可用后补回。
    reassertHostInstanceLock(instanceLockPath, appDataDir, instanceLockRecord);
    log(`[web-host] ready (appDataDir=${appDataDir}, startupGate=${startupReadyMarked})`);
  });

  const preparedExports = new Map<string, PreparedExport>();

  const gcPreparedExports = async () => {
    const now = Date.now();
    const expired: Promise<void>[] = [];
    for (const [id, item] of preparedExports) {
      if (item.expiresAt <= now) {
        preparedExports.delete(id);
        expired.push(rm(join(exportsRoot, id), { recursive: true, force: true }).catch((error: unknown) => {
          log(`[web-host] cannot remove expired export ${id}: ${String(error)}`);
        }));
      }
    }
    await Promise.all(expired);
  };

  return {
    appDataDir,
    config,
    ready,
    isReady() {
      return activeBridge.readyState;
    },
    attachWebSocket(ws: WebSocketConnection) {
      const tab: ConnectedTab = {
        id: `web-${tabSeq++}`,
        ws,
      };
      tabs.set(tab.id, tab);

      ws.onMessage((rawFrame) => {
        let decoded: unknown;
        try {
          decoded = decodeRendererMessage(rawFrame);
        } catch (error) {
          log(`[ws:${tab.id}] malformed wire frame: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        const checked = checkRendererMessage(decoded, MAX_LOCAL_INVOKE_PAYLOAD);
        if (!checked.ok) {
          log(`[ws:${tab.id}] rejected renderer message: ${checked.reason}`);
          if (checked.reply !== null) {
            sendToTab(tab, {
              type: 'result',
              callbackId: checked.reply.error,
              otherId: checked.reply.callback,
              body: ShellRuntime.encodeBody(`invalid IPC message: ${checked.reason}`),
            });
          }
          return;
        }
        const msg = checked.message;
        if (msg.type === 'invoke') {
          // Keep the canonical main capability identity, but give each connection its own
          // resource/pending-invoke domain and reply route (callback ids are tab-local).
          runtime.handleWebviewInvoke(virtualMainWindow as never, tab.id, msg, `${options.localOrigin}/`, 'main');
        } else if (msg.type === 'drag-drop' && msg.phase === 'drop' && msg.paths) {
          for (const p of msg.paths) {
            fsRuntime.allowFile(p);
            assetScope.allowFile(p);
          }
        }
      });

      ws.onClose(() => {
        tabs.delete(tab.id);
        runtime.webviewGone(tab.id, 'window-closed');
      });
    },

    async handleProtocolHttp(
      scheme: string,
      rawPath: string,
      req: IncomingMessage,
      res: ServerResponse,
      extraQuery = '',
    ): Promise<void> {
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
      }

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
      }

      if (scheme === 'ds-plugin') {
        const trimmed = rawPath.replace(/^\/+/, '');
        const pluginUrl = `ds-plugin://${trimmed}${extraQuery ? `?${extraQuery}` : ''}`;
        let request: Request;
        try {
          request = new Request(pluginUrl, { method });
        } catch (error) {
          res.writeHead(400, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(`invalid ds-plugin URL: ${error instanceof Error ? error.message : String(error)}\n`);
          return;
        }
        const response = await servePluginUiRequest(
          request,
          pluginUi,
          () => invokeHostCommand('plugin:ui|manifest', {}),
          pluginFiles,
        );
        const outHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          outHeaders[key] = value;
        });
        res.writeHead(response.status, outHeaders);
        if (method === 'HEAD' || response.body === null) {
          res.end();
          return;
        }
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }

      // 额外查询串（`mime=` / `qn=` 等）必须留在 pathname 之外：客户端把 `?mime=` 拼到
      // `?path=` 后面，路径里带 `?` 会让 realpath 找不到文件，媒体类型覆盖也失效。
      const encodedTarget = encodeURIComponent(rawPath);
      const protocolUrl = `${scheme}://localhost/${encodedTarget}${extraQuery ? `?${extraQuery}` : ''}`;

      if (scheme === 'asset') {
        const result = await assetResponse(
          { url: protocolUrl, method, headers },
          assetScope,
          options.localOrigin,
          platform,
        );
        res.writeHead(result.status, result.headers);
        if (method === 'HEAD' || result.body === null) {
          if (result.body instanceof ReadableStream) await result.body.cancel();
          res.end();
          return;
        }
        if (result.body instanceof Uint8Array) {
          res.end(Buffer.from(result.body));
          return;
        }
        const nodeStream = Readable.fromWeb(result.body as import('node:stream/web').ReadableStream);
        await pipeline(nodeStream, res).catch(() => undefined);
        return;
      }

      if (scheme === 'pdfstream' || scheme === 'filestream' || scheme === 'bilistream') {
        await new Promise<void>((resolveDone) => {
          let settled = false;
          let headWritten = false;
          // 客户端中途关页/切歌后，Host 仍会继续把整段文件分块推过来；继续 write 只会
          // 在已销毁的 socket 上堆 ERROR 并占用 CPU，所以立刻停止写入。
          let clientClosed = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            resolveDone();
          };
          req.once('aborted', () => {
            clientClosed = true;
          });
          res.once('close', () => {
            clientClosed = true;
            settle();
          });
          activeBridge.protocol(
            { scheme, url: protocolUrl, method, headers },
            {
              head(response) {
                headWritten = true;
                if (clientClosed) {
                  settle();
                  return;
                }
                res.writeHead(response.status, response.headers);
                if (method !== 'HEAD' && response.body.byteLength > 0) {
                  res.write(Buffer.from(response.body));
                }
                if (response.final || method === 'HEAD') {
                  res.end();
                  settle();
                }
              },
              chunk(chunk) {
                if (chunk.error) {
                  res.destroy(new Error(chunk.error));
                  settle();
                  return;
                }
                if (!clientClosed && !res.writableEnded && chunk.body.byteLength > 0 && method !== 'HEAD') {
                  res.write(Buffer.from(chunk.body));
                }
                if (chunk.final) {
                  if (!clientClosed && !res.writableEnded) res.end();
                  settle();
                }
              },
              fail(message) {
                if (!headWritten && !res.headersSent && !clientClosed) {
                  res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
                  res.end(message);
                } else if (!res.writableEnded) {
                  res.destroy(new Error(message));
                }
                settle();
              },
            },
          );
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Unsupported protocol scheme: ${scheme}`);
    },

    async handleStageUpload(fileName: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
      const safeName = sanitizeUploadFileName(fileName);
      const slotDir = join(stagingRoot, randomUUID());
      await mkdir(slotDir, { recursive: true });
      const destPath = join(slotDir, safeName);

      let written = 0;
      const out = createWriteStream(destPath, { flags: 'wx' });
      // 写流错误（磁盘满、权限、fd 回收）必须以 'error' 事件消费，否则会作为未捕获异常打穿进程。
      let streamError: Error | null = null;
      const takeStreamError = (): Error | null => streamError;
      out.on('error', (error: unknown) => {
        streamError ??= error instanceof Error ? error : new Error(String(error));
      });

      /**
       * 超限（413）、客户端中途断开、磁盘错误时删掉半截文件与空槽目录。
       * 先等写流 'close' 再删，避免删除与内核仍在排队的写入竞争出残留文件。
       */
      const discardPartial = async () => {
        const closed = out.closed
          ? Promise.resolve()
          : new Promise<void>((resolveClose) => {
              out.once('close', () => resolveClose());
            });
        out.destroy();
        await closed;
        await rm(slotDir, { recursive: true, force: true }).catch(() => undefined);
      };

      try {
        for await (const chunk of req) {
          const pendingError = takeStreamError();
          if (pendingError) throw pendingError;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          written += buf.byteLength;
          if (written > maxStageUploadBytes) {
            await discardPartial();
            res.writeHead(413, {
              'Content-Type': 'application/json; charset=utf-8',
              Connection: 'close',
            });
            res.end(JSON.stringify({ error: `File exceeds ${maxStageUploadBytes} bytes limit` }));
            return;
          }
          if (!out.write(buf)) {
            await new Promise<void>((resolveDrain) => {
              const done = () => {
                out.off('drain', done);
                out.off('error', done);
                resolveDrain();
              };
              out.once('drain', done);
              out.once('error', done);
            });
          }
        }
        const pendingError = takeStreamError();
        if (pendingError) throw pendingError;
        await new Promise<void>((resolveClose, rejectClose) => {
          out.end(() => {
            out.off('error', rejectClose);
            resolveClose();
          });
          out.once('error', rejectClose);
        });
      } catch (error) {
        await discardPartial();
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }

      fsRuntime.allowFile(destPath);
      assetScope.allowFile(destPath);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ path: destPath, name: safeName, size: written }));
    },

    async handlePrepareSave(bodyJson: string, res: ServerResponse): Promise<void> {
      await gcPreparedExports();
      let parsed: { defaultPath?: unknown } = {};
      if (bodyJson.trim() !== '') {
        try {
          const value = JSON.parse(bodyJson) as unknown;
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
          parsed = value as { defaultPath?: unknown };
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` }));
          return;
        }
      }
      const rawDefault = typeof parsed.defaultPath === 'string' ? parsed.defaultPath : 'export.bin';
      const safeName = sanitizeUploadFileName(rawDefault);
      const exportId = randomUUID();
      const slotDir = join(exportsRoot, exportId);
      await mkdir(slotDir, { recursive: true });
      const targetPath = join(slotDir, safeName);

      fsRuntime.allowFile(targetPath);
      assetScope.allowFile(targetPath);
      preparedExports.set(exportId, {
        path: targetPath,
        fileName: safeName,
        expiresAt: Date.now() + EXPORT_TTL_MS,
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ path: targetPath, exportId, fileName: safeName }));
    },

    async handleDownloadExport(exportId: string, res: ServerResponse): Promise<void> {
      await gcPreparedExports();
      const entry = preparedExports.get(exportId);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Export token not found or expired');
        return;
      }
      const normalizedRoot = exportsRoot.endsWith(sep) ? exportsRoot : exportsRoot + sep;
      if (!resolve(entry.path).startsWith(normalizedRoot)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden export path');
        return;
      }
      let info;
      try {
        info = await stat(entry.path);
      } catch (error) {
        void error;
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Exported file not yet written');
        return;
      }
      if (!info.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Export target is not a file');
        return;
      }

      const asciiFallback = entry.fileName.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download';
      const encodedName = encodeURIComponent(entry.fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(info.size),
        'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'no-store',
      });
      await pipeline(createReadStream(entry.path), res).catch(() => undefined);
    },

    async shutdown(): Promise<void> {
      shuttingDown = true;
      if (restartTimer !== null) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      try {
        for (const tab of tabs.values()) {
          tab.ws.close(1001, 'Server shutting down');
        }
        tabs.clear();
        activeBridge.dispose('WebUI gateway shutting down');
        if (restartInFlight) await restartInFlight;
        await activeSession.shutdown();
      } finally {
        releaseHostInstanceLock(instanceLockPath, instanceLockRecord, log);
      }
    },
  };
}
