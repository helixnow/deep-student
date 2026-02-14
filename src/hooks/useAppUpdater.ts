/**
 * 应用自动更新 Hook
 *
 * 基于 @tauri-apps/plugin-updater 实现桌面端自动更新检查。
 * - 启动后延迟 5 秒静默检查
 * - 提供手动检查更新功能
 * - Android/iOS 走应用商店，不使用此机制
 */
import { useState, useCallback, useEffect } from 'react';
import { isMobilePlatform } from '../utils/platform';

/** semver 大于比较（不引入额外依赖） */
function isNewerVersion(latest: string, current: string): boolean {
  // 仅比较 core semver（major.minor.patch），忽略 prerelease/build metadata
  const normalize = (v: string): [number, number, number] => {
    const core = v.trim().replace(/^v/i, '').split(/[+-]/, 1)[0] || '';
    const [major, minor, patch] = core.split('.');
    const toInt = (s?: string) => {
      const n = Number.parseInt(s ?? '0', 10);
      return Number.isFinite(n) ? n : 0;
    };
    return [toInt(major), toInt(minor), toInt(patch)];
  };

  const l = normalize(latest);
  const c = normalize(current);

  for (let i = 0; i < 3; i++) {
    const lv = l[i];
    const cv = c[i];
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

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
  /** 已是最新版本（检查完成但无更新） */
  upToDate: boolean;
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
  upToDate: false,
  info: null,
  downloading: false,
  progress: 0,
  error: null,
};

export function useAppUpdater() {
  const [state, setState] = useState<UpdateState>(initialState);

  const mobile = isMobilePlatform();

  /** 检查更新 */
  const checkForUpdate = useCallback(async (silent = false) => {
    // 移动端使用 GitHub API 检查最新版本
    if (mobile) {
      setState(prev => ({ ...prev, checking: true, error: null, upToDate: false }));
      try {
        const resp = await fetch('https://api.github.com/repos/000haoji/deep-student/releases/latest', {
          headers: { Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
        const data = await resp.json();
        const latestVersion = (data.tag_name ?? '').replace(/^v/, '');
        const { default: VERSION_INFO } = await import('../version');
        const currentVersion = VERSION_INFO.APP_VERSION;
        if (latestVersion && isNewerVersion(latestVersion, currentVersion)) {
          setState(prev => ({
            ...prev,
            checking: false,
            available: true,
            info: {
              version: latestVersion,
              date: data.published_at ?? undefined,
              body: data.body ?? undefined,
            },
          }));
        } else {
          setState(prev => ({ ...prev, checking: false, available: false, upToDate: !silent, info: null }));
        }
      } catch (err: any) {
        if (!silent) {
          setState(prev => ({ ...prev, checking: false, error: err?.message || String(err) }));
        } else {
          setState(prev => ({ ...prev, checking: false }));
          console.warn('[Updater] Mobile silent check failed:', err?.message || String(err));
        }
      }
      return;
    }

    // 桌面端使用 Tauri updater 插件
    setState(prev => ({ ...prev, checking: true, error: null, upToDate: false }));

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
          upToDate: !silent,
          info: null,
        }));
      }
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
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
  }, [mobile]);

  /** 下载并安装更新（仅桌面端） */
  const downloadAndInstall = useCallback(async () => {
    if (mobile) return; // 移动端不支持 in-app 安装

    setState(prev => ({ ...prev, downloading: true, progress: 0, error: null }));

    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();

      if (!update) {
        setState(prev => ({ ...prev, downloading: false, error: '更新已不可用' }));
        return;
      }

      // 下载并安装（官方推荐：用 downloaded/contentLength 计算真实进度）
      let downloaded = 0;
      let contentLength = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength ?? 0;
            downloaded = 0;
            setState(prev => ({ ...prev, progress: 0 }));
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            setState(prev => ({
              ...prev,
              progress: contentLength > 0
                ? Math.min(Math.round((downloaded / contentLength) * 100), 99)
                : Math.min(prev.progress + 2, 95),
            }));
            break;
          case 'Finished':
            setState(prev => ({ ...prev, progress: 100 }));
            break;
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
  }, [mobile]);

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
    isMobile: mobile,
    checkForUpdate,
    downloadAndInstall,
    dismiss,
  };
}
