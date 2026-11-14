import { useState, useEffect, useRef } from 'react';
import { DsButton } from '@/components/ui/DsButton';
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
    let disposed = false;
    let unlisten: (() => void | Promise<void>) | undefined;
    let querying = false;
    let stale = false;

    // resize 在拖动缩放时是高频事件：同一时刻只发一次 isMaximized，期间到达的事件合并成结束后的一次补查。
    const refreshMaximized = async () => {
      if (querying) {
        stale = true;
        return;
      }
      querying = true;
      try {
        do {
          stale = false;
          const maximized = await windowRef.current.isMaximized();
          if (!disposed) setIsMaximized(maximized);
        } while (stale && !disposed);
      } catch (error: unknown) {
        console.error('Failed to get maximized state:', error);
      } finally {
        querying = false;
      }
    };

    const initWindow = async () => {
      await refreshMaximized();
      try {
        // RUST-FIX(RF-W09-window-controls-maximize-follows-resize): Rust 版监听的 tauri://window-maximized/unmaximized
        // 没有任何发射端，最大化不经本按钮时图标不变；改为在 tauri://resize 后重新查询。
        const stop = await guardedListen('tauri://resize', () => void refreshMaximized());
        if (disposed) void stop();
        else unlisten = stop;
      } catch (error: unknown) {
        console.error('Failed to listen to window events:', error);
      }
    };

    initWindow();

    return () => {
      disposed = true;
      if (unlisten) void unlisten();
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
      <DsButton
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
      </DsButton>
      
      <DsButton
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
      </DsButton>
      
      <DsButton
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
      </DsButton>
    </div>
  );
};
