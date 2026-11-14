/**
 * Host → UI 事件（插件生态 v1，FE-C4 / W27）：`ctx.ui.host.on` 的传输适配与命名空间校验。
 *
 * 规则（见 interfaces/ui-runtime.md §2、host/kernel/API.md「插件 id 与派生命名空间」）：
 * - 只能订阅本插件 id 派生的命名空间 `id.replaceAll('.', '/') + ':'` 下的事件；
 * - 外来前缀、近似前缀、非法字符在**调用传输层之前**抛错，不会留下半截订阅；
 * - handler 的异常与 `listen` 失败计入插件错误预算，不传回传输层；
 * - 卸载时自动退订；`listen` 的 Promise 在退订后才 resolve 时立即调用底层退订函数。
 *
 * 事件名规则直接复用 Host 的实现（`host/kernel/plugin-id.ts`、`host/kernel/event-name.ts`），不另写正则。
 */
import { illegalEventName, isEventNameValid } from '../../../host/kernel/event-name.ts';
import { pluginEventName, pluginNamespaces } from '../../../host/kernel/plugin-id.ts';

/** Host → UI 的推送事件传输。生产实现见 bootstrap.ts（`@tauri-apps/api/event` 的 `listen`）。 */
export interface UiEventTransport {
  /** 订阅一个 Host 事件；resolve 为退订函数。 */
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}

/**
 * `ctx.ui.host.on` 的完整事件名：接受完整名（`example/word-of-day:changed`）或本地名（`changed`），
 * 两者都必须在调用方插件自己的命名空间内；其他形状同步抛 `TypeError`。
 */
export function pluginHostEventName(pluginId: string, event: string): string {
  if (typeof event !== 'string' || event.length === 0) throw new TypeError('ctx.ui.host.on: event name must be a non-empty string');
  const prefix = pluginNamespaces(pluginId).eventPrefix;
  if (event.startsWith(prefix)) {
    const local = event.slice(prefix.length);
    if (!local || !isEventNameValid(local)) throw new TypeError(illegalEventName(event));
    return event;
  }
  // RUST-FIX(RF-W17-host-event-own-prefix): Rust 没有按插件命名空间限定的事件订阅；这里是唯一放行外来事件名的位置
  if (event.includes(':') || event.includes('/')) {
    throw new TypeError(`ctx.ui.host.on: "${event}" is outside this plugin's event namespace ("${prefix}…")`);
  }
  if (!isEventNameValid(event)) throw new TypeError(illegalEventName(event));
  return pluginEventName(pluginId, event);
}

export interface HostEventSubscriptionOptions {
  pluginId: string;
  /** 所属插件仍在使用（卸载后丢弃迟到的事件与迟到的 `listen` 结果）。 */
  isActive(): boolean;
  /** 错误上报（插件错误预算）；handler 与传输失败都走这里。 */
  report(error: unknown): void;
}

/**
 * 订阅本插件命名空间下的一个事件，返回**同步生效**的退订函数。事件名不合法或没有传输实现时抛错，
 * 此时不会调用 `transport.listen`。
 */
export function subscribeHostEvent(
  transport: UiEventTransport | undefined,
  options: HostEventSubscriptionOptions,
  event: string,
  handler: (payload: unknown) => void,
): () => void {
  if (typeof handler !== 'function') throw new TypeError('ctx.ui.host.on: handler must be a function');
  const name = pluginHostEventName(options.pluginId, event);
  if (!transport) throw new Error('ctx.ui.host.on: event transport is not available in this window');
  let stopped = false;
  let unlisten: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    const off = unlisten;
    unlisten = undefined;
    off?.();
  };
  void transport.listen(name, (payload) => {
    if (stopped || !options.isActive()) return;
    try {
      handler(payload);
    } catch (error) {
      options.report(error);
    }
  }).then((off) => {
    if (stopped || !options.isActive()) {
      // The plugin unloaded before the transport acknowledged the subscription.
      try {
        off();
      } catch (error) {
        options.report(error);
      }
      return;
    }
    unlisten = off;
  }).catch((error) => {
    if (!stopped) options.report(error);
  });
  return stop;
}
