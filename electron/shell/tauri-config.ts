/**
 * 读取 Node 维护的 `resources/app/tauri.conf.json` 与平台覆盖文件，沿用既有合并规则。
 *
 * Tauri（tauri-utils `config::parse`）把 `tauri.<platform>.conf.json` 以 JSON Merge Patch
 * （RFC 7396）合并进主配置：对象逐键递归合并，数组与标量整体替换，`null` 删除键。
 * 因此 macOS 下 `app.windows` 整个数组被 `tauri.macos.conf.json` 的数组替换。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWindowConfig } from './window-config.ts';

export type ShellPlatform = 'darwin' | 'win32' | 'linux';

/** Tauri `WindowConfig` 中本外壳会读取的字段（camelCase），由 `decodeWindowConfig` 校验并归一化后产生。 */
export interface TauriWindowConfig {
  label?: string;
  url?: string;
  title?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  x?: number;
  y?: number;
  center?: boolean;
  resizable?: boolean;
  maximizable?: boolean;
  minimizable?: boolean;
  closable?: boolean;
  fullscreen?: boolean;
  focus?: boolean;
  focusable?: boolean;
  maximized?: boolean;
  visible?: boolean;
  decorations?: boolean;
  alwaysOnTop?: boolean;
  alwaysOnBottom?: boolean;
  contentProtected?: boolean;
  skipTaskbar?: boolean;
  shadow?: boolean;
  transparent?: boolean;
  titleBarStyle?: 'Visible' | 'Transparent' | 'Overlay';
  hiddenTitle?: boolean;
  trafficLightPosition?: { x: number; y: number };
  dragDropEnabled?: boolean;
  theme?: 'light' | 'dark';
  /** RGBA. */
  backgroundColor?: [number, number, number, number];
  additionalBrowserArgs?: string;
  zoomHotkeysEnabled?: boolean;
  parent?: string;
  acceptFirstMouse?: boolean;
  tabbingIdentifier?: string;
  devtools?: boolean;
}

export interface TauriUpdaterWindowsConfig {
  installerArgs?: string[];
  installMode?: 'basicUi' | 'quiet' | 'passive';
}

export interface TauriUpdaterConfig {
  endpoints: string[];
  pubkey: string;
  windows?: TauriUpdaterWindowsConfig;
}

export interface EffectiveTauriConfig {
  productName: string;
  version: string;
  identifier: string;
  devUrl: string;
  frontendDist: string;
  windows: TauriWindowConfig[];
  /** `app.security.assetProtocol.scope`（字符串数组形式）。 */
  assetScope: { allow: string[]; deny: string[]; requireLiteralLeadingDot?: boolean };
  assetProtocolEnabled: boolean;
  csp: string | null;
  macOSPrivateApi: boolean;
  /** `plugins.updater`（tauri-plugin-updater 2.10.0 的 Config）。 */
  updater?: TauriUpdaterConfig;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** RFC 7396 JSON Merge Patch，与 tauri-utils 使用的 `json_patch::merge` 相同。 */
export function mergePatch(target: Json, patch: Json): Json {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const base: { [key: string]: Json } =
    target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else base[key] = mergePatch(base[key] ?? null, value);
  }
  return base;
}

function platformConfigName(platform: ShellPlatform): string {
  switch (platform) {
    case 'darwin':
      return 'tauri.macos.conf.json';
    case 'win32':
      return 'tauri.windows.conf.json';
    case 'linux':
      return 'tauri.linux.conf.json';
  }
}

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8')) as Json;
}

function asObject(value: Json | undefined): { [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asString(value: Json | undefined, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function loadTauriConfig(tauriDir: string, platform: ShellPlatform, devOverride?: string): EffectiveTauriConfig {
  let merged = readJson(join(tauriDir, 'tauri.conf.json'));
  const platformFile = join(tauriDir, platformConfigName(platform));
  if (existsSync(platformFile)) merged = mergePatch(merged, readJson(platformFile));
  if (devOverride) merged = mergePatch(merged, readJson(devOverride));
  const root = asObject(merged);
  const build = asObject(root.build);
  const app = asObject(root.app);
  const security = asObject(app.security);
  const assetProtocol = asObject(security.assetProtocol);
  const scope = assetProtocol.scope;
  let assetScope: EffectiveTauriConfig['assetScope'] = { allow: [], deny: [] };
  if (Array.isArray(scope)) {
    assetScope = { allow: scope.filter((s): s is string => typeof s === 'string'), deny: [] };
  } else if (scope !== undefined && scope !== null && typeof scope === 'object') {
    const allow = Array.isArray(scope.allow) ? scope.allow.filter((s): s is string => typeof s === 'string') : [];
    const deny = Array.isArray(scope.deny) ? scope.deny.filter((s): s is string => typeof s === 'string') : [];
    const lead = scope.requireLiteralLeadingDot;
    assetScope = typeof lead === 'boolean' ? { allow, deny, requireLiteralLeadingDot: lead } : { allow, deny };
  }
  if (app.windows !== undefined && !Array.isArray(app.windows)) {
    throw new Error(`invalid tauri config: app.windows: invalid type: ${app.windows === null ? 'null' : typeof app.windows}, expected a sequence`);
  }
  const windows = (app.windows ?? []).map((window, index) => {
    try {
      return decodeWindowConfig(window);
    } catch (error) {
      throw new Error(`invalid tauri config: app.windows[${index}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const updater = asObject(asObject(root.plugins).updater);
  const updaterWindows = asObject(updater.windows);
  const installerArgs = Array.isArray(updaterWindows.installerArgs)
    ? updaterWindows.installerArgs.filter((s): s is string => typeof s === 'string')
    : Array.isArray(updaterWindows['installer-args'])
      ? (updaterWindows['installer-args'] as Json[]).filter((s): s is string => typeof s === 'string')
      : undefined;
  const installMode = updaterWindows.installMode ?? updaterWindows['install-mode'];
  return {
    productName: asString(root.productName, 'app'),
    version: asString(root.version, '0.0.0'),
    identifier: asString(root.identifier, ''),
    devUrl: asString(build.devUrl, ''),
    frontendDist: join(tauriDir, asString(build.frontendDist, '../../dist')),
    windows,
    assetScope,
    assetProtocolEnabled: assetProtocol.enable === true,
    csp: typeof security.csp === 'string' ? security.csp : null,
    macOSPrivateApi: app.macOSPrivateApi === true,
    ...(typeof updater.pubkey === 'string' && Array.isArray(updater.endpoints)
      ? {
          updater: {
            endpoints: updater.endpoints.filter((endpoint): endpoint is string => typeof endpoint === 'string'),
            pubkey: updater.pubkey,
            ...(installerArgs !== undefined || installMode !== undefined
              ? {
                  windows: {
                    ...(installerArgs !== undefined ? { installerArgs } : {}),
                    ...(installMode === 'basicUi' || installMode === 'quiet' || installMode === 'passive' ? { installMode } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}
