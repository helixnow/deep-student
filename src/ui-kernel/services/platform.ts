/**
 * 平台服务（FRONTEND-PLUGINIZATION §2.4）：`ctx.ui.platform = { kind, os, arch?, capabilities }`。
 *
 * 由外壳桥提供：外壳在页面脚本之前暴露 `globalThis.__DS_PLATFORM__`（Electron preload；移动端外壳同名给出
 * `kind: 'mobile'`），内核据此构造缺省平台（`createShellPlatform`）；没有外壳桥（浏览器开发、单元测试）时为桌面实现
 * （`createDesktopPlatform`）。也可由 `new UiKernel({ platform })` 显式传入。`kind` 在窗口生命周期内固定；`os` 与
 * `capabilities` 可由外壳在启动后补全。内核不读 `navigator.userAgent`。
 */
import { UI_PLATFORMS, type UiPlatformKind } from '../meta';
import { readShellPlatform, type ShellPlatform } from './shell-platform';

export type UiPlatformOs = 'macos' | 'windows' | 'linux' | 'android' | 'ios' | 'web' | 'unknown';

export interface UiPlatformInfo {
  readonly kind: UiPlatformKind;
  readonly os: UiPlatformOs;
  /** CPU 架构（外壳给出时才有，例如 `arm64`、`x64`）。 */
  readonly arch?: string;
  /** 外壳能力标记，例如 `multi-window`、`native-menu`、`file-system`、`touch`。 */
  readonly capabilities: readonly string[];
}

export const DESKTOP_CAPABILITIES = ['multi-window', 'native-menu', 'file-system', 'keyboard-shortcuts'] as const;
export const MOBILE_CAPABILITIES = ['touch'] as const;

export function createDesktopPlatform(os: UiPlatformOs = 'unknown', capabilities: readonly string[] = DESKTOP_CAPABILITIES): UiPlatformInfo {
  return freeze({ kind: 'desktop', os, capabilities });
}

/** 外壳桥给出的平台（缺省读 `globalThis.__DS_PLATFORM__`）；没有外壳桥时为 undefined。能力按 kind 取缺省值。 */
export function createShellPlatform(shell: ShellPlatform | undefined = readShellPlatform()): UiPlatformInfo | undefined {
  if (!shell) return undefined;
  const capabilities = shell.kind === 'mobile' ? MOBILE_CAPABILITIES : DESKTOP_CAPABILITIES;
  return freeze({ kind: shell.kind, os: shell.os, arch: shell.arch, capabilities });
}

function freeze(info: UiPlatformInfo): UiPlatformInfo {
  if (!(UI_PLATFORMS as readonly string[]).includes(info?.kind)) {
    throw new Error(`ui platform: unknown kind ${JSON.stringify(info?.kind)} (expected ${UI_PLATFORMS.join(' | ')})`);
  }
  if (typeof info.os !== 'string') throw new Error('ui platform: os must be a string');
  if (info.arch !== undefined && typeof info.arch !== 'string') throw new Error('ui platform: arch must be a string');
  if (!Array.isArray(info.capabilities) || !info.capabilities.every((c) => typeof c === 'string')) {
    throw new Error('ui platform: capabilities must be an array of strings');
  }
  const capabilities = Object.freeze([...info.capabilities]);
  return Object.freeze(info.arch === undefined
    ? { kind: info.kind, os: info.os, capabilities }
    : { kind: info.kind, os: info.os, arch: info.arch, capabilities });
}

export class UiPlatformService {
  private _current: UiPlatformInfo;
  private readonly _listeners = new Set<() => void>();

  constructor(initial: UiPlatformInfo = createShellPlatform() ?? createDesktopPlatform()) {
    this._current = freeze(initial);
  }

  get current(): UiPlatformInfo {
    return this._current;
  }

  get kind(): UiPlatformKind {
    return this._current.kind;
  }

  has(capability: string): boolean {
    return this._current.capabilities.includes(capability);
  }

  /** 外壳补全平台信息（例如 preload 异步返回 os）；不允许改变 kind。 */
  update(patch: Partial<Pick<UiPlatformInfo, 'os' | 'arch' | 'capabilities'>>): void {
    if ('kind' in patch && (patch as { kind?: unknown }).kind !== this._current.kind) {
      throw new Error('ui platform: kind is fixed for the lifetime of a window');
    }
    this._current = freeze({ ...this._current, ...patch, kind: this._current.kind });
    for (const fn of [...this._listeners]) fn();
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => void this._listeners.delete(listener);
  }
}
