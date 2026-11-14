/**
 * Tauri 事件系统（tauri-2.11.5 `src/event/{mod,listener,plugin}.rs`、`src/manager/mod.rs` `emit_to`）
 * 中 JS 监听者部分的移植。main 是唯一权威：记录每个 webview 的 JS 监听（事件名 → id → target），
 * 发射时按 target 过滤后把 id 列表推给对应 webview，由页面内的 `runCallback` 执行。
 */
import type { EventTarget, FrontendEvent, WindowRef } from '../../host/kernel/protocol.ts';

/**
 * main 自己产生、以 frontend-event 交给 Host 的原生事件（browser-content 的页面回调、全局快捷键等，相当于 Rust 代码直接
 * `app.emit`）。消息级 `native: true` 只由 {@link nativeFrontendEvent} 设置；Host 把它作为监听者收到的 `source.native`
 * 交给插件，并丢弃 `source` 里自带的同名字段（SEC-E05）。`FrontendEvent` 还没有该字段的 Host 会忽略它。
 */
export interface NativeFrontendEvent extends FrontendEvent {
  native: true;
}

/** 页面经 `plugin:event|emit` / `emit_to` 转给 Host 的事件：类型上不能带 `native`。 */
export type PageFrontendEvent = FrontendEvent & { native?: never };

export function nativeFrontendEvent(source: WindowRef, event: string, payload: unknown, target: EventTarget = { kind: 'App' }): NativeFrontendEvent {
  return { kind: 'frontend-event', event, payload, target, source: { window: source.window, webview: source.webview }, native: true };
}

/** 每个字段都由 main 重新取值，页面参数里多出来的键（包括 `native`）到不了 Host。 */
export function pageFrontendEvent(source: WindowRef, event: string, payload: unknown, target: EventTarget): PageFrontendEvent {
  return { kind: 'frontend-event', event, payload, target, source: { window: source.window, webview: source.webview } };
}

/** `is_event_name_valid`：Rust `char::is_alphanumeric` 或 `-` `/` `:` `_`。 */
export function isEventNameValid(name: string): boolean {
  return /^[\p{Alphabetic}\p{N}\-/:_]*$/u.test(name);
}

/** 命令参数反序列化失败时 serde 的自定义错误文本（`EventName::deserialize`）。 */
export const EVENT_NAME_DESERIALIZE_ERROR =
  'Event name must include only alphanumeric characters, `-`, `/`, `:` and `_`.';

export type TargetFilter = (candidate: EventTarget) => boolean;

export function targetsEqual(a: EventTarget, b: EventTarget): boolean {
  if (a.kind !== b.kind) return false;
  if ('label' in a && 'label' in b) return a.label === b.label;
  return true;
}

/** `emit_to` 中的 `filter_target`。 */
export function emitToFilter(target: EventTarget): TargetFilter | null {
  switch (target.kind) {
    case 'Any':
      return null;
    case 'AnyLabel':
      return (c) =>
        (c.kind === 'Window' || c.kind === 'Webview' || c.kind === 'WebviewWindow' || c.kind === 'AnyLabel') &&
        c.label === target.label;
    case 'Window':
      return (c) => (c.kind === 'AnyLabel' || c.kind === 'Window') && c.label === target.label;
    case 'Webview':
      return (c) => (c.kind === 'AnyLabel' || c.kind === 'Webview') && c.label === target.label;
    case 'WebviewWindow':
      return (c) => (c.kind === 'AnyLabel' || c.kind === 'WebviewWindow') && c.label === target.label;
    case 'App':
      return (c) => targetsEqual(c, target);
  }
}

/** `Window::emit_to_window` 的过滤器。 */
export function windowEventFilter(windowLabel: string): TargetFilter {
  return (c) => (c.kind === 'Window' || c.kind === 'WebviewWindow') && c.label === windowLabel;
}

/** `Webview::emit_to_webview` 的过滤器。 */
export function webviewEventFilter(webviewLabel: string): TargetFilter {
  return (c) => (c.kind === 'Webview' || c.kind === 'WebviewWindow') && c.label === webviewLabel;
}

/** `match_any_or_filter`：监听 target 为 Any 的总能收到。 */
export function matchAnyOrFilter(target: EventTarget, filter: TargetFilter | null): boolean {
  return target.kind === 'Any' || filter === null || filter(target);
}

export function parseEventTarget(value: unknown): EventTarget | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as { kind?: unknown; label?: unknown };
  switch (v.kind) {
    case 'Any':
    case 'App':
      return { kind: v.kind };
    case 'AnyLabel':
    case 'Window':
    case 'Webview':
    case 'WebviewWindow':
      return typeof v.label === 'string' ? { kind: v.kind, label: v.label } : null;
    default:
      return null;
  }
}

export class JsListenerRegistry {
  /** Tauri `next_event_id` 从 0 开始自增（AtomicU32 默认值）。 */
  private nextId = 0;
  /** webview label → event → (id → target)。 */
  private readonly byWebview = new Map<string, Map<string, Map<number, EventTarget>>>();

  listen(webview: string, event: string, target: EventTarget): number {
    const id = this.nextId;
    this.nextId = (this.nextId + 1) >>> 0;
    let events = this.byWebview.get(webview);
    if (!events) {
      events = new Map();
      this.byWebview.set(webview, events);
    }
    let handlers = events.get(event);
    if (!handlers) {
      handlers = new Map();
      events.set(event, handlers);
    }
    handlers.set(id, target);
    return id;
  }

  /** `unlisten_js`：在所有 webview 中删除该 id。 */
  unlisten(event: string, id: number): void {
    for (const events of this.byWebview.values()) {
      const handlers = events.get(event);
      if (!handlers) continue;
      handlers.delete(id);
      if (handlers.size === 0) events.delete(event);
    }
  }

  removeWebview(webview: string): void {
    this.byWebview.delete(webview);
  }

  /** `has_js_listener`：任一 webview 中存在 target 满足过滤器的监听（不含 Any 的特殊放行）。 */
  hasListener(event: string, filter: TargetFilter): boolean {
    for (const events of this.byWebview.values()) {
      const handlers = events.get(event);
      if (!handlers) continue;
      for (const target of handlers.values()) if (filter(target)) return true;
    }
    return false;
  }

  /** `emit_js_filter`：对每个有该事件监听的 webview 返回匹配的 id 列表（可能为空，与 Tauri 一致仍会调用）。 */
  collect(event: string, filter: TargetFilter | null, webviews?: Iterable<string>): Map<string, number[]> {
    const out = new Map<string, number[]>();
    const labels = webviews ? [...webviews] : [...this.byWebview.keys()];
    for (const label of labels) {
      const handlers = this.byWebview.get(label)?.get(event);
      if (!handlers) continue;
      const ids: number[] = [];
      for (const [id, target] of handlers) if (matchAnyOrFilter(target, filter)) ids.push(id);
      out.set(label, ids);
    }
    return out;
  }
}
