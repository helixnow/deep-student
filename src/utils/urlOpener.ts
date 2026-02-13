/**
 * 跨平台 URL 打开工具
 * 支持：Tauri 桌面端、Web 浏览器、iOS/Android WebView
 */

import { showGlobalNotification } from '../components/UnifiedNotification';
import i18n from '@/i18n';

/**
 * 检测是否在 Tauri 环境中
 */
const detectTauriEnvironment = (): boolean => {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as any).__TAURI_INTERNALS__)
  );
};

/** 安全 URL scheme 白名单 */
const SAFE_URL_SCHEMES = ['http:', 'https:', 'mailto:'];

/**
 * 统一的 URL 打开函数
 * @param url 要打开的 URL
 * @param options 选项
 */
export const openUrl = async (
  inputUrl: string,
  options?: {
    fallbackToCurrentWindow?: boolean;
  }
): Promise<void> => {
  const { fallbackToCurrentWindow = false } = options || {};
  let url = inputUrl;

  // 🔧 修复 #17: URL scheme 安全校验，阻止 javascript:/data:/vbscript: 等危险协议
  // 🔒 安全审计修复 (2026-02-08): 解析失败时默认拒绝而非允许
  try {
    const parsed = new URL(url);
    if (!SAFE_URL_SCHEMES.includes(parsed.protocol)) {
      console.warn(`Blocked unsafe URL scheme: ${parsed.protocol}`);
      showGlobalNotification('warning', i18n.t('common:urlOpener.blockedUnsafeScheme', { protocol: parsed.protocol, defaultValue: `Blocked unsafe link (${parsed.protocol})` }));
      return;
    }
  } catch {
    // URL 解析失败 — 默认拒绝，防止绕过 scheme 检查
    // 尝试补全为 https:// 后再次验证
    try {
      const retryUrl = url.startsWith('//') ? `https:${url}` : `https://${url}`;
      new URL(retryUrl); // 验证格式
      // 🔒 审阅修复: 使用补全后的 URL（原代码使用无协议的原始 URL，window.open 会解析为相对路径）
      url = retryUrl;
      console.warn('URL parse failed, retried with https:// prefix succeeded:', inputUrl);
    } catch {
      // 二次验证也失败，拒绝打开
      console.warn('URL parse failed, blocked for safety:', inputUrl);
      showGlobalNotification('warning', i18n.t('common:urlOpener.blockedInvalidUrl', 'Blocked invalid URL'));
      return;
    }
  }

  // 优先尝试使用 Tauri opener 插件（桌面端原生应用）
  if (detectTauriEnvironment()) {
    try {
      const { openUrl: tauriOpenUrl } = await import('@tauri-apps/plugin-opener');
      await tauriOpenUrl(url);
      return;
    } catch (tauriError: unknown) {
      console.warn('Tauri opener 失败，降级到 window.open:', tauriError);
      // 继续执行降级方案
    }
  }

  // 降级方案：使用 window.open（Web端、嵌入 WebView）
  try {
    const newWindow = window.open(url, '_blank', 'noopener,noreferrer');

    // 检测弹窗是否被阻止
    if (!newWindow) {
      showGlobalNotification(
        'warning',
        i18n.t('common:urlOpener.popupBlocked', 'Popup was blocked. Please allow popups and retry, or copy the link to open in a browser.')
      );
      if (fallbackToCurrentWindow) {
        window.location.href = url;
      }
    }
  } catch (windowError: unknown) {
    console.error('window.open 失败:', windowError);
    // 最后的降级方案：直接导航
    try {
      window.location.href = url;
    } catch (navError: unknown) {
      console.error('页面导航失败:', navError);
      showGlobalNotification('error', i18n.t('common:urlOpener.cannotOpenLink', { url, defaultValue: `Cannot open link, please copy and open manually: ${url}` }));
    }
  }
};

/**
 * 异步打开链接的便捷函数
 * @param url 要打开的 URL
 */
export const openLink = async (url: string): Promise<void> => {
  await openUrl(url);
};

/**
 * 检查当前是否在 Tauri 环境中
 */
export const isTauriEnvironment = (): boolean => {
  return detectTauriEnvironment();
};

/**
 * 检查当前是否支持弹窗
 */
export const canOpenPopup = (): boolean => {
  // 在某些移动设备或受限环境中，弹窗可能被禁用
  const userAgent = navigator.userAgent.toLowerCase();
  return !userAgent.includes('mobile') || userAgent.includes('ipad');
};
