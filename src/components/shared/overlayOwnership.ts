/**
 * 面板拥有的浮层（owned overlay）归属关系 —— 纯函数层。
 *
 * 背景：面板（如 InputBarUI 的 composer 面板）打开的部分浮层（AppMenu 内容、
 * 模型搜索框等）通过 portal 挂在 body 上，DOM 上不在面板容器内。外点关闭 /
 * back 处理只用 `containerRef.contains(target)` 会把"点在自己拥有的浮层里"
 * 误判为外点。短期修法是各处硬编码 `target.closest('[data-app-menu-id]')`，
 * 但这把"谁拥有哪个浮层"的知识散落在每个消费方。
 *
 * 本模块提供与 React 无关的登记表数据结构与查询纯函数：
 * owner（面板）登记自己拥有的浮层（element 引用或 selector），事件处理方查询
 * 「该事件是否落在此 owner 拥有的浮层内」。React 接线在 OverlayCoordinator.tsx。
 */

/** 一条浮层归属描述：element 引用（portal 根节点）或 CSS selector，至少给一个。 */
export interface OwnedOverlaySpec {
  /**
   * 浮层根元素引用。匹配规则：element === target 或 element.contains(target)。
   * 适合能拿到 portal 根 ref 的场景（最精确，portal 位置无关）。
   */
  element?: Element | null;
  /**
   * CSS selector。匹配规则：target.closest(selector) 非空。
   * 适合浮层由第三方/子组件渲染、只能靠 data 属性识别的场景
   * （如 `[data-app-menu-id="…"]`）。
   */
  selector?: string;
}

/** 带 owner 的登记入参。ownerId 是面板自定的稳定字符串（如 'input-bar-composer'）。 */
export interface OwnedOverlayRegistration extends OwnedOverlaySpec {
  ownerId: string;
}

/**
 * 登记表。一个 owner 可以同时拥有多条浮层（Set），同一 spec 对象重复登记幂等。
 * 用 Map/Set 而非数组是为了让 unregister O(1) 且天然幂等。
 */
export type OwnedOverlayStore = Map<string, Set<OwnedOverlaySpec>>;

export function createOwnedOverlayStore(): OwnedOverlayStore {
  return new Map();
}

/**
 * 登记一条归属关系，返回幂等的注销函数（可安全多次调用，配合 effect cleanup）。
 * spec 没有 element 也没有 selector 时视为无效登记，返回 noop（不污染表）。
 */
export function registerOwnedOverlayEntry(
  store: OwnedOverlayStore,
  registration: OwnedOverlayRegistration,
): () => void {
  const { ownerId, element, selector } = registration;
  if (!element && !selector) return () => {};

  const spec: OwnedOverlaySpec = { element, selector };
  let specs = store.get(ownerId);
  if (!specs) {
    specs = new Set();
    store.set(ownerId, specs);
  }
  specs.add(spec);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = store.get(ownerId);
    if (!current) return;
    current.delete(spec);
    if (current.size === 0) store.delete(ownerId);
  };
}

/**
 * 把 EventTarget 归一化为 Element：
 * 文本节点取 parentElement（pointerdown 的 target 常是 Text），
 * Document / Window / null 返回 null。
 */
export function resolveEventTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function specMatchesElement(spec: OwnedOverlaySpec, element: Element): boolean {
  if (spec.element && (spec.element === element || spec.element.contains(element))) {
    return true;
  }
  if (spec.selector && element.closest(spec.selector)) {
    return true;
  }
  return false;
}

/**
 * 查询：事件 target 是否落在 ownerId 登记的任一浮层内。
 * owner 未登记任何浮层、或 target 无法归一化为 Element 时返回 false
 * （空表语义：没登记就没有归属，调用方回落到自己原有的 contains/closest 判断）。
 */
export function isEventInsideOwnedOverlay(
  store: OwnedOverlayStore,
  ownerId: string,
  target: EventTarget | null,
): boolean {
  const specs = store.get(ownerId);
  if (!specs || specs.size === 0) return false;
  const element = resolveEventTargetElement(target);
  if (!element) return false;
  for (const spec of specs) {
    if (specMatchesElement(spec, element)) return true;
  }
  return false;
}

/** 当前有登记浮层的 ownerId 列表（去重，按登记先后）。调试 / back 分发用。 */
export function listOwnedOverlayOwnerIds(store: OwnedOverlayStore): string[] {
  return Array.from(store.keys());
}
