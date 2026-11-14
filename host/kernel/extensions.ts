/**
 * Rust: src/extensions.rs — 扩展点组合根。
 *
 * 组合根本身属于 F1：显式有序的插件列表、按名字幂等、apply 失败保留此前成功的条目、
 * 失败后下一次调用可重试剩余插件。各条目的具体 installer 由对应 lane 的实现提供；
 * 尚未发布的条目通过 `missing` 明确上报，不用空实现冒充。
 */
import { Scope, ScopedPluginError, ScopedPluginHost } from './primitives.ts';

/** `extensions.rs::plugins()` 的 apply 顺序。 */
export const EXTENSION_PLUGIN_ORDER = [
  'web_search_fallback',
  'memory_vfs',
  'memory_mastery',
  'media_vfs',
  'media_host',
  'qbank_vfs',
  'qbank_runtime',
  'storage_notes',
  'browser_artifact_root',
  'sync_settings_database',
  'memory_sync_field_merger',
  'chatanki_agent',
  'agent_insight_hints',
] as const;

export type ExtensionPluginName = (typeof EXTENSION_PLUGIN_ORDER)[number];

/**
 * 一个条目的接线动作。与 Rust `Plugin::apply` 相同：向 `scope` 登记撤销凭证；
 * 槽位已被占用等“已就位”情形由 installer 自己视为成功。
 */
export type ExtensionInstaller = (scope: Scope) => void;

export type ExtensionInstallers = Partial<Record<ExtensionPluginName, ExtensionInstaller>>;

export interface ExtensionLogger {
  error(message: string): void;
}

export interface ExtensionFailure {
  readonly name: ExtensionPluginName;
  readonly error: unknown;
}

export interface ExtensionRegistration {
  /** 本次真正新 apply 的条目（重复调用时为空）。 */
  readonly applied: ExtensionPluginName[];
  /** 未提供 installer 的条目，调用方据此报告跨 lane 未发布依赖。 */
  readonly missing: ExtensionPluginName[];
  /** 首个失败条目；与 Rust `apply_all` 一样，失败后停止，之前条目保留。 */
  readonly failure: ExtensionFailure | null;
}

function failureText(error: unknown): string {
  if (error instanceof ScopedPluginError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** 进程级组合根（Rust `HOST: OnceLock<Mutex<PluginHost>>`）。 */
export class ExtensionRegistry {
  private readonly host = new ScopedPluginHost();

  register(installers: ExtensionInstallers, logger: ExtensionLogger): ExtensionRegistration {
    const applied: ExtensionPluginName[] = [];
    const missing: ExtensionPluginName[] = [];
    let failure: ExtensionFailure | null = null;

    for (const name of EXTENSION_PLUGIN_ORDER) {
      const install = installers[name];
      if (install === undefined) {
        missing.push(name);
        continue;
      }
      try {
        if (this.host.apply({ name, apply: install })) applied.push(name);
      } catch (error) {
        failure = { name, error };
        break;
      }
    }

    if (missing.length > 0) {
      logger.error(`[extensions] installers not published yet: ${missing.join(', ')}`);
    }
    if (failure !== null) {
      // Rust: log::error!("[extensions] plugin apply failed: {}", error)
      logger.error(`[extensions] plugin apply failed: ${failureText(failure.error)}`);
    }
    return { applied, missing, failure };
  }

  /** 已 apply 的条目（apply 顺序）。 */
  appliedNames(): string[] {
    return this.host.appliedNames();
  }

  dispose(): void {
    this.host.unloadAll();
  }
}

let globalRegistry: ExtensionRegistry | undefined;

/**
 * Rust `register_extensions()`：进程级幂等注册。失败时保留已成功条目；
 * 下一次调用会重试失败条目及其后的条目。
 */
export function registerExtensions(
  installers: ExtensionInstallers,
  logger: ExtensionLogger,
): ExtensionRegistration {
  globalRegistry ??= new ExtensionRegistry();
  return globalRegistry.register(installers, logger);
}

/** 仅供 Host 关闭/测试隔离；Rust 进程生命周期内不卸载。 */
export function disposeGlobalExtensions(): void {
  globalRegistry?.dispose();
  globalRegistry = undefined;
}
