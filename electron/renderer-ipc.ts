/** 渲染进程 → main 的 IPC：桥初始化（同步）与 invoke / 拖放 / 拖动窗口等消息。 */
import type { IpcMain } from 'electron';
import {
  checkRendererMessage,
  IPC_CHANNEL_INIT,
  IPC_CHANNEL_TO_MAIN,
  MAX_REMOTE_INVOKE_PAYLOAD,
  type BridgeInit,
  type InvokeMessage,
  type RendererToMain,
} from './shell/bridge-messages.ts';
import { BROWSER_CONTENT_LABEL } from './shell/browser-protocol.ts';
import { checkDragDrop } from './shell/drag-drop.ts';
import { trustedFrameUrl } from './shell/frame-origin.ts';
import type { ShellRuntime } from './shell/runtime.ts';
import type { FsScope } from './shell/scope.ts';
import type { ShellPlatform } from './shell/tauri-config.ts';
import type { WindowManager } from './shell/windows.ts';

export interface RendererIpcDeps {
  platform: ShellPlatform;
  ipc: Pick<IpcMain, 'on'>;
  /** `windows` 在每条消息到达时读取（main 先建 runtime，之后才装上窗口管理器）。 */
  runtime: Pick<ShellRuntime, 'browserWebviewOf' | 'handleInvoke' | 'handleBrowserInvoke' | 'emitTo'> & {
    readonly windows: Pick<WindowManager, 'byWebContents'>;
  };
  /** 拖放进来的路径追加到这两个作用域。 */
  fsRuntime: Pick<FsScope, 'allowFile' | 'allowDirectory'>;
  assetScope: Pick<FsScope, 'allowFile' | 'allowDirectory'>;
  stopWindowDrag(label: string): void;
  log(message: string): void;
}

export function wireRendererIpc(deps: RendererIpcDeps): void {
  const { platform, runtime, log } = deps;
  const platformInit = {
    osName: platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux',
    protocolScheme: 'http',
    sep: platform === 'win32' ? '\\' : '/',
    delimiter: platform === 'win32' ? ';' : ':',
  } as const;

  deps.ipc.on(IPC_CHANNEL_INIT, (event) => {
    const browser = runtime.browserWebviewOf(event.sender);
    if (browser) {
      const init: BridgeInit = {
        ...platformInit,
        windowLabel: browser.windowLabel,
        webviewLabel: browser.label,
        dragDropEnabled: false,
        initializationScript: browser.initializationScript,
      };
      event.returnValue = init;
      return;
    }
    const win = runtime.windows.byWebContents(event.sender);
    if (!win) {
      event.returnValue = { error: 'unknown webContents' };
      return;
    }
    const init: BridgeInit = {
      ...platformInit,
      windowLabel: win.label,
      webviewLabel: win.label,
      dragDropEnabled: win.dragDropEnabled,
    };
    event.returnValue = init;
  });

  // 消息的形状由页面主世界决定，main 不能信任。invoke 原样交给 runtime：它按来源选载荷上限校验，能确定回调 id 时回错误。
  const isInvoke = (value: unknown): value is InvokeMessage =>
    typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'invoke';
  /** 其余消息（拖放、拖动结束、初始化脚本失败）先校验形状，不合格的记日志后丢弃。 */
  const checkedMessage = (value: unknown, label: string): Exclude<RendererToMain, InvokeMessage> | null => {
    const checked = checkRendererMessage(value, MAX_REMOTE_INVOKE_PAYLOAD);
    if (checked.ok && checked.message.type !== 'invoke') return checked.message;
    log(`[${label}] ignored a malformed renderer message: ${checked.ok ? 'unexpected invoke' : checked.reason}`);
    return null;
  };

  deps.ipc.on(IPC_CHANNEL_TO_MAIN, (event, untrusted: unknown) => {
    // 来源 URL 只从 main 持有的 WebFrameMain/WebContents 读取；不信任 message.headers.origin。
    const frameUrl = trustedFrameUrl(event.senderFrame, event.sender);
    const browser = runtime.browserWebviewOf(event.sender);
    if (browser) {
      if (isInvoke(untrusted)) {
        runtime.handleBrowserInvoke(event.sender, browser, untrusted, frameUrl);
        return;
      }
      const message = checkedMessage(untrusted, BROWSER_CONTENT_LABEL);
      if (message?.type === 'script-error') log(`[browser-content] initialization script failed: ${message.message}`);
      return;
    }
    const win = runtime.windows.byWebContents(event.sender);
    if (!win) return;
    if (isInvoke(untrusted)) {
      runtime.handleInvoke(win, untrusted, frameUrl);
      return;
    }
    const message = checkedMessage(untrusted, win.label);
    if (message === null) return;
    switch (message.type) {
      case 'window-drag-end':
        deps.stopWindowDrag(win.label);
        return;
      case 'script-error':
        log(`[${win.label}] initialization script failed: ${message.message}`);
        return;
      case 'drag-drop': {
        const checked = checkDragDrop(message, { dragDropEnabled: win.dragDropEnabled, topFrame: event.senderFrame?.parent === null, platform });
        if (!checked.accept) {
          log(`[${win.label}] drag-drop ignored: ${checked.reason}`);
          return;
        }
        if (checked.rejected.length > 0) {
          log(`[${win.label}] drag-drop: ignored ${checked.rejected.length} path(s) that are not existing absolute paths, first ${JSON.stringify(checked.rejected[0])?.slice(0, 300)}`);
        }
        // tauri manager/window.rs：webview 窗口以 AnyLabel(label) 发射；drop 时把路径加入 asset（window.rs:238）与
        // fs（tauri-plugin-fs lib.rs:455）作用域，目录两边都递归。
        const target = { kind: 'AnyLabel' as const, label: win.label };
        if (checked.phase === 'drop') {
          for (const { path, directory } of checked.paths) {
            if (directory) {
              deps.fsRuntime.allowDirectory(path, true);
              deps.assetScope.allowDirectory(path, true);
            } else {
              deps.fsRuntime.allowFile(path);
              deps.assetScope.allowFile(path);
            }
          }
        }
        const payload =
          checked.phase === 'leave'
            ? null
            : checked.phase === 'over'
              ? { position: checked.position }
              : { paths: checked.paths.map(({ path }) => path), position: checked.position };
        runtime.emitTo(target, `tauri://drag-${checked.phase}`, JSON.stringify(payload));
        return;
      }
    }
  });
}
