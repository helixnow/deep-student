/**
 * 导航服务（FRONTEND-PLUGINIZATION §2.5）：`ctx.ui.navigate(viewId, params)`。
 *
 * 内核只定义接口与校验：目标必须是 `views` 槽位里已登记的视图。真正的跳转由导航实现完成，优先级：
 * 框架插件经 `ctx.ui.navigation.provide(navigator)` 提供的实现（随其卸载撤销）> 窗口装配时传入的
 * `UiAdapters.navigate`（生产中派发既有的 `NAVIGATE_TO_VIEW` 事件，见 bootstrap.ts）。
 */

export interface UiNavigationRequest {
  view: string;
  params?: Readonly<Record<string, unknown>>;
  /** 发起导航的插件 id（根 context 为 `ui-kernel`）。 */
  source: string;
}

export type UiNavigator = (request: UiNavigationRequest) => void;

export class UiNavigationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiNavigationError';
  }
}

export class UiNavigationService {
  private _provided: { owner: string; navigator: UiNavigator } | undefined;

  constructor(
    private readonly _hasView: (view: string) => boolean,
    private readonly _fallback?: UiNavigator,
  ) {}

  /** 由某个插件提供导航实现；同一时间只允许一个提供者。返回撤销函数。 */
  provide(owner: string, navigator: UiNavigator): () => void {
    if (typeof navigator !== 'function') throw new TypeError('ctx.ui.navigation.provide: navigator must be a function');
    if (this._provided) throw new UiNavigationError(`ctx.ui.navigation.provide: a navigator is already provided by "${this._provided.owner}"`);
    const provided = { owner, navigator };
    this._provided = provided;
    return () => {
      if (this._provided === provided) this._provided = undefined;
    };
  }

  canNavigate(view: string): boolean {
    return !!this._navigator() && this._hasView(view);
  }

  navigate(source: string, view: string, params?: Readonly<Record<string, unknown>>): void {
    if (typeof view !== 'string' || !this._hasView(view)) throw new UiNavigationError(`ctx.ui.navigate: unknown view ${JSON.stringify(view)}`);
    const navigator = this._navigator();
    if (!navigator) throw new UiNavigationError('ctx.ui.navigate: no navigator is available in this window');
    navigator({ view, params, source });
  }

  private _navigator(): UiNavigator | undefined {
    return this._provided?.navigator ?? this._fallback;
  }
}
