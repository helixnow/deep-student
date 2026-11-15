/**
 * 移动端原型主线程入口：启动 Host Worker → 建立 MessagePort → 安装与桌面 preload 相同的 Tauri 兼容桥 →
 * 前端经 `@tauri-apps/api` 的 `invoke` / `listen` 调用 Host。
 *
 * 两种页面（{@link shouldMountApp}）：
 * - 诊断页（index.html 的 `#status`）：默认 / `--mode diagnostics` 构建、`?diagnostics=1`、或页面没有 `#root`，
 *   只显示 Host 启动结果（Playwright 用例与性能数据测的是它）；
 * - 完整前端（`--mode app`，app.html 的 `#root`）：`bootMobileShell()` resolve 之后动态加载仓库根的 `src/main.tsx`。
 */
import './shell/webview-compat.ts';
import { installTauriBridge } from '../../electron/preload/bridge.ts';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { ShellRequest } from '../../host/kernel/protocol.ts';
import { createMobileHttp } from '../../host/platform/http/mobile.ts';
import { MOBILE_APP_DATA_DIR } from '../../host/platform/storage-mobile/restore-intent.ts';
import { MOBILE_DIAGNOSTICS_PLUGIN_ID } from './diagnostics-id.ts';
import { HostWorkerSupervisor } from './shell/host-supervisor.ts';
import { MobileShell } from './shell/mobile-shell.ts';
import { requestPersistentStorage } from './shell/persistent-storage.ts';
import { installPagePlatform, mobileBridgeInit } from './shell/platform.ts';
import { shouldMountApp } from './shell/page-mode.ts';
import { pickBackupFile } from './shell/backup-picker.ts';
import { createAndroidInvokeHandler, isNativeAndroid, pickAndroidBackup, postAndroidNotification, saveAndroidDocument } from './shell/android-native.ts';
import { closeLegacyData, readLegacyData, readLegacyFileChunk } from './shell/legacy-data.ts';
import { decodeMobileAudio } from './shell/media-audio.ts';
import { fetchWithTimeout } from './shell/http-fetch.ts';
import mobilePackage from '../package.json';
import { androidHttpRequest } from './shell/android-http.ts';

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
  /** Worker serializes all request bodies here as strings or binary data. */
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

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join(''));
}

async function shellHttpFetch(request: ShellHttpRequest): Promise<ShellHttpResponse> {
  const headers = { ...(request.headers ?? {}) };
  const timeout = request.timeoutMs;
  const bytes = request.body instanceof Uint8Array ? request.body
    : request.body instanceof ArrayBuffer ? new Uint8Array(request.body) : undefined;
  const useNativeHttp = Capacitor.isNativePlatform() && typeof CapacitorHttp?.request === 'function';
  if (useNativeHttp) {
    try {
      const response = await CapacitorHttp.request({
        url: request.url,
        method: request.method ?? 'GET',
        headers,
        data: bytes !== undefined ? bytesToBase64(bytes) : typeof request.body === 'string' ? request.body : undefined,
        ...(bytes === undefined ? {} : { dataType: 'file' as const }),
        responseType: 'arraybuffer',
        disableRedirects: request.redirect === 'manual' || request.redirect === 'error',
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

/** 把 OPFS 文件交给系统。Android 走原生文件选择器，其余平台使用 Web API。 */
async function saveDocumentToSystem(path: string, fileName: string, mimeType: string): Promise<{ method: string } | null> {
  const file = await opfsReadFile(path);
  if (isNativeAndroid()) return saveAndroidDocument(file, fileName, mimeType);
  const shareFile = new File([file], fileName, { type: mimeType });
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
      ...(mimeType === 'application/zip' ? { types: [{ description: 'Deep Student backup', accept: { [mimeType]: ['.zip'] } }] } : {}),
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
  if (request.op.startsWith('http.android.')) return androidHttpRequest(request);
  switch (request.op) {
    case 'http.fetch':
      return shellHttpFetch((request.args ?? {}) as ShellHttpRequest);
    case 'process.restart':
      // 让本轮 Host 消息先回送（备份完成事件）再重载页面。
      setTimeout(() => window.location.reload(), 250);
      return null;
    case 'mobile:legacy-databases':
      return readLegacyData();
    case 'mobile:legacy-file':
      return readLegacyFileChunk(request.args);
    case 'mobile:legacy-close':
      return closeLegacyData(request.args);
    case 'mobile:decode-media': {
      const args = (request.args ?? {}) as { bytes?: unknown };
      if (!(args.bytes instanceof Uint8Array)) throw new Error('mobile:decode-media requires binary audio');
      return decodeMobileAudio(args.bytes);
    }
    case 'plugin:window|is_visible':
      return document.visibilityState === 'visible';
    case 'plugin:window|is_focused':
      return document.hasFocus();
    case 'plugin:window|is_minimized':
      return document.visibilityState === 'hidden';
    case 'plugin:notification|notify': {
      const options = (request.args as { options?: { title?: unknown; body?: unknown } } | null)?.options;
      if (!isNativeAndroid() || typeof options?.title !== 'string' || typeof options.body !== 'string') {
        throw new Error('Mobile system notification unavailable');
      }
      if (!await postAndroidNotification({ title: options.title, body: options.body })) {
        throw new Error('Android system notifications are not permitted');
      }
      return null;
    }
    // `filestream_check_access` / `pdfstream_check_access` ask for the desktop allow-list before
    // serving a path. Mobile has no process-wide filesystem roots (all files live in OPFS), so the
    // answer is the empty list; an unknown op here used to abort the whole command.
    case 'app.pdfStreamAllowedDirs':
      return [];
    case 'mobile:save-backup':
    case 'mobile:save-document': {
      const args = (request.args ?? {}) as { path?: unknown; fileName?: unknown; mimeType?: unknown };
      if (typeof args.path !== 'string') throw new Error(`${request.op} requires a path`);
      const fileName = typeof args.fileName === 'string' && args.fileName.trim() !== '' ? args.fileName : 'deep-student-backup.zip';
      const mimeType = typeof args.mimeType === 'string' && args.mimeType.trim() !== '' ? args.mimeType : 'application/zip';
      const result = await saveDocumentToSystem(args.path, fileName, mimeType);
      if (result === null && request.op === 'mobile:save-backup') throw new Error('已取消选择保存位置');
      return result;
    }
    case 'mobile:pick-backup': {
      const args = (request.args ?? {}) as { targetPath?: unknown };
      if (typeof args.targetPath !== 'string') throw new Error('mobile:pick-backup requires a targetPath');
      return isNativeAndroid() ? pickAndroidBackup(args.targetPath) : pickBackupFile(args.targetPath, opfsWriteFile);
    }
    default:
      throw new Error(`shell operation "${request.op}" is not available on mobile`);
  }
}

async function bootMobileShell(): Promise<MobileApp> {
  if (isNativeAndroid()) {
    const nativeHttp = createMobileHttp({
      shell: { request: async <R>(op: string, args?: unknown) => androidHttpRequest({ kind: 'shell-request', id: '', op, args }) as Promise<R> },
    });
    Object.defineProperty(globalThis, '__DS_ANDROID_MCP_FETCH__', {
      value: async (endpoint: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        const target = new URL(request.url);
        if (target.origin !== new URL(endpoint).origin || target.username || target.password) {
          throw new TypeError('The MCP request must stay on the configured server origin');
        }
        const body = request.body === null ? undefined : await request.text();
        const response = await nativeHttp.fetch(target, {
          method: request.method, headers: request.headers, body, signal: request.signal,
          // Manual mode selects the native streaming transport without making a preliminary browser request.
          redirect: 'manual', timeoutMs: null,
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new TypeError('MCP redirects are disabled; configure the final endpoint URL');
        }
        return response;
      },
    });
  }
  const shell: MobileShell = new MobileShell({
    // Host 协议的 platform 目前只有 darwin/win32/linux（见 PROGRESS.md「协议待定项」）。
    handshake: {
      appDataDir: MOBILE_APP_DATA_DIR,
      appVersion: MOBILE_APP_VERSION,
      platform: 'linux',
      // Tauri 的 `cfg!(debug_assertions)`：只有开发服务器与诊断构建是 debug。
      debug: import.meta.env.DEV || import.meta.env.MODE === 'diagnostics',
    },
    log: message => console.warn(message),
    onShellRequest,
    onNativeInvoke: isNativeAndroid()
      ? createAndroidInvokeHandler(target => shell.emitNativeEvent('deepstudent://notification-action', { target }))
      : undefined,
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
  if (import.meta.env.MODE === 'app') {
    // The new Android WebView origin cannot see the old app's localStorage.
    // Restore the SQLite copy before React applies the theme; a local choice wins.
    if (isNativeAndroid()) {
      try {
        if (localStorage.getItem('dstu-theme-mode') === null && localStorage.getItem('aimm-theme-mode') === null) {
          const mode = await invoke<string | null>('get_setting', { key: 'theme' });
          if (mode === 'light' || mode === 'dark' || mode === 'auto') {
            localStorage.setItem('dstu-theme-mode', mode);
          }
        }
      } catch (error) {
        // A restricted recovery Host has no settings command. It must still show its recovery page.
        console.warn('[mobile] Could not restore the saved theme:', error);
      }
    }
    await import('virtual:dstu-app-entry');
  }
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
