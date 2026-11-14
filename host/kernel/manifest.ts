/**
 * 插件包清单（`package.json#deepStudent`）的装载期校验。唯一权威定义是契约
 * `contracts/plugin-manifest/v1.schema.json`：结构校验直接编译该文件，不另写 schema；
 * 版本范围求值按契约 `$defs/range` 的文字语义实现，与门禁 `gate-checks/plugin-manifest.mjs`
 * 的一致性由 `host/kernel/tests/plugin-manifest-contract.test.ts` 守护。
 *
 * 校验顺序（契约 description）：manifestVersion → engines.deepStudent 对应用版本 → 完整 schema →
 * 来源相关的 id 限制 → 平台。启动期任一不通过只降级该插件（{@link PluginLoadError} 的消息即
 * `plugin:host|status` 的 `reason`，以错误码开头）；安装期由 {@link assertInstallable} 直接拒绝。
 *
 * 可移植：不依赖 Node 内建模块（读 package.json 的是桌面端 profile 装载器）。
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import MANIFEST_SCHEMA from '../../contracts/plugin-manifest/v1.schema.json' with { type: 'json' };
import type { HostPlugin, PluginPlatform } from './api.ts';
import { KERNEL_ONLY_SERVICES } from './kernel.ts';
import { PluginLoadError, type PluginLoadCode } from './plugin-load-error.ts';
import { isServiceNameOwnedBy, parsePluginId, reservedIdProblem, type PluginIdContext } from './plugin-id.ts';

export { PLUGIN_LOAD_CODES, PluginLoadError, parseDegradedReason, type PluginLoadCode } from './plugin-load-error.ts';

/** 本应用支持的最高 manifestVersion。 */
export const SUPPORTED_MANIFEST_VERSION = 1;
/** Plugin API support is a release contract, independent of the application version. */
const SUPPORTED_PLUGIN_APIS = new Set(['1']);

// ------------------------------------------------------------------ 版本与范围（契约 $defs/version、$defs/range）

type Triple = readonly [number, number, number];

const N = '(0|[1-9][0-9]*)';
/** 与契约 `$defs/version` 接受同一语言（一致性测试守护），另捕获三段数字与预发布标签。 */
const VERSION_RE = new RegExp(`^${N}\\.${N}\\.${N}(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
const RANGE_RE = new RegExp(MANIFEST_SCHEMA.$defs.range.pattern);
const PARTIAL_RE = new RegExp(`^([\\^~])${N}\\.${N}(?:\\.${N})?$`);
const EXACT_RE = new RegExp(`^${N}\\.${N}\\.${N}$`);
const BOUNDED_RE = new RegExp(`^>=${N}\\.${N}\\.${N}(?: <${N}\\.${N}\\.${N})?$`);

/** `X.Y.Z[-pre][+build]`；不合法返回 null。 */
export function parseVersion(text: string): { version: Triple; prerelease: string | null } | null {
  const m = VERSION_RE.exec(text);
  return m ? { version: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] ?? null } : null;
}

/** 范围的半开区间 `[min, max)`（`max` 为 null 表示无上界）。 */
export interface VersionRange {
  min: Triple;
  max: Triple | null;
}

const compare = (a: Triple, b: Triple) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * 契约范围子集 → 区间；不在子集内返回 null。语义同 npm semver：
 * `^X.Y[.Z]` 主版本非 0 到下一主版本、`^0.Y[.Z]`（Y>0）与 `^0.0` 到 0.(Y+1).0、`^0.0.Z` 只含 0.0.Z；
 * `~X.Y[.Z]` 到 X.(Y+1).0；`X.Y.Z` 精确；`>=X.Y.Z[ <A.B.C]`。
 */
export function parseRange(text: string): VersionRange | null {
  if (!RANGE_RE.test(text)) return null;
  let m = PARTIAL_RE.exec(text);
  if (m) {
    const major = Number(m[2]), minor = Number(m[3]), patch = m[4] === undefined ? null : Number(m[4]);
    const min: Triple = [major, minor, patch ?? 0];
    if (m[1] === '~') return { min, max: [major, minor + 1, 0] };
    if (major > 0) return { min, max: [major + 1, 0, 0] };
    if (minor > 0 || patch === null) return { min, max: [0, minor + 1, 0] };
    return { min, max: [0, 0, patch + 1] };
  }
  if ((m = EXACT_RE.exec(text))) {
    const v: Triple = [Number(m[1]), Number(m[2]), Number(m[3])];
    return { min: v, max: [v[0], v[1], v[2] + 1] };
  }
  if ((m = BOUNDED_RE.exec(text))) {
    return { min: [Number(m[1]), Number(m[2]), Number(m[3])], max: m[4] === undefined ? null : [Number(m[4]), Number(m[5]), Number(m[6])] };
  }
  return null;
}

/** 区间为空（上界不大于下界）。 */
export function rangeIsEmpty(range: VersionRange): boolean {
  return range.max !== null && compare(range.max, range.min) <= 0;
}

/**
 * 0.20 起插件 API v1 与 0.11 完全兼容：只面向 0.11 线的既有范围（如 `^0.11`、
 * `~0.11.5`、`0.11.2`、`>=0.11.0 <0.12.0`）在 0.20+ 上继续放行，避免升级后
 * 已安装插件与工坊模板以 `ENGINE_INCOMPATIBLE` 被降级。
 */
function isLegacyEngineRange(range: VersionRange): boolean {
  return compare(range.min, [0, 11, 0]) >= 0
    && range.max !== null
    && compare(range.max, [0, 12, 0]) <= 0;
}

/** `engines.deepStudent` 的应用版本判定：当前范围，或 0.20+ 对 0.11 线旧范围的兼容。 */
export function satisfiesAppEngine(appVersion: string, range: string, legacyWorkshop = false): boolean {
  if (satisfies(appVersion, range) === true) return true;
  const app = parseVersion(appVersion);
  if (app === null || app.version[0] !== 0 || app.version[1] < 20) return false;
  const parsed = parseRange(range);
  // Older Workshop projects used this exact generated default. Do not widen
  // manually bounded third-party ranges or rewrite installed package bytes.
  return parsed !== null && (isLegacyEngineRange(parsed)
    || (legacyWorkshop && range === '^0.20' && SUPPORTED_PLUGIN_APIS.has('1')));
}

export interface SatisfiesOptions {
  /**
   * npm semver 7 的 `includePrerelease`（默认开启；关闭时同 npm 默认，带预发布标签的版本不满足任何范围，
   * 即 W09 gate 的语义）。开启时预发布版本按优先级参与比较（`X.Y.Z-pre` < `X.Y.Z`），范围按 semver 7 展开：
   * 省略补丁号的 `^X.Y` / `~X.Y` 下界是 `>=X.Y.0-0`（含 `X.Y.0` 的预发布），其余下界不含；`^` / `~` / 精确版本的
   * 上界是 `<A.B.C-0`（不含 `A.B.C` 的预发布），显式 `<A.B.C` 含。
   */
  includePrerelease?: boolean;
}

/** version 是否在 range 内；任一不合法返回 null。 */
export function satisfies(version: string, range: string, options: SatisfiesOptions = {}): boolean | null {
  const v = parseVersion(version);
  const r = parseRange(range);
  if (!v || !r) return null;
  if (v.prerelease === null) return compare(v.version, r.min) >= 0 && (r.max === null || compare(v.version, r.max) < 0);
  if (options.includePrerelease === false) return false;
  // 范围不含预发布标签，所以 `T-pre` 与边界的比较只看 T：`>=min-0` ⇔ T>=min，`>=min` ⇔ T>min，
  // `<max-0` ⇔ T<max，`<max` ⇔ T<=max。
  const caretOrTilde = PARTIAL_RE.exec(range);
  const partial = caretOrTilde !== null && caretOrTilde[4] === undefined;
  const explicitMax = BOUNDED_RE.exec(range)?.[4] !== undefined;
  const aboveMin = partial ? compare(v.version, r.min) >= 0 : compare(v.version, r.min) > 0;
  const belowMax = r.max === null || (explicitMax ? compare(v.version, r.max) <= 0 : compare(v.version, r.max) < 0);
  return aboveMin && belowMax;
}

// ------------------------------------------------------------------ schema

let validator: ValidateFunction | null = null;

/** 契约 schema 的 Ajv 校验函数（首次使用时编译；多数启动没有社区插件）。 */
function validateManifest(): ValidateFunction {
  validator ??= new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false }).compile(MANIFEST_SCHEMA);
  return validator;
}

function describeSchemaErrors(errors: readonly ErrorObject[]): string[] {
  const out = new Set<string>();
  for (const e of errors) {
    // anyOf 分支与 allOf/propertyNames 的子错误由外层错误代表。
    if (e.keyword === 'allOf' || e.propertyName !== undefined || /\/anyOf\/\d+\//.test(e.schemaPath)) continue;
    const at = e.instancePath || '/';
    if (e.keyword === 'required') out.add(`${at} is missing "${String(e.params.missingProperty)}"`);
    else if (e.keyword === 'additionalProperties') out.add(`${at} has unknown field "${String(e.params.additionalProperty)}"`);
    else if (e.keyword === 'anyOf') out.add(`${at} must declare "host" or "ui"`);
    else if (e.keyword === 'not') out.add(e.schemaPath.includes('/id/') ? `${at} uses a forbidden publisher` : `${at} must not contain ".." segments`);
    else out.add(`${at} ${e.message ?? 'is invalid'}`);
  }
  return [...out];
}

/** 契约 schema 的问题列表（空数组即通过）。 */
export function manifestSchemaProblems(pkg: unknown): string[] {
  const validate = validateManifest();
  return validate(pkg) ? [] : describeSchemaErrors(validate.errors ?? []);
}

// ------------------------------------------------------------------ 清单

/** 校验通过后的清单（只保留装载方使用的字段）。 */
export interface PluginManifest {
  // RUST-FIX(RF-P1-plugin-display): Validated, non-executable package presentation.
  /** Host-derived only; never parsed from package metadata. */
  trust?: 'full' | 'restricted';
  displayName?: string;
  icon?: string;
  author?: string;
  description?: string;
  category?: string;
  homepage?: string;
  id: string;
  /** package.json#name。 */
  packageName: string;
  /** package.json#version。 */
  version: string;
  engines: string;
  platforms: readonly PluginPlatform[];
  host?: string;
  ui?: string;
  requires: Readonly<Record<string, string>>;
  permissions: readonly string[];
}

export interface ManifestCheckOptions {
  /** 应用版本（根 package.json#version，经握手传入的 `AppInfo.version`）。 */
  appVersion: string;
  /** 装载来源，决定 assigned publisher 的限制。 */
  context: Exclude<PluginIdContext, 'builtin'>;
  /** 当前平台；给出时检查 `platforms`。 */
  platform?: PluginPlatform;
  /** profile 条目声明的 id；给出时必须等于 manifest id。 */
  expectedId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 按契约顺序校验一个 package.json（已解析的 JSON 值）。失败时返回第一个不通过步骤的 {@link PluginLoadError}。
 * `fallbackId` 用于还读不出合法 id 时的错误归属（通常是 profile 条目 id）。
 */
export function checkManifest(pkg: unknown, options: ManifestCheckOptions, fallbackId = options.expectedId ?? '(unknown)'): { ok: true; manifest: PluginManifest } | { ok: false; error: PluginLoadError } {
  const fail = (code: PluginLoadCode, detail: string) => ({ ok: false as const, error: new PluginLoadError(code, fallbackId, detail) });
  const ds = isRecord(pkg) ? pkg.deepStudent : undefined;
  if (!isRecord(pkg) || !isRecord(ds)) return fail('MANIFEST_MISSING', 'package.json has no "deepStudent" manifest');
  const declaredId = typeof ds.id === 'string' ? ds.id : null;
  if (declaredId !== null && parsePluginId(declaredId)) fallbackId = declaredId;

  const manifestVersion = ds.manifestVersion;
  if (typeof manifestVersion === 'number' && Number.isInteger(manifestVersion) && manifestVersion > SUPPORTED_MANIFEST_VERSION) {
    return fail('MANIFEST_VERSION_UNSUPPORTED', `manifestVersion ${manifestVersion} is newer than this app supports (${SUPPORTED_MANIFEST_VERSION}); upgrade the app`);
  }

  const engines = isRecord(pkg.engines) ? pkg.engines.deepStudent : undefined;
  if (typeof engines !== 'string') return fail('MANIFEST_INVALID', '/engines/deepStudent is required');
  if (parseRange(engines) === null) return fail('MANIFEST_INVALID', `/engines/deepStudent ${JSON.stringify(engines)} is not a supported range (^X.Y[.Z], ~X.Y[.Z], X.Y.Z, >=X.Y.Z[ <A.B.C])`);
  const pluginApi = isRecord(pkg.engines) ? pkg.engines.deepStudentPluginApi : undefined;
  if (pluginApi !== undefined && (typeof pluginApi !== 'string' || !SUPPORTED_PLUGIN_APIS.has(pluginApi))) {
    return fail('ENGINE_INCOMPATIBLE', `requires plugin API ${JSON.stringify(pluginApi)}; supported: ${[...SUPPORTED_PLUGIN_APIS].join(', ')}`);
  }
  // Existing managed projects have a Host-assigned Workshop ID. Explicit API
  // declarations and other application ranges retain their exact meaning.
  const legacyWorkshop = pluginApi === undefined && manifestVersion === 1
    && declaredId !== null && /^workshop\.plugin-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(declaredId);
  if (satisfiesAppEngine(options.appVersion, engines, legacyWorkshop) !== true) {
    return fail('ENGINE_INCOMPATIBLE', `requires app version ${engines}; this app is ${options.appVersion}`);
  }

  if (Array.isArray(ds.permissions)) {
    const unknown = ds.permissions.filter((p): p is string => typeof p === 'string' && /^[a-z][a-z0-9-]*:\S+$/.test(p) && !p.startsWith('service:'));
    if (unknown.length) return fail('PERMISSION_UNKNOWN_KIND', `unknown permission kind in ${unknown.map(p => JSON.stringify(p)).join(', ')} (v1 only knows "service")`);
  }

  const problems = manifestSchemaProblems(pkg);
  const id = declaredId!;
  const requires = isRecord(ds.requires) ? (ds.requires as Record<string, string>) : {};
  if (!problems.length) {
    for (const [dep, range] of Object.entries(requires)) {
      if (dep === id) problems.push(`/deepStudent/requires must not require the plugin itself (${dep})`);
      else if (rangeIsEmpty(parseRange(range)!)) problems.push(`/deepStudent/requires/${dep} is an empty range: ${range}`);
    }
  }
  if (problems.length) return fail('MANIFEST_INVALID', problems.join('; '));

  const reserved = reservedIdProblem(id, options.context);
  if (reserved) return fail('ID_RESERVED', `plugin id "${id}": ${reserved}`);
  if (options.expectedId !== undefined && options.expectedId !== id) {
    return fail('ID_MISMATCH', `profile entry "${options.expectedId}" points to a package whose manifest id is "${id}"`);
  }
  const platforms = ds.platforms as PluginPlatform[];
  if (options.platform !== undefined && !platforms.includes(options.platform)) {
    return fail('UNSUPPORTED_ON_PLATFORM', `plugin "${id}" supports ${platforms.join(', ')}, not ${options.platform}`);
  }
  return {
    ok: true,
    manifest: Object.freeze({
      id,
      packageName: pkg.name as string,
      ...Object.fromEntries(['displayName', 'icon', 'author', 'description', 'category', 'homepage']
        .filter(key => typeof ds[key] === 'string').map(key => [key, ds[key]])),
      version: pkg.version as string,
      engines,
      platforms: Object.freeze([...platforms]),
      ...(typeof ds.host === 'string' ? { host: ds.host } : {}),
      ...(typeof ds.ui === 'string' ? { ui: ds.ui } : {}),
      requires: Object.freeze({ ...requires }),
      permissions: Object.freeze([...((ds.permissions as string[] | undefined) ?? [])]),
    }),
  };
}

/** 平台核心服务中对社区插件隐式授予、无需在 permissions 中声明的服务。 */
export const IMPLICIT_SERVICE_GRANTS: readonly string[] = Object.freeze(['log']);

/** permissions 授予的服务名（`service:<name>`）加隐式授予。 */
export function grantedServices(manifest: Pick<PluginManifest, 'permissions'>): Set<string> {
  const granted = new Set(IMPLICIT_SERVICE_GRANTS);
  for (const permission of manifest.permissions) if (permission.startsWith('service:')) granted.add(permission.slice('service:'.length));
  return granted;
}

function injectNames(plugin: HostPlugin<any>): string[] {
  return Array.isArray(plugin.inject) ? [...plugin.inject] : Object.keys(plugin.inject ?? {});
}

/**
 * 社区插件模块导入后、安装前的检查：`meta.id` / `meta.version` 与清单一致，提供的服务名在 id 派生的
 * 命名空间内，没有 `meta.commands`、不注入 kernel 专有服务（{@link KERNEL_ONLY_SERVICES}），
 * inject 的服务都已在 permissions 中声明（未声明的一律不注入：直接降级，不装载）。
 */
export function checkPluginModule(manifest: PluginManifest, plugin: HostPlugin<any>): PluginLoadError | null {
  const { id } = manifest;
  if (plugin.meta.id !== id) return new PluginLoadError('ID_MISMATCH', id, `module exports meta.id "${String(plugin.meta.id)}", manifest id is "${id}"`);
  if (plugin.meta.version !== manifest.version) {
    return new PluginLoadError('VERSION_MISMATCH', id, `module meta.version ${JSON.stringify(plugin.meta.version ?? null)} differs from package.json version "${manifest.version}"`);
  }
  const foreign = (plugin.meta.provides ?? []).filter(name => !isServiceNameOwnedBy(name, id));
  if (foreign.length) {
    return new PluginLoadError('SERVICE_NAME_INVALID', id, `services ${foreign.map(n => `"${n}"`).join(', ')} are outside the plugin's namespace (derived from the id; see pluginServiceName)`);
  }
  const commands = plugin.meta.commands ?? [];
  if (commands.length) {
    return new PluginLoadError('KERNEL_API_FORBIDDEN', id, `declares meta.commands ${commands.map(n => `"${n}"`).join(', ')}; app commands are not open to community plugins in plugin API v1 (use meta.remote)`);
  }
  const kernelOnly = injectNames(plugin).filter(name => KERNEL_ONLY_SERVICES.includes(name));
  if (kernelOnly.length) {
    return new PluginLoadError('KERNEL_API_FORBIDDEN', id, `injects kernel services ${kernelOnly.map(n => `"${n}"`).join(', ')}, which are not open to community plugins in plugin API v1`);
  }
  const granted = grantedServices(manifest);
  // RUST-FIX(RF-P1-plugin-trust): Explicit full trust bypasses declarations only, after K7 above.
  const undeclared = manifest.trust === 'full' ? [] : injectNames(plugin).filter(name => !granted.has(name));
  if (undeclared.length) {
    return new PluginLoadError('PERMISSION_UNDECLARED', id, `injects ${undeclared.map(n => `"${n}"`).join(', ')} without declaring ${undeclared.map(n => `"service:${n}"`).join(', ')} in deepStudent.permissions`);
  }
  return null;
}

/** requires 检查：`available` 是本次装载（或已安装）的插件 id → 版本。 */
export function checkRequires(manifest: Pick<PluginManifest, 'id' | 'requires'>, available: ReadonlyMap<string, string>): PluginLoadError | null {
  const missing: string[] = [], incompatible: string[] = [];
  for (const [dep, range] of Object.entries(manifest.requires)) {
    const version = available.get(dep);
    if (version === undefined) missing.push(`"${dep}" ${range}`);
    else if (satisfies(version, range) !== true) incompatible.push(`"${dep}" ${range} (found ${version})`);
  }
  if (missing.length) return new PluginLoadError('REQUIRES_MISSING', manifest.id, `requires ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not loaded`);
  if (incompatible.length) return new PluginLoadError('REQUIRES_INCOMPATIBLE', manifest.id, `requires ${incompatible.join(', ')}`);
  return null;
}

export interface InstallCheckOptions {
  appVersion: string;
  platform: PluginPlatform;
  /** 已安装插件 id → 版本（官方插件为应用版本）。 */
  installed: ReadonlyMap<string, string>;
}

/**
 * 安装期检查（插件管理器 / zip 安装器在写盘前调用）：与启动期同一套规则，但来源按
 * `community-install` 限制 publisher，且 requires 必须由已安装插件满足。不兼容即抛 {@link PluginLoadError}。
 */
export function assertInstallable(pkg: unknown, options: InstallCheckOptions): PluginManifest {
  const result = checkManifest(pkg, { appVersion: options.appVersion, context: 'community-install', platform: options.platform });
  if (!result.ok) throw result.error;
  // RUST-FIX(RF-W01-k7-kernel-service-install-denial): 安装期就拒绝内核专有服务，不等社区代码导入后的 inject 检查。
  const kernelOnly = result.manifest.permissions.filter((permission) => permission.startsWith('service:')
    && KERNEL_ONLY_SERVICES.includes(permission.slice('service:'.length)));
  if (kernelOnly.length) {
    throw new PluginLoadError('KERNEL_API_FORBIDDEN', result.manifest.id,
      `plugin "${result.manifest.id}" requests kernel-only services ${kernelOnly.map((name) => `"${name}"`).join(', ')}; plugin API v1 does not open them to community plugins`);
  }
  const requires = checkRequires(result.manifest, options.installed);
  if (requires) throw requires;
  return result.manifest;
}
