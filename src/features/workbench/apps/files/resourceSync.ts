/**
 * 资源删除联动（P8）
 *
 * 订阅现有 DSTU 前端事件总线（dstu.watch('*')，与 LearningHubPage 关闭
 * 失效标签页使用同一事件源）：资源被删除（deleted）或永久清除（purged）时，
 * 遍历窗口 store，关闭所有 instanceKey 指向该资源的资源应用窗口。
 *
 * 直接调用 store.closeWindow（不走 canClose 拦截）：资源已不存在，
 * 未保存拦截没有意义，反而会把窗口锁死。
 */
import { dstu } from '@/dstu';
import { useWindowStore } from '../../core/windowStore';
import { RESOURCE_APP_TYPE_IDS } from '../content/typeMap';

/** 从 DSTU 事件路径提取资源 ID（路径末段，如 '/folder/note_1' → 'note_1'） */
export function extractResourceIdFromPath(path: string | undefined): string | null {
  if (!path) return null;
  return path.split('/').filter(Boolean).pop() ?? null;
}

/** 关闭指向该资源的全部资源应用窗口，返回关闭数量 */
export function closeWindowsForDeletedResource(resourceId: string): number {
  const { windows } = useWindowStore.getState();
  let closed = 0;
  for (const win of Object.values(windows)) {
    if (win.instanceKey === resourceId && RESOURCE_APP_TYPE_IDS.has(win.typeId)) {
      useWindowStore.getState().closeWindow(win.id);
      closed += 1;
    }
  }
  return closed;
}

let stopWatcher: (() => void) | null = null;

/**
 * 启动删除联动订阅（幂等：重复调用复用同一订阅）。
 * 返回停止函数。files register 在模块装配时调用；测试可 stop 后重启。
 */
export function startResourceSync(): () => void {
  if (stopWatcher) return stopWatcher;

  const unwatch = dstu.watch('*', (event) => {
    if (event.type !== 'deleted' && event.type !== 'purged') return;
    const resourceId = extractResourceIdFromPath(event.path || event.oldPath);
    if (!resourceId) return;
    closeWindowsForDeletedResource(resourceId);
  });

  stopWatcher = () => {
    unwatch();
    stopWatcher = null;
  };
  return stopWatcher;
}

/** 停止订阅（幂等） */
export function stopResourceSync(): void {
  stopWatcher?.();
}
