import { useCallback, useEffect } from 'react';
import { getMemoryConfig } from '@/api/memoryApi';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import type { QuickAccessType } from '../stores/finderStore';
import type { LearningHubSidebarProps } from '../types';
import { LEARNING_HUB_QUICK_ACCESS_EVENT, takePendingLearningHubQuickAccess } from '../navigation/quickAccessRequest';
import type { SidebarT } from './sidebarConstants';

/** 快捷入口导航（拦截「记忆」入口）+ 消费外部快捷入口请求 */
export function useQuickAccessNavigation({
  enterFolder,
  quickAccessNavigate,
  t,
  mode,
  sessionActive,
}: {
  enterFolder: (folderId: string, folderName?: string, folderPath?: string) => Promise<void>;
  quickAccessNavigate: (type: QuickAccessType) => void;
  t: SidebarT;
  mode: LearningHubSidebarProps['mode'];
  sessionActive: boolean | undefined;
}) {
  // ★ 记忆系统改造：拦截"记忆"入口，导航到记忆根文件夹
  const handleQuickAccessNavigate = useCallback(async (type: QuickAccessType) => {
    if (type === 'memory') {
      try {
        const config = await getMemoryConfig();
        if (config.memoryRootFolderId) {
          // 记忆根文件夹已配置，直接导航到该文件夹
          enterFolder(config.memoryRootFolderId, config.memoryRootFolderTitle || t('memory.defaultRootTitle'));
          return;
        }
      } catch (e) {
        console.warn('[LearningHub] Failed to get memory config, falling back to MemoryView:', e);
      }
      // 未配置根文件夹或获取失败，回退到 MemoryView（用于引导设置）
    }
    quickAccessNavigate(type);
  }, [enterFolder, quickAccessNavigate, t]);

  // 外部请求打开某个快捷入口：只由全屏访达在本桶执行（同上面注册「活跃访达」的条件）
  const handlesQuickAccessRequests = mode !== 'canvas' && sessionActive !== false;
  useEffect(() => {
    if (!handlesQuickAccessRequests) return;
    const requested = takePendingLearningHubQuickAccess();
    if (requested) void handleQuickAccessNavigate(requested);
    // 只在成为全屏访达时消费一次挂起请求；之后的请求走事件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handlesQuickAccessRequests]);
  useEventRegistry(handlesQuickAccessRequests ? [{
    target: 'window',
    type: LEARNING_HUB_QUICK_ACCESS_EVENT,
    listener: () => {
      const requested = takePendingLearningHubQuickAccess();
      if (requested) void handleQuickAccessNavigate(requested);
    },
  }] : [], [handlesQuickAccessRequests, handleQuickAccessNavigate]);

  return handleQuickAccessNavigate;
}
