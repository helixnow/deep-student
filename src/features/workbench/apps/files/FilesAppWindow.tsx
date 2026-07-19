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
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LearningHubSidebar } from '@/features/learning-hub';
import type { ResourceListItem } from '@/features/learning-hub/types';
import { workbenchBus } from '../../core/workbenchBus';
import { shouldPauseHeavyContent } from '../../core/shellGestureFlags';
import type { AppWindowProps } from '../../core/types';
import { useDragRenderPause } from '../../hooks/useDragRenderPause';
import {
  isNotesWorkspaceResourceType,
  resourceTypeToAppTypeId,
} from '../content/typeMap';
import { requestWorkspaceResource } from '../notes/workspaceRegistry';
import { useFilesViewTransition } from './useFilesViewTransition';
import { useFilesHoverPreview } from './useFilesHoverPreview';
import { useResourceDragOut } from './useResourceDragOut';
import './FilesAppWindow.css';
import { WorkbenchSidebarLayout } from '../system/SystemWindowShared';
import { useWbSysSize } from '../system/useWbSysSize';

/**
 * ResourceListItem → workbenchBus.launch 请求。
 * 导出为纯函数便于测试；不可开窗类型返回 null 且不 launch。
 */
export function launchResourceItem(item: Pick<ResourceListItem, 'id' | 'type'>): string | null {
  const typeId = resourceTypeToAppTypeId(item.type);
  if (!typeId) return null;
  const workspaceResourceType = isNotesWorkspaceResourceType(item.type) ? item.type : null;
  if (workspaceResourceType) {
    void requestWorkspaceResource({ type: workspaceResourceType, id: item.id });
  }
  return workbenchBus.launch({
    typeId,
    instanceKey: workspaceResourceType ? undefined : item.id,
    payload: workspaceResourceType
      ? { resourceType: workspaceResourceType, resourceId: item.id }
      : undefined,
    reason: 'files',
  });
}

const FilesAppWindow: React.FC<AppWindowProps> = ({
  windowId,
  isActive,
  requestClose,
  onTitleChange,
  renderThrottleMs = 0,
}) => {
  const { t } = useTranslation(['workbench']);
  const hostRef = useRef<HTMLDivElement>(null);
  const { ref: sizeRef, sizeClass } = useWbSysSize();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [quickAccessTarget, setQuickAccessTarget] = useState<HTMLDivElement | null>(null);
  // 不依赖 hint 刷新：起拖同步旗后下一帧关掉 hover/拖出（避免跟手中途仍跑预览）
  const [gesturePaused, setGesturePaused] = useState(() => shouldPauseHeavyContent());
  const [titlebarTarget, setTitlebarTarget] = useState<HTMLElement | null>(null);
  const interactionEnabled = renderThrottleMs <= 0 && !gesturePaused;

  useEffect(() => {
    onTitleChange(t('workbench:apps.files'));
    // onTitleChange 由窗口壳提供，标题只需在挂载时设置一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cmd/Ctrl+W：关 files 窗（handlesCloseShortcut 让壳层放行）
  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey)
        || event.altKey
        || event.shiftKey
        || event.key.toLocaleLowerCase() !== 'w'
      ) return;
      event.preventDefault();
      void requestClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, requestClose]);

  useLayoutEffect(() => {
    const findTarget = () => {
      const target = Array.from(document.querySelectorAll<HTMLElement>('[data-wb-titlebar-slot]'))
        .find((element) => element.dataset.windowId === windowId) ?? null;
      setTitlebarTarget((current) => current === target ? current : target);
    };
    findTarget();
    const observer = new MutationObserver(findTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [windowId]);

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

  const setHostRef = useCallback((node: HTMLDivElement | null) => {
    hostRef.current = node;
    (sizeRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
  }, [sizeRef]);

  return (
    <div ref={setHostRef} className="wb-files-host" data-wb-files-host>
      <WorkbenchSidebarLayout
        sizeClass={sizeClass}
        navLabel={t('workbench:apps.files')}
        sidebar={<div ref={setQuickAccessTarget} className="h-full min-h-0 w-full" />}
      >
      <div ref={viewportRef} className="wb-files-viewport" data-wb-files-viewport>
        <LearningHubSidebar
          mode="fullscreen"
          hostId="files"
          sessionActive={isActive}
          onOpenApp={handleOpenApp}
          onOpenPreview={handleOpenApp}
          commandsEnabled={isActive}
          className="h-full w-full"
          isCollapsed={false}
          toolbarPortalTarget={titlebarTarget}
          quickAccessPortalTarget={quickAccessTarget}
        />
      </div>
      </WorkbenchSidebarLayout>
    </div>
  );
};

export default FilesAppWindow;
