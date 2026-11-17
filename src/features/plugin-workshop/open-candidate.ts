import { getWorkbenchHostBridge, subscribeWorkbenchHost } from '@/shared/workbenchHost';
import type { SlotStore } from '@/ui-kernel/slots';

/** Open exactly the candidate release once its view, desktop host and app registration are ready. */
export function openWorkshopCandidateView(
  slots: Pick<SlotStore, 'list' | 'subscribe'>,
  pluginId: string,
  version: string,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let launching = false;
    const stops: Array<() => void> = [];
    const finish = (windowId?: string, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const stop of stops) stop();
      if (windowId) resolve(windowId);
      else reject(error);
    };
    const abort = () => finish(undefined, new DOMException('Candidate opening cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(undefined, new Error(`WORKSHOP_OPEN_TIMEOUT: ${pluginId}@${version} has no ready desktop view`)), options.timeoutMs);
    const attempt = () => {
      if (settled || launching) return;
      const view = slots.list('views').find(entry => entry.owner === pluginId && entry.version === version && entry.key);
      const bridge = getWorkbenchHostBridge();
      if (!view?.key || !bridge?.isEnabled()) return;
      const typeId = `plugin-view.${view.key}`;
      if (!bridge.hasApp(typeId)) return;
      // launch synchronously notifies window subscribers; do not re-enter it from that notification.
      launching = true;
      try {
        const windowId = bridge.launch({ typeId, reason: 'api' });
        if (windowId) finish(windowId);
      } catch (error) { finish(undefined, error); }
      finally { launching = false; }
    };
    stops.push(slots.subscribe('views', attempt), subscribeWorkbenchHost(attempt));
    if (options.signal) {
      options.signal.addEventListener('abort', abort, { once: true });
      stops.push(() => options.signal?.removeEventListener('abort', abort));
      if (options.signal.aborted) { abort(); return; }
    }
    attempt();
  });
}
