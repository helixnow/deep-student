/**
 * 资源删除联动（P8）
 *
 * 订阅现有 DSTU 前端事件总线（dstu.watch('*')，与 LearningHubPage 关闭
 * 失效标签页使用同一事件源）：资源被删除（deleted）或永久清除（purged）时，
 * 遍历窗口 store，关闭所有 instanceKey 指向该资源的资源应用窗口。
 *
 * 删除事件可能晚于编辑器的自动保存防抖，因此仍须执行 canClose：用户取消时
 * 保留内存草稿供复制。批量/文件夹删除事件不携带后代 ID，另做存活性复核。
 */
import { dstu } from '@/dstu';
import { VfsErrorCode } from '@/shared/result';
import { appRegistry } from '../../core/appRegistry';
import { useWindowStore } from '../../core/windowStore';
import { RESOURCE_APP_TYPE_IDS } from '../content/typeMap';
import { normalizeResourceInstanceKey } from '../content/resourceIdentity';

const RESOURCE_RECONCILE_INTERVAL_MS = 5_000;
const retainedDeletedWindowIds = new Set<string>();

/** 从 DSTU 事件路径提取资源 ID（路径末段，如 '/folder/note_1' → 'note_1'） */
export function extractResourceIdFromPath(path: string | undefined): string | null {
  return normalizeResourceInstanceKey(path);
}

function closeWindowWithGuard(windowId: string): boolean {
  const store = useWindowStore.getState();
  const win = store.windows[windowId];
  if (!win) return false;
  if (retainedDeletedWindowIds.has(windowId)) return false;
  const canClose = appRegistry.get(win.typeId)?.canClose;
  if (!canClose) {
    retainedDeletedWindowIds.delete(windowId);
    store.closeWindow(windowId);
    return true;
  }

  try {
    const decision = canClose(win.instanceKey);
    if (decision && typeof (decision as Promise<boolean>).then === 'function') {
      void Promise.resolve(decision)
        .then((allowed) => {
          if (allowed) {
            retainedDeletedWindowIds.delete(windowId);
            useWindowStore.getState().closeWindow(windowId);
          } else {
            retainedDeletedWindowIds.add(windowId);
          }
        })
        .catch((error) => {
          retainedDeletedWindowIds.add(windowId);
          console.warn('[workbench:files] canClose failed during resource deletion:', error);
        });
      return false;
    }
    if (decision === false) {
      retainedDeletedWindowIds.add(windowId);
      return false;
    }
    retainedDeletedWindowIds.delete(windowId);
    store.closeWindow(windowId);
    return true;
  } catch (error) {
    retainedDeletedWindowIds.add(windowId);
    console.warn('[workbench:files] canClose failed during resource deletion:', error);
    return false;
  }
}

/** 关闭指向该资源的全部资源应用窗口，返回同步关闭数量 */
export function closeWindowsForDeletedResource(resourceId: string): number {
  const { windows } = useWindowStore.getState();
  const normalizedResourceId = normalizeResourceInstanceKey(resourceId);
  if (!normalizedResourceId) return 0;
  let closed = 0;
  for (const win of Object.values(windows)) {
    if (
      normalizeResourceInstanceKey(win.instanceKey) === normalizedResourceId &&
      RESOURCE_APP_TYPE_IDS.has(win.typeId)
    ) {
      if (closeWindowWithGuard(win.id)) closed += 1;
    }
  }
  return closed;
}

let reconcilePromise: Promise<number> | null = null;

/** Recheck every open resource against DSTU; missing resources are guarded-close candidates. */
export function reconcileDeletedResourceWindows(): Promise<number> {
  if (reconcilePromise) return reconcilePromise;
  reconcilePromise = (async () => {
    const windows = Object.values(useWindowStore.getState().windows).filter(
      (win) => RESOURCE_APP_TYPE_IDS.has(win.typeId) && !retainedDeletedWindowIds.has(win.id),
    );
    const liveWindowIds = new Set(Object.keys(useWindowStore.getState().windows));
    for (const windowId of retainedDeletedWindowIds) {
      if (!liveWindowIds.has(windowId)) retainedDeletedWindowIds.delete(windowId);
    }
    const resourceIds = [...new Set(
      windows
        .map((win) => normalizeResourceInstanceKey(win.instanceKey))
        .filter((id): id is string => Boolean(id)),
    )];
    const missing = await Promise.all(resourceIds.map(async (resourceId) => {
      const result = await dstu.get(`/${resourceId}`);
      if (result.ok && result.value) return null;
      return !result.ok && result.error.code === VfsErrorCode.NOT_FOUND
        ? resourceId
        : null;
    }));
    let closed = 0;
    for (const resourceId of missing) {
      if (resourceId) closed += closeWindowsForDeletedResource(resourceId);
    }
    return closed;
  })().finally(() => {
    reconcilePromise = null;
  });
  return reconcilePromise;
}

let stopWatcher: (() => void) | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动删除联动订阅（幂等：重复调用复用同一订阅）。
 * 返回停止函数。files register 在模块装配时调用；测试可 stop 后重启。
 */
export function startResourceSync(): () => void {
  if (stopWatcher) return stopWatcher;

  const unwatch = dstu.watch('*', (event) => {
    if (event.type === 'restored') {
      const restoredId = extractResourceIdFromPath(event.path || event.oldPath);
      if (restoredId) {
        for (const win of Object.values(useWindowStore.getState().windows)) {
          if (normalizeResourceInstanceKey(win.instanceKey) === restoredId) {
            retainedDeletedWindowIds.delete(win.id);
          }
        }
      }
      return;
    }
    if (event.type !== 'deleted' && event.type !== 'purged') return;
    const resourceId = extractResourceIdFromPath(event.path || event.oldPath);
    if (resourceId && resourceId !== '_trash') {
      const hasDirectTarget = Object.values(useWindowStore.getState().windows).some(
        (win) =>
          RESOURCE_APP_TYPE_IDS.has(win.typeId) &&
          normalizeResourceInstanceKey(win.instanceKey) === resourceId,
      );
      closeWindowsForDeletedResource(resourceId);
      if (hasDirectTarget) return;
    }
    // Folder and bulk events only identify the container. Reconciliation also
    // covers folderApi.deleteFolder, whose backend currently emits no watch event.
    void reconcileDeletedResourceWindows();
  });

  reconcileTimer = setInterval(() => {
    if (Object.values(useWindowStore.getState().windows).some(
      (win) => RESOURCE_APP_TYPE_IDS.has(win.typeId),
    )) {
      void reconcileDeletedResourceWindows();
    }
  }, RESOURCE_RECONCILE_INTERVAL_MS);

  stopWatcher = () => {
    unwatch();
    if (reconcileTimer) {
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
    stopWatcher = null;
    retainedDeletedWindowIds.clear();
  };
  return stopWatcher;
}

/** 停止订阅（幂等） */
export function stopResourceSync(): void {
  stopWatcher?.();
}
