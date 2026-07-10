/**
 * 资源浏览器应用窗口（P8 + O17）
 *
 * 单例窗口，完整复用 learning-hub 的 finder 组件体系
 * （LearningHubSidebar fullscreen 模式 = FinderToolbar + FinderQuickAccess +
 * FinderFileList/DesktopView + 搜索 + 文件夹导航 + 右键菜单，只读消费）。
 *
 * 与 legacy 全屏页的唯一差异：打开资源不再走标签页（openTab），
 * 而是把 ResourceListItem 映射为 workbench 应用并 launch
 * （双击/回车/上下文菜单"打开"最终都汇聚到 onOpenApp 回调）。
 *
 * O17 适配层增强：
 * - 列表/网格切换过渡（useFilesViewTransition）
 * - hover 预览玻璃卡（useFilesHoverPreview）
 * - 拖出窗外 → 桌面开窗（useResourceDragOut + desktopDragBridge）
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LearningHubSidebar } from '@/features/learning-hub';
import type { ResourceListItem } from '@/features/learning-hub/types';
import { workbenchBus } from '../../core/workbenchBus';
import { shouldPauseHeavyContent } from '../../core/shellGestureFlags';
import type { AppWindowProps } from '../../core/types';
import { useDragRenderPause } from '../../hooks/useDragRenderPause';
import { resourceTypeToAppTypeId } from '../content/typeMap';
import { useFilesViewTransition } from './useFilesViewTransition';
import { useFilesHoverPreview } from './useFilesHoverPreview';
import { useResourceDragOut } from './useResourceDragOut';
import './FilesAppWindow.css';

/**
 * ResourceListItem → workbenchBus.launch 请求。
 * 导出为纯函数便于测试；不可开窗类型返回 null 且不 launch。
 */
export function launchResourceItem(item: Pick<ResourceListItem, 'id' | 'type'>): string | null {
  const typeId = resourceTypeToAppTypeId(item.type);
  if (!typeId) return null;
  return workbenchBus.launch({
    typeId,
    instanceKey: item.id,
    reason: 'files',
  });
}

const FilesAppWindow: React.FC<AppWindowProps> = ({
  windowId,
  onTitleChange,
  renderThrottleMs = 0,
}) => {
  const { t } = useTranslation(['workbench']);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  // 不依赖 hint 刷新：起拖同步旗后下一帧关掉 hover/拖出（避免跟手中途仍跑预览）
  const [gesturePaused, setGesturePaused] = useState(() => shouldPauseHeavyContent());
  const interactionEnabled = renderThrottleMs <= 0 && !gesturePaused;

  useEffect(() => {
    onTitleChange(t('workbench:apps.files', '资源库'));
    // onTitleChange 由窗口壳提供，标题只需在挂载时设置一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    let raf = 0;
    const sync = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        setGesturePaused(shouldPauseHeavyContent());
      });
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-wb-dragging', 'data-wb-settling'],
    });
    return () => {
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  useDragRenderPause(hostRef, renderThrottleMs);
  useFilesViewTransition(viewportRef, interactionEnabled);
  useFilesHoverPreview({ hostRef, enabled: interactionEnabled });
  useResourceDragOut({ hostRef, windowId, enabled: interactionEnabled });

  const handleOpenApp = useCallback((item: ResourceListItem) => {
    launchResourceItem(item);
  }, []);

  return (
    <div ref={hostRef} className="wb-files-host" data-wb-files-host>
      <div ref={viewportRef} className="wb-files-viewport" data-wb-files-viewport>
        <LearningHubSidebar
          mode="fullscreen"
          onOpenApp={handleOpenApp}
          onOpenPreview={handleOpenApp}
          className="h-full w-full"
          isCollapsed={false}
        />
      </div>
    </div>
  );
};

export default FilesAppWindow;
