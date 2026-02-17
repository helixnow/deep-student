/**
 * 应用自动更新 Hook
 *
 * 基于 @tauri-apps/plugin-updater 实现桌面端自动更新检查。
 * - 启动后延迟 5 秒静默检查
 * - 提供手动检查更新功能
 * - Android/iOS 走应用商店，不使用此机制
 */
import { useState, useCallback, useEffect, useRef } from 'react';
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

/** 更新失败的阶段 */
export type UpdateErrorPhase =
  | 'check'           // 检查更新失败（网络/端点不可用）
  | 'download'        // 下载失败（网络中断/文件不存在）
  | 'install'         // 安装失败（签名验证/磁盘空间/权限）
  | 'relaunch'        // 重启失败（更新已安装，需手动重启）
  | 'unavailable';    // 更新源已不可用

export interface UpdateError {
  phase: UpdateErrorPhase;
  message: string;
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
  /** 错误信息（细粒度） */
  error: UpdateError | null;
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

/** 根据 downloadAndInstall 抛出的原始错误推断失败阶段 */
function classifyDownloadInstallError(err: any): UpdateErrorPhase {
  const msg = (err?.message || String(err)).toLowerCase();
  // 网络 / 下载阶段关键词
  if (
    msg.includes('network') ||
    msg.includes('fetch') ||
    msg.includes('timeout') ||
    msg.includes('dns') ||
    msg.includes('connect') ||
    msg.includes('download') ||
    msg.includes('status code')
  ) {
    return 'download';
  }
  // 签名验证 / 权限 / 磁盘空间 → 安装阶段
  if (
    msg.includes('signature') ||
    msg.includes('verify') ||
    msg.includes('permission') ||
    msg.includes('disk') ||
    msg.includes('space') ||
    msg.includes('extract') ||
    msg.includes('io error')
  ) {
    return 'install';
  }
  // 默认归为安装阶段（下载成功但后续失败的概率更高）
  return 'install';
}

export function useAppUpdater() {
  const [state, setState] = useState<UpdateState>(initialState);
  const pendingUpdateRef = useRef<any>(null);
  const downloadingRef = useRef(false);

  const mobile = isMobilePlatform();

  /** 检查更新 */
  const checkForUpdate = useCallback(async (silent = false) => {
    // 移动端：优先从 R2 检查最新版本，回退到 GitHub API
    if (mobile) {
      setState(prev => ({ ...prev, checking: true, error: null, upToDate: false }));
      try {
        const { default: VERSION_INFO } = await import('../version');
        const currentVersion = VERSION_INFO.APP_VERSION;

        let latestVersion = '';
        let releaseBody: string | undefined;
        let publishedAt: string | undefined;

        // 优先尝试 R2 镜像（国内更快）
        try {
          const r2Controller = new AbortController();
          const r2Timeout = setTimeout(() => r2Controller.abort(), 5000);
          const r2Resp = await fetch('https://download.deepstudent.cn/releases/latest.json', {
            signal: r2Controller.signal,
          }).finally(() => clearTimeout(r2Timeout));
          if (r2Resp.ok) {
            const r2Data = await r2Resp.json();
            latestVersion = r2Data.version ?? '';
            releaseBody = r2Data.notes ?? undefined;
            publishedAt = r2Data.pub_date ?? undefined;
          }
        } catch {
          // R2 失败，静默回退
        }

        // R2 失败时回退到 GitHub API
        if (!latestVersion) {
          const ghController = new AbortController();
          const ghTimeout = setTimeout(() => ghController.abort(), 10000);
          const resp = await fetch('https://api.github.com/repos/000haoji/deep-student/releases/latest', {
            headers: { Accept: 'application/vnd.github+json' },
            signal: ghController.signal,
          }).finally(() => clearTimeout(ghTimeout));
          if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
          const data = await resp.json();
          // 兼容 'v0.9.9' 和 'deep-student-v0.9.9' 两种 tag 格式
          const tagName = data.tag_name ?? '';
          latestVersion = tagName.match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? tagName.replace(/^v/, '');
          releaseBody = data.body ?? undefined;
          publishedAt = data.published_at ?? undefined;
        }

        if (latestVersion && isNewerVersion(latestVersion, currentVersion)) {
          setState(prev => ({
            ...prev,
            checking: false,
            available: true,
            info: {
              version: latestVersion,
              date: publishedAt,
              body: releaseBody,
            },
          }));
        } else {
          setState(prev => ({ ...prev, checking: false, available: false, upToDate: !silent, info: null }));
        }
      } catch (err: any) {
        if (!silent) {
          setState(prev => ({ ...prev, checking: false, error: { phase: 'check', message: err?.message || String(err) } }));
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
        pendingUpdateRef.current = update;
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
        pendingUpdateRef.current = null;
        setState(prev => ({
          ...prev,
          checking: false,
          available: false,
          upToDate: !silent,
          info: null,
        }));
      }
    } catch (err: any) {
      pendingUpdateRef.current = null;
      const errorMsg = err?.message || String(err);
      if (!silent) {
        setState(prev => ({
          ...prev,
          checking: false,
          error: { phase: 'check', message: errorMsg },
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
    if (downloadingRef.current) return; // 防止并发下载
    downloadingRef.current = true;

    setState(prev => ({ ...prev, downloading: true, progress: 0, error: null }));

    try {
      let update = pendingUpdateRef.current;
      if (!update) {
        const { check } = await import('@tauri-apps/plugin-updater');
        update = await check();
      }

      if (!update) {
        setState(prev => ({ ...prev, downloading: false, error: { phase: 'unavailable', message: '更新已不可用，请稍后重试' } }));
        return;
      }
      pendingUpdateRef.current = null;

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
      try {
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      } catch (relaunchErr: any) {
        console.error('[Updater] Relaunch failed:', relaunchErr);
        downloadingRef.current = false;
        setState(prev => ({
          ...prev,
          available: false,
          downloading: false,
          progress: 100,
          error: {
            phase: 'relaunch',
            message: '更新已安装，请手动重启应用以完成更新',
          },
        }));
      }
    } catch (err: any) {
      downloadingRef.current = false;
      const errorMsg = err?.message || String(err) || 'Unknown error';
      setState(prev => {
        // 如果 Finished 事件已触发（progress >= 100），说明下载完成、
        // 更新大概率已写入磁盘（macOS .app 替换后抛异常的典型场景）。
        // 此时归为 relaunch 阶段，避免误报"安装失败"。
        if (prev.progress >= 100) {
          console.warn('[Updater] Post-install error (update likely applied):', errorMsg, err);
          return {
            ...prev,
            available: false,
            downloading: false,
            error: {
              phase: 'relaunch',
              message: '更新已安装，请手动重启应用以完成更新',
            },
          };
        }
        const phase = classifyDownloadInstallError(err);
        console.error(`[Updater] ${phase} failed:`, errorMsg, err);
        return {
          ...prev,
          downloading: false,
          error: { phase, message: errorMsg },
        };
      });
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
