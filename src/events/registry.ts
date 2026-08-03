/**
 * 通用 typed CustomEvent 辅助：统一 add / remove / dispatch。
 *
 * 业务事件 map 放在各域模块（如 app.ts / chat.ts）；本文件只提供无域耦合的原语。
 * 原生 DOM 事件（error / keydown 等）请继续走 useEventRegistry。
 */

export type EventTargetKind = 'window' | 'document';

const resolveTarget = (target: EventTargetKind = 'window'): EventTarget | null => {
  if (target === 'document') {
    return typeof document !== 'undefined' ? document : null;
  }
  return typeof window !== 'undefined' ? window : null;
};

/**
 * 派发 CustomEvent。detail 省略时不带 payload（用于 void 事件）。
 */
export function dispatchTypedEvent(
  type: string,
  detail?: unknown,
  target: EventTargetKind = 'window',
): void {
  const resolved = resolveTarget(target);
  if (!resolved) return;

  if (arguments.length < 2 || detail === undefined) {
    resolved.dispatchEvent(new CustomEvent(type));
    return;
  }
  resolved.dispatchEvent(new CustomEvent(type, { detail }));
}

/**
 * 类型安全监听；返回 dispose，供 useEffect cleanup 或非 React owner 使用。
 */
export function addTypedEventListener<D>(
  type: string,
  handler: (detail: D, event: CustomEvent<D>) => void,
  options?: boolean | AddEventListenerOptions,
  target: EventTargetKind = 'window',
): () => void {
  const resolved = resolveTarget(target);
  if (!resolved) {
    return () => {};
  }

  const listener: EventListener = (event) => {
    const custom = event as CustomEvent<D>;
    handler(custom.detail as D, custom);
  };

  resolved.addEventListener(type, listener, options);
  return () => {
    resolved.removeEventListener(type, listener, options);
  };
}

/** 将 typed handler 转成 EventListener，供 useEventRegistry 条目使用。 */
export function toTypedEventListener<D>(
  handler: (detail: D, event: CustomEvent<D>) => void,
): EventListener {
  return (event: Event) => {
    const custom = event as CustomEvent<D>;
    handler(custom.detail as D, custom);
  };
}
