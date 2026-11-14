/**
 * `ctx.backendEvents`：Tauri 事件系统的后端一侧。
 *
 * 依据 tauri-2.11.5：
 * - `emit`：先发给全部 webview 中的 JS 监听者，再同步调用 Rust 监听者（src/manager/mod.rs:534-556）。
 *   JS 侧按 target 的扇出由 main 完成（BackendEvent 带 target 转发）。
 * - `emit_to`：`EventTarget::Any` 等同 `emit`；其余按 `filter_target` 过滤（src/manager/mod.rs:592-638）。
 * - Rust `app.listen(event, ..)` 以 `EventTarget::Any` 注册（src/event/listener.rs:334 等），而
 *   `Window::listen` 以 `EventTarget::Window { label }` 注册（src/window/mod.rs:2353）。投递时统一走
 *   `match_any_or_filter(listener.target, filter)`（listener.rs:306-311）：Any 监听者收到全部事件，
 *   窗口监听者收到广播（target Any）与目标匹配的事件；**source 是发出者，不参与接收范围判断**。
 * - 前端 `emit` 的载荷是 `Option<JsonValue>`（src/event/plugin.rs:33-50），缺省为 `null`。
 * - 事件名只允许字母数字与 `-` `/` `:` `_`（src/event/event_name.rs:8-12），否则
 *   `IllegalEventName`（src/error.rs:164-165）。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { BackendEvents, EventTarget, UiEvents, WindowRef } from './api.ts';
import { pluginNamespaces } from './plugin-id.ts';
import { illegalEventName, isEventNameValid } from './event-name.ts';
import { emitToFilter, matchAnyOrFilter } from './event-target.ts';
import { findNonJson, hasRawJson, plainWireOutput } from './json.ts';
import { assertKernelSurface, describeError, FIBER_DISPOSED, FIBER_FAILED, type KernelState } from './kernel.ts';
import type { BackendEvent } from './protocol.ts';

interface Listener {
  /** 监听器注册的 Tauri target；`listen` 为 Any，`listenWindow` 为 Window{label}。 */
  target: EventTarget;
  receive(payload: unknown, source: WindowRef): void;
}

/**
 * 后端自身 emit 时传给 Host 监听者的 `source`。Rust `Event` 不携带来源（src/event/mod.rs `Event { id, data }`），
 * 监听者不应依赖它；用空 label 标明"来自后端"。
 */
export const BACKEND_SOURCE: WindowRef = Object.freeze({ window: '', webview: '' });

const TARGET_KINDS = new Set(['Any', 'AnyLabel', 'App', 'Window', 'Webview', 'WebviewWindow']);

export { illegalEventName, isEventNameValid };

/** Narrow community-facing emitter; never exposes the unrestricted backendEvents service. */
// RUST-FIX(RF-W01-ui-events-emitter): 前缀由调用方 ctx.fiber 的插件归属决定，不是 payload 里的 caller。
export class UiEventService extends Service implements UiEvents {
  private readonly kernel: KernelState;
  private readonly events: BackendEventService;

  constructor(ctx: Context, kernel: KernelState, events: BackendEventService) {
    super(ctx, 'uiEvents');
    this.kernel = kernel;
    this.events = events;
  }

  emit(event: string, payload: unknown): void {
    const fiber = this.ctx.fiber;
    // RUST-FIX(RF-P1-managed-plugin-install): Event callbacks execute as their registering plugin owner.
    const owner = this.kernel.ownerOf(fiber);
    if (!owner) throw new TypeError('ctx.uiEvents.emit requires a plugin owner');
    // 保留的发射器（或已卸载插件的 ctx）不能再投递：fiber 卸载后为 DISPOSED，重新挂载会得到新的 ctx。
    if ((fiber.state as number) === FIBER_DISPOSED || (fiber.state as number) === FIBER_FAILED) {
      throw new TypeError(`ctx.uiEvents.emit: plugin "${owner.id}" is not active`);
    }
    const prefix = pluginNamespaces(owner.id).eventPrefix;
    if (typeof event !== 'string' || !isEventNameValid(event) || !event.startsWith(prefix) || event.length === prefix.length) {
      throw new TypeError(`ctx.uiEvents.emit requires an event in plugin "${owner.id}" namespace "${prefix}"`);
    }
    const problem = findNonJson(payload === undefined ? null : payload, '$', new Set());
    if (problem) throw new TypeError(`ctx.uiEvents.emit payload is not plain JSON: ${problem}`);
    this.events._emit({ kind: 'Any' }, event, payload);
  }
}

function assertTarget(target: EventTarget): void {
  if (typeof target !== 'object' || target === null || !TARGET_KINDS.has(target.kind)) {
    throw new TypeError(`ctx.backendEvents.emitTo: invalid target ${JSON.stringify(target)}`);
  }
  if (target.kind !== 'Any' && target.kind !== 'App' && typeof (target as { label?: unknown }).label !== 'string') {
    throw new TypeError(`ctx.backendEvents.emitTo: target ${target.kind} requires a string label`);
  }
}

export class BackendEventService extends Service implements BackendEvents {
  _kernel: KernelState;
  _listeners = new Map<string, Set<Listener>>();

  constructor(ctx: Context, kernel: KernelState) {
    super(ctx, 'backendEvents');
    this._kernel = kernel;
  }

  emit(event: string, payload: unknown): void {
    assertKernelSurface(this._kernel, this.ctx.fiber, 'ctx.backendEvents.emit');
    this._emit({ kind: 'Any' }, event, payload);
  }

  emitTo(target: EventTarget, event: string, payload: unknown): void {
    assertKernelSurface(this._kernel, this.ctx.fiber, 'ctx.backendEvents.emitTo');
    assertTarget(target);
    this._emit(target, event, payload);
  }

  listen(event: string, handler: (payload: unknown, source: WindowRef) => void): void {
    assertKernelSurface(this._kernel, this.ctx.fiber, 'ctx.backendEvents.listen');
    this._assertSubscription(event, handler, 'ctx.backendEvents.listen', 'handler');
    // Rust `app.listen` 的监听 target 是 Any：收到该事件名的全部事件，不论 target。
    this._subscribe('ctx.backendEvents.listen', event, { kind: 'Any' }, (payload, source) => handler(payload, source));
  }

  listenWindow(window: WindowRef, event: string, receive: (payload: unknown) => void): () => void {
    const method = 'ctx.backendEvents.listenWindow';
    assertKernelSurface(this._kernel, this.ctx.fiber, method);
    if (typeof window !== 'object' || window === null
      || typeof window.window !== 'string' || typeof window.webview !== 'string') {
      throw new TypeError(`${method}: window must be a WindowRef with string window/webview labels`);
    }
    this._assertSubscription(event, receive, method, 'receive');
    // Rust `Window::listen` 把订阅登记为 EventTarget::Window { label }（src/window/mod.rs:2353）。
    // 投递按事件 target 判定接收范围，source 只是发出者，不参与过滤。
    return this._subscribe(method, event, { kind: 'Window', label: window.window }, (payload) => receive(payload));
  }

  _assertSubscription(event: string, handler: unknown, method: string, name: string): void {
    if (typeof event !== 'string' || !isEventNameValid(event)) throw new TypeError(illegalEventName(String(event)));
    if (typeof handler !== 'function') throw new TypeError(`${method}("${event}"): ${name} must be a function`);
  }

  /** 注册监听者并返回幂等注销函数；effect 同时保证插件卸载时撤销。 */
  _subscribe(
    method: string,
    event: string,
    target: EventTarget,
    receive: (payload: unknown, source: WindowRef) => void,
  ): () => void {
    const fiber = this.ctx.fiber;
    const listener: Listener = { target, receive: (payload, source) => {
      const invoke = () => receive(payload, source);
      if (this._kernel.execution) this._kernel.execution.run(fiber, invoke);
      else invoke();
    } };
    const dispose = this.ctx.effect(() => {
      let set = this._listeners.get(event);
      if (!set) this._listeners.set(event, (set = new Set()));
      // 同一函数重复 listen 视为两个监听者（Rust 每次 listen 分配新 EventId）。
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0 && this._listeners.get(event) === set) this._listeners.delete(event);
      };
    }, `${method}(${JSON.stringify(event)})`);
    // Cordis 的 effect disposer 本身幂等；这里只把返回类型收窄为同步 `void`。
    return () => {
      void dispose();
    };
  }

  _emit(target: EventTarget, event: string, payload: unknown): void {
    if (typeof event !== 'string' || !isEventNameValid(event)) throw new TypeError(illegalEventName(String(event)));
    const value = payload === undefined ? null : payload;
    const raw = hasRawJson(value);
    if (this._kernel.app.debug) {
      const problem = findNonJson(value, '$', new Set(), raw);
      if (problem) throw new TypeError(`ctx.backendEvents: payload of event "${event}" is not plain JSON: ${problem}`);
    }
    // D3：线上载荷按 Rust serde_json 的 JSON 数字输出；Host 监听者仍拿到内部原值（BigInt 不丢精度）。
    const wire = plainWireOutput(value, raw);
    if (wire.projection) this._kernel.root.logger('backend-events').warn(`[dstu-host] payload of event "${event}" is not plain JSON: ${wire.projection}`);
    const message: BackendEvent = { kind: 'event', event, payload: wire.value, target: { ...target },
      ...(wire.json === undefined ? {} : { payloadJson: wire.json }) };
    this._kernel.outbound?.send(message);
    // 后端 emit 也同步触达 Host 侧监听者（Rust `Listeners::emit`），顺序在 JS 扇出之后。
    // target 为 Any 时窗口监听者也会收到（Tauri `match_any_or_filter` 对广播 filter=None 返回 true）。
    this._deliver(event, value, BACKEND_SOURCE, target);
  }

  /**
   * main 转发的前端事件；`target` 是 Tauri 的发射目标，`source` 只是发出者。
   * `native` 为 true（消息级 `FrontendEvent.native`）时监听者收到的 `source` 带 `native: true`，否则不带。
   */
  _deliverFrontend(event: string, payload: unknown, source: WindowRef, target: EventTarget, native = false): void {
    const { native: _claimed, ...from } = source;
    this._deliver(event, payload === undefined ? null : payload, native ? { ...from, native: true } : from, target);
  }

  _deliver(event: string, payload: unknown, source: WindowRef, target: EventTarget): void {
    const set = this._listeners.get(event);
    if (!set) return;
    const filter = emitToFilter(target);
    const logger = this._kernel.root.logger('backend-events');
    for (const listener of [...set]) {
      if (!matchAnyOrFilter(listener.target, filter)) continue;
      try {
        listener.receive(payload, source);
      } catch (error) {
        logger.error(`listener of event "${event}" threw:\n${describeError(error)}`);
      }
    }
  }
}
