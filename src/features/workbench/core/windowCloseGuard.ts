import { appRegistry } from './appRegistry';
import { useWindowStore } from './windowStore';

const closeConfirmations = new Map<string, Promise<boolean>>();

/** 同一窗口的 canClose single-flight；调用方在 await 后必须重新读取窗口状态。 */
export function confirmWindowClose(windowId: string): Promise<boolean> {
  const current = closeConfirmations.get(windowId);
  if (current) return current;
  const win = useWindowStore.getState().windows[windowId];
  if (!win) return Promise.resolve(true);
  const canClose = appRegistry.get(win.typeId)?.canClose;
  if (!canClose) return Promise.resolve(true);

  const confirmation = Promise.resolve().then(() => canClose(win.instanceKey)).then(Boolean).finally(() => {
    if (closeConfirmations.get(windowId) === confirmation) closeConfirmations.delete(windowId);
  });
  closeConfirmations.set(windowId, confirmation);
  return confirmation;
}
