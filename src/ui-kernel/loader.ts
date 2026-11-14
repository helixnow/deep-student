/**
 * 社区 UI 插件加载器：按 Host 提供的 UI 引导清单加载、对账（FRONTEND.md §3）。
 *
 * - 清单来自 `plugin:ui|manifest` 命令与 `host://ui-manifest` 事件（Host 内核生成）；
 * - 模块经 `ds-plugin://<id>/<文件名>` 由外壳提供，同一插件再次导入时带 `?reload=<n>`（见 `pluginUrl`）；
 * - 单个插件失败（导入失败、导出不合法、id 不符、apply 抛错）只影响它自己：记录错误并继续，界面不受影响；
 * - 清单变化时卸载被移除或换了文件的插件，安装新增的插件。
 */
import type { UiKernel, UiPlugin } from './kernel';

export interface UiManifestEntry {
  id: string;
  /** Host 侧 UI 模块的绝对路径。 */
  file: string;
  version?: string;
}

export interface UiPluginLoadError {
  id: string;
  error: string;
}

export interface LoaderDeps {
  importModule(url: string): Promise<{ default?: unknown }>;
  /** Report the loaded module's version, never the inventory's advertised version. */
  ready?(id: string, version: string | undefined): Promise<{ id: string; matched: boolean }>;
  log?: { warn(message: string): void; error(message: string): void };
}

/**
 * 本页面里每个插件的 UI 模块已经 import 过几次。浏览器按 URL 缓存 ES 模块（整页一份，跨加载器），
 * 所以更新、Host 重启后重新出现或上次导入失败的插件，再次 import 时要换一个 URL，否则拿到的是第一次加载的模块。
 */
const imports = new Map<string, number>();

/** `reload` 为该插件此前在本页面 import 过的次数；大于 0 时加 `?reload=<n>`（外壳的 `ds-plugin:` 处理器忽略查询串）。 */
export function pluginUrl(entry: UiManifestEntry, reload = 0): string {
  const base = entry.file.split(/[\\/]/).pop() ?? 'ui.js';
  const url = `ds-plugin://${encodeURIComponent(entry.id)}/${encodeURIComponent(base)}`;
  return reload > 0 ? `${url}?reload=${reload}` : url;
}

function nextPluginUrl(entry: UiManifestEntry): string {
  const reload = imports.get(entry.id) ?? 0;
  imports.set(entry.id, reload + 1);
  return pluginUrl(entry, reload);
}

export class UiPluginLoader {
  private readonly current = new Map<string, UiManifestEntry>();
  readonly errors = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly kernel: UiKernel, private readonly deps: LoaderDeps) {}

  /** 以新清单对账（串行执行，避免清单快速变化时交错）。 */
  sync(manifest: readonly UiManifestEntry[]): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const run = this.queue.then(() => this.apply(manifest));
    // A rejected sync is reported to its caller only; it must not block later syncs or dispose().
    this.queue = run.catch(() => {});
    return run;
  }

  private async apply(manifest: readonly UiManifestEntry[]): Promise<void> {
    if (this.disposed) return;
    const next = new Map(manifest.map((e) => [e.id, e]));
    for (const [id, old] of this.current) {
      const now = next.get(id);
      if (!now || now.file !== old.file || now.version !== old.version) {
        await this.kernel.unload(id);
        this.current.delete(id);
        this.errors.delete(id);
      }
    }
    for (const entry of manifest) {
      if (this.current.has(entry.id)) continue;
      try {
        const mod = await this.deps.importModule(nextPluginUrl(entry));
        if (this.disposed) return;
        const plugin = mod.default as UiPlugin<unknown> | undefined;
        if (!plugin || typeof plugin.apply !== 'function' || !plugin.meta?.id) {
          throw new Error(`UI module must default-export defineUiPlugin(...)`);
        }
        if (plugin.meta.id !== entry.id) throw new Error(`UI plugin id "${plugin.meta.id}" does not match host plugin id "${entry.id}"`);
        const installed = await this.kernel.install(plugin, { origin: 'community' });
        if (installed && this.deps.ready) {
          try {
            const reply = await this.deps.ready(entry.id, plugin.meta.version);
            if (!reply.matched) throw new Error(`UI plugin version does not match Host: ${entry.id}`);
          } catch (error) {
            await this.kernel.unload(entry.id);
            throw error;
          }
        }
        if (!installed) {
          const skip = this.kernel.skipped().find((s) => s.id === entry.id);
          this.deps.log?.warn(skip?.reason === 'platform'
            ? `[ui-plugins] "${entry.id}" does not support this platform; skipped`
            : skip?.reason === 'build'
              ? `[ui-plugins] "${entry.id}" is development-only; skipped in this build`
              : skip?.reason === 'requires'
                ? `[ui-plugins] "${entry.id}" requires ${skip.requires.map((dep) => `"${dep}"`).join(', ')}, which this build or platform leaves out; skipped`
                : `[ui-plugins] "${entry.id}" waits for its Host plugins; installs when they are online`);
        }
        this.current.set(entry.id, entry);
        this.errors.delete(entry.id);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.errors.set(entry.id, message);
        this.deps.log?.error(`[ui-plugins] failed to load "${entry.id}": ${message}`);
      }
    }
  }

  loadErrors(): UiPluginLoadError[] {
    return [...this.errors].map(([id, error]) => ({ id, error }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.queue;
    for (const id of this.current.keys()) await this.kernel.unload(id);
    this.current.clear();
    this.errors.clear();
  }
}
