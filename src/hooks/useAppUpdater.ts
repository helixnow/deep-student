/**
 * 应用自动更新 Hook
 *
 * 桌面端基于 @tauri-apps/plugin-updater：
 * - 启动后延迟 5 秒静默检查（受频率/跳过版本/不再提醒设置控制）
 * - 稳定版用户先做 channel 探测（R2 → GitHub latest.json 两级），
 *   探测失败时保守跳过——绝不"无法确认渠道时放行检查"，
 *   避免实验版被推给稳定版用户
 * - 下载安装完成后不强制重启：置 readyToRelaunch 并通知用户自行选择时机
 *   （Windows 例外：NSIS 安装器接管时进程即退出，平台行为不可延迟）
 * - Linux 仅 AppImage 支持应用内更新；deb/rpm 安装降级为手动下载引导
 *
 * Android 走自建链路（updater 插件不支持移动端）：
 * - R2 latest.json → GitHub API 回退
 * - 应用内下载 APK（plugin-http 流式 + plugin-fs 分块写）后调起系统安装器
 *
 * iOS 无分发渠道，保持外链提示。
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { isMobilePlatform, isAndroid } from '../utils/platform';
import { openLink } from '../utils/urlOpener';
import { showGlobalNotification } from '../components/UnifiedNotification';
import i18n from '@/i18n';

/**
 * 获取一个不受 WebView 网络限制约束的 fetch 函数。
 * Tauri 环境（桌面 + 移动）优先走 http 插件的原生网络层：
 * - 移动端 WebView 严格执行 CORS；
 * - 桌面端 webview CSP 仅放行 download.deepstudent.cn，访问 github.com 会被拦，
 *   而 http 插件走原生层不受 CSP 约束（capabilities 已 allow github.com/*）。
 * 纯浏览器环境（demo 壳 / vite dev）降级为 window.fetch。
 */
async function getNativeFetch(): Promise<typeof fetch> {
  try {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    return tauriFetch as typeof fetch;
  } catch {
    return fetch;
  }
}

/** 带超时的 JSON 探测；任何失败（网络/超时/非 2xx/解析错误）都返回 null。 */
async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<any | null> {
  try {
    const nativeFetch = await getNativeFetch();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await nativeFetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

const R2_LATEST_URL = 'https://download.deepstudent.cn/releases/latest.json';
const GH_LATEST_URL = 'https://github.com/helixnow/deep-student/releases/latest/download/latest.json';
const GH_RELEASES_PAGE = 'https://github.com/helixnow/deep-student/releases/latest';

/**
 * 探测最新发布的渠道：R2 优先，GitHub latest.json asset 兜底。
 * 这两个 URL 正是桌面端 updater 插件的两个 endpoint，因此"两个都失败"
 * 就意味着 check() 也注定失败，可以直接按检查失败处理，无信息损失。
 * 返回 null 表示渠道无法确认。
 */
async function probeReleaseChannel(): Promise<string | null> {
  // demo 壳没有真实更新源，恒按 stable 处理（避免演示时发出真实外网请求）
  if (typeof window !== 'undefined' && (window as any).__DS_DEMO_SHELL__) return 'stable';

  const r2 = await fetchJsonWithTimeout(R2_LATEST_URL, 5000);
  if (r2) return typeof r2.channel === 'string' ? r2.channel : 'stable';

  const gh = await fetchJsonWithTimeout(GH_LATEST_URL, 10000);
  if (gh) return typeof gh.channel === 'string' ? gh.channel : 'stable';

  return null;
}

export type UpdateChannel = 'stable' | 'experimental';
const UPDATE_CHANNEL_KEY = 'ds-update-channel';

// ---- Auto-update frequency & skip settings ----
export type UpdateFrequency = 'every_launch' | 'every_n_days' | 'never';
const UPDATE_FREQUENCY_KEY = 'ds-update-frequency';
const UPDATE_FREQUENCY_DAYS_KEY = 'ds-update-frequency-days';
const UPDATE_LAST_CHECK_KEY = 'ds-update-last-check';
const UPDATE_SKIPPED_VERSION_KEY = 'ds-update-skipped-version';
const UPDATE_NO_REMIND_KEY = 'ds-update-no-remind';

export function getUpdateFrequency(): UpdateFrequency {
  try {
    const v = localStorage.getItem(UPDATE_FREQUENCY_KEY);
    if (v === 'every_n_days' || v === 'never') return v;
    return 'every_launch';
  } catch { return 'every_launch'; }
}

export function setUpdateFrequency(freq: UpdateFrequency) {
  try {
    localStorage.setItem(UPDATE_FREQUENCY_KEY, freq);
    // Changing frequency away from 'never' implicitly clears no-remind
    if (freq !== 'never') {
      localStorage.removeItem(UPDATE_NO_REMIND_KEY);
    }
  } catch { /* localStorage 不可用时静默忽略 */ }
}

export function getUpdateFrequencyDays(): number {
  try {
    const v = parseInt(localStorage.getItem(UPDATE_FREQUENCY_DAYS_KEY) ?? '', 10);
    return Number.isFinite(v) && v > 0 ? v : 3;
  } catch { return 3; }
}

export function setUpdateFrequencyDays(days: number) {
  try { localStorage.setItem(UPDATE_FREQUENCY_DAYS_KEY, String(Math.max(1, Math.round(days)))); } catch { /* localStorage 不可用时静默忽略 */ }
}

export function getSkippedVersion(): string {
  try { return localStorage.getItem(UPDATE_SKIPPED_VERSION_KEY) ?? ''; } catch { return ''; }
}

export function setSkippedVersion(version: string) {
  try { localStorage.setItem(UPDATE_SKIPPED_VERSION_KEY, version); } catch { /* localStorage 不可用时静默忽略 */ }
}

export function getNoRemind(): boolean {
  try { return localStorage.getItem(UPDATE_NO_REMIND_KEY) === 'true'; } catch { return false; }
}

export function setNoRemind(value: boolean) {
  try {
    if (value) {
      localStorage.setItem(UPDATE_NO_REMIND_KEY, 'true');
    } else {
      localStorage.removeItem(UPDATE_NO_REMIND_KEY);
    }
  } catch { /* localStorage 不可用时静默忽略 */ }
}

function getLastCheckTime(): number {
  try {
    const v = parseInt(localStorage.getItem(UPDATE_LAST_CHECK_KEY) ?? '', 10);
    return Number.isFinite(v) ? v : 0;
  } catch { return 0; }
}

function setLastCheckTime() {
  try { localStorage.setItem(UPDATE_LAST_CHECK_KEY, String(Date.now())); } catch { /* localStorage 不可用时静默忽略 */ }
}

/** Determine if a startup auto-check should run based on user preferences */
function shouldAutoCheck(): boolean {
  if (getNoRemind()) return false;
  const freq = getUpdateFrequency();
  if (freq === 'never') return false;
  if (freq === 'every_launch') return true;
  // every_n_days
  const days = getUpdateFrequencyDays();
  const last = getLastCheckTime();
  if (last === 0) return true;
  const elapsed = Date.now() - last;
  return elapsed >= days * 24 * 60 * 60 * 1000;
}

export function getUpdateChannel(): UpdateChannel {
  try {
    return localStorage.getItem(UPDATE_CHANNEL_KEY) === 'experimental' ? 'experimental' : 'stable';
  } catch { return 'stable'; }
}

export function setUpdateChannel(channel: UpdateChannel) {
  try { localStorage.setItem(UPDATE_CHANNEL_KEY, channel); } catch { /* localStorage 不可用时静默忽略 */ }
}

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

export interface UpdateInfo {
  version: string;
  date?: string;
  body?: string;
  /** R2 镜像 APK 下载地址（仅移动端从 R2 latest.json 获取） */
  apkUrl?: string;
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
  /** 是否为启动时自动检查触发（用于弹窗判断） */
  isStartupCheck: boolean;
  /**
   * 下载安装已完成、等待重启生效。
   * 仅 macOS/Linux 会到达此状态；Windows 上 NSIS 安装器接管时进程即退出。
   */
  readyToRelaunch: boolean;
  /**
   * 当前安装形态是否支持应用内自更新。
   * Linux 上仅 AppImage 支持（deb/rpm 为 false）；null = 尚未检测/非桌面。
   */
  installSupported: boolean | null;
}

export interface AppUpdaterController extends UpdateState {
  isMobile: boolean;
  /** 是否支持应用内下载安装（Android） */
  canInstallInApp: boolean;
  checkForUpdate: (silent?: boolean, startup?: boolean) => Promise<boolean>;
  downloadAndInstall: () => Promise<void>;
  relaunchApp: () => Promise<void>;
  dismiss: () => void;
  skipVersion: (version: string) => void;
  setNeverRemind: () => void;
  performUpdateAction: () => Promise<void>;
}

const initialState: UpdateState = {
  checking: false,
  available: false,
  upToDate: false,
  info: null,
  downloading: false,
  progress: 0,
  error: null,
  isStartupCheck: false,
  readyToRelaunch: false,
  installSupported: null,
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

/** 启动通知按版本模块级去重（hook 存在多实例：App 顶层 + AboutTab） */
let lastNotifiedVersion: string | null = null;

export function useAppUpdater(): AppUpdaterController {
  const [state, setState] = useState<UpdateState>(initialState);
  const pendingUpdateRef = useRef<any>(null);
  const downloadingRef = useRef(false);

  const mobile = isMobilePlatform();
  const android = isAndroid();

  /** 检查成功统一入口：记录检查时间（手动检查也刷新"每 N 天"计时基准） */
  const succeed = useCallback((): boolean => {
    setLastCheckTime();
    return true;
  }, []);

  /** 检查更新 */
  const checkForUpdate = useCallback(async (silent = false, startup = false): Promise<boolean> => {
    // 移动端：优先从 R2 检查最新版本，回退到 GitHub API
    if (mobile) {
      setState(prev => ({ ...prev, checking: true, error: null, upToDate: false, isStartupCheck: startup }));
      try {
        const { default: VERSION_INFO } = await import('../version');
        const currentVersion = VERSION_INFO.APP_VERSION;
        const safeFetch = await getNativeFetch();

        let latestVersion = '';
        let releaseBody: string | undefined;
        let publishedAt: string | undefined;
        let apkUrl: string | undefined;

        let releaseChannel = '';

        // 优先尝试 R2 镜像（国内更快）
        try {
          const r2Controller = new AbortController();
          const r2Timeout = setTimeout(() => r2Controller.abort(), 5000);
          const r2Resp = await safeFetch(R2_LATEST_URL, {
            signal: r2Controller.signal,
          }).finally(() => clearTimeout(r2Timeout));
          if (r2Resp.ok) {
            const r2Data = await r2Resp.json();
            latestVersion = r2Data.version ?? '';
            releaseBody = r2Data.notes ?? undefined;
            publishedAt = r2Data.pub_date ?? undefined;
            apkUrl = r2Data.apk_url ?? undefined;
            releaseChannel = r2Data.channel ?? 'stable';
          }
        } catch {
          // R2 失败，静默回退
        }

        // R2 失败时回退到 GitHub API
        if (!latestVersion) {
          const ghController = new AbortController();
          const ghTimeout = setTimeout(() => ghController.abort(), 10000);
          const resp = await safeFetch('https://api.github.com/repos/helixnow/deep-student/releases/latest', {
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
          // 从 release assets 中查找 APK，构造 R2 镜像下载链接
          if (!apkUrl && tagName) {
            const apkAsset = (data.assets as any[])?.find((a: any) => a.name?.endsWith('.apk'));
            if (apkAsset) {
              apkUrl = `https://download.deepstudent.cn/releases/${tagName}/${apkAsset.name}`;
            }
          }
          // GitHub API 不含 channel，从 GitHub Release 的 latest.json asset 补取
          if (!releaseChannel) {
            const ghLatest = await fetchJsonWithTimeout(GH_LATEST_URL, 5000);
            if (ghLatest) releaseChannel = ghLatest.channel ?? 'stable';
          }
        }

        // 渠道无法确认（版本号来自 GitHub API 但 latest.json asset 也不可达）：
        // 稳定版用户保守跳过，避免实验版被推给稳定版用户；实验版用户不受渠道门控。
        if (!releaseChannel) {
          if (getUpdateChannel() === 'stable') {
            if (!silent) {
              setState(prev => ({ ...prev, checking: false, error: { phase: 'check', message: '无法确认更新渠道，请稍后重试' } }));
            } else {
              setState(prev => ({ ...prev, checking: false }));
              console.warn('[Updater] Mobile channel probe failed; skipping check for stable user');
            }
            return false;
          }
          releaseChannel = 'experimental';
        }

        // 稳定版用户遇到实验版 → 视为已是最新
        if (getUpdateChannel() === 'stable' && releaseChannel === 'experimental') {
          setState(prev => ({ ...prev, checking: false, available: false, upToDate: !silent }));
          return succeed();
        }

        if (latestVersion && isNewerVersion(latestVersion, currentVersion)) {
          // Startup check: skip if user chose to skip this specific version
          if (startup && getSkippedVersion() === latestVersion) {
            setState(prev => ({ ...prev, checking: false, available: false, upToDate: false }));
            return succeed();
          }
          setState(prev => ({
            ...prev,
            checking: false,
            available: true,
            info: {
              version: latestVersion,
              date: publishedAt,
              body: releaseBody,
              apkUrl,
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
        return false;
      }
      return succeed();
    }

    // 桌面端使用 Tauri updater 插件
    setState(prev => ({ ...prev, checking: true, error: null, upToDate: false, isStartupCheck: startup }));

    try {
      // 稳定版用户：先探测最新发布的 channel，实验版则跳过。
      // R2 → GitHub latest.json 两级探测（即 check() 的两个 endpoint）；
      // 全部失败时绝不放行检查——无法确认渠道就把更新推给用户，
      // 会有实验版泄漏给稳定版用户的风险。
      if (getUpdateChannel() === 'stable') {
        const channel = await probeReleaseChannel();
        if (channel === 'experimental') {
          setState(prev => ({ ...prev, checking: false, available: false, upToDate: !silent }));
          return succeed();
        }
        if (channel === null) {
          if (!silent) {
            setState(prev => ({ ...prev, checking: false, error: { phase: 'check', message: '无法连接更新服务器，请稍后重试' } }));
          } else {
            setState(prev => ({ ...prev, checking: false }));
            console.warn('[Updater] Channel probe failed on both R2 and GitHub; skipping check for stable user');
          }
          return false;
        }
      }

      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();

      if (update) {
        // Startup check: skip if user chose to skip this specific version
        if (startup && getSkippedVersion() === update.version) {
          pendingUpdateRef.current = null;
          setState(prev => ({ ...prev, checking: false, available: false, upToDate: false }));
        } else {
          pendingUpdateRef.current = update;
          // 安装形态探测：Linux 非 AppImage（deb/rpm）不支持应用内自更新，
          // UI 据此把安装按钮降级为手动下载引导。探测失败保守放行（行为同旧版）。
          let installSupported = true;
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            installSupported = await invoke<boolean>('updater_install_supported');
          } catch { /* 命令不可用时按支持处理 */ }
          setState(prev => ({
            ...prev,
            checking: false,
            available: true,
            installSupported,
            info: {
              version: update.version,
              date: update.date ?? undefined,
              body: update.body ?? undefined,
            },
          }));
        }
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
      return false;
    }
    return succeed();
  }, [mobile, succeed]);

  /** 重启应用以应用已安装的更新（macOS/Linux；Windows 由安装器自动完成） */
  const relaunchApp = useCallback(async () => {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err: any) {
      console.error('[Updater] Relaunch failed:', err);
      setState(prev => ({
        ...prev,
        error: {
          phase: 'relaunch',
          message: '更新已安装，请手动重启应用以完成更新',
        },
      }));
    }
  }, []);

  /** Android：应用内下载 APK 并调起系统安装器 */
  const downloadApkAndInstall = useCallback(async () => {
    const info = state.info;
    if (!info?.apkUrl) {
      setState(prev => ({ ...prev, downloading: false, error: { phase: 'unavailable', message: '更新已不可用，请稍后重试' } }));
      return;
    }
    const { apkUrl, version } = info;

    try {
      const nativeFetch = await getNativeFetch();
      const { open, mkdir, BaseDirectory } = await import('@tauri-apps/plugin-fs');
      const { appCacheDir, join } = await import('@tauri-apps/api/path');
      const { invoke } = await import('@tauri-apps/api/core');

      const resp = await nativeFetch(apkUrl);
      if (!resp.ok || !resp.body) throw new Error(`download failed with status code ${resp.status}`);
      const total = Number(resp.headers.get('content-length') ?? 0) || 0;

      // 写入应用私有缓存目录（FileProvider 仅暴露该 updates/ 子目录给安装器）。
      // 注意：fs open 的 create 不会创建父目录，必须先 mkdir。
      const fileName = `DeepStudent-v${version}.apk`;
      await mkdir('updates', { baseDir: BaseDirectory.AppCache, recursive: true });
      const file = await open(`updates/${fileName}`, {
        create: true,
        write: true,
        truncate: true,
        baseDir: BaseDirectory.AppCache,
      });

      let downloaded = 0;
      const reader = resp.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            await file.write(value);
            downloaded += value.byteLength;
            setState(prev => ({
              ...prev,
              progress: total > 0
                ? Math.min(Math.round((downloaded / total) * 100), 99)
                : Math.min(prev.progress + 2, 95),
            }));
          }
        }
      } finally {
        await file.close().catch(() => { /* 关闭失败不阻塞后续流程 */ });
      }
      setState(prev => ({ ...prev, progress: 100 }));

      // 调起系统安装器（Kotlin 侧 FileProvider → ACTION_VIEW）。
      // 此后安装由系统 UI 接管，结果不可知（用户可取消），故保留 available 状态允许重试。
      const absPath = await join(await appCacheDir(), 'updates', fileName);
      await invoke('install_apk', { path: absPath });

      setState(prev => ({ ...prev, downloading: false }));
      showGlobalNotification(
        'info',
        i18n.t('common:update.installerLaunched'),
      );
    } catch (err: any) {
      downloadingRef.current = false;
      const errorMsg = err?.message || String(err) || 'Unknown error';
      const phase = classifyDownloadInstallError(err);
      console.error(`[Updater] APK ${phase} failed:`, errorMsg, err);
      setState(prev => ({
        ...prev,
        downloading: false,
        error: { phase, message: errorMsg },
      }));
    }
  }, [state.info]);

  /** 下载并安装更新 */
  const downloadAndInstall = useCallback(async () => {
    if (downloadingRef.current) return; // 防止并发下载

    // Android：应用内下载 + 系统安装器；iOS 不支持应用内安装（走外链）
    if (mobile) {
      if (!android) return;
      downloadingRef.current = true;
      setState(prev => ({ ...prev, downloading: true, progress: 0, error: null }));
      await downloadApkAndInstall();
      downloadingRef.current = false;
      return;
    }

    downloadingRef.current = true;

    setState(prev => ({ ...prev, downloading: true, progress: 0, error: null }));

    try {
      let update = pendingUpdateRef.current;
      if (!update) {
        const { check } = await import('@tauri-apps/plugin-updater');
        update = await check();
      }

      if (!update) {
        downloadingRef.current = false;
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

      // 能执行到这里说明是 macOS/Linux（Windows 上 updater 启动 NSIS 安装器后
      // 进程即退出，后面的代码永远不会运行）。.app/AppImage 已替换完成，
      // 不强制重启，交给用户选择时机，避免硬中断进行中的会话。
      downloadingRef.current = false;
      setState(prev => ({
        ...prev,
        downloading: false,
        readyToRelaunch: true,
      }));
      showGlobalNotification(
        'success',
        i18n.t('common:update.readyMessage'),
        undefined,
        {
          action: {
            label: i18n.t('common:update.restartNow'),
            onClick: () => { void relaunchApp(); },
          },
        },
      );
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
            readyToRelaunch: true,
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
  }, [mobile, android, downloadApkAndInstall, relaunchApp]);

  const performUpdateAction = useCallback(async () => {
    if (!state.available || !state.info) return;

    if (state.readyToRelaunch) {
      await relaunchApp();
      return;
    }

    if (mobile) {
      // Android 且拿到 APK 地址 → 应用内下载安装；其余（Android 缺地址 / iOS）降级外链
      if (android && state.info.apkUrl) {
        await downloadAndInstall();
        return;
      }
      await openLink(android ? (state.info.apkUrl || GH_RELEASES_PAGE) : GH_RELEASES_PAGE);
      return;
    }

    await downloadAndInstall();
  }, [downloadAndInstall, relaunchApp, mobile, android, state.available, state.info, state.readyToRelaunch]);

  /** 关闭更新提示 */
  const dismiss = useCallback(() => {
    setState(initialState);
  }, []);

  /** 跳过某个特定版本 */
  const skipVersion = useCallback((version: string) => {
    setSkippedVersion(version);
    setState(initialState);
  }, []);

  /** 设置不再提醒 */
  const setNeverRemind = useCallback(() => {
    setNoRemind(true);
    setState(initialState);
  }, []);

  // 启动检查发现更新 → 一次性全局通知（覆盖侧栏折叠/移动端抽屉等徽标不可见场景）。
  // 通过 ref 调最新 performUpdateAction，避免与上面的 useCallback 形成循环依赖。
  // 注意去重必须是模块级：useAppUpdater 存在多个实例（App 顶层 + AboutTab），
  // 启动检查会在每个已挂载实例中各跑一次，per-instance ref 挡不住跨实例重复通知。
  const performUpdateActionRef = useRef(performUpdateAction);
  performUpdateActionRef.current = performUpdateAction;
  useEffect(() => {
    if (!state.isStartupCheck || !state.available || !state.info) return;
    if (state.downloading || state.readyToRelaunch) return;
    if (lastNotifiedVersion === state.info.version) return;
    lastNotifiedVersion = state.info.version;
    showGlobalNotification(
      'info',
      i18n.t('common:update.notifyMessage', { version: state.info.version }),
      undefined,
      {
        action: {
          label: i18n.t('common:update.notifyAction'),
          onClick: () => { void performUpdateActionRef.current(); },
        },
      },
    );
  }, [state.isStartupCheck, state.available, state.info, state.downloading, state.readyToRelaunch]);

  // 启动后延迟静默检查（受频率设置控制）
  useEffect(() => {
    if (!shouldAutoCheck()) return;
    const timer = setTimeout(() => {
      // lastCheck 时间在 checkForUpdate 成功时统一记录（含手动检查），
      // 网络失败不延后下次检查。
      void checkForUpdate(true, true);
    }, 5000);
    return () => clearTimeout(timer);
  }, [checkForUpdate]);

  return {
    ...state,
    isMobile: mobile,
    canInstallInApp: mobile && android,
    checkForUpdate,
    downloadAndInstall,
    relaunchApp,
    performUpdateAction,
    dismiss,
    skipVersion,
    setNeverRemind,
  };
}
