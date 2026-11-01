import { useMemo } from 'react';
import { ModernSidebar, type SidebarUpdater } from '@/components/ModernSidebar';
import { SettingsShellSidebar } from '@/features/settings/components/SettingsShellSidebar';
import { TodoShellSidebar } from '@/features/todo/components/TodoShellSidebar';
import type { useAppUpdater } from '@/hooks/useAppUpdater';
import type { CurrentView } from '@/types/navigation';
import type { SetCurrentView } from '../navigation/viewRouting';

/**
 * App 壳层：桌面壳侧栏层的元素（主 ModernSidebar、设置壳侧栏、待办壳侧栏）及传给主侧栏的
 * updater memo。元素以 useMemo 保持稳定引用，供 DesktopShellSidebarLayers 常驻挂载。
 * 从 App.tsx 原样搬出（desktop-page 层依赖 App 内的 portal 目标 state，留在 App）。
 */
export function useDesktopSidebarElements(
  updater: ReturnType<typeof useAppUpdater>,
  currentView: CurrentView,
  handleViewChange: (newView: CurrentView) => void,
  leftPanelCollapsed: boolean,
  setCurrentView: SetCurrentView,
) {
  // 渲染侧边栏导航 - 现代化风格
  const sidebarUpdater = useMemo<SidebarUpdater>(() => ({
    checking: updater.checking,
    available: updater.available,
    info: updater.info,
    downloading: updater.downloading,
    progress: updater.progress,
    readyToRelaunch: updater.readyToRelaunch,
    performUpdateAction: updater.performUpdateAction,
  }), [
    updater.available,
    updater.checking,
    updater.downloading,
    updater.info,
    updater.performUpdateAction,
    updater.progress,
    updater.readyToRelaunch,
  ]);
  const sidebarElement = useMemo(() => (
    <ModernSidebar
      currentView={currentView}
      onViewChange={handleViewChange}
      sidebarCollapsed={leftPanelCollapsed}
      updater={sidebarUpdater}
    />
  ), [currentView, handleViewChange, leftPanelCollapsed, sidebarUpdater]);

  const settingsShellSidebarElement = useMemo(() => (
    <SettingsShellSidebar
      isSmallScreen={false}
      globalLeftPanelCollapsed={leftPanelCollapsed}
      onBack={() => setCurrentView('chat-v2')}
    />
  ), [leftPanelCollapsed, setCurrentView]);

  const todoShellSidebarElement = useMemo(() => (
    <TodoShellSidebar
      isSmallScreen={false}
      globalLeftPanelCollapsed={leftPanelCollapsed}
      onBack={() => setCurrentView('chat-v2')}
    />
  ), [leftPanelCollapsed, setCurrentView]);

  return {
    sidebarElement,
    settingsShellSidebarElement,
    todoShellSidebarElement,
  };
}
