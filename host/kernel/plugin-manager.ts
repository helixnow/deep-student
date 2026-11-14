/**
 * Rust: src/plugins/manager.rs. Lifecycle, state machine and generation isolation are
 * ported one-for-one; the Tauri AppHandle is replaced by injected settings/event sinks.
 */
import type { BackendEvents } from './api.ts';
import { AppError } from './error-model.ts';
import type { PluginJsonValue as JsonValue } from './plugin-types.ts';
import { createPluginEventSink } from './plugin-events.ts';
import type { PluginEventSink } from './plugin-events.ts';
import {
  DEFAULT_PLUGIN_STATE,
  canTransitionTo,
  type ChannelPlugin,
  type PluginInfo,
  type PluginRuntimeContext,
  type PluginSettings,
  type PluginState,
  type PluginStatusSnapshot,
} from './plugin-types.ts';

interface RunningHandle {
  readonly controller: AbortController;
  readonly generation: number;
}

export interface PluginManagerOptions {
  settings: PluginSettings;
  events: Pick<BackendEvents, 'emit'>;
  desktop?: boolean;
  now?: () => number;
  /** Rust uses `tracing::warn`; the Cordis entry injects `ctx.logger`. */
  warn: (message: string) => void;
  /** Rust `tracing::debug` (unusual state transition); defaults to `warn`. */
  debug?: (message: string) => void;
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

function isAppError(value: unknown): value is ReturnType<typeof AppError.validation> {
  return typeof value === 'object' && value !== null && 'error_type' in value && 'message' in value && 'details' in value;
}

/** Re-throw a plugin/manager failure as the AppError value Tauri serializes. */
export function asAppError(error: unknown): ReturnType<typeof AppError.validation> {
  return isAppError(error) ? error : AppError.internal(errorMessage(error));
}

export class PluginManager {
  private readonly plugins = new Map<string, ChannelPlugin>();
  private readonly handles = new Map<string, RunningHandle>();
  private readonly states = new Map<string, PluginState>();
  private readonly errors = new Map<string, string>();
  private readonly settings: PluginSettings;
  private readonly events: PluginEventSink;
  private readonly desktop: boolean;
  private readonly warn: (message: string) => void;
  private readonly debug: (message: string) => void;
  private nextGeneration = 0;
  private lifecycleTail: Promise<void> = Promise.resolve();

  constructor(options: PluginManagerOptions) {
    this.settings = options.settings;
    this.desktop = options.desktop ?? true;
    this.warn = options.warn;
    this.debug = options.debug ?? this.warn;
    this.events = createPluginEventSink(options.events, {
      ...(options.now ? { now: options.now } : {}),
      warn: this.warn,
    });
  }

  /** Compile-time registry equivalent (`PluginManager::new` inserts the built-in plugins). */
  register(plugin: ChannelPlugin): void {
    const id = plugin.descriptor().id;
    this.plugins.set(id, plugin);
    if (!this.states.has(id)) this.states.set(id, DEFAULT_PLUGIN_STATE);
  }

  private plugin(id: string): ChannelPlugin {
    const plugin = this.plugins.get(id);
    if (!plugin) throw AppError.validation(`未知插件: ${id}`);
    return plugin;
  }

  private async serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lifecycleTail.then(fn, fn);
    this.lifecycleTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async setState(id: string, state: PluginState, error: string | null): Promise<void> {
    const current = this.states.get(id) ?? DEFAULT_PLUGIN_STATE;
    if (!canTransitionTo(current, state) && current !== state) {
      // manager.rs:71 `tracing::debug!("[plugins] unusual transition {:?} -> {:?} for {}")`.
      this.debug(`[plugins] unusual transition ${current} -> ${state} for ${id}`);
    }
    this.states.set(id, state);
    if (error !== null) this.errors.set(id, error);
    else if (state === 'running' || state === 'stopped' || state === 'waiting_login') this.errors.delete(id);
    this.events.emitState(id, state, error);
  }

  currentState(id: string): PluginState {
    return this.states.get(id) ?? DEFAULT_PLUGIN_STATE;
  }

  private enabledFlag(id: string): boolean {
    const key = `plugin.${id.replaceAll('-', '')}.enabled`;
    // Prefer canonical settings keys; ilink uses plugin.ilinkbot.enabled
    const alt = id === 'ilinkbot' ? 'plugin.ilinkbot.enabled' : key;
    try {
      const value = this.settings.get(alt);
      return value === 'true' || value === '1';
    } catch (error) {
      this.warn(`[plugins] read enabled ${alt} failed: ${errorMessage(error)}`);
      return false;
    }
  }

  async list(): Promise<PluginInfo[]> {
    const out: PluginInfo[] = [];
    for (const [id, plugin] of this.plugins) {
      const descriptor = plugin.descriptor();
      const state = this.currentState(id);
      let config: JsonValue = null;
      try {
        config = await plugin.getPublicConfig(this.settings);
      } catch (error) {
        this.warn(`[plugins] get_public_config ${id} failed: ${errorMessage(error)}`);
      }
      const enabled = this.enabledFlag(id);
      const configured = plugin.isConfigured(config);
      const bound = await plugin.isBound(this.settings);
      const error = this.errors.get(id) ?? null;
      out.push({
        id: descriptor.id,
        label: descriptor.label,
        blurb: descriptor.blurb,
        kind: descriptor.kind,
        state,
        enabled,
        configured,
        bound,
        error,
      });
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  async getStatus(id: string): Promise<PluginStatusSnapshot> {
    const plugin = this.plugin(id);
    const snapshot = await plugin.status(this.settings);
    snapshot.state = this.currentState(id);
    const error = this.errors.get(id);
    if (error !== undefined) snapshot.lastError = error;
    return snapshot;
  }

  async start(id: string): Promise<PluginState> {
    return this.serialized(() => this.startInternal(id));
  }

  private async startInternal(id: string): Promise<PluginState> {
    if (!this.desktop) throw AppError.validation('插件仅支持桌面端');
    const plugin = this.plugin(id);
    const current = this.currentState(id);
    if (current === 'running' || current === 'starting' || current === 'waiting_login') return current;

    // Stop any leftover handle first
    await this.stopInternal(id);

    const controller = new AbortController();
    const generation = ++this.nextGeneration;
    this.handles.set(id, { controller, generation });
    await this.setState(id, 'starting', null);

    let config: JsonValue = null;
    try {
      config = await plugin.getPublicConfig(this.settings);
    } catch (error) {
      this.warn(`[plugins] start ${id} config failed: ${errorMessage(error)}`);
    }
    const context: PluginRuntimeContext = { settings: this.settings, signal: controller.signal, config, desktop: this.desktop };

    void (async () => {
      let failure: unknown = null;
      try {
        await plugin.run(context);
      } catch (error) {
        failure = error;
      }
      const handle = this.handles.get(id);
      const isCurrent = handle?.generation === generation;
      if (!isCurrent) return;
      this.handles.delete(id);
      // A stopped run may finish after a new run has already started.
      // Its completion must not remove or overwrite the new run.
      if (failure === null) await this.setState(id, 'stopped', null);
      else await this.setState(id, 'error', errorMessage(failure));
    })();

    return 'starting';
  }

  private async stopInternal(id: string): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle) return;
    this.handles.delete(id);
    await this.setState(id, 'stopping', null);
    handle.controller.abort();
  }

  async stop(id: string): Promise<PluginState> {
    return this.serialized(async (): Promise<PluginState> => {
      this.plugin(id);
      await this.stopInternal(id);
      // Give run loop a moment; state will settle via task completion or force stopped
      const state = this.currentState(id);
      if (state === 'stopping' || state === 'starting' || state === 'waiting_login' || state === 'running') {
        await this.setState(id, 'stopped', null);
      }
      return 'stopped';
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.plugin(id);
    if (id !== 'ilinkbot') throw AppError.validation('unsupported plugin');
    try {
      this.settings.save('plugin.ilinkbot.enabled', enabled ? 'true' : 'false');
    } catch (error) {
      throw AppError.database(`保存 enabled 失败: ${errorMessage(error)}`);
    }
    if (enabled) await this.start(id);
    else await this.stop(id);
  }

  async getConfig(id: string): Promise<JsonValue> {
    const plugin = this.plugin(id);
    return plugin.getPublicConfig(this.settings);
  }

  async setConfig(id: string, patch: JsonValue): Promise<void> {
    const plugin = this.plugin(id);
    await plugin.setConfig(this.settings, patch);
  }

  async beginLogin(id: string): Promise<void> {
    return this.serialized(async () => {
      if (!this.desktop) throw AppError.validation('插件仅支持桌面端');
      const plugin = this.plugin(id);
      const state = this.currentState(id);
      if (state === 'starting' || state === 'waiting_login' || state === 'running') return;
      if (this.handles.has(id)) {
        // A lifecycle operation already owns the existing handle. A
        // second login request must not share its token or generation
        // with the first background login flow.
        return;
      }
      const controller = new AbortController();
      const generation = ++this.nextGeneration;
      this.handles.set(id, { controller, generation });
      await this.setState(id, 'waiting_login', null);

      let config: JsonValue = null;
      try {
        config = await plugin.getPublicConfig(this.settings);
      } catch (error) {
        this.warn(`[plugins] begin_login ${id} config failed: ${errorMessage(error)}`);
      }
      const context: PluginRuntimeContext = { settings: this.settings, signal: controller.signal, config, desktop: this.desktop };

      void (async () => {
        let failure: unknown = null;
        try {
          await plugin.beginLogin(context);
        } catch (error) {
          failure = error;
        }
        const handle = this.handles.get(id);
        const isCurrent = handle?.generation === generation;
        if (!isCurrent) return;
        this.handles.delete(id);
        if (failure !== null) {
          await this.setState(id, 'error', errorMessage(failure));
          return;
        }
        // Cancellation and duplicate login flows return Ok(()) without
        // persisted credentials. Only confirmed QR login activates polling.
        if (!(await plugin.isBound(this.settings))) {
          await this.setState(id, 'stopped', null);
          return;
        }
        // Scanning is the single activation action: bind, enable, then start polling.
        try {
          this.settings.save('plugin.ilinkbot.enabled', 'true');
        } catch (error) {
          await this.setState(id, 'error', `保存启用状态失败: ${errorMessage(error)}`);
          return;
        }
        try {
          await this.start(id);
        } catch (error) {
          this.warn(`[plugins] auto-start after login failed: ${errorMessage(error)}`);
        }
      })();
    });
  }

  async cancelLogin(id: string): Promise<void> {
    return this.serialized(async () => {
      const plugin = this.plugin(id);
      await plugin.cancelLogin();
      await this.stopInternal(id);
      await this.setState(id, 'stopped', null);
    });
  }

  async logout(id: string): Promise<void> {
    return this.serialized(async () => {
      const plugin = this.plugin(id);
      await this.stopInternal(id);
      const state = this.currentState(id);
      if (state === 'stopping' || state === 'starting' || state === 'waiting_login' || state === 'running') {
        await this.setState(id, 'stopped', null);
      }
      await plugin.logout(this.settings);
      try {
        this.settings.save('plugin.ilinkbot.enabled', 'false');
      } catch (error) {
        throw AppError.database(`重置启用状态失败: ${errorMessage(error)}`);
      }
      await this.setState(id, 'stopped', null);
    });
  }

  /** `plugin_unbind` is the same operation as `plugin_logout` (commands.rs:87-90). */
  async unbind(id: string): Promise<void> {
    return this.logout(id);
  }

  async shutdownAll(): Promise<void> {
    await this.serialized(async () => {
      for (const id of [...this.plugins.keys()]) await this.stopInternal(id);
    });
  }

  /** Auto-start bound plugins after app setup. */
  async bootstrapEnabled(): Promise<void> {
    if (!this.desktop) return;
    let list: PluginInfo[];
    try {
      list = await this.list();
    } catch (error) {
      this.warn(`[plugins] bootstrap list failed: ${errorMessage(error)}`);
      return;
    }
    for (const info of list) {
      if (!info.bound) continue;
      let setting: string | null = null;
      try {
        setting = this.settings.get('plugin.ilinkbot.enabled');
      } catch (error) {
        // manager.rs:481-482 `.ok().flatten()` continues as if the key were absent.
        this.warn(`[plugins] bootstrap enabled setting read failed: ${errorMessage(error)}`);
      }
      if (setting === 'false' || setting === '0') continue;
      // Migrate bindings created before the enabled setting existed,
      // while respecting an explicit user pause.
      if (setting === null) {
        try {
          this.settings.save('plugin.ilinkbot.enabled', 'true');
        } catch (error) {
          this.warn(`[plugins] migrate enabled setting failed: ${errorMessage(error)}`);
        }
      }
      try {
        await this.start(info.id);
      } catch (error) {
        this.warn(`[plugins] auto-start ${info.id} failed: ${errorMessage(error)}`);
      }
    }
  }
}
