import type React from 'react';
import { useCallback, useRef } from 'react';
import type { CurrentView } from '@/types/navigation';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { getNavigationShortcutText } from '@/hooks/useNavigationShortcuts';
import type { useWindowDrag } from '@/hooks/useWindowDrag';
import {
  HEADER_HOTZONE_DRAG_THRESHOLD,
  clearHeaderHotzoneActivationTimer,
  shouldIgnoreHeaderHotzoneTarget,
} from '../shell/desktopHeaderHotzone';
import type { SetCurrentView } from '../navigation/viewRouting';

/**
 * App 壳层：桌面标题栏与标题栏热区的指针交互——空白处拖拽 / 双击最大化，热区按下后
 * 超过阈值转拖拽、否则延迟激活；新建会话、打开命令面板；导航快捷键文案。
 * 从 App.tsx 原样搬出。
 */
export function useDesktopTitlebarInteractions(
  startDragging: ReturnType<typeof useWindowDrag>['startDragging'],
  toggleDesktopWindowMaximize: () => Promise<void>,
  currentView: CurrentView,
  setCurrentView: SetCurrentView,
) {
  const navigationShortcuts = getNavigationShortcutText();
  const commandPaletteTriggerRef = useRef<(() => void) | null>(null);
  const handleDesktopTitlebarMouseDown = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const dragExclusionTarget = (event.target as HTMLElement).closest('[data-no-drag]');
    if (dragExclusionTarget || shouldIgnoreHeaderHotzoneTarget(event.target, event.currentTarget)) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    event.preventDefault();

    if (event.detail === 2) {
      void toggleDesktopWindowMaximize();
      return;
    }

    void startDragging(event);
  }, [startDragging, toggleDesktopWindowMaximize]);
  const clearHeaderHotzonePress = useCallback((element: HTMLElement) => {
    delete element.dataset.shellHotzoneStartX;
    delete element.dataset.shellHotzoneStartY;
  }, []);
  const handleHeaderHotzoneMouseDown = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || shouldIgnoreHeaderHotzoneTarget(event.target, event.currentTarget)) {
      return;
    }

    if (event.detail === 2) {
      event.preventDefault();
      event.stopPropagation();
      clearHeaderHotzonePress(event.currentTarget);
      clearHeaderHotzoneActivationTimer(event.currentTarget);
      event.currentTarget.dataset.shellHotzoneSuppressClick = 'true';
      void toggleDesktopWindowMaximize();
      return;
    }

    event.currentTarget.dataset.shellHotzoneStartX = String(event.clientX);
    event.currentTarget.dataset.shellHotzoneStartY = String(event.clientY);
    delete event.currentTarget.dataset.shellHotzoneSuppressClick;
  }, [clearHeaderHotzonePress, toggleDesktopWindowMaximize]);
  const handleHeaderHotzoneMouseMove = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (event.buttons !== 1) {
      return;
    }

    const { shellHotzoneStartX, shellHotzoneStartY } = event.currentTarget.dataset;
    if (!shellHotzoneStartX || !shellHotzoneStartY) {
      return;
    }

    const deltaX = event.clientX - Number(shellHotzoneStartX);
    const deltaY = event.clientY - Number(shellHotzoneStartY);
    if (Math.hypot(deltaX, deltaY) < HEADER_HOTZONE_DRAG_THRESHOLD) {
      return;
    }

    clearHeaderHotzonePress(event.currentTarget);
    event.currentTarget.dataset.shellHotzoneSuppressClick = 'true';
    void startDragging(event);
  }, [clearHeaderHotzonePress, startDragging]);
  const handleHeaderHotzoneMouseUp = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const hotzoneElement = event.currentTarget;
    clearHeaderHotzonePress(hotzoneElement);

    if (hotzoneElement.dataset.shellHotzoneSuppressClick === 'true') {
      window.setTimeout(() => {
        delete hotzoneElement.dataset.shellHotzoneSuppressClick;
      }, 0);
    }
  }, [clearHeaderHotzonePress]);
  const handleHeaderHotzoneMouseLeave = useCallback((event: React.MouseEvent<HTMLElement>) => {
    clearHeaderHotzonePress(event.currentTarget);
  }, [clearHeaderHotzonePress]);
  const handleCreateChatSession = useCallback(() => {
    if (currentView !== 'chat-v2') {
      setCurrentView('chat-v2');
      requestAnimationFrame(() => {
        dispatchAppEvent(APP_EVENTS.CHAT_NEW_SESSION);
      });
      return;
    }

    dispatchAppEvent(APP_EVENTS.CHAT_NEW_SESSION);
  }, [currentView, setCurrentView]);
  const openCommandPalette = useCallback(() => {
    commandPaletteTriggerRef.current?.();
  }, []);

  return {
    navigationShortcuts,
    commandPaletteTriggerRef,
    handleDesktopTitlebarMouseDown,
    handleHeaderHotzoneMouseDown,
    handleHeaderHotzoneMouseMove,
    handleHeaderHotzoneMouseUp,
    handleHeaderHotzoneMouseLeave,
    handleCreateChatSession,
    openCommandPalette,
  };
}
