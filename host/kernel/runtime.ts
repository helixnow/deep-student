/**
 * Desktop Host 运行时：Cordis 根 Context + kernel 服务 + 插件生命周期。
 *
 * 生命周期语义（沿用 f3958900 `src/plugin-runtime/host.ts`，建立在 Cordis fiber 之上）：
 * - 安装：`ctx.plugin()` 启动插件；`apply` 抛错 → Cordis 撤销其已产生的副作用，kernel 再移除 fiber 并抛出；
 *   `meta.provides` 声明的服务必须由插件（含其子 fiber）提供，未声明的服务不得提供。
 * - 停止：拒绝新调用 → 中止进行中调用 → 等待其结束 → Cordis 按注册逆序撤销副作用（服务、监听、注册）。
 * - 依赖：仍有已安装插件 `inject` 本插件提供的服务时，拒绝单独卸载（dependents block unload）。
 * - profile：按顺序安装，任一失败则按逆序回滚本 profile 已安装的插件。
 */
import { Context, type Fiber } from '@deepseek-ai/cordis';
import {
  HOST_CALL_COMMAND,
  HOST_STATUS_COMMAND,
  PLUGINS_DEGRADED_EVENT,
  UI_MANIFEST_COMMAND,
  UI_READY_COMMAND,
  UI_MANIFEST_EVENT,
  UI_MANIFEST_V2_EVENT,
  UI_MANIFEST_VERSION,
  type AppInfo,
  type DegradedPlugin,
  type HostExiting,
  type HostPlugin,
  type HostPluginOrigin,
  type UiManifestEntry,
  type UiManifestV2,
  type UiManifestV2Plugin,
  type WindowRef,
} from './api.ts';
import { fileUrlToPath, fileUrlWithin, isHostModuleUrl, moduleOrigin, moduleUrlOf, resolveRelativeFile } from './module-origin.ts';
import { AppError, CommandError, errorDisplay } from './error-model.ts';
import { CommandService, type DispatchRequest, type InvokeOutcome } from './commands.ts';
import type { ContractSet } from './contract-set.ts';
import { checkCoverage, type CoverageReport } from './coverage.ts';
import { BackendEventService, UiEventService } from './events.ts';
import { findNonJson, toWireJson } from './json.ts';
import { FIBER_ACTIVE, isWithin, type HostOutbound, type InstalledPlugin, type KernelState } from './kernel.ts';
import type { EventTarget, ProtocolChunk, ProtocolRequest, ProtocolResponse, ShellResponse, WindowLifecycle } from './protocol.ts';
import { ProtocolService } from './protocols.ts';
import { resolvePluginConfig } from './plugin-config.ts';
import { parseDegradedReason, PluginLoadError } from './plugin-load-error.ts';
import type { PluginManifest } from './manifest.ts';
import type { DstuPluginInstaller } from './plugin-admin.ts';
import { BuiltinPluginInstaller } from './plugin-installer.ts';
import { communityContext } from './community-context.ts';
import { CORE_SERVICES } from './profile-install.ts';
import { ShellService } from './shell.ts';
import { StartupTimeline } from './startup-timing.ts';
import type { CapabilityAcl } from './acl.ts';
import { workshopUiReceipt, releaseWorkshopUiReceipt } from './workshop-ui-authority.ts';

export type { InstalledPlugin, HostOutbound } from './kernel.ts';

/**
 * `plugin:host|call` 没带 `caller` 时的处理（SEC-E06）：
 * - `warn`：放行，按服务计数（{@link HostRuntime.hostCallsWithoutCaller}），每个服务记一次 warn；
 * - `require`：以 Validation 错误拒绝，不查找服务。
 */
export type HostCallCallerMode = 'warn' | 'require';

/** UI 内核（`src/ui-kernel/kernel.ts`）与移动端诊断页（`mobile/src/main.ts`）都已带 caller（K2，API.md §15.2）。 */
export const DEFAULT_HOST_CALL_CALLER_MODE: HostCallCallerMode = 'require';

/**
 * 关停各阶段的等待上限（V09 P1-1/P1-2，API.md「关停」）。外壳给 Host 的关停预算必须大于它们之和加上
 * `main.ts::exitSoon` 的 500 ms：2000 + 3000 + 500 = 5500 ms。
 */
export const COMMAND_CLOSE_TIMEOUT_MS = 2_000;
export const PLUGIN_DISPOSE_TIMEOUT_MS = 1_500;
export const DISPOSE_PHASE_BUDGET_MS = 3_000;
/**
 * dispose 段末尾留给平台核心服务（{@link CORE_SERVICES}）提供方的时间：其他插件只能用到段截止前这么久，
 * 前面的插件挂住时 storage / log 仍有这段时间收尾。包含在 {@link DISPOSE_PHASE_BUDGET_MS} 之内。
 */
export const CORE_DISPOSE_RESERVE_MS = 500;

export interface HostRuntimeOptions {
  acl?: CapabilityAcl;
  app: AppInfo;
  contracts: ContractSet;
  /** Host → main 出口；没有连接时为 `null`（shell 请求会立即失败）。 */
  outbound?: HostOutbound | null;
  /** `ctx.shell.request` 的超时，默认 30 秒。 */
  shellTimeoutMs?: number;
  /** 默认 {@link DEFAULT_HOST_CALL_CALLER_MODE}。 */
  hostCallCaller?: HostCallCallerMode;
  /** 卸载/关停时等待在途命令响应 abort 的上限，默认 {@link COMMAND_CLOSE_TIMEOUT_MS}。 */
  commandCloseTimeoutMs?: number;
  /**
   * 安全模式（W06 `--safe-mode`）：只允许官方（应用内）插件装载，拒绝社区插件的安装、启用与 profile 变更。
   * 由外壳以 `DS_SAFE_MODE=1` / `--safe-mode` 传入；渲染进程不能切换。
   */
  safeMode?: boolean;
}

/** 一条待安装的插件。 */
export interface PluginInstall {
  plugin: HostPlugin<any>;
  config?: unknown;
  /** 来源（profile 中的模块 URL），只用于诊断。 */
  source?: string;
  /** 社区插件的包根目录（`package.json` 所在目录，绝对路径）；`meta.ui` 不得解析到它之外。 */
  packageRoot?: string;
  /** 社区插件的安装前校验 manifest（profile 筛查结果；官方插件没有）。 */
  manifest?: PluginManifest;
}

export class PluginLifecycleError extends Error {
  override name = 'PluginLifecycleError';
}

/**
 * `plugin:ui|manifest` 的可选参数 `version`：缺省或 1 为 v1，2 为 v2；其他取值是调用方错误。
 * 旧调用方传 `{}`（或不传）时行为与 v1 完全相同。
 */
function manifestVersion(args: unknown): 1 | 2 {
  const version = typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>).version : undefined;
  if (version === undefined || version === null || version === 1) return 1;
  if (version === UI_MANIFEST_VERSION) return UI_MANIFEST_VERSION;
  throw new CommandError(AppError.validation(`${UI_MANIFEST_COMMAND}: unsupported manifest version ${JSON.stringify(version)} (expected 1 or ${UI_MANIFEST_VERSION})`));
}

function injectNames(plugin: HostPlugin<any>): string[] {
  const inject = plugin.inject;
  if (!inject) return [];
  return Array.isArray(inject) ? [...inject] : Object.keys(inject);
}

function assertHostPlugin(plugin: unknown, where: string): asserts plugin is HostPlugin<any> {
  const p = plugin as HostPlugin<any> | undefined;
  if (typeof p !== 'object' || p === null) throw new PluginLifecycleError(`${where}: plugin must be an object created by definePlugin()`);
  if (typeof p.apply !== 'function') throw new PluginLifecycleError(`${where}: plugin.apply must be a function`);
  if (typeof p.meta !== 'object' || p.meta === null || typeof p.meta.id !== 'string' || !p.meta.id) {
    throw new PluginLifecycleError(`${where}: plugin.meta.id must be a non-empty string`);
  }
}

export class HostRuntime {
  private pluginInstaller: DstuPluginInstaller | undefined;

  /** Kernel bootstrap only; capability is scoped into declared builtin dependencies at start(). */
  setBuiltinPluginInstaller(installer: DstuPluginInstaller): void { this.pluginInstaller = installer; }
  /** Profile dependency checks must include this entry's scoped builtin capability, never publish it on root. */
  hasDependency(entry: PluginInstall, name: string): boolean {
    return name === 'dstuPluginInstaller' && !this.isCommunity(entry)
      ? this.pluginInstaller !== undefined : this.ctx.get(name) !== undefined;
  }
  readonly ctx: Context;
  readonly kernel: KernelState;
  readonly commands: CommandService;
  readonly backendEvents: BackendEventService;
  readonly protocols: ProtocolService;
  readonly shell: ShellService;
  /** 启动计时（阶段、模块导入、apply）；只记录，不影响装载。 */
  readonly startup = new StartupTimeline();
  private readonly installed: InstalledPlugin[] = [];
  private readonly owners = new WeakMap<Fiber, InstalledPlugin>();
  /** 已发送的清单；初始为 `[]`——前端默认只加载官方 UI，空清单不需要额外事件。 */
  private lastUiManifest: string | null = '[]';
  /** 已发送的 v2 清单；收到第一次 v2 请求前为 `null`，此时不发 v2 事件。 */
  private lastUiManifestV2: string | null = null;
  private degraded: DegradedPlugin[] = [];
  readonly hostCallCaller: HostCallCallerMode;
  /** 安全模式：只允许官方插件；社区插件的安装/启用与 profile 变更在命令层拒绝。 */
  readonly safeMode: boolean;
  /** warn 模式下未带 caller 而放行的调用次数（服务名 → 次数）；首次出现时记 warn。 */
  private readonly callsWithoutCaller = new Map<string, number>();
  private disposed = false;
  private exiting = false;

  constructor(options: HostRuntimeOptions) {
    const root = new Context();
    this.ctx = root;
    this.hostCallCaller = options.hostCallCaller ?? DEFAULT_HOST_CALL_CALLER_MODE;
    this.safeMode = options.safeMode === true;
    const app: AppInfo = Object.freeze({ ...options.app });
    const owners = this.owners;
    this.kernel = {
      root,
      contracts: options.contracts,
      app,
      ...(options.acl ? { acl: options.acl } : {}),
      outbound: options.outbound ?? null,
      shellTimeoutMs: options.shellTimeoutMs ?? 30_000,
      commandCloseTimeoutMs: options.commandCloseTimeoutMs ?? COMMAND_CLOSE_TIMEOUT_MS,
      ownerOf(fiber: Fiber) {
        let current: Fiber = fiber;
        while (true) {
          const owner = owners.get(current);
          if (owner) return owner;
          const parent: Fiber = current.parent.fiber;
          if (parent === current || !current.runtime) return undefined;
          current = parent;
        }
      },
    };
    // kernel 服务挂在根 fiber 上：插件无需 inject 即可访问，且永远处于 ACTIVE。
    root.provide('app', app);
    this.commands = new CommandService(root, this.kernel);
    this.backendEvents = new BackendEventService(root, this.kernel);
    // RUST-FIX(RF-W01-ui-events-emitter): 受限的插件事件入口，与 backendEvents 共用同一条线上传输。
    new UiEventService(root, this.kernel, this.backendEvents);
    this.protocols = new ProtocolService(root, this.kernel);
    this.shell = new ShellService(root, this.kernel);
    // `docs/plugins/FRONTEND.md` §3/§5：内核自有的 UI 引导通道。不属于 Rust 命令，不在 IPC 契约的 `commands` 段
    // （kernel 不按契约校验其参数与结果），只登记在 `contracts/ipc/F1-kernel.json` 的 `hostNative` 段。
    this.commands._registerKernel(UI_MANIFEST_COMMAND, (args) => (manifestVersion(args) === UI_MANIFEST_VERSION ? this.requestUiManifestV2() : this.uiManifest()));
    this.commands._registerKernel(HOST_CALL_COMMAND, (args, call) => this.hostCall(args, call.signal, call.source, call.invokeId));
    this.commands._registerKernel(HOST_STATUS_COMMAND, () => this.degradedPlugins());
    this.commands._registerKernel(UI_READY_COMMAND, async (args, call) => {
      // RUST-FIX(RF-P1-managed-plugin-install): UI reports actual loaded metadata, not a guessed package version.
      if (call.source.window !== 'main' || call.source.webview !== 'main' || call.source.origin !== undefined) {
        throw new CommandError(AppError.configuration('PLUGIN_MANAGER_FORBIDDEN: UI ready requires the local main window'));
      }
      const value = args as { id?: unknown; version?: unknown } | null;
      if (typeof value?.id !== 'string' || typeof value.version !== 'string') throw new CommandError(AppError.validation('plugin:ui|ready requires id/version'));
      const entry = this.get(value.id);
      if (!entry) throw new CommandError(AppError.not_found(`PLUGIN_NOT_FOUND: ${value.id}`));
      const expected = entry.manifest?.version ?? entry.plugin.meta.version;
      if (expected !== undefined && expected !== value.version) {
        await this.degradeVersionMismatch(entry, value.version, expected);
        return { id: entry.id, matched: false };
      }
      return { id: entry.id, matched: true };
    });
  }

  get app(): AppInfo {
    return this.kernel.app;
  }

  /** 已安装插件（安装顺序）。 */
  plugins(): readonly InstalledPlugin[] {
    return [...this.installed];
  }

  get(id: string): InstalledPlugin | undefined {
    return this.installed.find((p) => p.id === id);
  }

  /** 本次 profile 装载中未安装的插件（`plugin:host|status` 的返回值）。 */
  degradedPlugins(): DegradedPlugin[] {
    return this.degraded.map((item) => ({ ...item }));
  }

  /** warn 模式下没带 `caller` 而放行的 `plugin:host|call` 次数，按服务名；切到 `require` 后这些调用会被拒绝。 */
  hostCallsWithoutCaller(): Record<string, number> {
    return Object.fromEntries(this.callsWithoutCaller);
  }

  /** 记录 profile 装载结果：每个未安装插件记 warn，非空时广播 `host://plugins-degraded`。 */
  recordDegraded(plugins: readonly DegradedPlugin[]): void {
    this.degraded = plugins.map((item) => ({ ...item }));
    for (const item of this.degraded) {
      void this.recordPluginError(item.id, 'plugin.inactive', item.reason, undefined, parseDegradedReason(item.reason).code);
      this.ctx.logger('host').warn(`[host] plugin "${item.id}" is inactive: ${item.reason}`);
    }
    if (this.degraded.length) this.backendEvents.emit(PLUGINS_DEGRADED_EVENT, this.degradedPlugins());
    this.emitUiManifestV2();
  }

  /**
   * UI 引导清单（`docs/plugins/FRONTEND.md` §3）：只列 `meta.ui` 指向的**用户/社区插件**，
   * 官方插件的 UI 半已打包进前端，模块位于 `host/` 内的条目不进清单。
   */
  uiManifest(): UiManifestEntry[] {
    const manifest: UiManifestEntry[] = [];
    for (const entry of this.installed) {
      const file = this.communityUiFile(entry, true);
      if (file === undefined) continue;
      manifest.push({
        id: entry.id,
        file,
        ...(entry.plugin.meta.version !== undefined ? { version: entry.plugin.meta.version } : {}),
      });
    }
    return manifest;
  }

  /**
   * v1 清单收录的 UI 半文件：声明了 `meta.ui` 且模块位于 `host/` 之外；否则 undefined。
   * 解析结果必须在插件包根目录（没有包根时为模块所在目录）之内：`ds-plugin://` 以 UI 文件所在目录为服务根（SEC-E12）。
   */
  private communityUiFile(entry: InstalledPlugin, warn: boolean): string | undefined {
    const ui = entry.plugin.meta.ui;
    if (!ui) return undefined;
    const moduleUrl = this.moduleUrl(entry);
    if (moduleUrl === null || !moduleUrl.startsWith('file:')) {
      if (warn) this.ctx.logger('host').warn(`[host] cannot resolve the module file of plugin "${entry.id}" (${entry.source ?? 'no source'}); its UI half is not listed`);
      return undefined;
    }
    if (isHostModuleUrl(moduleUrl)) return undefined;
    const href = resolveRelativeFile(moduleUrl, ui);
    const root = entry.packageRoot ?? fileUrlToPath(new URL('./', moduleUrl).href);
    if (!fileUrlWithin(href, root)) {
      if (warn) this.ctx.logger('host').warn(`[host] meta.ui ${JSON.stringify(ui)} of plugin "${entry.id}" resolves outside its package ${root}; its UI half is not listed`);
      return undefined;
    }
    return fileUrlToPath(href);
  }

  /**
   * UI 清单 v2（FE-A3）：**全部**已安装插件（安装顺序），标注来源与平台；社区插件带 UI 半文件（同 v1），
   * 另附本次 profile 装载中未安装的插件。前端据此对账官方 UI 半：Host 半不在清单里的卸载，降级的显示不可用面板。
   */
  uiManifestV2(): UiManifestV2 {
    const plugins = this.installed.map((entry): UiManifestV2Plugin => {
      const { meta } = entry.plugin;
      const file = this.communityUiFile(entry, false);
      return {
        id: entry.id,
        origin: this.originOf(entry),
        platforms: [...(meta.platforms ?? ['desktop'])],
        ...(meta.version !== undefined ? { version: meta.version } : {}),
        ...(file !== undefined ? { file } : {}),
      };
    });
    return { version: UI_MANIFEST_VERSION, plugins, degraded: this.degradedPlugins(), safeMode: this.safeMode };
  }

  /** 清单变化时发出当前 UI 引导清单（启动 / 插件装卸 / 回退共用）。 */
  emitUiManifest(): void {
    const manifest = this.uiManifest();
    const serialized = JSON.stringify(manifest);
    if (serialized !== this.lastUiManifest) {
      this.lastUiManifest = serialized;
      this.backendEvents.emit(UI_MANIFEST_EVENT, manifest);
    }
    this.emitUiManifestV2();
  }

  /** v2 请求：此后清单变化时发出 {@link UI_MANIFEST_V2_EVENT}。 */
  private requestUiManifestV2(): UiManifestV2 {
    const manifest = this.uiManifestV2();
    this.lastUiManifestV2 = JSON.stringify(manifest);
    return manifest;
  }

  private emitUiManifestV2(): void {
    if (this.lastUiManifestV2 === null) return;
    const manifest = this.uiManifestV2();
    const serialized = JSON.stringify(manifest);
    if (serialized === this.lastUiManifestV2) return;
    this.lastUiManifestV2 = serialized;
    this.backendEvents.emit(UI_MANIFEST_V2_EVENT, manifest);
  }

  /** 应用内的模块（`host/`、`electron/`）与进程内直接安装、没有模块来源的插件是官方插件。 */
  private originOf(entry: { readonly source?: string }): HostPluginOrigin {
    if (!entry.source) return 'builtin';
    const moduleUrl = this.moduleUrl(entry);
    return moduleUrl === null ? 'community' : moduleOrigin(moduleUrl);
  }

  /** 插件模块的 URL；包名无法解析时 `null`（清单无处可指，调用方记录 warn 后跳过该插件）。 */
  private moduleUrl(entry: { readonly source?: string }): string | null {
    return entry.source ? moduleUrlOf(entry.source) : null;
  }

  /** 该条目是否是社区插件（模块在应用内之外，或由 profile 筛查出 packageRoot）。 */
  private isCommunity(entry: { readonly source?: string; readonly packageRoot?: string }): boolean {
    return entry.packageRoot !== undefined || this.originOf(entry) === 'community';
  }

  /**
   * `plugin:host|call`（`docs/plugins/FRONTEND.md` §5）：只放行已装载插件 `meta.remote[service]`
   * 中列出、且该插件确实提供了的服务方法。参数必须是 `{ caller?, service, method, args }` 形状的纯 JSON；
   * 带 `caller`（调用方 UI 半的插件 id）时，服务必须由该插件自己提供（决策 7，SEC-E06）；
   * 不带时按 {@link HostRuntime.hostCallCaller} 拒绝或放行并计数。
   */
  private async hostCall(input: unknown, signal: AbortSignal, source: WindowRef, invokeId?: string): Promise<unknown> {
    const problem = findNonJson(input);
    if (problem) throw new CommandError(AppError.validation(`invalid arguments for ${HOST_CALL_COMMAND}: ${problem}`));
    // D3：UI → Host 的参数已在线路上；BigInt 按 Rust/Tauri 的 JSON 数字语义交给服务。
    const wireInput = toWireJson(input);
    if (typeof wireInput !== 'object' || wireInput === null || Array.isArray(wireInput)) {
      throw new CommandError(AppError.validation(`${HOST_CALL_COMMAND} requires an object argument`));
    }
    const { caller, service, method, args } = wireInput as Record<string, unknown>;
    if (caller !== undefined && (typeof caller !== 'string' || !caller)) {
      throw new CommandError(AppError.validation(`${HOST_CALL_COMMAND} requires "caller" to be a non-empty string when given`));
    }
    if (typeof service !== 'string' || !service) {
      throw new CommandError(AppError.validation(`${HOST_CALL_COMMAND} requires "service" to be a non-empty string`));
    }
    if (typeof method !== 'string' || !method) {
      throw new CommandError(AppError.validation(`${HOST_CALL_COMMAND} requires "method" to be a non-empty string`));
    }
    if (!Array.isArray(args)) throw new CommandError(AppError.validation(`${HOST_CALL_COMMAND} requires "args" to be an array`));
    if (caller === undefined && this.hostCallCaller === 'require') {
      throw new CommandError(AppError.validation(`${HOST_CALL_COMMAND} requires "caller", the plugin id of the calling UI half (SEC-E06)`));
    }
    return this.remoteCall(caller, service, method, args, signal, source, invokeId);
  }

  private async remoteCall(caller: string | undefined, service: string, method: string, args: readonly unknown[], signal: AbortSignal, source: WindowRef, invokeId?: string): Promise<unknown> {
    let providers = this.installed.filter((entry) => this.providedBy(entry.fiber).includes(service));
    if (providers.length === 0) throw new CommandError(AppError.validation(`unknown service "${service}"`));
    if (caller !== undefined) {
      const own = providers.filter((entry) => entry.id === caller);
      if (own.length === 0) {
        throw new CommandError(AppError.validation(
          `plugin "${caller}" cannot call service "${service}" of ${providers.map((entry) => `"${entry.id}"`).join(', ')}: a UI half may only call its own Host half`,
        ));
      }
      providers = own;
    } else {
      // warn 模式（过渡期）。只为已有服务计数，计数表的大小以服务数为上限。
      const count = (this.callsWithoutCaller.get(service) ?? 0) + 1;
      this.callsWithoutCaller.set(service, count);
      if (count === 1) {
        this.ctx.logger('host').warn(`[host] ${HOST_CALL_COMMAND} to service "${service}" carries no "caller" plugin id; cross-plugin calls are not rejected until the UI kernel sends it (SEC-E06)`);
      }
    }
    if (!providers.some((entry) => (entry.plugin.meta.remote?.[service] ?? []).includes(method))) {
      throw new CommandError(AppError.validation(`service "${service}" does not expose "${method}" to UI (declare it in meta.remote)`));
    }
    const target = this.ctx.get(service) as Record<string, unknown> | undefined;
    const fn = target?.[method];
    if (typeof fn !== 'function') throw new CommandError(AppError.validation(`service "${service}" has no method "${method}"`));
    // RUST-FIX(RF-P3-workshop-tools): paired UI calls get a one-use kernel receipt, never a payload-provided authority.
    // The call runs inside the provider's execution scope (P1 owner checks) and the receipt is released afterwards.
    const receipt = service === 'pluginWorkshop' ? workshopUiReceipt(source, caller, service, method, signal) : null;
    const invoke = () => (fn as (...params: unknown[]) => unknown).call(target, ...args, receipt ?? { signal });
    let value: unknown;
    try { value = await (this.kernel.execution ? this.kernel.execution.run(providers[0]!.fiber, invoke) : invoke()); }
    catch (error) {
      const owner = providers[0]!;
      await this.recordPluginError(owner.id, service + '.' + method, error, invokeId);
      throw error;
    }
    finally { if (receipt) releaseWorkshopUiReceipt(receipt); }
    const valueProblem = findNonJson(value);
    if (valueProblem) {
      const message = `[dstu-host] ${HOST_CALL_COMMAND} ${service}.${method} returned a value that is not plain JSON: ${valueProblem}`;
      this.ctx.logger('host').error(message);
      throw new CommandError(AppError.internal(message));
    }
    // D3：Host 桥返回值也走同一条 JSON 数字边界；内部值仍由服务方保持原表示。
    return toWireJson(value);
  }

  private async recordPluginError(pluginId: string, operation: string, error: unknown, id?: string, code?: string): Promise<void> {
    try {
      const log = this.ctx.reflect.get('log', false) as import('../platform/log/api.ts').LogService | undefined;
      await log?.recordError({ source: 'host', pluginId, operation, error, id, code });
    } catch { /* boundary-allow empty-catch: Lifecycle and IPC failures still reach their original caller. */ }
  }

  /** 安装单个插件并等待其启动；依赖的服务必须已经就绪。 */
  async install(plugin: HostPlugin<any>, config?: unknown): Promise<InstalledPlugin> {
    return this.installEntry({ plugin, config });
  }

  /** 安装一个完整的 profile 条目（保留 source/packageRoot/manifest，管理器热装载用）。 */
  async installEntry(entry: PluginInstall): Promise<InstalledPlugin> {
    const installed = await this.start(entry);
    try {
      await this.verifyStarted(installed);
    } catch (error) {
      await this.recordPluginError(installed.id, 'plugin.start', error);
      await this.stop(installed);
      throw error;
    }
    this.emitUiManifest();
    return installed;
  }

  /**
   * 热更新一个已安装插件的配置（Cordis `fiber.update` 会校验并重启该插件）。
   * 失败（schema 不合法、apply 抛错）由调用方处理，配置不会被写进 profile 以外的地方。
   */
  async updateConfig(id: string, config: unknown): Promise<InstalledPlugin> {
    const entry = this.get(id);
    if (!entry) throw new PluginLifecycleError(`plugin "${id}" is not installed`);
    const resolved = resolvePluginConfig(entry.plugin, config);
    entry.fiber.update(resolved);
    await entry.fiber.await();
    const updated: InstalledPlugin = Object.freeze({ ...entry, config: resolved });
    const index = this.installed.indexOf(entry);
    if (index >= 0) this.installed.splice(index, 1, updated);
    this.owners.set(updated.fiber, updated);
    this.emitUiManifest();
    return updated;
  }

  /**
   * 按顺序安装一组插件（profile）。所有插件启动并通过检查后才算成功；任一失败则按逆序停止本批已安装的插件，
   * 再抛出原错误（回滚本身出错时抛 AggregateError）。
   */
  async installAll(entries: readonly PluginInstall[]): Promise<InstalledPlugin[]> {
    const done: InstalledPlugin[] = [];
    try {
      for (const entry of entries) done.push(await this.start(entry));
      for (const entry of done) await entry.fiber.await();
      for (const entry of done) await this.verifyStarted(entry);
      this.emitUiManifest();
      return done;
    } catch (error) {
      const failures: unknown[] = [];
      for (const entry of done.reverse()) {
        try {
          await this.stop(entry);
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      if (failures.length) throw new AggregateError([error, ...failures], `profile installation failed and rollback reported errors: ${String(error)}`);
      throw error;
    }
  }

  /**
   * 按插件隔离安装（profile 装载）：失败只撤销该插件自身，返回原因供 `host://plugins-degraded`。
   * 依赖缺服务由调用方在安装前判定（级联 inactive）。
   */
  async installIsolated(entry: PluginInstall): Promise<{ ok: true; value: InstalledPlugin } | { ok: false; reason: string }> {
    let installed: InstalledPlugin | null = null;
    const started = performance.now();
    try {
      installed = await this.start(entry);
      await this.verifyStarted(installed);
      this.startup.recordInstall(entry.plugin.meta.id, started, true);
      return { ok: true, value: installed };
    } catch (error) {
      this.startup.recordInstall(entry.plugin.meta.id, started, false);
      await this.recordPluginError(entry.plugin.meta.id, 'plugin.start', error);
      if (installed !== null && this.get(installed.id) !== undefined) {
        try {
          await this.stop(installed);
        } catch (stopError) {
          this.ctx.logger('host').warn(`[host] rollback of plugin "${installed.id}" failed: ${errorDisplay(stopError)}`);
        }
      }
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** UI incompatibility invalidates the provider and its complete dependency closure. */
  private async degradeVersionMismatch(entry: InstalledPlugin, actual: string, expected: string): Promise<void> {
    // RUST-FIX(RF-P1-managed-plugin-install): Invalidate consumers transitively before removing the incompatible provider.
    const affected = new Set<InstalledPlugin>([entry]);
    const ordered: InstalledPlugin[] = [];
    const visit = (provider: InstalledPlugin): void => {
      const services = this.providedBy(provider.fiber);
      for (const candidate of this.installed) {
        const requires = candidate.manifest?.requires ?? {};
        if (affected.has(candidate) || (!Object.hasOwn(requires, provider.id)
          && !injectNames(candidate.plugin).some(name => services.includes(name)))) continue;
        affected.add(candidate);
        visit(candidate);
      }
      ordered.push(provider);
    };
    visit(entry);
    const reason = `VERSION_MISMATCH: UI version ${actual} differs from Host ${expected}`;
    const failures: string[] = [];
    for (const target of ordered) {
      try { await this.stop(target); }
      catch (error) { failures.push(`${target.id}: ${errorDisplay(error)}`); }
    }
    const ids = new Set([...affected].map(target => target.id));
    this.recordDegraded([
      ...this.degradedPlugins().filter(item => !ids.has(item.id)),
      ...ordered.map(target => ({ id: target.id, reason: target === entry ? reason : `${reason}; depends on incompatible plugin "${entry.id}"` })),
    ]);
    this.emitUiManifest();
    if (failures.length) throw new CommandError(AppError.configuration(`${reason}; cleanup failed: ${failures.join('; ')}`));
  }

  /** 卸载插件。仍有其他插件依赖其服务时拒绝。 */
  async unload(id: string): Promise<void> {
    const entry = this.get(id);
    if (!entry) return;
    const provided = this.providedBy(entry.fiber);
    for (const other of this.installed) {
      if (other === entry) continue;
      const needed = injectNames(other.plugin).filter((name) => provided.includes(name));
      if (needed.length) {
        throw new PluginLifecycleError(`cannot unload "${id}": plugin "${other.id}" requires ${needed.map((n) => `"${n}"`).join(', ')}`);
      }
    }
    await this.stop(entry);
    this.emitUiManifest();
  }

  /**
   * 广播 `host/exiting`（每个 runtime 一次，同步派发）。serve 在中止传输层调用之前以 `shutdown` 调用；
   * {@link dispose} 开头以 `dispose` 调用，已发过则不再发。
   */
  markExiting(reason: HostExiting['reason']): void {
    if (this.exiting) return;
    this.exiting = true;
    try {
      this.ctx.emit('host/exiting', Object.freeze({ reason }));
    } catch (error) {
      this.ctx.logger('host').warn(`[host] a host/exiting listener threw: ${errorDisplay(error)}`);
    }
  }

  /**
   * 关停：广播 `host/exiting` → 并行中止全部插件的在途命令（≤ `commandCloseTimeoutMs`）→ 按安装逆序 dispose，
   * 每个插件最多等 {@link PLUGIN_DISPOSE_TIMEOUT_MS}、整段最多 {@link DISPOSE_PHASE_BUDGET_MS}（最后
   * {@link CORE_DISPOSE_RESERVE_MS} 只给核心服务提供方）；超时的插件记 warn 后继续下一个（它的清理在后台跑完），
   * 保证排在最后的 storage / log 也被 dispose 并有时间收尾。最后拒绝未决的 shell 请求。可重复调用。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.markExiting('dispose');
    this.disposed = true;
    const logger = this.ctx.logger('host');
    const order = [...this.installed].reverse();
    await Promise.all(order.map((entry) => this.commands._closeOwnedBy(entry.fiber)));
    const failures: unknown[] = [];
    let returned = false;
    const isCore = (entry: InstalledPlugin) => (entry.plugin.meta.provides ?? []).some(name => (CORE_SERVICES as readonly string[]).includes(name));
    const phaseEnd = performance.now() + DISPOSE_PHASE_BUDGET_MS;
    const reserve = order.some(isCore) ? CORE_DISPOSE_RESERVE_MS : 0;
    for (const entry of order) {
      const deadline = isCore(entry) ? phaseEnd : phaseEnd - reserve;
      const budget = Math.max(0, Math.min(PLUGIN_DISPOSE_TIMEOUT_MS, deadline - performance.now()));
      const stopping = this.stop(entry).then(() => true, (error: unknown) => {
        if (!returned) failures.push(error);
        else logger.warn(`[host] plugin "${entry.id}" cleanup failed after shutdown moved on: ${errorDisplay(error)}`);
        return true;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([
        stopping,
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), budget); }),
      ]).finally(() => clearTimeout(timer));
      if (!finished) logger.warn(`[host] plugin "${entry.id}" did not finish disposing within ${Math.round(budget)}ms; continuing shutdown while its cleanup runs in the background`);
    }
    returned = true;
    this.shell._rejectAll('Host is shutting down');
    if (failures.length) throw new AggregateError(failures, 'Host shutdown reported plugin cleanup errors');
  }

  /** 覆盖检查：已安装插件声明的命令 vs 契约 vs 实际注册。 */
  coverage(): CoverageReport {
    return checkCoverage({
      plugins: this.installed.map((p) => p.plugin.meta),
      contracts: this.kernel.contracts,
      registered: this.commands._entries().filter((r) => !r.kernel).map((r) => ({ command: r.name, plugin: this.kernel.ownerOf(r.fiber)?.id })),
    });
  }

  // -------------------------------------------------------------- 入站消息

  dispatchInvoke(request: DispatchRequest, signal?: AbortSignal): Promise<InvokeOutcome> {
    return this.commands._dispatch(request, signal);
  }

  /** 前端事件。`target` 决定 Host 侧监听范围（`source` 只是发出者，不参与过滤）；`native` 见 `FrontendEvent.native`。 */
  deliverFrontendEvent(event: string, payload: unknown, source: WindowRef, target: EventTarget, native = false): void {
    this.backendEvents._deliverFrontend(event, payload, source, target, native);
  }

  deliverWindow(message: Pick<WindowLifecycle, 'ref' | 'state'>): void {
    this.ctx.emit('host/window', { ...message.ref }, message.state);
  }

  serveProtocol(request: ProtocolRequest, send: (message: ProtocolResponse | ProtocolChunk) => void): Promise<void> {
    return this.protocols._serve(request, send);
  }

  resolveShell(response: ShellResponse): boolean {
    return this.shell._resolve(response);
  }

  // -------------------------------------------------------------- 内部

  private async start(entry: PluginInstall): Promise<InstalledPlugin> {
    if (this.disposed) throw new PluginLifecycleError('Host runtime is disposed');
    assertHostPlugin(entry.plugin, entry.source ?? 'install');
    const { plugin } = entry;
    const id = plugin.meta.id;
    if (this.get(id)) throw new PluginLifecycleError(`plugin "${id}" is already installed`);
    // RUST-FIX(RF-W01-safe-mode-official-only): 安全模式只装载官方插件（W06 `--safe-mode`），
    // 不依赖外壳是否已经强制官方 profile：直接安装社区的路径同样拒绝。
    if (this.safeMode && this.isCommunity(entry)) {
      throw new PluginLoadError('SAFE_MODE_ACTIVE', id, `plugin "${id}" is a community plugin; safe mode loads official plugins only`);
    }
    const config = resolvePluginConfig(plugin, entry.config);
    let parent = this.ctx;
    let installerOwner: Fiber | undefined;
    if (injectNames(plugin).includes('dstuPluginInstaller')) {
      if (this.isCommunity(entry)) throw new PluginLoadError('KERNEL_API_FORBIDDEN', id, 'dstuPluginInstaller is builtin-only');
      if (this.pluginInstaller) {
        parent = this.ctx.isolate('dstuPluginInstaller');
        new BuiltinPluginInstaller(parent, this.pluginInstaller, () => installerOwner, this.kernel.execution);
      }
    }
    const runtimePlugin = this.isCommunity(entry) || this.kernel.execution ? {
      ...plugin,
      apply: (ctx: Context, config: unknown) => {
        const apply = () => plugin.apply(this.isCommunity(entry) ? communityContext(ctx, this.kernel, id) : ctx, config);
        return this.kernel.execution ? this.kernel.execution.run(ctx.fiber, apply) : apply();
      },
    } : plugin;
    const wrapped = parent.plugin(runtimePlugin, config as never);
    const fiber = wrapped.ctx.fiber;
    installerOwner = fiber;
    const installed: InstalledPlugin = Object.freeze({
      id, plugin, config, fiber,
      ...(entry.source ? { source: entry.source } : {}),
      ...(entry.packageRoot ? { packageRoot: entry.packageRoot } : {}),
      ...(entry.manifest ? { manifest: entry.manifest } : {}),
    });
    // apply 在下一个微任务才运行（Cordis Fiber._reload），此处登记归属后，apply 中的注册即可找到所属插件。
    this.owners.set(fiber, installed);
    this.installed.push(installed);
    try {
      await wrapped;
    } catch (error) {
      await this.recordPluginError(installed.id, 'plugin.load', error);
      this.remove(installed);
      await fiber.dispose();
      throw error;
    }
    return installed;
  }

  private async verifyStarted(entry: InstalledPlugin): Promise<void> {
    const { fiber, plugin } = entry;
    await fiber.await();
    if ((fiber.state as number) !== FIBER_ACTIVE) {
      const missing = injectNames(plugin).filter((name) => this.ctx.get(name) === undefined);
      throw new PluginLifecycleError(
        `plugin "${entry.id}" did not start: ${missing.length ? `required services not available: ${missing.map((n) => `"${n}"`).join(', ')}` : `fiber state ${String(fiber.state)}`}`,
      );
    }
    const declared = [...(plugin.meta.provides ?? [])];
    const provided = this.providedBy(fiber);
    const missing = declared.filter((name) => !provided.includes(name));
    if (missing.length) {
      throw new PluginLifecycleError(`plugin "${entry.id}" declares meta.provides ${missing.map((n) => `"${n}"`).join(', ')} but did not provide ${missing.length > 1 ? 'them' : 'it'}`);
    }
    const undeclared = provided.filter((name) => !declared.includes(name));
    if (undeclared.length) {
      throw new PluginLifecycleError(`plugin "${entry.id}" provides ${undeclared.map((n) => `"${n}"`).join(', ')} without declaring ${undeclared.length > 1 ? 'them' : 'it'} in meta.provides`);
    }
  }

  /** `root` fiber 子树当前提供的服务名。 */
  private providedBy(root: Fiber): string[] {
    const store = this.ctx.reflect.store;
    const names: string[] = [];
    for (const key of Reflect.ownKeys(store)) {
      const impl = store[key as symbol];
      if (impl && isWithin(impl.fiber, root)) names.push(impl.name);
    }
    return names;
  }

  private remove(entry: InstalledPlugin): void {
    const index = this.installed.indexOf(entry);
    if (index >= 0) this.installed.splice(index, 1);
  }

  private async stop(entry: InstalledPlugin): Promise<void> {
    await this.commands._closeOwnedBy(entry.fiber);
    this.remove(entry);
    try { await entry.fiber.dispose(); }
    catch (error) {
      await this.recordPluginError(entry.id, 'plugin.stop', error);
      throw error;
    }
  }
}
