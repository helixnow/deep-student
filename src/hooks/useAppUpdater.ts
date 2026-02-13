/**
 * 应用自动更新 Hook
 *
 * 基于 @tauri-apps/plugin-updater 实现桌面端自动更新检查。
 * - 启动后延迟 5 秒静默检查
 * - 提供手动检查更新功能
 * - Android/iOS 走应用商店，不使用此机制
 */
import { useState, useCallback, useEffect } from 'react';

interface UpdateInfo {
  version: string;
  date?: string;
  body?: string;
}

interface UpdateState {
  /** 是否正在检查 */
  checking: boolean;
  /** 是否有可用更新 */
  available: boolean;
  /** 更新信息 */
  info: UpdateInfo | null;
  /** 是否正在下载安装 */
  downloading: boolean;
  /** 下载进度 (0-100) */
  progress: number;
  /** 错误信息 */
  error: string | null;
}

const initialState: UpdateState = {
  checking: false,
  available: false,
  info: null,
  downloading: false,
  progress: 0,
  error: null,
};

export function useAppUpdater() {
  const [state, setState] = useState<UpdateState>(initialState);

  /** 检查更新 */
  const checkForUpdate = useCallback(async (silent = false) => {
    setState(prev => ({ ...prev, checking: true, error: null }));

    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();

      if (update) {
        setState(prev => ({
          ...prev,
          checking: false,
          available: true,
          info: {
            version: update.version,
            date: update.date ?? undefined,
            body: update.body ?? undefined,
          },
        }));
      } else {
        setState(prev => ({
          ...prev,
          checking: false,
          available: false,
          info: null,
        }));
      }
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      // 静默模式下不显示错误（启动时检查）
      if (!silent) {
        setState(prev => ({
          ...prev,
          checking: false,
          error: errorMsg,
        }));
      } else {
        setState(prev => ({ ...prev, checking: false }));
        console.warn('[Updater] Silent check failed:', errorMsg);
      }
    }
  }, []);

  /** 下载并安装更新 */
  const downloadAndInstall = useCallback(async () => {
    setState(prev => ({ ...prev, downloading: true, progress: 0, error: null }));

    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();

      if (!update) {
        setState(prev => ({ ...prev, downloading: false, error: '更新已不可用' }));
        return;
      }

      // 下载并安装
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started' && event.data.contentLength) {
          setState(prev => ({ ...prev, progress: 0 }));
        } else if (event.event === 'Progress') {
          // 简单进度估算
          setState(prev => ({
            ...prev,
            progress: Math.min(prev.progress + 5, 95),
          }));
        } else if (event.event === 'Finished') {
          setState(prev => ({ ...prev, progress: 100 }));
        }
      });

      // 安装完成后需要重启
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err: any) {
      setState(prev => ({
        ...prev,
        downloading: false,
        error: err?.message || '更新下载失败',
      }));
    }
  }, []);

  /** 关闭更新提示 */
  const dismiss = useCallback(() => {
    setState(initialState);
  }, []);

  // 启动后延迟静默检查
  useEffect(() => {
    const timer = setTimeout(() => {
      checkForUpdate(true);
    }, 5000);
    return () => clearTimeout(timer);
  }, [checkForUpdate]);

  return {
    ...state,
    checkForUpdate,
    downloadAndInstall,
    dismiss,
  };
}
