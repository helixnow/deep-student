import { useState, useEffect, useRef } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { guardedListen } from '../utils/guardedListen';
import { useTranslation } from 'react-i18next';

const getCurrentWindowPoly = () => {
  try {
    return getCurrentWindow();
  } catch {
    // 🪟 非 Tauri / Web 环境：提供最小可用的桩对象，避免方法不存在报错
    return {
      // 通用窗口操作
      minimize: async () => {},
      maximize: async () => {},
      unmaximize: async () => {},
      isMaximized: async () => false,
      close: async () => {},
      listen: async () => () => {},
      onFileDropEvent: async () => () => {},
      startDragging: async () => {},
    } as any;
  }
};

export const WindowControls: React.FC = () => {
  const { t } = useTranslation(['common']);
  const [isMaximized, setIsMaximized] = useState(false);
  const windowRef = useRef(getCurrentWindowPoly());

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const updateInitialState = async () => {
      try {
        const maximized = await windowRef.current.isMaximized();
        setIsMaximized(maximized);
      } catch (error: unknown) {
        console.error('Failed to get maximized state:', error);
      }
    };

    const initWindow = async () => {
      await updateInitialState();
      try {
        // 仅监听最大化/还原两个离散事件，避免高频 resize 事件
        const unlistenMax = await guardedListen('tauri://window-maximized', () => setIsMaximized(true));
        const unlistenUnmax = await guardedListen('tauri://window-unmaximized', () => setIsMaximized(false));
        // 合并两个卸载函数
        unlisten = () => {
          unlistenMax();
          unlistenUnmax();
        };
      } catch (error: unknown) {
        console.error('Failed to listen to window events:', error);
      }
    };

    initWindow();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const handleMinimize = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await windowRef.current.minimize();
    } catch (error: unknown) {
      console.error('Failed to minimize window:', error);
    }
  };

  const handleMaximize = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const isCurrentlyMaximized = await windowRef.current.isMaximized();
      if (isCurrentlyMaximized) {
        await windowRef.current.unmaximize();
        setIsMaximized(false);
      } else {
        await windowRef.current.maximize();
        setIsMaximized(true);
      }
    } catch (error: unknown) {
      console.error('Failed to toggle maximize:', error);
    }
  };

  const handleClose = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await windowRef.current.close();
    } catch (error: unknown) {
      console.error('Failed to close window:', error);
    }
  };

  return (
    <div data-shell-window-controls>
      <NotionButton
        variant="ghost"
        size="icon"
        iconOnly
        data-shell-window-button="minimize"
        className="desktop-shell-toolbar-button"
        onClick={handleMinimize}
        onMouseDown={(e) => e.stopPropagation()}
        title={t('window_controls.minimize')}
        aria-label={t('window_controls.minimize')}
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="M2 6h8" stroke="currentColor" strokeWidth="1" />
        </svg>
      </NotionButton>
      
      <NotionButton
        variant="ghost"
        size="icon"
        iconOnly
        data-shell-window-button="maximize"
        className="desktop-shell-toolbar-button"
        onClick={handleMaximize}
        onMouseDown={(e) => e.stopPropagation()}
        title={isMaximized ? t('window_controls.restore') : t('window_controls.maximize')}
        aria-label={isMaximized ? t('window_controls.restore') : t('window_controls.maximize')}
      >
        {isMaximized ? (
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M3 3h6v6H3V3z M1 1h6v2H3v4H1V1z" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2 2h8v8H2V2z" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        )}
      </NotionButton>
      
      <NotionButton
        variant="ghost"
        size="icon"
        iconOnly
        data-shell-window-button="close"
        className="desktop-shell-toolbar-button"
        onClick={handleClose}
        onMouseDown={(e) => e.stopPropagation()}
        title={t('window_controls.close')}
        aria-label={t('window_controls.close')}
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1" />
        </svg>
      </NotionButton>
    </div>
  );
};
