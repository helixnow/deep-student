/**
 * 沙箱 preload（由 electron/scripts/build-preload.mjs 打包为 CommonJS）。
 *
 * - main 有待写的 Tauri 版 localStorage 迁移条目时（仅空白迁移页），先写入并同步回报（webview-migration.ts）。
 * - 同步向 main 取本 webview 的初始化参数，然后用 `contextBridge.executeInMainWorld` 在页面主世界
 *   安装 Tauri 内部接口（见 bridge.ts），先于页面任何脚本执行，与 Tauri 初始化脚本的时机一致。
 * - 以 `contextBridge.exposeInMainWorld` 暴露只读的 `window.__DS_PLATFORM__`（FE-A5，见 ../API.md“页面平台信息”）。
 * - 在隔离世界处理两件只有 preload 能做的事：外部文件拖放（需要 `webUtils.getPathForFile`）
 *   与 `data-tauri-drag-region` 的 CSS 翻译、`start_dragging` 模拟拖动的松键回报。
 */
import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';
import { installTauriBridge, type BridgeTransport } from './bridge.ts';
import { installBootDiagnostics } from './boot-diagnostics.ts';
import { dragRegionCss } from './drag-region.ts';
import { applyPendingWebviewMigration } from './webview-migration.ts';
import type { StorageLike } from '../storage-migration/apply.ts';
import {
  IPC_CHANNEL_INIT,
  IPC_CHANNEL_TO_MAIN,
  IPC_CHANNEL_TO_RENDERER,
  type BridgeInit,
  type MainToRenderer,
  type RendererToMain,
} from '../shell/bridge-messages.ts';

// 隔离世界与主世界共享同一 DOM；这里只用到少量 DOM 接口，以结构类型声明。
interface DomFile {
  readonly name: string;
}
interface DomDataTransfer {
  readonly types: readonly string[];
  readonly files: ArrayLike<DomFile>;
  dropEffect: string;
}
interface DomDragEvent {
  readonly dataTransfer: DomDataTransfer | null;
  readonly clientX: number;
  readonly clientY: number;
  readonly relatedTarget: unknown;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}
interface DomWindow {
  readonly devicePixelRatio: number;
  addEventListener(type: string, listener: (event: DomDragEvent) => void, capture: boolean): void;
}

const dom = globalThis as unknown as DomWindow;

// Tauri 版 localStorage 迁移：只有 main 认定的空白迁移页会领到条目，在任何页面脚本之前写入并同步回报。
applyPendingWebviewMigration(ipcRenderer, () => (globalThis as unknown as { localStorage: StorageLike }).localStorage);

const init = ipcRenderer.sendSync(IPC_CHANNEL_INIT) as BridgeInit | { error: string };
if ('error' in init) throw new Error(`[dstu-shell] preload init failed: ${init.error}`);

const mainWorldListeners: Array<(message: MainToRenderer) => void> = [];
let windowDragActive = false;

ipcRenderer.on(IPC_CHANNEL_TO_RENDERER, (_event, message: MainToRenderer) => {
  if (message.type === 'window-drag-start') {
    windowDragActive = true;
    return;
  }
  for (const listener of mainWorldListeners) listener(message);
});

function sendToMain(message: RendererToMain): void {
  ipcRenderer.send(IPC_CHANNEL_TO_MAIN, message);
}

const transport: BridgeTransport = {
  send: (message) => sendToMain(message),
  subscribe: (listener) => {
    mainWorldListeners.push(listener);
  },
};

contextBridge.executeInMainWorld({ func: installTauriBridge, args: [transport, init] });
// FE-A5：前端平台服务据此选择桌面实现（API.md“页面平台信息”）。
contextBridge.exposeInMainWorld('__DS_PLATFORM__', Object.freeze({ kind: 'desktop', os: process.platform, arch: process.arch }));
// lib.rs Started IIFE: synchronous, in the same world as the first script and errorReporter cleanup.
contextBridge.executeInMainWorld({ func: installBootDiagnostics });

// Tauri `initialization_script`：必须在页面脚本前执行（content 的 `__dsBrowserBridge` 依赖此时机）。
if (typeof init.initializationScript === 'string' && init.initializationScript !== '') {
  void webFrame.executeJavaScript(init.initializationScript).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    sendToMain({ type: 'script-error', message });
  });
}

// ---------------------------------------------------------------- 拖动区域

// 以 webFrame.insertCSS 注入：不受页面 CSP 约束（迁移页是 default-src 'none'，内联 <style> 会被拒绝并报错），
// 也不在 DOM 里留下节点；样式表随本文档存在，每次导航 preload 都会重新注入。
webFrame.insertCSS(dragRegionCss());

function endWindowDrag(): void {
  if (!windowDragActive) return;
  windowDragActive = false;
  sendToMain({ type: 'window-drag-end' });
}
dom.addEventListener('mouseup', endWindowDrag, true);
dom.addEventListener('pointerup', endWindowDrag, true);
dom.addEventListener('blur', endWindowDrag, true);

// ---------------------------------------------------------------- 外部文件拖放（Tauri DragDropEvent）

if (init.dragDropEnabled) {
  let inside = false;
  const isFileDrag = (event: DomDragEvent) => event.dataTransfer !== null && event.dataTransfer.types.includes('Files');
  const position = (event: DomDragEvent) => ({
    x: event.clientX * dom.devicePixelRatio,
    y: event.clientY * dom.devicePixelRatio,
  });
  // Tauri 接管原生拖放后页面收不到文件拖放的 DOM 事件；这里同样在捕获阶段截断。
  const swallow = (event: DomDragEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  dom.addEventListener(
    'dragenter',
    (event) => {
      if (!isFileDrag(event)) return;
      swallow(event);
      if (!inside) {
        inside = true;
        sendToMain({ type: 'drag-drop', phase: 'enter', paths: [], position: position(event) });
      }
    },
    true,
  );
  dom.addEventListener(
    'dragover',
    (event) => {
      if (!isFileDrag(event)) return;
      swallow(event);
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      sendToMain({ type: 'drag-drop', phase: 'over', position: position(event) });
    },
    true,
  );
  dom.addEventListener(
    'dragleave',
    (event) => {
      if (!isFileDrag(event)) return;
      swallow(event);
      if (event.relatedTarget === null && inside) {
        inside = false;
        sendToMain({ type: 'drag-drop', phase: 'leave' });
      }
    },
    true,
  );
  dom.addEventListener(
    'drop',
    (event) => {
      if (!isFileDrag(event)) return;
      swallow(event);
      inside = false;
      const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
      const paths = files.map((file) => webUtils.getPathForFile(file as unknown as File)).filter((p) => p !== '');
      sendToMain({ type: 'drag-drop', phase: 'drop', paths, position: position(event) });
    },
    true,
  );
}
