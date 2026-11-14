/**
 * 系统类插件：clipboard-manager（2.2.3）、opener（2.5.3）、notification（2.3.3）、process（2.3.1）、
 * updater（2.10.0）、global-shortcut（2.3.2）。命令集合与各插件 `generate_handler!` 的桌面端注册一致。
 */
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { clipboard, ClipboardItem, globalShortcut, Notification, shell } from 'electron';
import { GLOBAL_SHORTCUT_TRIGGERED } from '../../../host/kernel/core.ts';
import type { WindowRef } from '../../../host/kernel/protocol.ts';
import { optString, raw, reqChannel, reqString, reqStringArray, type InvokeInput } from '../args.ts';
import {
  openerApplicationMatches,
  openerPathEntries,
  openerUrlAllowed,
  openerUrlEntries,
  type OpenerApplication,
  type OpenerUrlEntry,
} from '../capabilities.ts';
import { formatIoError, missingKey, ShellCommandError } from '../errors.ts';
import { fsScopeFromPatterns, type FsScope } from '../scope.ts';
import { executableTarget } from './executable-files.ts';
import type { BuiltinPlugin, CommandContext } from '../runtime.ts';
import { unsupported } from '../runtime.ts';
import { HotKeyParseError, hotKeyToString, parseHotKey, toElectronAccelerator, type ParsedHotKey } from '../hotkey.ts';
import type { ShellPlatform } from '../tauri-config.ts';
import { ImageResource, resolveImage } from '../images.ts';

/** arboard `Error::ContentNotAvailable` 的 Display。 */
const CLIPBOARD_EMPTY = 'The clipboard contents were not available in the requested format or the clipboard is empty.';
/** arboard `Error::ConversionFailure` 的 Display（`get_image` 的 PNG 解码失败）。 */
const CLIPBOARD_CONVERSION_FAILURE =
  'The image or the text that was about the be transferred to/from the clipboard could not be converted to the appropriate format.';

/** 读取剪贴板中某个 MIME 的数据；不存在时与 arboard 一样报 `ContentNotAvailable`。 */
async function readClipboardType(type: 'text/plain' | 'image/png'): Promise<Blob> {
  for (const item of await clipboard.read()) {
    if (item.types.includes(type)) return item.getType(type);
  }
  throw new ShellCommandError(CLIPBOARD_EMPTY);
}

export function clipboardPlugin(): BuiltinPlugin {
  return {
    write_text: async (input) => {
      await clipboard.writeText(reqString(input, 'text'));
      return null;
    },
    read_text: async () => (await readClipboardType('text/plain')).text(),
    write_html: async (input) => {
      const html = reqString(input, 'html');
      const alt = optString(input, 'altText');
      await clipboard.write([new ClipboardItem({ 'text/html': html, ...(alt !== null ? { 'text/plain': alt } : {}) })]);
      return null;
    },
    clear: () => {
      clipboard.clear();
      return null;
    },
    read_image: async (_input, ctx) => {
      const png = new Uint8Array(await (await readClipboardType('image/png')).arrayBuffer());
      let image: ImageResource;
      try {
        image = ImageResource.fromPng(png);
      } catch {
        // arboard `get_image`：PNG 解码失败 `Err(_e) => Err(Error::ConversionFailure)`，不记日志。
        throw new ShellCommandError(CLIPBOARD_CONVERSION_FAILURE);
      }
      return ctx.runtime.addResource(ctx.webviewLabel, image);
    },
    write_image: async (input, ctx) => {
      const png = resolveImage(raw(input, 'image'), ctx).png();
      // TS 5.7+ 的 BlobPart 只接受普通 ArrayBuffer 上的视图；PNG 字节直接复用。
      const bytes = new Uint8Array(png.buffer as ArrayBuffer, png.byteOffset, png.byteLength);
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
      return null;
    },
  };
}

/** 全部 capability 中 opener 作用域条目的并集（上界）；每次调用还要满足调用方经 ACL 解析出的作用域。 */
export interface OpenerScope {
  urlAllow: OpenerUrlEntry[];
  /** 由 capability `opener:allow-open-path` 构造的路径作用域。 */
  paths: FsScope;
  /** 上述路径条目的 `app` 约束；路径本身与 `app` 无关，任一匹配即可（Rust `matches_path_program`）。 */
  pathApps: OpenerApplication[];
}

interface CallPathScope {
  paths: FsScope;
  apps: OpenerApplication[];
}

export function openerPlugin(scope: OpenerScope, platform: NodeJS.Platform): BuiltinPlugin {
  const shellPlatform: ShellPlatform = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
  const io = (e: unknown) => formatIoError(e, shellPlatform);
  const callPathScopes = new Map<string, CallPathScope>();
  const callScope = (ctx: CommandContext) => (ctx.scope ? ctx.scope() : { allow: [], deny: [] });
  /** 本次调用的 URL 判定（tauri-plugin-opener `Scope::is_url_allowed`：先查 deny，条目同样按 url 与 app 匹配）。 */
  const callUrlAllowed = (ctx: CommandContext, url: string, withApp: string | null) => {
    const entries = callScope(ctx);
    return !openerUrlAllowed(openerUrlEntries(entries.deny), url, withApp) && openerUrlAllowed(openerUrlEntries(entries.allow), url, withApp);
  };
  const callPathScope = (ctx: CommandContext): CallPathScope => {
    const entries = callScope(ctx);
    const allow = openerPathEntries(entries.allow);
    const deny = openerPathEntries(entries.deny).map((entry) => entry.path);
    const key = JSON.stringify([allow, deny]);
    let cached = callPathScopes.get(key);
    if (cached === undefined) {
      cached = { paths: fsScopeFromPatterns(ctx.runtime.paths, shellPlatform, allow.map((entry) => entry.path), deny), apps: allow.map((entry) => entry.app) };
      callPathScopes.set(key, cached);
    }
    return cached;
  };
  /** open crate 的 `with_detached`（macOS `/usr/bin/open`、Linux 直接启动程序、Windows `cmd /c start`）。 */
  const openWith = (target: string, program: string): Promise<void> => {
    const invocation =
      platform === 'darwin'
        ? { command: '/usr/bin/open', args: [target, '-a', program] }
        : platform === 'win32'
          ? { command: 'cmd', args: ['/c', 'start', '', program, target] }
          : { command: program, args: [target] };
    return new Promise<void>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    }).catch((error: unknown) => {
      throw new ShellCommandError(io(error));
    });
  };
  return {
    open_url: async (input, ctx) => {
      const url = reqString(input, 'url');
      const withApp = optString(input, 'with');
      if (!openerUrlAllowed(scope.urlAllow, url, withApp) || !callUrlAllowed(ctx, url, withApp)) {
        throw new ShellCommandError(`Not allowed to open url ${url}${withApp !== null ? ` with ${withApp}` : ''}`);
      }
      if (withApp === null) await shell.openExternal(url);
      else await openWith(url, withApp);
      return null;
    },
    open_path: async (input, ctx) => {
      const path = reqString(input, 'path');
      const withApp = optString(input, 'with');
      const call = callPathScope(ctx);
      const allowed = scope.paths.isAllowed(path) && scope.pathApps.some((app) => openerApplicationMatches(app, withApp))
        && call.paths.isAllowed(path) && call.apps.some((app) => openerApplicationMatches(app, withApp));
      if (!allowed) throw new ShellCommandError(`Not allowed to open path ${path}${withApp !== null ? ` with ${withApp}` : ''}`);
      // RUST-FIX(RF-W23-opener-open-path-executables)：Rust 插件把可执行文件同样交给系统打开，即运行它。
      const executable = executableTarget(path, platform);
      if (executable !== null) throw new ShellCommandError(`Not allowed to open path ${path}: ${executable}`);
      if (withApp !== null) {
        // Rust 仅在 `with` 为空时预检查存在性；指定程序时交给启动进程自己失败。
        await openWith(path, withApp);
      } else {
        try {
          statSync(path);
        } catch (error) {
          throw new ShellCommandError(io(error));
        }
        const error = await shell.openPath(path);
        if (error !== '') throw new ShellCommandError(error);
      }
      return null;
    },
    reveal_item_in_dir: (input) => {
      const paths = reqStringArray(input, 'paths');
      for (const p of paths) {
        if (!existsSync(p)) {
          throw new ShellCommandError(io(Object.assign(new Error('ENOENT'), { code: 'ENOENT', errno: -2 })));
        }
      }
      for (const p of paths) shell.showItemInFolder(p);
      return null;
    },
  };
}

/** `plugin:notification|notify` 的原生投递面；测试可注入替身，生产默认走 Electron Notification。 */
export interface NotificationHooks {
  isSupported(): boolean;
  show(options: {
    /** Rust `NotificationBuilder::id(i32)`；Electron 在 macOS/Windows 用它做系统级去重。 */
    id?: string;
    title: string;
    body: string;
    silent: boolean;
    icon?: string;
  }): void;
}

export const electronNotificationHooks: NotificationHooks = {
  isSupported: () => Notification.isSupported(),
  show: (options) => {
    new Notification({
      title: options.title,
      body: options.body,
      silent: options.silent,
      ...(options.id === undefined ? {} : { id: options.id }),
      ...(options.icon === undefined ? {} : { icon: options.icon }),
    }).show();
  },
};

export function notificationPlugin(hooks: NotificationHooks = electronNotificationHooks): BuiltinPlugin {
  return {
    // 桌面端 permission_state / request_permission 恒为 Granted（tauri-plugin-notification desktop.rs）。
    is_permission_granted: () => true,
    request_permission: () => 'granted',
    notify: (input) => {
      const options = raw(input, 'options');
      if (options === undefined) throw missingKey(input.command, 'options');
      const o = (options ?? {}) as { id?: unknown; title?: unknown; body?: unknown; silent?: unknown; icon?: unknown };
      if (!hooks.isSupported()) throw new ShellCommandError('[electron-shell] notifications are not supported on this system');
      try {
        hooks.show({
          ...(typeof o.id === 'number' && Number.isInteger(o.id) ? { id: String(o.id) } : {}),
          title: typeof o.title === 'string' ? o.title : '',
          body: typeof o.body === 'string' ? o.body : '',
          silent: o.silent === true,
          ...(typeof o.icon === 'string' ? { icon: o.icon } : {}),
        });
      } catch (error) {
        throw new ShellCommandError(
          `[electron-shell] notification failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    },
  };
}

export interface ProcessHooks {
  /** `app.request_restart()`：走有序退出后重启。 */
  restart(): void;
  /** `app.exit(code)`：走有序退出。 */
  exit(code: number): void;
}

export function processPlugin(hooks: ProcessHooks): BuiltinPlugin {
  return {
    exit: (input) => {
      const code = raw(input, 'code');
      if (code === undefined) throw missingKey(input.command, 'code');
      hooks.exit(typeof code === 'number' ? code : 0);
      return null;
    },
    restart: () => {
      hooks.restart();
      return null;
    },
  };
}

export { updaterPlugin } from '../updater.ts';

export interface GlobalShortcutHooks {
  /** 原生处理器（Rust `with_handler`），按下时调用。 */
  pressed(event: { shortcut: string; id: number; state: 'Pressed' }): void;
}

/**
 * Rust `with_handler` 是应用逻辑（quick_assistant::toggle）：按下事件作为 main 的原生事件交给 Host，带 `native: true`
 * （SEC-E05），与页面经 `plugin:event|emit` 发来的同名事件区分。
 */
export function forwardShortcutToHost(runtime: { sendNativeEvent(event: string, payload: unknown, source: WindowRef): void }): GlobalShortcutHooks['pressed'] {
  return (event) => runtime.sendNativeEvent(GLOBAL_SHORTCUT_TRIGGERED, event, { window: 'main', webview: 'main' });
}

export function globalShortcutPlugin(platform: ShellPlatform, hooks: GlobalShortcutHooks): BuiltinPlugin {
  /** 已注册快捷键：hotkey id → 回调通道与 accelerator（与 Rust 一样以 id 去重）。 */
  const registered = new Map<number, { hotkey: ParsedHotKey; accelerator: string; webview: string; channel: number }>();
  const parse = (shortcut: string): ParsedHotKey => {
    try {
      return parseHotKey(shortcut, platform);
    } catch (error) {
      if (error instanceof HotKeyParseError) throw new ShellCommandError(error.message);
      throw error;
    }
  };
  const accel = (hotkey: ParsedHotKey, shortcut: string): string => {
    const a = toElectronAccelerator(hotkey);
    if (a === null) throw new ShellCommandError(`[electron-shell] global-shortcut key \`${hotkey.key}\` (${shortcut}) has no Electron accelerator`);
    return a;
  };
  return {
    register: (input: InvokeInput, ctx: CommandContext) => {
      const shortcuts = reqStringArray(input, 'shortcuts');
      const channel = reqChannel(input, 'handler');
      const parsed = shortcuts.map((s) => ({ hotkey: parse(s), shortcut: s }));
      for (const { hotkey, shortcut } of parsed) {
        const accelerator = accel(hotkey, shortcut);
        const ok = globalShortcut.register(accelerator, () => {
          const event = { shortcut: hotKeyToString(hotkey), id: hotkey.id, state: 'Pressed' as const };
          hooks.pressed(event);
          const entry = registered.get(hotkey.id);
          if (entry) ctx.runtime.sendChannel(entry.webview, entry.channel, event);
        });
        if (!ok) throw new ShellCommandError(`Unable to register hotkey: ${shortcut}`);
        registered.set(hotkey.id, { hotkey, accelerator, webview: ctx.webviewLabel, channel });
      }
      return null;
    },
    unregister: (input) => {
      for (const shortcut of reqStringArray(input, 'shortcuts')) {
        const hotkey = parse(shortcut);
        const entry = registered.get(hotkey.id);
        globalShortcut.unregister(entry?.accelerator ?? accel(hotkey, shortcut));
        registered.delete(hotkey.id);
      }
      return null;
    },
    unregister_all: () => {
      for (const entry of registered.values()) globalShortcut.unregister(entry.accelerator);
      registered.clear();
      return null;
    },
    is_registered: (input) => {
      const shortcut = reqString(input, 'shortcut');
      try {
        return registered.has(parseHotKey(shortcut, platform).id);
      } catch (error) {
        if (error instanceof HotKeyParseError) return false;
        throw error;
      }
    },
  };
}
