/**
 * Profile：决定 Host 加载哪些插件、以什么顺序和配置加载。格式见 API.md「Profile」。
 * 本文件是桌面入口（读 profile 文件、动态导入、社区插件清单筛查）；可移植的安装半在 profile-install.ts。
 *
 * 不使用 @deepseek-ai/cordis-plugin-loader 的原因（详见 API.md）：它在模块导入失败时只记日志并继续
 * （config/entry.ts:223-229），与"官方模块导入失败即致命"冲突；它会对配置中的 `!!js` 表达式求值（config/utils.ts），
 * 不适合用户可编辑的 profile；条目以 loader entry id 标识，而覆盖语义需要按插件 `meta.id` 合并。
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HostPlugin, PluginPlatform } from './api.ts';
import { describeError } from './kernel.ts';
import { checkManifest, checkPluginModule, checkRequires, PluginLoadError, type PluginManifest } from './manifest.ts';
import { isAppModuleUrl } from './module-origin.ts';
import {
  finishProfile, platformProblem, ProfileError, rejection,
  type ProfileInstallOptions, type ProfileLoadResult, type RejectedEntry,
} from './profile-install.ts';
import type { HostRuntime, PluginInstall } from './runtime.ts';
import type { StartupTimeline } from './startup-timing.ts';

/** 官方 profile：`extends: "official"` 的目标，也是用户 profile 装载失败后的回退目标。 */
export const OFFICIAL_PROFILE_PATH = fileURLToPath(new URL('../profiles/desktop.json', import.meta.url));

/** 用户 profile 失败时发给前端的后端事件（载荷 `{ profile, error }`）。 */
export const PROFILE_FAILED_EVENT = 'host://plugin-profile-failed';

export interface ProfileResolveOptions {
  /** `extends: "official"` 解析到的路径；默认 {@link OFFICIAL_PROFILE_PATH}。 */
  official?: string;
  /**
   * 根文件是用户 profile（`<dataDir>/plugins/user.profile.json`）：它和它 extends 的非 official 文件里，条目的 `module`
   * 只能是文件路径（`./`、`../`、绝对路径、`file:`），否则 {@link ProfileError}（S01-r3 M1）。`data:`、`node:`、`http:`、
   * 包名这类说明符不经社区清单检查就会被 `import()` 执行。官方 profile 与显式 profile 不受此限制。
   */
  user?: boolean;
}

export {
  CORE_SERVICES, ProfileError, installProfile, loadImportedProfile, orderForProfile,
  type ProfileInstallOptions, type ProfileLoadResult, type RejectedEntry,
} from './profile-install.ts';

export interface ProfileLoadOptions extends ProfileResolveOptions, ProfileInstallOptions {
  /**
   * 按插件 id 覆盖配置：浅合并到 profile 配置之上（profile 配置不是对象时以覆盖值为准）。
   * 桌面入口用它把开发开关（如 `DEEP_STUDENT_HPIAS_BACKEND`）映射到插件配置；不在 profile 中的 id 忽略。
   */
  configOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface ProfileEntry {
  /** 插件 id，必须等于模块默认导出的 `meta.id`。 */
  id: string;
  /** 模块路径：相对路径以声明它的 profile 文件所在目录为基准；也可以是绝对路径、`file:` URL，官方 / 显式 profile 还可以是包名。 */
  module: string;
  /** 传给 `apply(ctx, config)` 的配置。 */
  config?: unknown;
  /** 为 true 时移除同 id 的先前条目（用户 profile 关闭官方插件）。 */
  disabled?: boolean;
}

export interface ProfileFile {
  /** 先加载的基础 profile（相对本文件）。条目按 extends 顺序在前、本文件条目在后。 */
  extends?: string | string[];
  plugins: ProfileEntry[];
}

/** 合并后的条目：模块已解析为 import 说明符。 */
export interface ResolvedEntry {
  id: string;
  specifier: string;
  config: unknown;
  /** 最终生效的条目来自哪个 profile 文件。 */
  declaredIn: string;
}


function isFileModule(module: string): boolean {
  return module.startsWith('./') || module.startsWith('../') || isAbsolute(module) || module.startsWith('file:');
}

function resolveSpecifier(module: string, profilePath: string): string {
  if (module.startsWith('./') || module.startsWith('../')) return pathToFileURL(resolve(dirname(profilePath), module)).href;
  if (isAbsolute(module)) return pathToFileURL(module).href;
  if (module.startsWith('file:')) return module;
  return module;
}

/**
 * 校验一个已解析的 profile 值（结构、未知键、条目字段）。管理器写回前用它拒绝会破坏装载的文件；
 * {@link resolveProfile} 也用它做同一次校验。
 */
export function validateProfileFile(value: unknown, path: string): ProfileFile {
  return validateFile(value, path);
}

function validateFile(value: unknown, path: string): ProfileFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProfileError(`${path}: profile must be a JSON object`);
  const file = value as Record<string, unknown>;
  for (const key of Object.keys(file)) {
    if (key !== 'extends' && key !== 'plugins' && key !== '$schema' && key !== '$comment') throw new ProfileError(`${path}: unknown profile key "${key}"`);
  }
  const ext = file.extends;
  if (ext !== undefined && typeof ext !== 'string' && !(Array.isArray(ext) && ext.every((e) => typeof e === 'string'))) {
    throw new ProfileError(`${path}: "extends" must be a string or an array of strings`);
  }
  if (!Array.isArray(file.plugins)) throw new ProfileError(`${path}: "plugins" must be an array`);
  file.plugins.forEach((entry, index) => {
    const where = `${path}: plugins[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new ProfileError(`${where} must be an object`);
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!['id', 'module', 'config', 'disabled', '$comment'].includes(key)) throw new ProfileError(`${where}: unknown key "${key}"`);
    }
    if (typeof e.id !== 'string' || !e.id) throw new ProfileError(`${where}: "id" must be a non-empty string`);
    if (e.disabled !== undefined && typeof e.disabled !== 'boolean') throw new ProfileError(`${where}: "disabled" must be a boolean`);
    if (e.disabled !== true && (typeof e.module !== 'string' || !e.module)) throw new ProfileError(`${where}: "module" must be a non-empty string`);
  });
  return file as unknown as ProfileFile;
}

/**
 * 读取 profile（含 extends 链）并按 id 合并：后出现的同 id 条目替换先前条目（保留先前条目的位置），
 * `disabled: true` 移除该 id。
 */
export async function resolveProfile(path: string, options: ProfileResolveOptions = {}): Promise<ResolvedEntry[]> {
  const official = options.official ?? OFFICIAL_PROFILE_PATH;
  const ordered: (ResolvedEntry | null)[] = [];
  const index = new Map<string, number>();

  const visit = async (file: string, stack: string[], user: boolean): Promise<void> => {
    const abs = resolve(file);
    if (stack.includes(abs)) throw new ProfileError(`profile extends cycle: ${[...stack, abs].join(' -> ')}`);
    let text: string;
    try {
      text = await readFile(abs, 'utf8');
    } catch (error) {
      throw new ProfileError(`cannot read profile ${abs}: ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ProfileError(`profile ${abs} is not valid JSON: ${(error as Error).message}`);
    }
    const profile = validateFile(parsed, abs);
    const bases = profile.extends === undefined ? [] : Array.isArray(profile.extends) ? profile.extends : [profile.extends];
    for (const base of bases) {
      if (base === 'official') await visit(resolve(official), [...stack, abs], false);
      else await visit(resolve(dirname(abs), base), [...stack, abs], user);
    }
    for (const entry of profile.plugins) {
      const at = index.get(entry.id);
      if (entry.disabled) {
        if (at !== undefined) ordered[at] = null;
        index.delete(entry.id);
        continue;
      }
      if (user && !isFileModule(entry.module)) {
        throw new ProfileError(`${abs}: plugin "${entry.id}": module "${entry.module}" is not a file path; a user profile only loads ./ or ../ relative paths, absolute paths or file: URLs`);
      }
      const resolved: ResolvedEntry = { id: entry.id, specifier: resolveSpecifier(entry.module, abs), config: entry.config, declaredIn: abs };
      if (at !== undefined) ordered[at] = resolved;
      else {
        index.set(entry.id, ordered.length);
        ordered.push(resolved);
      }
    }
  };

  await visit(path, [], options.user === true);
  return ordered.filter((e): e is ResolvedEntry => e !== null);
}

/**
 * 导入全部条目的模块（先全部导入成功再开始安装），并核对 `meta.id`。
 * `checkedLater` 中的条目（已过清单检查的社区插件）不在这里核对 id：不一致由 {@link prepareProfile} 降级为 `ID_MISMATCH`。
 */
export async function importProfile(entries: readonly ResolvedEntry[], timeline?: StartupTimeline, checkedLater: ReadonlySet<string> = new Set()): Promise<PluginInstall[]> {
  const installs: PluginInstall[] = [];
  for (const entry of entries) installs.push(await importProfileEntry(entry, timeline, checkedLater.has(entry.id)));
  return installs;
}

async function importProfileEntry(entry: ResolvedEntry, timeline?: StartupTimeline, checkIdLater = false): Promise<PluginInstall> {
  let namespace: { default?: unknown };
  const started = performance.now();
  try {
    namespace = (await import(entry.specifier)) as { default?: unknown };
    timeline?.recordImport(entry.id, started);
  } catch (error) {
    throw new ProfileError(`plugin "${entry.id}" (${entry.specifier}, from ${entry.declaredIn}) failed to import: ${(error as Error).message}`, { cause: error });
  }
  const plugin = namespace.default as HostPlugin<any> | undefined;
  if (typeof plugin !== 'object' || plugin === null || typeof plugin.apply !== 'function' || !plugin.meta) {
    throw new ProfileError(`plugin "${entry.id}" (${entry.specifier}): module must default-export a plugin created by definePlugin()`);
  }
  if (plugin.meta?.id !== entry.id && !checkIdLater) {
    throw new ProfileError(`plugin "${entry.id}" (${entry.specifier}): module exports meta.id "${String(plugin.meta?.id)}", expected "${entry.id}"`);
  }
  return { plugin, config: entry.config, source: entry.specifier };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 按 {@link ProfileLoadOptions.configOverrides} 覆盖条目配置。 */
export function applyConfigOverrides(entries: readonly ResolvedEntry[], overrides: ProfileLoadOptions['configOverrides']): ResolvedEntry[] {
  if (!overrides) return [...entries];
  return entries.map(entry => {
    const override = Object.hasOwn(overrides, entry.id) ? overrides[entry.id] : undefined;
    return override === undefined ? entry : { ...entry, config: { ...(isRecord(entry.config) ? entry.config : {}), ...override } };
  });
}

/** 条目模块对应的文件；包名经 `import.meta.resolve` 解析，解析不到文件时为 null（交给导入阶段报错）。 */
function moduleFileOf(specifier: string): string | null {
  try {
    const href = specifier.startsWith('file:') ? specifier : import.meta.resolve(specifier);
    return href.startsWith('file:') ? fileURLToPath(href) : null;
  } catch {
    // 包名解析失败：导入阶段会给出带上下文的 ProfileError。
    return null;
  }
}

/** 从模块所在目录向上找最近的 package.json。 */
async function findPackageJson(dir: string): Promise<string | null> {
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, 'package.json');
    if (await isFile(candidate)) return candidate;
    if (dirname(current) === current) return null;
  }
}

/**
 * 社区条目（模块不在应用内）的清单检查：读模块旁最近的 package.json，按契约顺序校验
 * （manifestVersion → engines → schema → id 来源 → 平台），再核对 Host 半入口就是该模块。
 * 返回清单与包根目录（package.json 所在目录）；官方条目返回 null；不通过抛 {@link PluginLoadError}。
 */
export async function screenProfileEntry(entry: ResolvedEntry, appVersion: string, platform?: PluginPlatform): Promise<{ manifest: PluginManifest; packageRoot: string } | null> {
  let file: string | null;
  try {
    file = moduleFileOf(entry.specifier);
  } catch (error) {
    throw new PluginLoadError('IMPORT_FAILED', entry.id, describeError(error), { cause: error });
  }
  if (file === null || isAppModuleUrl(pathToFileURL(file).href)) return null;
  if (!(await isFile(file))) throw new PluginLoadError('IMPORT_FAILED', entry.id, `plugin module is missing: ${file}`);
  const packageJson = await findPackageJson(dirname(file));
  if (packageJson === null) throw new PluginLoadError('MANIFEST_MISSING', entry.id, `no package.json found for ${file}`);
  let pkg: unknown;
  try {
    pkg = JSON.parse(await readFile(packageJson, 'utf8'));
  } catch (error) {
    throw new PluginLoadError('MANIFEST_INVALID', entry.id, `${packageJson} cannot be read as JSON: ${(error as Error).message}`, { cause: error });
  }
  const result = checkManifest(pkg, { appVersion, context: 'community-startup', expectedId: entry.id, ...(platform ? { platform } : {}) }, entry.id);
  if (!result.ok) throw result.error;
  const { manifest } = result;
  if (manifest.host === undefined) throw new PluginLoadError('HOST_ENTRY_MISMATCH', entry.id, `${packageJson} declares no "host" entry; a profile can only load a plugin's Host half`);
  const hostFile = resolve(dirname(packageJson), manifest.host);
  if (hostFile !== file) throw new PluginLoadError('HOST_ENTRY_MISMATCH', entry.id, `profile module ${file} is not the package's host entry ${hostFile}`);
  return { manifest, packageRoot: dirname(packageJson) };
}


/**
 * 导入 profile 条目并做安装前检查（`decisions/2026-11-07-plugin-ecosystem-v1.md` P0）：
 * 1. 社区条目先校验清单（导入前：不兼容的插件代码不执行）；
 * 2. 导入通过的条目；社区模块导入失败只降级自身，官方模块导入失败仍抛 {@link ProfileError}；
 * 3. 社区插件核对 `meta.id` / `meta.version` / 服务名空间 / 权限，全部条目检查平台；
 * 4. 社区插件的服务名与其他条目冲突时降级该社区插件（官方之间的冲突仍是 profile 结构错误）；
 * 5. requires 按本次装载中的版本（社区取 package.json#version，官方取 `meta.version`，缺省为应用版本）检查到不动点。
 * 未通过的条目进 `rejected`，不安装。
 */
export async function prepareProfile(runtime: HostRuntime, entries: readonly ResolvedEntry[], options: ProfileLoadOptions = {}): Promise<{ installs: PluginInstall[]; rejected: RejectedEntry[] }> {
  const appVersion = runtime.app.version;
  const { platform } = options;
  const rejected: RejectedEntry[] = [];
  const manifests = new Map<string, { manifest: PluginManifest; packageRoot: string }>();
  const accepted: ResolvedEntry[] = [];
  for (const entry of applyConfigOverrides(entries, options.configOverrides)) {
    try {
      if (runtime.safeMode && !isAppModuleUrl(entry.specifier)) {
        throw new PluginLoadError('SAFE_MODE_ACTIVE', entry.id, `plugin "${entry.id}" is a community plugin; safe mode loads official plugins only`);
      }
      let screened = await screenProfileEntry(entry, appVersion, platform);
      // RUST-FIX(RF-W01-safe-mode-official-only): 安全模式只装载官方插件（W06 `--safe-mode`）。
      if (runtime.safeMode && screened) {
        throw new PluginLoadError('SAFE_MODE_ACTIVE', entry.id, `plugin "${entry.id}" is a community plugin; safe mode loads official plugins only`);
      }
      // K3：社区条目在导入前查同意账本（W32）；未匹配或账本不可读都拒绝，社区代码不执行。
      if (screened && options.communityGate) {
        let problem: string | null | { trust: 'full' | 'restricted' };
        try { problem = await options.communityGate(screened.manifest); }
        catch (error) { problem = `community package could not be verified: ${error instanceof Error ? error.message : String(error)}`; }
        if (typeof problem === 'string') throw new PluginLoadError('CONSENT_REQUIRED', entry.id, problem);
        // RUST-FIX(RF-P1-plugin-trust): Only Host consent decisions supply runtime trust.
        if (problem) screened = { ...screened, manifest: { ...screened.manifest, trust: problem.trust } };
      }
      if (screened) manifests.set(entry.id, screened);
      accepted.push(entry);
    } catch (error) {
      if (!(error instanceof PluginLoadError)) throw error;
      rejected.push(rejection(entry.id, error));
    }
  }
  runtime.startup.mark('manifests checked');
  const imported: Array<{ entry: ResolvedEntry; install: PluginInstall }> = [];
  for (const entry of accepted) {
    const community = manifests.has(entry.id);
    try {
      imported.push({ entry, install: await importProfileEntry(entry, runtime.startup, community) });
    } catch (error) {
      if (!community) throw error;
      rejected.push(rejection(entry.id, new PluginLoadError('IMPORT_FAILED', entry.id, describeError(error), { cause: error })));
    }
  }
  runtime.startup.mark('modules imported');

  /** 已过模块检查的社区插件 → 清单（此后 `meta.id` 等于清单 id）。 */
  const community = new Map<PluginInstall, PluginManifest>();
  let installs: PluginInstall[] = [];
  imported.forEach(({ entry: { id }, install }) => {
    const screened = manifests.get(id);
    const problem = screened ? checkPluginModule(screened.manifest, install.plugin) : platformProblem(install.plugin, platform);
    if (problem) {
      rejected.push(rejection(id, problem, install.plugin));
      return;
    }
    if (!screened) {
      installs.push(install);
      return;
    }
    const withRoot: PluginInstall = { ...install, packageRoot: screened.packageRoot, manifest: screened.manifest };
    community.set(withRoot, screened.manifest);
    installs.push(withRoot);
  });

  const providers = new Map<string, string>();
  for (const install of installs) if (!community.has(install)) for (const name of install.plugin.meta.provides ?? []) providers.set(name, install.plugin.meta.id);
  installs = installs.filter((install) => {
    const { plugin } = install;
    if (!community.has(install)) return true;
    const conflicts = (plugin.meta.provides ?? []).filter(name => providers.has(name));
    if (conflicts.length) {
      rejected.push(rejection(plugin.meta.id, new PluginLoadError('SERVICE_CONFLICT', plugin.meta.id,
        conflicts.map(name => `service "${name}" is already provided by "${providers.get(name)}"`).join(', ')), plugin));
      return false;
    }
    for (const name of plugin.meta.provides ?? []) providers.set(name, plugin.meta.id);
    return true;
  });

  for (let changed = true; changed;) {
    changed = false;
    const versions = new Map([
      ...runtime.plugins().map((entry): [string, string] => [entry.id, entry.manifest?.version ?? entry.plugin.meta.version ?? appVersion]),
      ...installs.map((install): [string, string] => [install.plugin.meta.id, community.get(install)?.version ?? install.plugin.meta.version ?? appVersion]),
    ]);
    for (const install of installs) {
      const manifest = community.get(install);
      const problem = manifest ? checkRequires(manifest, versions) : null;
      if (!problem) continue;
      rejected.push(rejection(install.plugin.meta.id, problem, install.plugin));
      installs = installs.filter(other => other !== install);
      changed = true;
      break;
    }
  }
  return { installs, rejected };
}

/**
 * 读取、导入并安装一个 profile。
 *
 * 装载按插件隔离（见 {@link installProfile}）：清单 / 平台 / requires 不通过的条目不导入或不安装（{@link prepareProfile}），
 * 缺服务的条目 inactive、apply 失败的条目只撤销自身，其结果写入 `plugin:host|status` 并广播 `host://plugins-degraded`；
 * profile 结构错误、官方模块导入失败与核心服务缺失会抛 {@link ProfileError}。
 */
export async function loadProfile(runtime: HostRuntime, path: string, options: ProfileLoadOptions = {}): Promise<ProfileLoadResult> {
  const entries = await resolveProfile(path, options);
  runtime.startup.mark('profile resolved');
  const { installs, rejected } = await prepareProfile(runtime, entries, options);
  return finishProfile(runtime, installs, options, rejected);
}


export interface StartupProfileOptions extends ProfileLoadOptions {
  /** 显式 profile（命令行 / 握手）；给出时不做用户 profile 探测与失败回退。 */
  profile?: string;
  /** 用户 profile 路径；默认 `<app.dataDir>/plugins/user.profile.json`。 */
  userProfile?: string;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    // 文件不存在是正常分支（没有用户 profile 时直接加载官方 profile）。
    return false;
  }
}

/**
 * 启动时选择 profile（`docs/plugins/SDK.md` §6）：
 * - 显式 profile：原样加载，失败即 HostFatal（命令行 / 握手 / headless 的既有语义）；
 * - 存在 `<dataDir>/plugins/user.profile.json`：加载它（通常 `extends: "official"`）；
 *   **文件结构或官方模块无效**时才记 error 日志、
 *   发出 {@link PROFILE_FAILED_EVENT} 并回退到官方 profile。文件有效但个别插件装载失败时
 *   按插件隔离（inactive/degraded），不再回退；
 * - 否则加载官方 profile。
 *
 * 官方 / 用户分支要求平台核心服务（`storage`/`paths`/`log`）可用：缺失即 HostFatal。
 */
export async function loadStartupProfile(runtime: HostRuntime, options: StartupProfileOptions = {}): Promise<ProfileLoadResult> {
  const official = options.official ?? OFFICIAL_PROFILE_PATH;
  const shared: ProfileLoadOptions = {
    official,
    platform: options.platform ?? 'desktop',
    ...(options.communityGate ? { communityGate: options.communityGate } : {}),
    ...(options.configOverrides ? { configOverrides: options.configOverrides } : {}),
  };
  if (options.profile !== undefined) {
    return loadProfile(runtime, options.profile, { ...shared, ...(options.requireCoreServices ? { requireCoreServices: true } : {}) });
  }
  const userProfile = options.userProfile ?? join(runtime.app.dataDir, 'plugins', 'user.profile.json');
  if (!(await isFile(userProfile))) return loadProfile(runtime, official, { ...shared, requireCoreServices: true });
  let prepared: { installs: PluginInstall[]; rejected: RejectedEntry[] };
  try {
    const entries = await resolveProfile(userProfile, { official, user: true });
    runtime.startup.mark('profile resolved');
    prepared = await prepareProfile(runtime, entries, shared);
  } catch (error) {
    // 用户 profile 文件本身无效：先记日志，再通知前端，最后回到官方 profile。
    const reason = error instanceof Error ? error.message : String(error);
    runtime.ctx.logger('host').error(`plugin profile ${userProfile} failed to load; falling back to the official profile:\n${describeError(error)}`);
    runtime.backendEvents.emit(PROFILE_FAILED_EVENT, { profile: userProfile, error: reason });
    return loadProfile(runtime, official, { ...shared, requireCoreServices: true });
  }
  return finishProfile(runtime, prepared.installs, { ...shared, requireCoreServices: true }, prepared.rejected);
}
