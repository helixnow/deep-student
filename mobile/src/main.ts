/**
 * 移动端原型主线程入口：启动 Host Worker → 建立 MessagePort → 安装与桌面 preload 相同的 Tauri 兼容桥 →
 * 前端经 `@tauri-apps/api` 的 `invoke` / `listen` 调用 Host。
 *
 * 两种页面（{@link shouldMountApp}）：
 * - 诊断页（index.html 的 `#status`）：默认 / `--mode diagnostics` 构建、`?diagnostics=1`、或页面没有 `#root`，
 *   只显示 Host 启动结果（Playwright 用例与性能数据测的是它）；
 * - 完整前端（`--mode app`，app.html 的 `#root`）：`bootMobileShell()` resolve 之后动态加载仓库根的 `src/main.tsx`。
 */
import { installTauriBridge } from '../../electron/preload/bridge.ts';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { ShellRequest } from '../../host/kernel/protocol.ts';
import { MOBILE_DIAGNOSTICS_PLUGIN_ID } from './diagnostics-id.ts';
import { HostWorkerSupervisor } from './shell/host-supervisor.ts';
import { MobileShell } from './shell/mobile-shell.ts';
import { requestPersistentStorage } from './shell/persistent-storage.ts';
import { installPagePlatform, mobileBridgeInit } from './shell/platform.ts';
import { shouldMountApp } from './shell/page-mode.ts';
import { pickBackupFile } from './shell/backup-picker.ts';
import { fetchWithTimeout } from './shell/http-fetch.ts';
import mobilePackage from '../package.json';

/**
 * `src/version.ts` is generated (gitignored). App builds generate it before Vite starts; other builds
 * (diagnostics) may not have it, so resolve it optionally and fall back to the build-injected root version.
 */
const VERSION_MODULES = import.meta.glob<{ VERSION_INFO?: { APP_VERSION?: string } }>('../../src/version.ts', { eager: true });
const FALLBACK_APP_VERSION = import.meta.env.VITE_DSTU_APP_VERSION?.trim() || mobilePackage.version;
export const MOBILE_APP_VERSION = Object.values(VERSION_MODULES)
  .map(module => module.VERSION_INFO?.APP_VERSION?.trim())
  .find(version => version !== undefined && version !== '') ?? FALLBACK_APP_VERSION;

export interface BootMetrics {
  /** 页面 timeOrigin 起到 Worker 创建。 */
  workerCreatedMs: number;
  /** Worker 报告 Host 模块求值完成（主线程时间）。 */
  workerLoadedMs: number;
  /** Host 发出 HostReady（迁移 + 插件装载完成，主线程时间）。 */
  hostReadyMs: number;
  /** 首个 invoke 往返耗时。 */
  firstInvokeMs: number;
}

export interface MobileApp {
  readonly metrics: BootMetrics;
  invoke: typeof invoke;
  listen: typeof listen;
  /** `caller` 缺省为诊断插件 id（{@link MOBILE_DIAGNOSTICS_PLUGIN_ID}）。 */
  hostCall<T = unknown>(service: string, method: string, args?: unknown[], caller?: string): Promise<T>;
  shutdown(): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __dstuMobile: Promise<MobileApp> | undefined;
}

// ---------------------------------------------------------------- shell requests

/** `http.fetch` 的请求参数（Host 的 `ctx.http` → 主线程原生 HTTP）。 */
interface ShellHttpRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  /** string / Uint8Array / ArrayBuffer / FormData / Blob；可结构化克隆。 */
  readonly body?: unknown;
  readonly timeoutMs?: number | null;
  readonly redirect?: 'follow' | 'manual' | 'error';
}

interface ShellHttpResponse {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function capacitorResponseBytes(data: unknown, contentType: string, status: number): Uint8Array {
  if (status === 204 || status === 205 || status === 304 || status === 101) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data === null || data === undefined) return new Uint8Array(0);
  if (typeof data === 'string') {
    // CapacitorHttp native: `arraybuffer` comes back as base64, except when the response is JSON
    // (the plugin ignores responseType for `application/json` and parses it).
    if (contentType.toLowerCase().includes('json')) return new TextEncoder().encode(data);
    try {
      return base64ToBytes(data);
    } catch {
      return new TextEncoder().encode(data);
    }
  }
  return new TextEncoder().encode(JSON.stringify(data));
}

function isTextBody(body: unknown): body is string | undefined {
  return body === undefined || body === null || typeof body === 'string';
}

/** `CapacitorHttp.request` 不能在原生侧发送二进制/FormData；这些请求交给已打补丁的 `fetch`。 */
async function shellHttpFetch(request: ShellHttpRequest): Promise<ShellHttpResponse> {
  const headers = { ...(request.headers ?? {}) };
  const timeout = request.timeoutMs;
  const useNativeHttp = Capacitor.isNativePlatform() && isTextBody(request.body) && typeof CapacitorHttp?.request === 'function';
  if (useNativeHttp) {
    try {
      const response = await CapacitorHttp.request({
        url: request.url,
        method: request.method ?? 'GET',
        headers,
        data: typeof request.body === 'string' ? request.body : undefined,
        responseType: 'arraybuffer',
        disableRedirects: request.redirect === 'manual',
        ...(typeof timeout === 'number' && timeout > 0 ? { connectTimeout: timeout, readTimeout: timeout } : {}),
      });
      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers ?? {})) responseHeaders[name.toLowerCase()] = String(value);
      return {
        url: response.url || request.url,
        status: response.status,
        statusText: '',
        headers: responseHeaders,
        body: capacitorResponseBytes(response.data, responseHeaders['content-type'] ?? '', response.status),
      };
    } catch (error) {
      // CapacitorHttp disabled/missing on this platform → fall through to the patched fetch.
      console.warn('[mobile] CapacitorHttp.request failed, retrying with fetch:', error);
    }
  }
  const response = await fetchWithTimeout(request.url, {
    method: request.method ?? 'GET',
    headers,
    ...(request.body === undefined || request.body === null ? {} : { body: request.body as BodyInit }),
    ...(request.redirect === undefined ? {} : { redirect: request.redirect }),
  }, timeout);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => { responseHeaders[name] = value; });
  return {
    url: response.url || request.url,
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

/** 旧版原生 Android 应用（0.15.x）在应用私有 files 目录里留下的数据库。 */
const LEGACY_SLOTS = ['slotA', 'slotB'] as const;
const LEGACY_DATABASES = ['chat_v2.db', 'mistakes.db', 'llm_usage.db', 'browser.db', 'databases/vfs.db'] as const;
const LEGACY_AUDIT_DATABASE = 'databases/audit.db';
const LEGACY_FILES_DIR = '/data/user/0/com.deepstudent.app/files';

interface ShellLegacyDatabases {
  readonly slot: string;
  readonly files: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>;
}

function legacyFileUrl(path: string): string {
  try {
    return Capacitor.convertFileSrc(path);
  } catch {
    return `https://localhost/_capacitor_file_${path}`;
  }
}

async function readLegacyFile(relativePath: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(legacyFileUrl(`${LEGACY_FILES_DIR}/${relativePath}`));
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > 0 ? bytes : null;
  } catch {
    // Missing / unreadable legacy file.
    return null;
  }
}

async function readLegacyNativeDatabases(): Promise<ShellLegacyDatabases | null> {
  if (Capacitor.getPlatform() !== 'android') return null;
  const stateBytes = await readLegacyFile('slots/state.json');
  let activeSlot: string | undefined;
  if (stateBytes !== null) {
    const state = JSON.parse(new TextDecoder().decode(stateBytes)) as { active?: string };
    if (state.active === 'slotA' || state.active === 'slotB') activeSlot = state.active;
  }
  const candidates: ShellLegacyDatabases[] = [];
  for (const slot of LEGACY_SLOTS) {
    const files: Array<{ name: string; bytes: Uint8Array }> = [];
    for (const name of LEGACY_DATABASES) {
      const bytes = await readLegacyFile(`slots/${slot}/${name}`);
      if (bytes !== null) files.push({ name, bytes });
    }
    if (files.length > 0) candidates.push({ slot, files });
  }
  if (candidates.length === 0) return null;
  // 优先遵循旧版插槽状态；仅缺失状态文件时按聊天库大小推断。
  const sizeOf = (candidate: ShellLegacyDatabases): number => candidate.files.find(file => file.name === 'chat_v2.db')?.bytes.byteLength ?? 0;
  const best = candidates.find(candidate => candidate.slot === activeSlot)
    ?? (stateBytes === null ? candidates.sort((a, b) => sizeOf(b) - sizeOf(a))[0]! : candidates[0]!);
  // Tauri 的审计库不在数据槽里：`<files>/databases/audit.db`。
  if (!best.files.some(file => file.name === LEGACY_AUDIT_DATABASE)) {
    const audit = await readLegacyFile(LEGACY_AUDIT_DATABASE);
    if (audit !== null) return { slot: best.slot, files: [...best.files, { name: LEGACY_AUDIT_DATABASE, bytes: audit }] };
  }
  return best;
}

async function opfsReadFile(path: string): Promise<File> {
  const root = await navigator.storage.getDirectory();
  const parts = path.split('/').filter(part => part !== '' && part !== '.');
  const name = parts.pop();
  if (!name) throw new Error(`invalid OPFS path: ${path}`);
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part);
  const handle = await directory.getFileHandle(decodeURIComponent(name));
  return handle.getFile();
}

async function opfsWriteFile(path: string, bytes: Uint8Array, mimeType = 'application/zip'): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const parts = path.split('/').filter(part => part !== '' && part !== '.');
  const name = parts.pop();
  if (!name) throw new Error(`invalid OPFS path: ${path}`);
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
  const handle = await directory.getFileHandle(decodeURIComponent(name), { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(new Blob([bytes], { type: mimeType }));
  } finally {
    await writable.close();
  }
}

/** 把 OPFS 里的备份交给系统：Web Share → File System Access → 浏览器下载（Capacitor 只命中第一/第三条）。 */
async function saveBackupToSystem(path: string, fileName: string): Promise<{ method: string }> {
  const file = await opfsReadFile(path);
  const shareFile = new File([file], fileName, { type: 'application/zip' });
  const navigatorWithShare = navigator as Navigator & {
    canShare?(data?: ShareData): boolean;
    share?(data?: ShareData): Promise<void>;
  };
  if (navigatorWithShare.canShare?.({ files: [shareFile] }) === true && typeof navigatorWithShare.share === 'function') {
    await navigatorWithShare.share({ files: [shareFile], title: fileName });
    return { method: 'share' };
  }
  const picker = (window as unknown as {
    showSaveFilePicker?: (options: {
      suggestedName?: string;
      types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    }) => Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }>;
  }).showSaveFilePicker;
  if (typeof picker === 'function') {
    const handle = await picker.call(window, {
      suggestedName: fileName,
      types: [{ description: 'Deep Student backup', accept: { 'application/zip': ['.zip'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(shareFile);
    await writable.close();
    return { method: 'save-picker' };
  }
  const url = URL.createObjectURL(shareFile);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { method: 'download' };
}

/**
 * Host 请求主线程代办的平台操作。Host 在 Web Worker 里没有 CORS 豁免、原生 HTTP、系统文件
 * 选择器等能力，这些都必须回到主线程。
 */
async function onShellRequest(request: ShellRequest): Promise<unknown> {
  switch (request.op) {
    case 'http.fetch':
      return shellHttpFetch((request.args ?? {}) as ShellHttpRequest);
    case 'process.restart':
      // 让本轮 Host 消息先回送（备份完成事件）再重载页面。
      setTimeout(() => window.location.reload(), 250);
      return null;
    case 'mobile:legacy-databases':
      return readLegacyNativeDatabases();
    // `filestream_check_access` / `pdfstream_check_access` ask for the desktop allow-list before
    // serving a path. Mobile has no process-wide filesystem roots (all files live in OPFS), so the
    // answer is the empty list; an unknown op here used to abort the whole command.
    case 'app.pdfStreamAllowedDirs':
      return [];
    case 'mobile:save-backup': {
      const args = (request.args ?? {}) as { path?: unknown; fileName?: unknown };
      if (typeof args.path !== 'string') throw new Error('mobile:save-backup requires a path');
      const fileName = typeof args.fileName === 'string' && args.fileName.trim() !== '' ? args.fileName : 'deep-student-backup.zip';
      return saveBackupToSystem(args.path, fileName);
    }
    case 'mobile:pick-backup': {
      const args = (request.args ?? {}) as { targetPath?: unknown };
      if (typeof args.targetPath !== 'string') throw new Error('mobile:pick-backup requires a targetPath');
      return pickBackupFile(args.targetPath, opfsWriteFile);
    }
    default:
      throw new Error(`shell operation "${request.op}" is not available on mobile`);
  }
}

async function bootMobileShell(): Promise<MobileApp> {
  const shell = new MobileShell({
    // Host 协议的 platform 目前只有 darwin/win32/linux（见 PROGRESS.md「协议待定项」）。
    handshake: {
      appDataDir: '/deep-student',
      appVersion: MOBILE_APP_VERSION,
      platform: 'linux',
      // Tauri 的 `cfg!(debug_assertions)`：只有开发服务器与诊断构建是 debug。
      debug: import.meta.env.DEV || import.meta.env.MODE === 'diagnostics',
    },
    log: message => console.warn(message),
    onShellRequest,
  });
  let workerCreatedMs = 0;
  let resolveLoaded!: (atMs: number) => void;
  const loaded = new Promise<number>((resolve) => { resolveLoaded = resolve; });
  const supervisor = new HostWorkerSupervisor({
    shell,
    createWorker: () => {
      const worker = new Worker(new URL('./worker/host-worker.ts', import.meta.url), { type: 'module', name: 'dstu-host' });
      workerCreatedMs ||= performance.now();
      return worker;
    },
    log: message => console.warn(message),
    onWorkerLoaded: resolveLoaded,
    onUnavailable: (reason) => {
      showStatus(`Host 不可用：${reason}（重新打开应用后重试）`);
      document.body.dataset.ready = 'failed';
    },
  });
  void requestPersistentStorage(navigator.storage, message => console.warn(message));
  supervisor.start();
  installTauriBridge(shell.bridgeTransport(), mobileBridgeInit());
  installPagePlatform();

  await shell.ready;
  const hostReadyMs = performance.now();
  const workerLoadedMs = await loaded;

  const hostCall = <T>(service: string, method: string, args: unknown[] = [], caller = MOBILE_DIAGNOSTICS_PLUGIN_ID) =>
    invoke<T>('plugin:host|call', { caller, service, method, args });
  const before = performance.now();
  await invoke('plugin:host|status');
  const firstInvokeMs = performance.now() - before;

  return {
    metrics: { workerCreatedMs, workerLoadedMs, hostReadyMs, firstInvokeMs },
    invoke,
    listen,
    hostCall,
    shutdown: () => supervisor.shutdown(),
  };
}

/** 诊断页写 `#status`；完整前端页没有它，失败信息替换 `#root` 的启动占位（React 还没接手）。 */
function showStatus(text: string): void {
  const status = document.getElementById('status');
  if (status) {
    status.textContent = text;
    return;
  }
  const root = document.getElementById('root');
  if (!root) return;
  const message = document.createElement('p');
  message.id = 'status';
  message.setAttribute('role', 'alert');
  message.textContent = text;
  root.replaceChildren(message);
}

function render(app: MobileApp): void {
  showStatus(`Host 就绪：${app.metrics.hostReadyMs.toFixed(0)} ms（首个命令 ${app.metrics.firstInvokeMs.toFixed(1)} ms）`);
  document.body.dataset.ready = 'true';
}

/** 完整前端：Host 就绪、桥已装好之后才求值 `src/main.tsx`（它在模块顶层就会 `invoke`）。 */
async function mountApp(): Promise<void> {
  // 条件在构建期替换成常量：非 app 构建里整个 import 被删掉，前端闭包（React、Tailwind CSS…）不进诊断产物。
  if (import.meta.env.MODE === 'app') await import('virtual:dstu-app-entry');
  document.body.dataset.ready = 'true';
}

const fail = (error: unknown) => {
  showStatus(`启动失败：${error instanceof Error ? error.message : String(error)}`);
  document.body.dataset.ready = 'failed';
};

globalThis.__dstuMobile = bootMobileShell();
if (shouldMountApp({ mode: import.meta.env.MODE, search: location.search, hasRoot: document.getElementById('root') !== null })) {
  globalThis.__dstuMobile.then(mountApp).catch(fail);
} else {
  globalThis.__dstuMobile.then(render, fail);
}
