/**
 * UiPluginMeta v2（FRONTEND-PLUGINIZATION §2.2）：平台、依赖、与 Host 插件的配对。
 *
 * v1 插件只有 `id`、`version`，继续有效（视为 `apiVersion: 1`、平台不限、不配对）。
 */
import { PLUGIN_PLATFORMS, type PluginPlatform } from '../../host/kernel/platforms.ts';

/** 本内核提供的 UI 插件 API 版本。 */
export const UI_KERNEL_API_VERSION = 2;

/** 平台取值：即 Host 的 `PLUGIN_PLATFORMS`（`host/kernel/platforms.ts`，同一常量对象）。 */
export const UI_PLATFORMS = PLUGIN_PLATFORMS;
export type UiPlatformKind = PluginPlatform;

export interface UiPluginMeta {
  /** 全栈插件包的 id；与 Host 半相同时用 `host: true` 声明配对。 */
  id: string;
  version?: string;
  /** UI 插件 API 版本：省略视为 1；高于内核版本的插件拒绝安装。 */
  apiVersion?: 1 | 2;
  /**
   * 可装配的平台。省略表示不限：UI 半跟随 Host 清单（Host 侧省略才等于 `['desktop']`）。
   * 当前平台不在列表内时，`install` 跳过该插件并返回 false。
   */
  platforms?: readonly UiPlatformKind[];
  /** 配对的 Host 插件（FE-A3 按它对账）：`true` 表示同 id 的 Host 半；字符串为指定的 Host 插件 id；省略为不配对。 */
  host?: true | string;
  /** 额外依赖的 Host 插件 id（纯前端插件依赖官方服务时声明）。 */
  requiresHost?: readonly string[];
  /** 必须先安装的 UI 插件 id；缺失时安装失败。 */
  requires?: readonly string[];
  /**
   * 文案命名空间，省略时为插件 id（id 中的 ":" 替换为 "_"）。社区插件只能省略或写成这个派生值；
   * 另起命名空间只限官方插件。
   */
  i18n?: { namespace?: string };
  /**
   * 只在开发构建中安装（调试面板、开发命令）。生产构建的内核跳过它并返回 false；官方插件表在生产构建里
   * 连模块都不收录，因此官方插件必须写成字面量 `devOnly: true`。
   */
  devOnly?: boolean;
  /**
   * 核心插件（只限官方插件，即以 `origin: 'builtin'` 安装）：生产构建中不能卸载，也不能被同 id 的社区插件替换；
   * 社区插件只能往它的槽位追加。开发构建与测试可以卸载。与 `devOnly` 互斥。
   */
  core?: boolean;
  /**
   * 插件声明（`ctx.ui.declareSlot`）的槽位名。写了就必须列全：声明未列出的槽位会报错。插件被跳过（平台不符、
   * `devOnly`、依赖被跳过）时，其他插件往这些槽位的贡献静默跳过（开发构建告警一次），而不是报“槽位未声明”。
   * 官方插件必须写成字符串字面量数组（构建期插件表据此记下被排除插件的槽位）。
   */
  slots?: readonly string[];
}

/** 构建类型：`devOnly` 插件只在 `development` 中安装。 */
export type UiBuildKind = 'development' | 'production';

/** 当前构建（Vite 的 `import.meta.env.DEV`）；不在 Vite 环境中时按生产处理。 */
export function currentUiBuild(): UiBuildKind {
  try {
    return import.meta.env.DEV ? 'development' : 'production';
  } catch {
    return 'production';
  }
}

/** 校验并补齐缺省值后的 meta。 */
export interface NormalizedUiPluginMeta {
  readonly id: string;
  readonly version?: string;
  readonly apiVersion: 1 | 2;
  readonly platforms?: readonly UiPlatformKind[];
  readonly host?: string;
  readonly requiresHost: readonly string[];
  readonly requires: readonly string[];
  readonly namespace: string;
  /** 只在开发构建中安装。 */
  readonly devOnly?: true;
  /** 核心插件：生产构建中不能卸载或被社区插件替换。 */
  readonly core?: true;
  /** 插件声明的槽位（省略 `meta.slots` 时为 undefined）。 */
  readonly slots?: readonly string[];
}

export class UiPluginMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiPluginMetaError';
  }
}

export class UiPluginDependencyError extends Error {
  constructor(readonly pluginId: string, readonly missing: readonly string[]) {
    super(`${pluginId}: missing UI plugin dependencies: ${missing.join(', ')}`);
    this.name = 'UiPluginDependencyError';
  }
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function idList(meta: UiPluginMeta, field: 'requires' | 'requiresHost'): readonly string[] {
  const value = meta[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isId)) throw new UiPluginMetaError(`${meta.id}: meta.${field} must be an array of non-empty plugin ids`);
  return Object.freeze([...value]);
}

/** 平台校验规则与 W14 的 `pluginPlatforms` 相同：非空、取值已知、不重复。 */
export function validatePlatforms(id: string, declared: unknown): readonly UiPlatformKind[] | undefined {
  if (declared === undefined) return undefined;
  if (!Array.isArray(declared) || declared.length === 0) throw new UiPluginMetaError(`${id}: meta.platforms must be a non-empty array`);
  const seen = new Set<string>();
  for (const platform of declared as readonly unknown[]) {
    if (typeof platform !== 'string' || !(UI_PLATFORMS as readonly string[]).includes(platform)) {
      throw new UiPluginMetaError(`${id}: unknown platform ${JSON.stringify(platform)} in meta.platforms (expected ${UI_PLATFORMS.join(' | ')})`);
    }
    if (seen.has(platform)) throw new UiPluginMetaError(`${id}: duplicate platform ${platform} in meta.platforms`);
    seen.add(platform);
  }
  return Object.freeze([...declared]) as readonly UiPlatformKind[];
}

export function normalizeUiPluginMeta(meta: UiPluginMeta): NormalizedUiPluginMeta {
  if (!meta || !isId(meta.id)) throw new UiPluginMetaError('meta.id must be a non-empty string');
  const { id } = meta;
  const apiVersion = meta.apiVersion ?? 1;
  if (!Number.isInteger(apiVersion) || apiVersion < 1) throw new UiPluginMetaError(`${id}: meta.apiVersion must be a positive integer`);
  if (apiVersion > UI_KERNEL_API_VERSION) throw new UiPluginMetaError(`${id}: requires UI plugin API ${apiVersion}, this kernel provides ${UI_KERNEL_API_VERSION}`);
  if (meta.host !== undefined && meta.host !== true && !isId(meta.host)) throw new UiPluginMetaError(`${id}: meta.host must be true or a non-empty plugin id`);
  const requires = idList(meta, 'requires');
  if (requires.includes(id)) throw new UiPluginMetaError(`${id}: meta.requires must not list the plugin itself`);
  const declared = meta.i18n?.namespace;
  if (declared !== undefined && (!isId(declared) || declared.includes(':'))) {
    throw new UiPluginMetaError(`${id}: meta.i18n.namespace must be a non-empty string without ":"`);
  }
  const namespace = declared ?? pluginNamespace(id);
  if (meta.devOnly !== undefined && typeof meta.devOnly !== 'boolean') throw new UiPluginMetaError(`${id}: meta.devOnly must be a boolean`);
  if (meta.core !== undefined && typeof meta.core !== 'boolean') throw new UiPluginMetaError(`${id}: meta.core must be a boolean`);
  if (meta.core && meta.devOnly) throw new UiPluginMetaError(`${id}: meta.core and meta.devOnly are mutually exclusive`);
  const slots = meta.slots;
  if (slots !== undefined && (!Array.isArray(slots) || !slots.every(isId) || new Set(slots).size !== slots.length)) {
    throw new UiPluginMetaError(`${id}: meta.slots must be an array of distinct non-empty slot names`);
  }
  return Object.freeze({
    id,
    version: meta.version,
    apiVersion: apiVersion as 1 | 2,
    platforms: validatePlatforms(id, meta.platforms),
    host: meta.host === true ? id : meta.host,
    requiresHost: idList(meta, 'requiresHost'),
    requires,
    namespace,
    devOnly: meta.devOnly === true ? true : undefined,
    core: meta.core === true ? true : undefined,
    slots: slots && Object.freeze([...slots]),
  });
}

/**
 * 由插件 id 派生的文案命名空间（插件生态 v1 决议：命名空间由 id 派生）。社区插件只能使用它；官方插件可另行声明。
 * ":" 是 i18next 的命名空间分隔符；v1 插件 id 可能含 ":"，派生时替换掉。
 */
export function pluginNamespace(id: string): string {
  return id.replaceAll(':', '_');
}

/** 该 UI 半需要在线的 Host 插件（配对的 Host 半 + requiresHost，去重保序）。FE-A3 用它对账。 */
export function requiredHostPlugins(meta: NormalizedUiPluginMeta): string[] {
  return [...new Set([...(meta.host ? [meta.host] : []), ...meta.requiresHost])];
}
