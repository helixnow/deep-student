/**
 * 插件作用域：一次 `apply` 的生命周期。插件私有服务（storage 订阅、插件 store、语言包、导航提供者……）的
 * 状态都登记在这里；fiber 失效（卸载、同 id 覆盖、apply 失败、inject 的服务离线）时整体撤销。
 *
 * 注意：作用域对象经 Cordis 追踪代理访问 UiService 时会被取到，不要使用 `#private` 字段。
 */
import type { NormalizedUiPluginMeta } from './meta';
import type { UiPluginOrigin } from './slots';

export class UiPluginDisposedError extends Error {
  constructor(readonly pluginId: string, service: string) {
    super(`ctx.ui.${service}: plugin "${pluginId}" has been unloaded`);
    this.name = 'UiPluginDisposedError';
  }
}

export class UiPluginScope {
  private _active = true;
  private readonly _disposers = new Set<() => void>();

  constructor(readonly meta: NormalizedUiPluginMeta, readonly origin: UiPluginOrigin) {}

  get id(): string {
    return this.meta.id;
  }

  get namespace(): string {
    return this.meta.namespace;
  }

  get active(): boolean {
    return this._active;
  }

  /** 登记随作用域撤销的清理函数；返回提前撤销（只执行一次）。作用域已撤销时立即清理。 */
  track(dispose: () => void): () => void {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      this._disposers.delete(once);
      dispose();
    };
    if (!this._active) {
      once();
      return once;
    }
    this._disposers.add(once);
    return once;
  }

  assertActive(service: string): void {
    if (!this._active) throw new UiPluginDisposedError(this.id, service);
  }

  /** 逆序执行清理；单个清理失败只记录，不影响其余清理与卸载流程。 */
  dispose(): void {
    if (!this._active) return;
    this._active = false;
    for (const dispose of [...this._disposers].reverse()) {
      try {
        dispose();
      } catch (error) {
        console.error(`[ui-kernel] cleanup of "${this.id}" failed`, error);
      }
    }
    this._disposers.clear();
  }
}
