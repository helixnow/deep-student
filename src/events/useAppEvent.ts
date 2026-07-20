import { useEffect, type DependencyList } from 'react';
import {
  addAppEventListener,
  type AppEventName,
  type AppEventPayloads,
} from './app';

/**
 * 单个 App 事件的 React 生命周期绑定。
 * deps 控制 handler 新鲜度（与 useEventRegistry 相同约定），避免 stale closure。
 */
export function useAppEvent<K extends AppEventName>(
  type: K,
  handler: (detail: AppEventPayloads[K], event: CustomEvent<AppEventPayloads[K]>) => void,
  deps: DependencyList,
  options?: boolean | AddEventListenerOptions,
): void {
  useEffect(() => {
    return addAppEventListener(type, handler, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-controlled deps gate
  }, deps);
}
