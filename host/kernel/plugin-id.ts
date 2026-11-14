/**
 * 插件 id 与由它派生的命名空间（`decisions/2026-11-07-plugin-ecosystem-v1.md`，契约
 * `contracts/plugin-manifest/v1.schema.json` 的 `$defs/id` 与 `$defs/reservedPublishers`）。
 *
 * id 语法与保留 publisher 直接取自契约，不在这里另写一份；派生规则（服务名、存储前缀、数据目录、
 * i18n / 设置命名空间、事件名、槽位贡献 id）在本文件定义，规则说明见 `host/kernel/API.md`「插件 id 与派生命名空间」。
 * 可移植：不依赖 Node 内建模块，移动端 Host 与前端可直接导入。
 */
import MANIFEST_SCHEMA from '../../contracts/plugin-manifest/v1.schema.json' with { type: 'json' };
import { illegalEventName, isEventNameValid } from './event-name.ts';

const ID_DEF = MANIFEST_SCHEMA.$defs.id;
const ID_PATTERN = new RegExp(ID_DEF.pattern);
const FORBIDDEN_PATTERN = new RegExp(ID_DEF.not.pattern);

/** 任何插件都不得使用的 publisher（契约 `reservedPublishers.forbidden`）。 */
export const FORBIDDEN_PUBLISHERS: readonly string[] = Object.freeze([...MANIFEST_SCHEMA.$defs.reservedPublishers.const.forbidden]);

/** 只能用于指定场合的 publisher → 场合说明（契约 `reservedPublishers.assigned`）。 */
export const ASSIGNED_PUBLISHERS: Readonly<Record<string, string>> = Object.freeze({ ...MANIFEST_SCHEMA.$defs.reservedPublishers.const.assigned });

/** 官方内置插件的 publisher。 */
export const OFFICIAL_PUBLISHER = 'dstu';

export interface PluginIdParts {
  id: string;
  /** 第一段。 */
  publisher: string;
  /** 第一段之后的部分（官方插件可含 `.`，如 `platform.crypto`）。 */
  name: string;
  official: boolean;
}

/** id 是否满足契约 `$defs/id`（语法、长度与 forbidden publisher）。 */
export function isValidPluginId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= ID_DEF.maxLength && ID_PATTERN.test(id) && !FORBIDDEN_PATTERN.test(id);
}

/** 拆分合法 id；不合法返回 null。 */
export function parsePluginId(id: string): PluginIdParts | null {
  if (!isValidPluginId(id)) return null;
  const dot = id.indexOf('.');
  const publisher = id.slice(0, dot);
  return { id, publisher, name: id.slice(dot + 1), official: publisher === OFFICIAL_PUBLISHER };
}

function words(segment: string): string[] {
  return segment.split(/[.-]/).filter(Boolean);
}

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * 插件的主服务名：id 各段按 `.`/`-` 切词后拼成 lowerCamelCase，如 `alice.study-stats` → `aliceStudyStats`、
 * `example.word-of-day` → `exampleWordOfDay`。社区插件 `meta.provides` 的每个服务名必须等于它，
 * 或以它为前缀再接一个大写字母开头的后缀（`aliceStudyStatsCache`），见 {@link isServiceNameOwnedBy}。
 */
export function pluginServiceName(id: string): string {
  const parts = parsePluginId(id);
  if (!parts) throw new TypeError(`invalid plugin id: ${JSON.stringify(id)}`);
  const all = [...words(parts.publisher), ...words(parts.name)];
  return all[0]! + all.slice(1).map(capitalize).join('');
}

/** `service` 是否落在插件 `id` 的服务名空间内（等于主服务名，或主服务名 + 大写开头的后缀）。 */
export function isServiceNameOwnedBy(service: string, id: string): boolean {
  const base = pluginServiceName(id);
  return service === base || (service.startsWith(base) && /^[A-Z][A-Za-z0-9]*$/.test(service.slice(base.length)));
}

/** 由 id 派生的全部命名空间。 */
export interface PluginNamespaces {
  id: string;
  /** 主服务名，见 {@link pluginServiceName}。 */
  service: string;
  /** 前端 key-value 存储（localStorage 等）的键前缀：`ds:plugin:<id>:`。 */
  storagePrefix: string;
  /** 数据目录相对 `<数据目录>` 的路径段：`['plugins', id]`；由调用方用平台路径服务拼接。 */
  dataDirSegments: readonly [string, string];
  /** i18n 命名空间：id 本身。 */
  i18nNamespace: string;
  /** 设置命名空间：id 本身。 */
  settingsNamespace: string;
  /** 自定义事件名前缀：id 的 `.` 换成 `/` 再接 `:`，见 {@link pluginEventName}。 */
  eventPrefix: string;
  /** 槽位贡献 id 前缀：`<id>/`。 */
  slotPrefix: string;
}

export function pluginNamespaces(id: string): PluginNamespaces {
  return Object.freeze({
    id,
    service: pluginServiceName(id),
    storagePrefix: `ds:plugin:${id}:`,
    dataDirSegments: Object.freeze(['plugins', id] as [string, string]),
    i18nNamespace: id,
    settingsNamespace: id,
    eventPrefix: `${eventScope(id)}:`,
    slotPrefix: `${id}/`,
  });
}

/** id 的字符集是 `[a-z0-9.-]`，不含 `/`，所以 `.` → `/` 一一对应。 */
function eventScope(id: string): string {
  return id.replaceAll('.', '/');
}

/**
 * 自定义事件名：id 的 `.` 换成 `/`，再接 `:<event>`，如 `example.word-of-day` + `refreshed` → `example/word-of-day:refreshed`。
 * 事件名只允许字母数字与 `- / : _`（Tauri `is_event_name_valid`；前端 `emit`/`listen` 与 Host `backendEvents` 同一条），
 * id 原样带 `.` 过不了；`event` 本身也必须是合法事件名。
 */
export function pluginEventName(id: string, event: string): string {
  if (!isValidPluginId(id)) throw new TypeError(`invalid plugin id: ${JSON.stringify(id)}`);
  if (!event) throw new TypeError('event name must be non-empty');
  if (!isEventNameValid(event)) throw new TypeError(illegalEventName(event));
  return `${eventScope(id)}:${event}`;
}

/** 槽位贡献 id `<id>/<localId>`。 */
export function pluginSlotId(id: string, localId: string): string {
  if (!isValidPluginId(id)) throw new TypeError(`invalid plugin id: ${JSON.stringify(id)}`);
  if (!localId || localId.includes('/')) throw new TypeError(`slot local id must be non-empty and contain no "/": ${JSON.stringify(localId)}`);
  return `${id}/${localId}`;
}

/** 存储键 `ds:plugin:<id>:<key>`。 */
export function pluginStorageKey(id: string, key: string): string {
  if (!isValidPluginId(id)) throw new TypeError(`invalid plugin id: ${JSON.stringify(id)}`);
  return `ds:plugin:${id}:${key}`;
}

/** 装载来源：决定 assigned publisher 能否使用。 */
export type PluginIdContext = 'builtin' | 'community-startup' | 'community-install';

/**
 * assigned publisher 的来源限制（forbidden 已由 {@link isValidPluginId} 拒绝）：
 * - `dstu`：只有应用内置模块可用；社区来源一律拒绝（防止冒充官方插件）。
 * - `local` / `test`：启动时允许（本地开发、测试夹具从用户 profile 装载）；安装期拒绝（不得进入索引 / 安装包）。
 * - `example`：两种社区来源都允许（示例插件就是给开发者装来看的）。
 * 返回拒绝原因；允许时返回 null。
 */
export function reservedIdProblem(id: string, context: PluginIdContext): string | null {
  const parts = parsePluginId(id);
  if (!parts || context === 'builtin') return null;
  if (parts.publisher === OFFICIAL_PUBLISHER) return `publisher "${OFFICIAL_PUBLISHER}" is reserved for built-in plugins`;
  if (context === 'community-install' && (parts.publisher === 'local' || parts.publisher === 'test')) {
    return `publisher "${parts.publisher}" is reserved (${ASSIGNED_PUBLISHERS[parts.publisher]}) and cannot be installed`;
  }
  return null;
}
