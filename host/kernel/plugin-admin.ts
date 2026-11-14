/**
 * 插件管理可信命令（插件生态 v1 P1-1/P1-3，K3/K7 接线；W35 的唯一入口）。
 *
 * 授权：只接受**主窗口本地页**（`source.window/webview === 'main'` 且 `source.origin` 缺省）的调用。
 * 不读 `payload.caller`、不读插件自报的来源、不接受远程页面——来源由 main 从 WebFrameMain 推导。
 * 社区服务的调用权限与同意账本都不作为社区服务暴露。
 *
 * 一致性：用户 profile 的读-改-写按修订号（文件 SHA256）做 CAS；`plugin:manager|*` 的写命令都要求回传
 * 读到的 revision，不一致即以 `PROFILE_CONFLICT` 拒绝，不覆盖别的窗口/安装流程刚写入的条目。
 *
 * 同意（K3）：社区插件装载前经 W32 账本评估；`plugin:manager|consent` 只接受与当前已校验包**完全一致**的
 * ID/版本/规范权限集合（陈旧确认以 `CONSENT_STALE` 拒绝），写入后才允许启用。这不是物理隔离。
 *
 * 安装包（W34）：`packages` 未接入时不注册导入命令；卸载在接入时先移除指针、失败用 `restore` 回滚。
 */
import type { CallContext, HostPlugin } from './core.ts';
import { join, basename, resolve, dirname } from 'node:path';
import { mkdir, readFile, realpath, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MemoryZipSink, ZipWriter } from '../platform/zip/core/index.ts';
import { nodeZipCodec } from '../platform/zip/node/file.ts';
import { pathToFileURL } from 'node:url';
import type { FilesService } from '../platform/files/api.ts';
import { PluginPackages, type PackageRecord } from './plugin-packages/index.ts';
// RUST-FIX(RF-W01-trusted-plugin-admin): 新增主窗口本地来源的 revision-aware 管理命令；不是物理隔离。
import {
  PLUGIN_MANAGER_CONFIG_COMMAND,
  PLUGIN_MANAGER_CONFIG_SAVE_COMMAND,
  PLUGIN_MANAGER_CONSENT_COMMAND,
  PLUGIN_MANAGER_LIST_COMMAND,
  PLUGIN_MANAGER_UPDATE_IMPACT_COMMAND,
  type PluginUpdateImpact,
  PLUGIN_MANAGER_INSTALL_COMMAND,
  PLUGIN_MANAGER_SET_TRUST_COMMAND,
  PLUGIN_MANAGER_SET_ENABLED_COMMAND,
  PLUGIN_MANAGER_UNINSTALL_COMMAND,
  type PluginManagerConfigView,
  type PluginManagerConsentView,
  type PluginManagerEntry,
  type PluginManagerInventory,
  type PluginManagerInstallResult,
} from './core.ts';
import { canonicalPermissions, type CommunityConsentLedger, type CommunityConsentRecord, type ConsentDecision } from './community-consent.ts';
import { projectConfigSchema } from './config-schema.ts';
import { AppError, CommandError } from './error-model.ts';
import { toWireJson } from './json.ts';
import { moduleOrigin } from './module-origin.ts';
import { parsePluginId } from './plugin-id.ts';
import { PluginLoadError } from './plugin-load-error.ts';
import { resolvePluginConfig } from './plugin-config.ts';
import {
  disabledIds, entryIndex, removeEntries, writeEntry, ProfileConflictError, type ProfileDocument, type UserProfileStore,
} from './profile-store.ts';
import { prepareProfile, resolveProfile, screenProfileEntry, type ProfileFile, type ResolvedEntry } from './profile.ts';
import type { HostRuntime, InstalledPlugin, PluginInstall } from './runtime.ts';
import { KERNEL_ONLY_SERVICES } from './kernel.ts';
import { assertInstallable, parseVersion, type PluginManifest } from './manifest.ts';
import { workshopDirectoryWithin } from './workshop-paths.ts';
import { pluginExecution } from './plugin-execution.ts';

export interface ManagedPluginInstallRequest {
  id: string;
  directory: string;
  revision: string;
  version: string;
  permissions: readonly string[];
  confirmed: true;
}

/** Kernel-provided capability for the builtin workshop, never a renderer arbitrary-path command. */
export interface DstuPluginInstaller {
  activateManaged(id: string, revision: string): Promise<unknown>;
  isolateManaged(id: string): Promise<unknown>;
  onFault(listener: (id: string, reason: string) => Promise<void>): () => void;
  installManagedDirectory(request: ManagedPluginInstallRequest): Promise<PluginManagerInstallResult>;
  inventory(): Promise<PluginManagerInventory>;
  /** Read-only view of any plugin's config schema and current values (same data as `plugin:manager|config`). */
  configOf(id: string): Promise<PluginManagerConfigView>;
  /** Revision-aware config write that hot-updates the running plugin fiber; no app restart required. */
  configureManaged(id: string, values: Record<string, unknown>): Promise<PluginManagerConfigView>;
  /** Revision-aware enable/disable of a managed plugin, hot-loading or unloading it immediately. */
  setEnabledManaged(id: string, enabled: boolean): Promise<unknown>;
  uninstall(id: string, revision: string): Promise<unknown>;
  /** Read-only snapshot of the actual running plugins (including meta and Config). */
  plugins(): readonly HostPlugin<any>[];
  onActivation(listener: (result: WorkshopActivationResult) => Promise<void>): () => void;
  selfCheckContext(id: string, names: readonly string[]): Promise<WorkshopSelfCheckContext>;
}
export interface WorkshopSelfCheckContext {
  trust: 'full' | 'restricted'; safeMode: boolean; services: Record<string, unknown>;
}
export interface WorkshopActivationResult {
  id: string; attemptedVersion: string | null; actualVersion: string | null; success: boolean;
  error: string | null; rollback?: 'not-needed' | 'restored' | 'failed';
}

declare module '@deepseek-ai/cordis' {
  interface Context { dstuPluginInstaller: DstuPluginInstaller }
}

/** W34 `PluginPackages` 中管理器用到的部分（结构类型；模块由 W34 交付，W01 不复制实现）。 */
export type PluginPackageStore = PluginPackages;

export interface PluginAdminOptions {
  runtime: HostRuntime;
  /** `<dataDir>/plugins/user.profile.json` 的读-改-写入口。 */
  store: UserProfileStore;
  /** 官方 profile（`extends: "official"` 与社区筛查的基准）。 */
  official: string;
  /** W32 同意账本；省略时社区插件不带同意状态、`consent` 命令不可用。 */
  consent?: CommunityConsentLedger;
  /** W34 离线安装包存储；省略时卸载只改 profile，不删包。 */
  packages?: PluginPackageStore;
  files?: FilesService;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function validation(message: string): never {
  throw new CommandError(AppError.validation(message));
}

function argsObject(args: unknown, command: string): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) validation(`${command}: arguments must be an object`);
  return args as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, command: string, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value) validation(`${command}: "${key}" must be a non-empty string`);
  return value;
}

function booleanArg(args: Record<string, unknown>, command: string, key: string): boolean {
  const value = args[key];
  if (typeof value !== 'boolean') validation(`${command}: "${key}" must be a boolean`);
  return value;
}

/** 只接受主窗口的本地页面：远程页面（`origin` 为 URL 或 "null"）与子 webview 一律拒绝。 */
export function assertTrustedManagerSource(source: CallContext['source'], command: string): void {
  if (source.window !== 'main' || source.webview !== 'main' || source.origin !== undefined) {
    throw new CommandError(AppError.configuration(
      `PLUGIN_MANAGER_FORBIDDEN: ${command} is only available to the main window's local app page`,
    ));
  }
}

function conflict(error: ProfileConflictError): CommandError {
  return new CommandError(AppError.conflict(error.message));
}

const samePermissions = (left: readonly string[], right: readonly string[]): boolean => {
  const a = canonicalPermissions(left), b = canonicalPermissions(right);
  return a.length === b.length && a.every((permission, index) => permission === b[index]);
};

/** 社区清单 → 同意 subject（ID/版本精确匹配；权限用 W32 的规范化规则）。 */
const subjectOf = (manifest: PluginManifest) => ({ id: manifest.id, version: manifest.version, permissions: manifest.permissions });

const WORKSHOP_WORK_ID = /^workshop\.plugin-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function readWorkshopFallbackMeta(dataDir: string, id: string): Promise<{ displayName?: string; description?: string } | undefined> {
  if (!WORKSHOP_WORK_ID.test(id)) return undefined;
  try {
    const raw = JSON.parse(await readFile(join(dataDir, 'dstu-workshop', id, 'workshop.json'), 'utf8')) as {
      title?: unknown;
      description?: unknown;
    };
    const displayName = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined;
    const description = typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : undefined;
    return displayName || description ? { ...(displayName ? { displayName } : {}), ...(description ? { description } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

async function evaluateConsent(ledger: CommunityConsentLedger | undefined, manifest: PluginManifest): Promise<ConsentDecision | undefined> {
  if (!ledger) return undefined;
  try {
    return await ledger.evaluate(subjectOf(manifest));
  } catch (error) {
    // fail closed：账本不可读按未同意处理。
    void error;
    return { matched: false, code: 'CONSENT_REQUIRED', reason: 'missing', grantedPermissions: [] };
  }
}

/** K3 装载前门：账本不可读也给出原因（fail closed），由 profile 装载记为 CONSENT_REQUIRED。 */
export async function consentProblem(ledger: CommunityConsentLedger, manifest: PluginManifest): Promise<string | { trust: 'full' | 'restricted' }> {
  try {
    const decision = await ledger.evaluate(subjectOf(manifest));
    if (decision.matched) return { trust: decision.trust ?? 'restricted' };
    return `community plugin "${manifest.id}" ${manifest.version} has no matching consent record (${decision.reason ?? 'missing'}); confirm it in the plugin manager`;
  } catch (error) {
    return `community plugin "${manifest.id}" ${manifest.version} consent record could not be verified (${errorText(error)}); refusing to load`;
  }
}

export class PluginAdmin {
  private readonly runtime: HostRuntime;
  private readonly store: UserProfileStore;
  private readonly official: string;
  private readonly consent: CommunityConsentLedger | undefined;
  private readonly packages: PluginPackageStore | undefined;
  private readonly files: FilesService | undefined;
  private mutations: Promise<unknown> = Promise.resolve();
  private readonly managedReplacements = new Map<string, {
    previous: PackageRecord; candidatePath: string; profile: ProfileFile;
    runtime: InstalledPlugin | undefined; consent: CommunityConsentRecord | undefined;
  }>();

  constructor(options: PluginAdminOptions) {
    this.runtime = options.runtime;
    this.store = options.store;
    this.official = options.official;
    this.consent = options.consent;
    this.packages = options.packages;
    this.files = options.files;
    this.runtime.kernel.execution = pluginExecution;
  }

  /** 注册全部内核管理命令（随 runtime 的 root fiber 一起撤销）。 */
  register(): void {
    const activationListeners = new Set<(result: WorkshopActivationResult) => Promise<void>>();
    const faultListeners = new Set<(id: string, reason: string) => Promise<void>>();
    this.runtime.backendEvents.listen('host://plugins-degraded', payload => {
      for (const fault of payload as { id: string; reason: string }[]) {
        for (const listener of faultListeners) {
          void listener(fault.id, fault.reason).catch(error => this.runtime.ctx.logger('host').error(`[plugin-workshop] recovery failed: ${errorText(error)}`));
        }
      }
    });
    const commands = this.runtime.commands;
    commands._registerKernel(PLUGIN_MANAGER_LIST_COMMAND, (args, call) => this.list(args, call));
    commands._registerKernel(PLUGIN_MANAGER_UPDATE_IMPACT_COMMAND, (args, call) => this.updateImpact(args, call));
    commands._registerKernel(PLUGIN_MANAGER_CONFIG_COMMAND, (args, call) => this.config(args, call));
    const mutation = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = this.mutations.then(fn, fn).catch((error: unknown) => {
        if (error instanceof CommandError) throw error;
        if (error instanceof ProfileConflictError) throw conflict(error);
        throw new CommandError(AppError.configuration(errorText(error)));
      });
      // The next mutation chains with then(fn, fn), so it runs after this one whether it succeeded or failed;
      // the caller awaits `run`, so its rejection is handled there.
      this.mutations = run;
      return run;
    };
    // RUST-FIX(RF-P1-managed-plugin-install): Builtin capability reuses the same trusted list/uninstall and mutation queue.
    const internalCall = (): CallContext => ({
      source: { window: 'main', webview: 'main' }, signal: new AbortController().signal, invokeId: randomUUID(),
    });
    const isolate = (id: string) => mutation(async () => {
      const record = (await this.consent?.read())?.find(entry => entry.id === id);
      if (record?.source !== 'workshop') validation('WORKSHOP_INVALID: only managed workshop plugins may isolate');
      const profile = await this.store.read();
      return this.setEnabled({ id, enabled: false, revision: profile.revision }, internalCall());
    });
    const activate = (id: string, revision: string) => mutation(async () => {
      const record = (await this.consent?.read())?.find(entry => entry.id === id);
      if (record?.source !== 'workshop') validation('WORKSHOP_INVALID: only managed workshop plugins may activate');
      return this.setEnabled({ id, enabled: true, revision }, internalCall());
    });
    const installer: DstuPluginInstaller = Object.freeze({
      onFault: (listener: (id: string, reason: string) => Promise<void>) => {
        faultListeners.add(listener); return () => { faultListeners.delete(listener); };
      },
      isolateManaged: isolate,
      activateManaged: activate,
      installManagedDirectory: (request: ManagedPluginInstallRequest) => this.installManagedDirectory(request),
      inventory: () => this.list({}, internalCall()),
      // RUST-FIX(RF-P4-plugin-self-configuration): the Agent reads the same schema/values the manager shows.
      configOf: (id: string) => this.config({ id }, internalCall()),
      configureManaged: (id: string, values: Record<string, unknown>) => mutation(async () => {
        // `saveConfig` validates, hot-updates the running fiber (`runtime.updateConfig`) and persists the
        // profile under CAS; the view it returns is read back after the write so callers see fresh revision.
        const profile = await this.store.read();
        await this.saveConfig({ id, revision: profile.revision, values }, internalCall());
        return this.config({ id }, internalCall());
      }),
      // Not wrapped in `mutation` here: activate/isolate already queue on the same chain, and nesting
      // a mutation inside a running one would deadlock on the queue.
      setEnabledManaged: async (id: string, enabled: boolean) => {
        if (!enabled) return isolate(id);
        const profile = await this.store.read();
        return activate(id, profile.revision);
      },
      uninstall: (id: string, revision: string) => mutation(() => this.uninstall({ id, revision }, internalCall())),
      plugins: () => Object.freeze(this.runtime.plugins().map(entry => entry.plugin)),
      onActivation: (listener: (result: WorkshopActivationResult) => Promise<void>) => {
        activationListeners.add(listener); return () => { activationListeners.delete(listener); };
      },
      selfCheckContext: async (id: string, names: readonly string[]): Promise<WorkshopSelfCheckContext> => {
        // RUST-FIX(RF-P3-workshop-tools): actual application services, never kernel-only capabilities.
        const trust = (await this.consent?.read())?.find(record => record.id === id)?.trust ?? 'full';
        const services: Record<string, unknown> = {};
        if (!this.runtime.safeMode) for (const name of names) {
          if (KERNEL_ONLY_SERVICES.includes(name) || name === 'pluginWorkshop') continue;
          const value = this.runtime.ctx.get(name);
          if (value !== undefined) services[name] = value;
        }
        return { trust, safeMode: this.runtime.safeMode, services };
      },
    });
    this.runtime.setBuiltinPluginInstaller(installer);
    commands._registerKernel(PLUGIN_MANAGER_CONFIG_SAVE_COMMAND, (args, call) => mutation(() => this.saveConfig(args, call)));
    commands._registerKernel(PLUGIN_MANAGER_SET_ENABLED_COMMAND, (args, call) => mutation(async () => {
      // RUST-FIX(RF-P3-workshop-tools): publish the real enable outcome so workshop recovery survives Host restarts.
      assertTrustedManagerSource(call.source, PLUGIN_MANAGER_SET_ENABLED_COMMAND);
      const document = argsObject(args, PLUGIN_MANAGER_SET_ENABLED_COMMAND);
      const id = stringArg(document, PLUGIN_MANAGER_SET_ENABLED_COMMAND, 'id');
      const enabled = booleanArg(document, PLUGIN_MANAGER_SET_ENABLED_COMMAND, 'enabled');
      const before = enabled ? (await this.list({}, call)).plugins.find(entry => entry.id === id) : undefined;
      const notify = async (success: boolean, error: unknown = null) => {
        if (!enabled || before?.source !== 'workshop') return;
        const actual = (await this.list({}, call)).plugins.find(entry => entry.id === id);
        const value = error instanceof CommandError ? error.value : error;
        const rollback = (value as { details?: { rollback?: string } } | null)?.details?.rollback;
        const result: WorkshopActivationResult = { id, attemptedVersion: before.version ?? null, actualVersion: actual?.version ?? null,
          success, error: error === null ? null : errorText(error),
          ...(rollback === 'not-needed' || rollback === 'restored' || rollback === 'failed' ? { rollback } : {}) };
        for (const listener of activationListeners) await listener(result);
      };
      let result;
      try { result = await this.setEnabled(args, call); }
      catch (error) { await notify(false, error); throw error; }
      await notify(true); return result;
    }));
    commands._registerKernel(PLUGIN_MANAGER_UNINSTALL_COMMAND, (args, call) => mutation(() => this.uninstall(args, call)));
    commands._registerKernel(PLUGIN_MANAGER_CONSENT_COMMAND, (args, call) => mutation(() => this.grantConsent(args, call)));
    commands._registerKernel(PLUGIN_MANAGER_INSTALL_COMMAND, (args, call) => mutation(() => this.installPackage(args, call)));
    commands._registerKernel(PLUGIN_MANAGER_SET_TRUST_COMMAND, (args, call) => mutation(() => this.setTrust(args, call)));
  }

  // ---------------------------------------------------------------- 读

  private async updateImpact(args: unknown, call: CallContext): Promise<PluginUpdateImpact> {
    const command = PLUGIN_MANAGER_UPDATE_IMPACT_COMMAND;
    assertTrustedManagerSource(call.source, command);
    const version = stringArg(argsObject(args, command), command, 'version');
    if (!parseVersion(version)) validation(`${command}: invalid app version`);
    const result: PluginUpdateImpact = { incompatible: [], unchecked: [] };
    if (!(await this.store.read()).exists) return result;
    const profile = await resolveProfile(this.store.path, { official: this.official, user: true });
    for (const entry of profile) {
      if (moduleOrigin(entry.specifier) === 'builtin') continue;
      try {
        await screenProfileEntry(entry, version, 'desktop');
      } catch (error) {
        if (error instanceof PluginLoadError && error.code === 'ENGINE_INCOMPATIBLE') result.incompatible.push(entry.id);
        else result.unchecked.push(entry.id);
      }
    }
    return result;
  }

  private async list(args: unknown, call: CallContext): Promise<PluginManagerInventory> {
    assertTrustedManagerSource(call.source, PLUGIN_MANAGER_LIST_COMMAND);
    const document = argsObject(args, PLUGIN_MANAGER_LIST_COMMAND);
    if (Object.keys(document).length) validation(`${PLUGIN_MANAGER_LIST_COMMAND}: takes no arguments`);

    let profile: ProfileDocument;
    try {
      profile = await this.store.read();
    } catch (error) {
      throw new CommandError(AppError.configuration(`PROFILE_READ_FAILED: ${errorText(error)}`));
    }
    const disabled = disabledIds(profile.file);
    let effective: ResolvedEntry[] = [];
    if (profile.exists) {
      try {
        effective = await resolveProfile(this.store.path, { official: this.official, user: true });
      } catch (error) {
        this.runtime.ctx.logger('host').warn(`[plugin-manager] cannot resolve ${this.store.path}: ${errorText(error)}`);
      }
    }

    const ids = new Set<string>();
    for (const entry of effective) ids.add(entry.id);
    for (const entry of this.runtime.plugins()) ids.add(entry.id);
    for (const entry of this.runtime.degradedPlugins()) ids.add(entry.id);
    for (const id of disabled) ids.add(id);

    const plugins: PluginManagerEntry[] = [];
    for (const id of [...ids].sort()) {
      plugins.push(await this.describe(id, {
        installed: this.runtime.get(id),
        effective: effective.find((entry) => entry.id === id) ?? await this.declaredEntry(id),
        disabled: disabled.has(id),
        reason: this.runtime.degradedPlugins().find((entry) => entry.id === id)?.reason,
      }));
    }
    return { safeMode: this.runtime.safeMode, revision: profile.revision, plugins };
  }

  private async describe(id: string, state: {
    installed: InstalledPlugin | undefined;
    effective: ResolvedEntry | undefined;
    disabled: boolean;
    reason: string | undefined;
  }): Promise<PluginManagerEntry> {
    const { installed, effective, disabled, reason } = state;
    const manifest = installed?.manifest ?? await this.manifestOf(id, effective);
    const meta = installed?.plugin.meta;
    const origin = installed
      ? (installed.manifest ? 'community' : moduleOrigin(installed.source ?? null))
      : effective ? moduleOrigin(effective.specifier) : (parsePluginId(id)?.official ? 'builtin' : 'community');
    const consent = manifest ? await evaluateConsent(this.consent, manifest) : undefined;
    const workshopFallback = origin !== 'builtin' && (!manifest?.displayName || manifest.description === undefined)
      ? await readWorkshopFallbackMeta(this.runtime.app.dataDir, id)
      : undefined;
    const communityFields = {
      ...Object.fromEntries(['displayName', 'icon', 'author', 'description', 'category', 'homepage']
        .filter(key => manifest?.[key as keyof PluginManifest] !== undefined)
        .map(key => [key, manifest![key as keyof PluginManifest]])),
      ...(manifest?.displayName === undefined && workshopFallback?.displayName ? { displayName: workshopFallback.displayName } : {}),
      ...(manifest?.description === undefined && workshopFallback?.description ? { description: workshopFallback.description } : {}),
    };
    return {
      id,
      origin,
      trust: origin === 'builtin' ? 'full' : consent?.trust ?? 'restricted',
      source: origin === 'builtin' ? 'builtin' : consent?.source ?? 'package',
      // RUST-FIX(RF-P1-plugin-display): Display metadata without importing disabled community code.
      ...(origin === 'builtin' ? {
        displayName: meta?.displayName ?? id.replace(/^dstu\./, '').split(/[.-]/).map(part => part[0]!.toUpperCase() + part.slice(1)).join(' '),
        icon: meta?.icon ?? 'Package', author: meta?.author ?? 'Deep Student',
        description: meta?.description ?? (meta?.provides ?? []).join(', '),
        category: meta?.category ?? (id.startsWith('dstu.platform.') ? 'platform' : meta?.lane ?? 'application'),
        homepage: meta?.homepage ?? 'https://github.com/helixnow/deep-student',
        ...(meta?.displayNameKey ? { displayNameKey: meta.displayNameKey } : !meta?.displayName ? { displayNameKey: `builtinNames.${id}` } : {}),
        ...(meta?.descriptionKey ? { descriptionKey: meta.descriptionKey } : !meta?.description ? { descriptionKey: `builtinDescriptions.${id}` } : {}),
      } : communityFields),
      platforms: [...(meta?.platforms ?? manifest?.platforms ?? ['desktop'])],
      ...(manifest !== undefined ? { version: manifest.version } : meta?.version !== undefined ? { version: meta.version } : {}),
      enabled: !disabled,
      state: installed ? 'running' : disabled ? 'disabled' : reason !== undefined ? 'degraded' : 'not-installed',
      ...(reason !== undefined && !installed ? { reason } : {}),
      permissions: [...(manifest?.permissions ?? [])],
      services: [...(meta?.provides ?? [])],
      hasConfig: installed?.plugin.Config !== undefined,
      ...(consent ? { consent: { matched: consent.matched, code: consent.code, reason: consent.reason, grantedPermissions: [...consent.grantedPermissions] } } : {}),
    };
  }

  private async manifestOf(id: string, effective: ResolvedEntry | undefined): Promise<PluginManifest | undefined> {
    if (!effective) return undefined;
    try {
      return (await screenProfileEntry(effective, this.runtime.app.version))?.manifest;
    } catch {
      return undefined;
    }
  }

  private async config(args: unknown, call: CallContext): Promise<PluginManagerConfigView> {
    assertTrustedManagerSource(call.source, PLUGIN_MANAGER_CONFIG_COMMAND);
    const document = argsObject(args, PLUGIN_MANAGER_CONFIG_COMMAND);
    const id = stringArg(document, PLUGIN_MANAGER_CONFIG_COMMAND, 'id');
    const installed = this.runtime.get(id);
    const profile = await this.store.read();
    if (!installed) {
      // 未运行（停用/降级）的插件没有已校验的 Config：只回 profile 修订号，避免猜 schema。
      return { id, revision: profile.revision, values: null, schema: null };
    }
    let schema;
    try {
      schema = projectConfigSchema(installed.plugin.Config);
    } catch (error) {
      throw new CommandError(AppError.configuration(`CONFIG_INVALID: plugin "${id}": ${errorText(error)}`));
    }
    return { id, revision: profile.revision, values: toWireJson(installed.config ?? null), schema };
  }

  // ---------------------------------------------------------------- 写（都要求 revision）

  private assertWritable(command: string): void {
    if (this.runtime.safeMode) {
      throw new CommandError(AppError.configuration(`SAFE_MODE_ACTIVE: ${command} is disabled in safe mode`));
    }
  }

  private revisionArg(document: Record<string, unknown>, command: string): string {
    const revision = document.revision;
    if (typeof revision !== 'string' || !revision) validation(`${command}: "revision" must be the string from plugin:manager|list`);
    return revision;
  }

  private async saveConfig(args: unknown, call: CallContext): Promise<{ id: string; revision: string }> {
    assertTrustedManagerSource(call.source, PLUGIN_MANAGER_CONFIG_SAVE_COMMAND);
    this.assertWritable(PLUGIN_MANAGER_CONFIG_SAVE_COMMAND);
    const document = argsObject(args, PLUGIN_MANAGER_CONFIG_SAVE_COMMAND);
    const id = stringArg(document, PLUGIN_MANAGER_CONFIG_SAVE_COMMAND, 'id');
    const revision = this.revisionArg(document, PLUGIN_MANAGER_CONFIG_SAVE_COMMAND);
    const values = document.values;
    const installed = this.runtime.get(id);
    if (!installed) throw new CommandError(AppError.not_found(`PLUGIN_NOT_RUNNING: plugin "${id}" is not running; enable it before editing its configuration`));
    const effective = await this.effectiveEntry(id);
    if (!effective) throw new CommandError(AppError.not_found(`PLUGIN_NOT_FOUND: plugin "${id}" is not declared by the user profile`));
    // 当前修订号先核对（冲突不产生任何副作用），再校验值，再热更新。
    const current = await this.store.read();
    if (current.revision !== revision) throw conflict(new ProfileConflictError(revision, current.revision));
    let config: unknown;
    try {
      config = resolvePluginConfig(installed.plugin, values);
    } catch (error) {
      const code = error instanceof PluginLoadError ? error.code : 'CONFIG_INVALID';
      throw new CommandError(AppError.configuration(`${code}: plugin "${id}": ${errorText(error)}`));
    }
    const previousConfig = installed.config;
    try {
      await this.runtime.updateConfig(id, config);
    } catch (error) {
      try { await this.runtime.updateConfig(id, previousConfig); } catch (rollback) {
        this.runtime.ctx.logger('host').error(`[plugin-manager] config apply rollback failed: ${errorText(rollback)}`);
      }
      throw new CommandError(AppError.configuration(`CONFIG_APPLY_FAILED: plugin "${id}": ${errorText(error)}`));
    }
    try {
      const written = await this.store.mutate(revision, (file) => {
        const existing = file.plugins.find((entry) => entry.id === id);
        writeEntry(file, {
          ...(existing ?? { id, module: effective.specifier }),
          config,
        });
      });
      return { id, revision: written.revision };
    } catch (error) {
      // profile 写失败：把热更新退回去，避免“运行态与持久化不一致”。
      try { await this.runtime.updateConfig(id, previousConfig); } catch (rollback) {
        this.runtime.ctx.logger('host').error(`[plugin-manager] rollback of "${id}" config failed: ${errorText(rollback)}`);
      }
      if (error instanceof ProfileConflictError) throw conflict(error);
      throw new CommandError(AppError.file_system(`PROFILE_WRITE_FAILED: ${errorText(error)}`));
    }
  }

  private async setEnabled(args: unknown, call: CallContext): Promise<{ id: string; enabled: boolean; revision: string }> {
    assertTrustedManagerSource(call.source, PLUGIN_MANAGER_SET_ENABLED_COMMAND);
    this.assertWritable(PLUGIN_MANAGER_SET_ENABLED_COMMAND);
    const document = argsObject(args, PLUGIN_MANAGER_SET_ENABLED_COMMAND);
    const id = stringArg(document, PLUGIN_MANAGER_SET_ENABLED_COMMAND, 'id');
    const enabled = booleanArg(document, PLUGIN_MANAGER_SET_ENABLED_COMMAND, 'enabled');
    const revision = this.revisionArg(document, PLUGIN_MANAGER_SET_ENABLED_COMMAND);
    const current = await this.store.read();
    if (current.revision !== revision) throw conflict(new ProfileConflictError(revision, current.revision));

    const effective = await this.effectiveEntry(id);
    const installed = this.runtime.get(id);
    const packageRecord = (await this.packages?.list())?.find((entry) => entry.id === id);
    if (!enabled) {
      if (!installed && !current.file.plugins.some((entry) => entry.id === id)) {
        throw new CommandError(AppError.not_found(`PLUGIN_NOT_FOUND: plugin "${id}" is not installed or declared`));
      }
      // 先卸载（有依赖者时抛错，不写 profile），再写停用标记。
      if (installed) await this.unloadOrConflict(id);
      let written;
      try {
      if (packageRecord) await this.packages!.setEnabled(id, false);
      written = await this.store.mutate(revision, (file) => {
        const existing = file.plugins.find((entry) => entry.id === id);
        writeEntry(file, {
          ...(existing ?? { id, module: effective?.specifier ?? id }),
          ...(existing?.config !== undefined ? { config: existing.config } : {}),
          disabled: true,
        });
      });
      } catch (error) {
        if (packageRecord) await this.packages!.restore(id, packageRecord, packageRecord.path);
        if (installed && !this.runtime.get(id)) await this.runtime.installEntry(installed);
        if (error instanceof ProfileConflictError) throw conflict(error);
        throw new CommandError(AppError.file_system(`PROFILE_WRITE_FAILED: ${errorText(error)}`));
      }
      return { id, enabled, revision: written.revision };
    }

    // 先核对同意，未同意不改 profile/revision、不执行社区代码。
    const declared = await this.declaredEntry(id);
    if (!declared) throw new CommandError(AppError.not_found(`PLUGIN_NOT_FOUND: plugin "${id}" is not declared by the profile`));
    if (packageRecord) await this.packages!.verify(id);
    const screened = await screenProfileEntry(declared, this.runtime.app.version, 'desktop');
    if (screened) {
      const decision = await evaluateConsent(this.consent, screened.manifest);
      if (!decision?.matched) throw new CommandError(AppError.with_details('Configuration',
        `CONSENT_REQUIRED: plugin "${id}" ${screened.manifest.version} needs consent`,
        { code: 'CONSENT_REQUIRED', id, version: screened.manifest.version, permissions: [...screened.manifest.permissions] }));
    }
    // 启用：写 profile（去掉 disabled 标记），再装载；失败按修订号回滚。
    const previous = current.file;
    const written = await this.store.mutate(revision, (file) => {
      const index = entryIndex(file, id);
      if (index < 0) return;
      const entry = file.plugins[index]!;
      if (entry.disabled) delete entry.disabled;
    });
    const target = await this.effectiveEntry(id);
    if (!target) throw new CommandError(AppError.not_found(`PLUGIN_NOT_FOUND: plugin "${id}" is not declared by the profile`));
    if (this.runtime.safeMode && moduleOrigin(target.specifier) === 'community') {
      await this.restoreProfile(written.revision, previous);
      throw new CommandError(AppError.configuration(`SAFE_MODE_ACTIVE: plugin "${id}" is a community plugin; safe mode loads official plugins only`));
    }
    try {
      if (packageRecord) await this.packages!.setEnabled(id, true);
      const result = await this.installEnabled(id, target, written.revision);
      this.managedReplacements.delete(id);
      return result;
    } catch (error) {
      if (packageRecord) await this.packages!.restore(id, packageRecord, packageRecord.path);
      await this.restoreProfile(written.revision, previous);
      const replacement = this.managedReplacements.get(id);
      if (replacement && packageRecord?.path === replacement.candidatePath) {
        try {
          await this.packages!.restore(id, replacement.previous, replacement.candidatePath);
          await this.consent!.restore(id, replacement.consent);
          await this.store.mutate((await this.store.read()).revision, file => {
            removeEntries(file, id);
            const previousEntry = replacement.profile.plugins.find(entry => entry.id === id);
            if (previousEntry) writeEntry(file, structuredClone(previousEntry));
          });
          if (replacement.runtime && !this.runtime.get(id)) await this.runtime.installEntry(replacement.runtime);
          this.managedReplacements.delete(id);
        } catch (rollback) {
          throw new CommandError(AppError.with_details('Configuration', `PLUGIN_ENABLE_FAILED: ${errorText(error)}; rollback: ${errorText(rollback)}`, { code: 'PLUGIN_ENABLE_FAILED', rollback: 'failed' }));
        }
        throw new CommandError(AppError.with_details('Configuration', errorText(error), { code: 'PLUGIN_ENABLE_FAILED', rollback: 'restored' }));
      }
      throw error;
    }
  }

  private async installEnabled(id: string, target: ResolvedEntry, revision: string): Promise<{ id: string; enabled: boolean; revision: string }> {
    if (this.runtime.get(id)) return { id, enabled: true, revision };
    try {
      const prepared = await prepareProfile(this.runtime, [target], {
        platform: 'desktop',
        ...(this.consent ? { communityGate: (manifest) => consentProblem(this.consent!, manifest) } : {}),
      });
      const install = prepared.installs.find((entry) => entry.plugin.meta.id === id);
      if (!install) {
        const rejected = prepared.rejected.find((entry) => entry.id === id);
        throw new Error(rejected?.reason ?? `plugin "${id}" was not prepared for loading`);
      }
      await this.runtime.installEntry(install as PluginInstall);
      this.runtime.recordDegraded(this.runtime.degradedPlugins().filter((entry) => entry.id !== id));
      return { id, enabled: true, revision };
    } catch (error) {
      throw new CommandError(AppError.configuration(`PLUGIN_ENABLE_FAILED: plugin "${id}": ${errorText(error)}`));
    }
  }

  private async uninstall(args: unknown, call: CallContext): Promise<{ id: string; removed: boolean; revision: string }> {
    assertTrustedManagerSource(call.source, PLUGIN_MANAGER_UNINSTALL_COMMAND);
    this.assertWritable(PLUGIN_MANAGER_UNINSTALL_COMMAND);
    const document = argsObject(args, PLUGIN_MANAGER_UNINSTALL_COMMAND);
    const id = stringArg(document, PLUGIN_MANAGER_UNINSTALL_COMMAND, 'id');
    const revision = this.revisionArg(document, PLUGIN_MANAGER_UNINSTALL_COMMAND);
    const current = await this.store.read();
    if (current.revision !== revision) throw conflict(new ProfileConflictError(revision, current.revision));
    const installed = this.runtime.get(id);
    if (installed) await this.unloadOrConflict(id);

    let removedPackage: PackageRecord | undefined;
    if ((await this.packages?.list())?.some((entry) => entry.id === id)) {
      try { removedPackage = await this.packages!.uninstall(id); } catch (error) {
        if (installed) await this.runtime.installEntry(installed);
        throw new CommandError(AppError.file_system(`PLUGIN_PACKAGE_UNINSTALL_FAILED: ${errorText(error)}`));
      }
    }
    try {
      const written = await this.store.mutate(revision, (file) => { removeEntries(file, id); });
      this.managedReplacements.delete(id);
      this.runtime.recordDegraded(this.runtime.degradedPlugins().filter((entry) => entry.id !== id));
      return { id, removed: true, revision: written.revision };
    } catch (error) {
      // uninstall removed the lock pointer, so the rollback expects it to still be absent ('').
      // If the restore fails (for example a newer install took the pointer), the old runtime stays unloaded.
      let packageRestored = removedPackage === undefined;
      if (removedPackage && this.packages?.restore) {
        try {
          await this.packages.restore(id, removedPackage, '');
          packageRestored = true;
        } catch (rollback) {
          this.runtime.ctx.logger('host').error(`[plugin-manager] package restore of "${id}" failed: ${errorText(rollback)}`);
        }
      }
      if (installed && packageRestored && !this.runtime.get(id)) await this.runtime.installEntry(installed);
      if (error instanceof ProfileConflictError) throw conflict(error);
      throw new CommandError(AppError.file_system(`PROFILE_WRITE_FAILED: ${errorText(error)}`));
    }
  }

  private async setTrust(args: unknown, call: CallContext): Promise<PluginManagerConsentView> {
    // RUST-FIX(RF-P1-plugin-trust): exact user-confirmed subject, never a payload-derived source.
    assertTrustedManagerSource(call.source, PLUGIN_MANAGER_SET_TRUST_COMMAND);
    this.assertWritable(PLUGIN_MANAGER_SET_TRUST_COMMAND);
    const document = argsObject(args, PLUGIN_MANAGER_SET_TRUST_COMMAND);
    if (document.confirmed !== true) validation('TRUST_CONFIRMATION_REQUIRED: confirm same-process plugin execution risk');
    if (document.trust !== 'full' && document.trust !== 'restricted') validation('set-trust: invalid trust');
    return this.grantConsent(args, call, document.trust);
  }

  private async grantConsent(args: unknown, call: CallContext, trust?: 'full' | 'restricted'): Promise<PluginManagerConsentView> {
    assertTrustedManagerSource(call.source, PLUGIN_MANAGER_CONSENT_COMMAND);
    this.assertWritable(PLUGIN_MANAGER_CONSENT_COMMAND);
    const document = argsObject(args, PLUGIN_MANAGER_CONSENT_COMMAND);
    const id = stringArg(document, PLUGIN_MANAGER_CONSENT_COMMAND, 'id');
    const version = stringArg(document, PLUGIN_MANAGER_CONSENT_COMMAND, 'version');
    const permissions = document.permissions;
    if (!Array.isArray(permissions) || permissions.some((item) => typeof item !== 'string')) {
      validation(`${PLUGIN_MANAGER_CONSENT_COMMAND}: "permissions" must be an array of strings`);
    }
    if (!this.consent) throw new CommandError(AppError.configuration(`CONSENT_UNAVAILABLE: this Host has no consent ledger`));
    if ((await this.packages?.list())?.some((entry) => entry.id === id)) await this.packages!.verify(id);
    const manifest = await this.manifestOf(id, await this.declaredEntry(id));
    if (!manifest) throw new CommandError(AppError.not_found(`PLUGIN_NOT_FOUND: plugin "${id}" is not a community package declared by the profile`));
    if (manifest.version !== version || !samePermissions(manifest.permissions, permissions as string[])) {
      throw new CommandError(AppError.conflict(
        `CONSENT_STALE: confirmation for "${id}" does not match the installed package (version ${manifest.version}, permissions ${JSON.stringify(canonicalPermissions(manifest.permissions))})`,
      ));
    }
    let record;
    const stopped = trust !== undefined ? this.runtime.get(id) : undefined;
    if (stopped) await this.unloadOrConflict(id);
    try {
      record = await this.consent.grant(subjectOf(manifest), trust === undefined ? {} : { trust });
    } catch (error) {
      if (stopped && !this.runtime.get(id)) await this.runtime.installEntry(stopped);
      throw new CommandError(AppError.file_system(`CONSENT_WRITE_FAILED: ${errorText(error)}`));
    }
    return { id: record.id, version: record.version, permissions: [...record.permissions], permissionsDigest: record.permissionsDigest, trust: record.trust, source: record.source };
  }

  // ---------------------------------------------------------------- 工具

  private async declaredEntry(id: string): Promise<ResolvedEntry | undefined> {
    const effective = await this.effectiveEntry(id);
    if (effective) return effective;
    const profile = await this.store.read();
    const entry = profile.file.plugins.find((item) => item.id === id);
    if (entry?.module) return {
      id, config: entry.config, declaredIn: this.store.path,
      specifier: entry.module.startsWith('file:') ? entry.module : pathToFileURL(resolve(dirname(this.store.path), entry.module)).href,
    };
    return (await resolveProfile(this.official)).find((item) => item.id === id);
  }

  installManagedDirectory(request: ManagedPluginInstallRequest): Promise<PluginManagerInstallResult> {
    const run = this.mutations.then(() => this.installManaged(request), () => this.installManaged(request));
    this.mutations = run;
    return run;
  }

  private async installManaged(request: ManagedPluginInstallRequest): Promise<PluginManagerInstallResult> {
    // RUST-FIX(RF-P1-managed-plugin-install): Host-owned workshop path, real ZIP transaction, retained source.
    this.assertWritable('dstuPluginInstaller.installManagedDirectory');
    if (request.confirmed !== true) validation('TRUST_CONFIRMATION_REQUIRED: confirm full-trust same-process execution risk');
    if (!parsePluginId(request.id) || parsePluginId(request.id)!.official) validation('PLUGIN_WORKSHOP_PATH_INVALID: invalid community id');
    if (!this.files || !this.packages || !this.consent) validation('PLUGIN_INSTALL_UNAVAILABLE: package storage/consent is not configured');
    const appData = await realpath(this.runtime.app.dataDir);
    const root = join(appData, 'dstu-workshop', request.id);
    if (!workshopDirectoryWithin(root, request.directory)) validation('PLUGIN_WORKSHOP_PATH_INVALID: directory has a traversal or foreign root');
    const directory = await realpath(request.directory);
    if (!workshopDirectoryWithin(root, directory)) validation('PLUGIN_WORKSHOP_PATH_INVALID: directory is not inside this workshop project');
    const scope = this.files.scope(directory);
    const manifest = assertInstallable(JSON.parse(await scope.readText('package.json', { maxBytes: 1024 * 1024 })), {
      appVersion: this.runtime.app.version, platform: 'desktop', installed: this.installedVersions(),
    });
    if (manifest.id !== request.id || manifest.version !== request.version || !samePermissions(manifest.permissions, request.permissions)) {
      validation('CONSENT_STALE: managed candidate differs from the confirmed subject');
    }
    const sink = new MemoryZipSink();
    const zip = new ZipWriter(sink, { codec: nodeZipCodec });
    let bytes = 0, count = 0;
    for await (const item of scope.walk('', { includeDirectories: true })) {
      if (++count > 10_000) validation('PLUGIN_PACKAGE_INVALID: too many workshop files');
      if (item.kind === 'directory') continue;
      if (item.kind !== 'file') validation('PLUGIN_WORKSHOP_PATH_INVALID: only regular project files are allowed');
      await zip.addStream(item.relativePath, await scope.openRead(item.relativePath), { onData(chunk) {
        bytes += chunk.length;
        if (bytes > 256 * 1024 * 1024) validation('PLUGIN_PACKAGE_INVALID: workshop exceeds 256 MiB');
      } });
    }
    await zip.finish();
    const temporaryRoot = join(appData, 'dstu-workshop', '.installs');
    await mkdir(temporaryRoot, { recursive: true });
    const path = join(temporaryRoot, `${randomUUID()}.dstuplugin`);
    await writeFile(path, sink.bytes(), { flag: 'wx' });
    try {
      return await this.installPackage({ path, revision: request.revision }, { source: { window: 'main', webview: 'main' } } as CallContext, request);
    } finally { await unlink(path); }
  }

  private installedVersions(): Map<string, string> {
    return new Map(this.runtime.plugins().map(entry => [entry.id, entry.manifest?.version ?? entry.plugin.meta.version ?? this.runtime.app.version]));
  }

  private async installPackage(args: unknown, call: CallContext, managed?: ManagedPluginInstallRequest): Promise<PluginManagerInstallResult> {
    // RUST-FIX(RF-W01-package-manager-wiring): W34 离线事务接入可信命令；profile 失败按指针 CAS restore。
    assertTrustedManagerSource(call.source, PLUGIN_MANAGER_INSTALL_COMMAND);
    this.assertWritable(PLUGIN_MANAGER_INSTALL_COMMAND);
    const document = argsObject(args, PLUGIN_MANAGER_INSTALL_COMMAND);
    const path = stringArg(document, PLUGIN_MANAGER_INSTALL_COMMAND, 'path');
    const revision = this.revisionArg(document, PLUGIN_MANAGER_INSTALL_COMMAND);
    const current = await this.store.read();
    if (current.revision !== revision) throw conflict(new ProfileConflictError(revision, current.revision));
    if (!this.files || !this.packages) throw new CommandError(AppError.configuration('PLUGIN_INSTALL_UNAVAILABLE: package storage is not configured'));
    const grant = this.files.grant(path);
    let result: Awaited<ReturnType<PluginPackages['install']>> | undefined;
    let stopped: InstalledPlugin | undefined;
    let previousConsent: CommunityConsentRecord | undefined;
    let consentChanged = false;
    try {
      const archive = await this.files.openFile(path, { mode: 'read' });
      try {
        result = await this.packages.install(archive, basename(path), {
          appVersion: this.runtime.app.version, platform: 'desktop',
          installed: this.installedVersions(),
        });
      } finally { await archive.close(); }
      const { manifest, record } = result;
      if (managed && (record.id !== managed.id || record.version !== managed.version || !samePermissions(manifest.permissions, managed.permissions))) {
        throw new Error('CONSENT_STALE: archived managed candidate changed');
      }
      if (!manifest.host) throw new Error('PLUGIN_HOST_REQUIRED: UI-only packages are not supported by this Host manager yet');
      stopped = this.runtime.get(record.id);
      if (stopped) await this.unloadOrConflict(record.id);
      await this.packages.setEnabled(record.id, false);
      previousConsent = (await this.consent?.read())?.find(entry => entry.id === record.id);
      if (managed) await this.consent!.grant(subjectOf(manifest), {
        trust: previousConsent?.source === 'workshop' ? previousConsent.trust : 'full', source: 'workshop',
      });
      else if (this.consent) {
        if (previousConsent) await this.consent.grant(previousConsent, { trust: 'restricted', source: 'package' });
      }
      consentChanged = managed !== undefined || previousConsent !== undefined;
      const written = await this.store.mutate(revision, (file) => {
        const existing = file.plugins.find((entry) => entry.id === record.id);
        writeEntry(file, { id: record.id, module: pathToFileURL(join(this.runtime.app.dataDir, 'plugins', record.path, manifest.host!)).href,
          ...(existing?.config !== undefined ? { config: existing.config } : {}), disabled: true });
      });
      if (managed && result.previous) {
        const pending = this.managedReplacements.get(record.id);
        this.managedReplacements.set(record.id, pending ? { ...pending, candidatePath: record.path } : {
          previous: result.previous, candidatePath: record.path, profile: current.file, runtime: stopped, consent: previousConsent,
        });
      }
      if (!managed) this.managedReplacements.delete(record.id);
      return { id: record.id, version: record.version, enabled: false, revision: written.revision,
        consentRequired: { ...subjectOf(manifest), code: 'CONSENT_REQUIRED' }, rollback: 'not-needed' };
    } catch (error) {
      let rollback: 'not-needed' | 'restored' | 'failed' = 'not-needed';
      if (result) {
        try {
          await this.packages.restore(result.record.id, result.previous, result.record.path);
          if (consentChanged) await this.consent!.restore(result.record.id, previousConsent);
          if (stopped && !this.runtime.get(stopped.id)) await this.runtime.installEntry(stopped);
          rollback = 'restored';
        } catch (failure) {
          rollback = 'failed';
          this.runtime.ctx.logger('host').error(`[plugin-manager] install rollback failed: ${errorText(failure)}`);
        }
      }
      throw new CommandError(AppError.with_details('Configuration', errorText(error), { code: error instanceof PluginLoadError ? error.code : 'PLUGIN_INSTALL_FAILED', rollback }));
    } finally { grant.revoke(); }
  }

  private async unloadOrConflict(id: string): Promise<void> {
    try {
      await this.runtime.unload(id);
    } catch (error) {
      throw new CommandError(AppError.conflict(`PLUGIN_UNLOAD_BLOCKED: ${errorText(error)}`));
    }
  }

  private async effectiveEntry(id: string): Promise<ResolvedEntry | undefined> {
    const profile = await this.store.read();
    if (!profile.exists) return (await resolveProfile(this.official)).find((entry) => entry.id === id);
    const entries = await resolveProfile(this.store.path, { official: this.official, user: true });
    return entries.find((entry) => entry.id === id);
  }

  /** 把用户 profile 恢复成写操作前的快照（保留当前文件的注释键）。 */
  private async restoreProfile(expectedRevision: string, previous: ProfileFile): Promise<void> {
    try {
      await this.store.mutate(expectedRevision, (file) => {
        file.plugins = structuredClone(previous.plugins);
        if (previous.extends === undefined) delete file.extends;
        else file.extends = structuredClone(previous.extends);
      });
    } catch (error) {
      this.runtime.ctx.logger('host').error(`[plugin-manager] profile rollback failed: ${errorText(error)}`);
    }
  }
}
