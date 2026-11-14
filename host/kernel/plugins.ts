/**
 * Cordis entry point for the plugin subsystem (Rust: src/plugins/commands.rs + manager.rs).
 * `plugin_unbind` is intentionally a second command name for `logout` (commands.rs:87-90).
 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError, definePlugin, errorDisplay } from './api.ts';
import type { PluginJsonValue as JsonValue } from './plugin-types.ts';
import { IlinkBotPlugin } from '../plugins/ilink/api.ts';
import { PluginManager, asAppError } from './plugin-manager.ts';
import type { ChannelPlugin, PluginState } from './plugin-types.ts';

export const PLUGIN_COMMANDS = [
  'plugin_begin_login',
  'plugin_cancel_login',
  'plugin_get_config',
  'plugin_get_status',
  'plugin_list',
  'plugin_logout',
  'plugin_set_config',
  'plugin_set_enabled',
  'plugin_start',
  'plugin_stop',
  'plugin_unbind',
] as const;

export type PluginCommandName = (typeof PLUGIN_COMMANDS)[number];

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** F1: the app-level channel plugin manager. Rust keeps this in Tauri state. */
    plugins: PluginManager;
  }
}

async function command<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new CommandError(asAppError(error));
  }
}

export interface PluginHostConfig {
  /** Rust runs bootstrap_enabled() 3 s after app setup (a startup finalizer here); tests may disable it. */
  bootstrap?: boolean;
  /** Extra channel plugins registered next to the built-in iLink bot. */
  channels?: readonly ChannelPlugin[];
}

export default definePlugin<PluginHostConfig>({
  meta: {
    id: 'dstu.plugins',
    lane: 'F1-kernel',
    provides: ['plugins'],
    commands: PLUGIN_COMMANDS,
  },
  inject: ['settings'],
  apply(ctx: Context, config: PluginHostConfig = {}) {
    const log = (message: string) => ctx.logger('plugins').warn(message);
    const debug = (message: string) => ctx.logger('plugins').debug(message);
    const manager = new PluginManager({
      settings: ctx.settings,
      events: ctx.backendEvents,
      desktop: ctx.app.platform === 'darwin' || ctx.app.platform === 'win32' || ctx.app.platform === 'linux',
      warn: log,
      debug,
    });
    const setBotState = (state: PluginState, error: string | null) => {
      void manager.setState('ilinkbot', state, error);
    };
    manager.register(
      new IlinkBotPlugin({
        events: ctx.backendEvents,
        onState: setBotState,
        log,
        debug,
      }),
    );
    for (const channel of config.channels ?? []) manager.register(channel);
    ctx.provide('plugins', manager);

    ctx.commands.register('plugin_list', () => command(() => manager.list()));
    ctx.commands.register<{ id: string }, PluginState>('plugin_start', (args) => command(() => manager.start(args.id)));
    ctx.commands.register<{ id: string }, PluginState>('plugin_stop', (args) => command(() => manager.stop(args.id)));
    ctx.commands.register('plugin_get_status', (args: { id: string }) => command(() => manager.getStatus(args.id)));
    ctx.commands.register<{ id: string }, JsonValue>('plugin_get_config', (args) => command(() => manager.getConfig(args.id)));
    ctx.commands.register<{ id: string; patch: unknown }, null>('plugin_set_config', (args) =>
      command(async () => {
        await manager.setConfig(args.id, (args.patch ?? null) as JsonValue);
        return null;
      }),
    );
    ctx.commands.register<{ id: string; enabled: boolean }, null>('plugin_set_enabled', (args) =>
      command(async () => {
        await manager.setEnabled(args.id, args.enabled);
        return null;
      }),
    );
    ctx.commands.register<{ id: string }, null>('plugin_begin_login', (args) =>
      command(async () => {
        await manager.beginLogin(args.id);
        return null;
      }),
    );
    ctx.commands.register<{ id: string }, null>('plugin_cancel_login', (args) =>
      command(async () => {
        await manager.cancelLogin(args.id);
        return null;
      }),
    );
    ctx.commands.register<{ id: string }, null>('plugin_logout', (args) =>
      command(async () => {
        await manager.logout(args.id);
        return null;
      }),
    );
    ctx.commands.register<{ id: string }, null>('plugin_unbind', (args) =>
      command(async () => {
        await manager.unbind(args.id);
        return null;
      }),
    );

    ctx.effect(() => () => {
      void manager.shutdownAll();
    });

    if (config.bootstrap ?? true) scheduleBootstrap(ctx, manager, log);
  },
});

/** Rust `src/lib.rs:1356-1368`：setup 末尾 `sleep(3s)` 后 `bootstrap_enabled()`（等 DB 和 LLM 就绪）。 */
export const PLUGIN_BOOTSTRAP_DELAY_MS = 3_000;
export const PLUGIN_BOOTSTRAP_FINALIZER = 'dstu.plugins.bootstrap-enabled';

interface StartupFinalizers {
  registerFinalizer?(name: string, fn: () => void): void;
}

/**
 * V04-12：在启动 finalizer 里排 {@link PLUGIN_BOOTSTRAP_DELAY_MS} 定时器再自启动。恢复模式下 serve.ts 不跑 finalizer，
 * 等价 Rust setup 提前 return、不注册 PluginManager；没有 storage finalizer 的宿主（TestHost）不自启动。
 */
function scheduleBootstrap(ctx: Context, manager: PluginManager, warn: (message: string) => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  ctx.effect(() => () => {
    disposed = true;
    clearTimeout(timer);
  });
  // Structural probe: storage is ready here because settings injects it; the kernel never imports platform/storage.
  const storage = ctx.get('storage') as StartupFinalizers | undefined;
  if (typeof storage?.registerFinalizer !== 'function') {
    warn('[plugins] no startup finalizers (storage service missing); enabled plugins are not auto-started');
    return;
  }
  try {
    storage.registerFinalizer(PLUGIN_BOOTSTRAP_FINALIZER, () => {
      if (disposed) return;
      timer = setTimeout(() => {
        timer = undefined;
        void manager.bootstrapEnabled();
      }, PLUGIN_BOOTSTRAP_DELAY_MS);
    });
  } catch (error) {
    warn(`[plugins] bootstrap finalizer not registered, enabled plugins are not auto-started: ${errorDisplay(error)}`);
  }
}
