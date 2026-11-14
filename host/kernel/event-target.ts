/**
 * Tauri 2.11.5 事件目标匹配（`src/manager/mod.rs::emit_to`、`src/event/listener.rs::match_any_or_filter`）。
 *
 * 语义：监听器注册时带一个 `EventTarget`；发射事件时按发射 target 生成过滤器，再对每个监听器
 * 调用 `match_any_or_filter(listener.target, filter)`：
 * - 监听器 target 为 `Any` 时恒匹配；
 * - 发射 target 为 `Any`（广播）时 filter 为 `null`，所有监听器都匹配；
 * - 其余按 target kind/label 精确匹配（`Window` 与 `AnyLabel` 可互相命中，`Webview` 只命中
 *   `Webview`/`AnyLabel`，`WebviewWindow` 只命中自身/`AnyLabel`，`App` 只命中 `App`）。
 *
 * 这段逻辑与 `electron/shell/events.ts` 的 JS 监听扇出保持一致；Host 不能 import Electron 代码，
 * 因此在此保留同一份纯函数，改动时两处需同时核对 Tauri 源码。
 */
import type { EventTarget } from './protocol.ts';

export type TargetFilter = (candidate: EventTarget) => boolean;

export function targetsEqual(a: EventTarget, b: EventTarget): boolean {
  if (a.kind !== b.kind) return false;
  if ('label' in a && 'label' in b) return a.label === b.label;
  return true;
}

/** `emit_to` 生成的过滤器；`Any` 广播返回 `null`。 */
export function emitToFilter(target: EventTarget): TargetFilter | null {
  switch (target.kind) {
    case 'Any':
      return null;
    case 'AnyLabel':
      return (candidate) =>
        (candidate.kind === 'Window' || candidate.kind === 'Webview'
          || candidate.kind === 'WebviewWindow' || candidate.kind === 'AnyLabel')
        && candidate.label === target.label;
    case 'Window':
      return (candidate) => (candidate.kind === 'AnyLabel' || candidate.kind === 'Window') && candidate.label === target.label;
    case 'Webview':
      return (candidate) => (candidate.kind === 'AnyLabel' || candidate.kind === 'Webview') && candidate.label === target.label;
    case 'WebviewWindow':
      return (candidate) =>
        (candidate.kind === 'AnyLabel' || candidate.kind === 'WebviewWindow') && candidate.label === target.label;
    case 'App':
      return (candidate) => targetsEqual(candidate, target);
  }
}

/** `match_any_or_filter`：监听 target 为 Any 的总能收到；广播 filter 为 null 时也总能收到。 */
export function matchAnyOrFilter(target: EventTarget, filter: TargetFilter | null): boolean {
  return target.kind === 'Any' || filter === null || filter(target);
}
