/**
 * W38 — 桌面工作台宿主桥的运行时实现。
 *
 * 只在桌面构建里被 `./load` 动态引入；本文件是唯一汇总 App 壳层需要的
 * `src/features/workbench/**` 运行时代码的模块。移动端构建在 Rollup 阶段
 * 丢掉指向本模块的 dynamic import，因此不会包含这些模块。
 */
import { useWindowStore } from '@/features/workbench/core/windowStore';
import {
  openAppsPanel,
  toggleAppsPanel,
} from '@/features/workbench/components/appsPanelStore';
import {
  PDF_PAGE_ACTIVATION_TYPE_IDS,
  workbenchBus,
} from '@/features/workbench/core/workbenchBus';
import { consumeHandoffDescriptor } from '@/features/workbench/core/handoffDescriptor';
import { installLegacyNavigationFallback } from '@/features/workbench/core/legacyNavigationMap';
import {
  hasDirtyWorkbenchWindows,
  runWorkbenchDeactivationTransaction,
} from '@/features/workbench/core/deactivationTransaction';
import { flushSnapshot } from '@/features/workbench/core/snapshot';
import { getWorkspaceActiveResource } from '@/features/workbench/apps/notes/workspaceRegistry';
import {
  notifyWorkbenchHostChanged,
  setWorkbenchHostBridge,
  type WorkbenchHostBridge,
} from '@/shared/workbenchHost';

let unsubscribeWindowStore: (() => void) | null = null;

/** 注册宿主桥；重复调用幂等。 */
export function installWorkbenchHost(): void {
  if (unsubscribeWindowStore) return;
  const implementation: WorkbenchHostBridge = {
    isEnabled: () => workbenchBus.isEnabled(),
    focusedAppTypeId: () => {
      const state = useWindowStore.getState();
      const focusedWindowId = state.focusStack[state.focusStack.length - 1];
      return focusedWindowId ? state.windows[focusedWindowId]?.typeId ?? null : null;
    },
    workspaceActiveResourceType: () => getWorkspaceActiveResource()?.type ?? null,
    openAppsPanel,
    toggleAppsPanel,
    activate: (request) => workbenchBus.activate(request),
    launch: (request) => {
      workbenchBus.launch(request);
    },
    isPdfPageActivationType: (typeId) =>
      (PDF_PAGE_ACTIVATION_TYPE_IDS as readonly string[]).includes(typeId),
    openPdfPage: (request) => workbenchBus.openPdfPage(request),
    consumeHandoff: () => {
      const descriptor = consumeHandoffDescriptor();
      if (!descriptor) return null;
      return {
        appType: descriptor.appType,
        resourceId: descriptor.resourceId ?? null,
        innerRoute: descriptor.innerRoute,
        version: descriptor.version,
        savedAt: descriptor.savedAt,
      };
    },
    installLegacyNavigationFallback,
    hasDirtyWindows: hasDirtyWorkbenchWindows,
    runDeactivationTransaction: (reason) => runWorkbenchDeactivationTransaction(reason),
    flushSnapshot,
  };
  setWorkbenchHostBridge(implementation);
  unsubscribeWindowStore = useWindowStore.subscribe(() => notifyWorkbenchHostChanged());
}

/** 仅测试与 HMR 使用：撤销注册，回到安全缺省值。 */
export function uninstallWorkbenchHost(): void {
  unsubscribeWindowStore?.();
  unsubscribeWindowStore = null;
  setWorkbenchHostBridge(null);
}
