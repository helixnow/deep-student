/**
 * 导图视图控制器注册表（W10 · B-5）
 *
 * MindMapContentView 在挂载时把带「blur 编辑框 + 落 viewport + 恢复大纲 caret」
 * 语义的 switchView 注册到这里；Workbench activation（register.ts 的 setView）
 * 通过 storeApi 反查控制器，从而与 UI 路径共用同一条视图切换链路，
 * 不再直接调 store.setCurrentView 丢失未提交编辑。
 *
 * 以 store 实例为键（WeakMap）：同资源多宿主时每个宿主有独立 store，
 * activation 已按 windowId/storeInstanceId 精确路由到目标 store，
 * 因此控制器查找天然继承同一路由结果，无需再引入实例 id。
 */

import type { MindMapStoreApi } from './store';
import type { MindMapViewType } from './types';

export interface MindMapViewController {
  /** 与 UI 工具栏相同语义的视图切换（blur + viewport + caret resume） */
  switchView: (view: MindMapViewType) => void;
}

const controllers = new WeakMap<MindMapStoreApi, MindMapViewController>();

/** 注册当前 store 实例的视图控制器；返回清理函数（仅清理自己注册的那份）。 */
export function registerMindMapViewController(
  store: MindMapStoreApi,
  controller: MindMapViewController,
): () => void {
  controllers.set(store, controller);
  return () => {
    if (controllers.get(store) === controller) {
      controllers.delete(store);
    }
  };
}

/** 查找 store 实例对应的视图控制器；组件未挂载（纯 headless store）时返回 null。 */
export function getMindMapViewController(
  store: MindMapStoreApi,
): MindMapViewController | null {
  return controllers.get(store) ?? null;
}
