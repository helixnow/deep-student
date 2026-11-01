import { useEffect } from 'react';
import { useLearningHubNavigationSafe } from '../LearningHubNavigationContext';
import {
  setActiveFinderHostId,
  getActiveFinderHostId,
  resolveFinderHostId,
  DEFAULT_FINDER_HOST_ID,
  type FinderPath,
} from '../stores/finderStore';
import type { LearningHubSidebarProps } from '../types';

/** canvas 本地列表刷新触发 + 导航上下文同步 + 「活跃访达」注册 */
export function useFinderHostLifecycle({
  mode,
  sessionActive,
  hostId,
  currentPath,
  canvasSearchQuery,
  refreshCanvas,
}: {
  mode: LearningHubSidebarProps['mode'];
  sessionActive: boolean | undefined;
  hostId: string | undefined;
  currentPath: FinderPath;
  canvasSearchQuery: string;
  refreshCanvas: () => Promise<void>;
}) {
  useEffect(() => {
    if (mode !== 'canvas' || sessionActive === false) return;
    void refreshCanvas();
  }, [mode, currentPath, canvasSearchQuery, refreshCanvas, sessionActive]);

  // ★ 2025-12-31: 移除组件挂载时的 reset() 调用
  // 原因: finderStore 使用 persist 中间件保存导航状态到 localStorage
  // 如果每次挂载都 reset，会导致:
  // 1. 用户在子文件夹时切换视图，路径被意外重置到根目录
  // 2. 移动端三屏布局切换时丢失导航状态
  // 导航状态应该由用户操作控制，而非组件生命周期

  // ★ 文档28 Prompt 8: 同步 finderStore 与 LearningHubNavigationContext
  useLearningHubNavigationSafe();

  // ★ LH-HOST：把本宿主注册为「活跃访达」，让 App 级前进/后退壳层作用在本桶上。
  // canvas 宿主自带局部列表状态，不参与全局导航壳层。
  useEffect(() => {
    if (mode === 'canvas' || sessionActive === false) return;
    const bucketId = resolveFinderHostId(hostId);
    setActiveFinderHostId(bucketId);
    return () => {
      if (getActiveFinderHostId() === bucketId) {
        setActiveFinderHostId(DEFAULT_FINDER_HOST_ID);
      }
    };
  }, [mode, hostId, sessionActive]);
}
