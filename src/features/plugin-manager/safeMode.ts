import i18n from 'i18next';
import { isWebUiShell } from '@/utils/platform';

const OVERLAY_ID = 'ds-safe-mode-transition-overlay';

function resolveTransitionCopy(mode: 'enter' | 'exit'): { title: string; detail: string } {
  const lang = (
    i18n?.resolvedLanguage ??
    i18n?.language ??
    (typeof document !== 'undefined' ? document.documentElement.lang : '') ??
    ''
  ).toLowerCase();
  const isEn = lang.startsWith('en');

  const defaultTitle =
    mode === 'enter'
      ? isEn
        ? 'Switching to Safe Mode, isolating community plugins…'
        : '正在切换至安全模式排查，正在隔离社区插件…'
      : isEn
        ? 'Exiting Safe Mode and restarting normally…'
        : '正在退出安全模式并恢复正常启动…';

  const defaultDetail =
    mode === 'enter'
      ? isEn
        ? 'Restarting with official capabilities only. Your notes and study materials remain safe…'
        : '即将以纯净官方环境重启，您的笔记与学习资料不会丢失，请稍候…'
      : isEn
        ? 'Reloading your enabled plugins, please wait…'
        : '正在重新加载已启用的插件，请稍候…';

  if (i18n?.isInitialized) {
    const titleKey = mode === 'enter' ? 'plugin_manager:safeMode.switchingEnter' : 'plugin_manager:safeMode.switchingExit';
    const detailKey = mode === 'enter' ? 'plugin_manager:safeMode.switchingEnterDetail' : 'plugin_manager:safeMode.switchingExitDetail';
    return {
      title: i18n.t(titleKey, { defaultValue: defaultTitle }),
      detail: i18n.t(detailKey, { defaultValue: defaultDetail }),
    };
  }
  return { title: defaultTitle, detail: defaultDetail };
}

/**
 * Mounts an immediate full-screen loading/transition overlay before Safe Mode
 * reload/relaunch so users never stare at an unconfirmed blank white screen.
 */
export function mountSafeModeTransitionOverlay(mode: 'enter' | 'exit'): HTMLElement | null {
  if (typeof document === 'undefined' || !document.body) return null;
  const { title, detail } = resolveTransitionCopy(mode);

  let overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('data-testid', 'safe-mode-transition-overlay');
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'assertive');
    overlay.setAttribute('aria-busy', 'true');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:99999',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'gap:14px',
      'padding:24px',
      'text-align:center',
      'background:hsl(var(--background, 222 47% 11%) / 0.94)',
      'color:hsl(var(--foreground, 210 40% 98%))',
      'backdrop-filter:blur(8px)',
      '-webkit-backdrop-filter:blur(8px)',
    ].join(';');
    document.body.appendChild(overlay);
  }
  overlay.setAttribute('data-mode', mode);

  if (!document.getElementById(`${OVERLAY_ID}-keyframes`) && document.head) {
    const style = document.createElement('style');
    style.id = `${OVERLAY_ID}-keyframes`;
    style.textContent = '@keyframes dsSafeModeSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
  }

  overlay.replaceChildren();

  const spinner = document.createElement('div');
  spinner.setAttribute('aria-hidden', 'true');
  spinner.style.cssText = [
    'width:32px',
    'height:32px',
    'border-radius:9999px',
    'border:3px solid currentColor',
    'border-top-color:transparent',
    'opacity:0.85',
    'animation:dsSafeModeSpin 0.85s linear infinite',
  ].join(';');

  const heading = document.createElement('div');
  heading.setAttribute('data-testid', 'safe-mode-transition-title');
  heading.style.cssText = 'font-size:15px;font-weight:600;line-height:1.5;max-width:480px;';
  heading.textContent = title;

  const sub = document.createElement('div');
  sub.setAttribute('data-testid', 'safe-mode-transition-detail');
  sub.style.cssText = 'font-size:12px;line-height:1.6;opacity:0.75;max-width:460px;';
  sub.textContent = detail;

  overlay.append(spinner, heading, sub);
  return overlay;
}

export function dismissSafeModeTransitionOverlay(): void {
  if (typeof document === 'undefined') return;
  document.getElementById(OVERLAY_ID)?.remove();
}

async function postWebUiSafeMode(endpoint: '/api/safe-mode/exit' | '/api/safe-mode/enter'): Promise<void> {
  if (typeof fetch !== 'function') return;
  try {
    await fetch(endpoint, { method: 'POST', credentials: 'same-origin' });
  } catch {
    // Ignore transient network errors before reload; host state refresh still proceeds.
  }
}

function reloadOrAssign(targetUrl?: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (targetUrl) {
      window.location.assign(targetUrl);
      return;
    }
    window.location.reload();
  } catch {
    // Ignore read-only location stubs in headless test environments.
  }
}

/**
 * Exits plugin Safe Mode and restarts / reloads the session cleanly:
 * - In WebUI (or URL-forced `?safeMode=1` / `?safe_mode=1`): notifies `/api/safe-mode/exit`, clears query params, and reloads.
 * - In Desktop (Tauri): relaunches the app process via `@tauri-apps/plugin-process`, falling back to reload.
 */
export async function exitSafeModeAndRestart(): Promise<void> {
  mountSafeModeTransitionOverlay('exit');
  let cleanedUrl: string | null = null;
  if (typeof window !== 'undefined') {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('safeMode') || url.searchParams.has('safe_mode')) {
        url.searchParams.delete('safeMode');
        url.searchParams.delete('safe_mode');
        cleanedUrl = url.toString();
      }
    } catch {
      // Non-URL location (e.g. about:blank in tests): fall through safely.
    }
  }

  if (isWebUiShell()) {
    if (cleanedUrl && typeof window !== 'undefined') {
      try {
        window.history?.replaceState?.(null, '', cleanedUrl);
      } catch {
        // Fallback to assign(cleanedUrl) below if replaceState fails.
      }
    }
    await postWebUiSafeMode('/api/safe-mode/exit');
    reloadOrAssign(cleanedUrl && window.location.search ? cleanedUrl : null);
    return;
  }

  if (cleanedUrl) {
    reloadOrAssign(cleanedUrl);
    return;
  }

  try {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
    return;
  } catch {
    // Browser/dev/test runtime without Tauri process plugin: reload below.
  }

  reloadOrAssign();
}

/**
 * Enters plugin Safe Mode for troubleshooting and restarts / reloads cleanly:
 * - In WebUI: notifies `/api/safe-mode/enter` so the Host restarts in safe mode, then reloads.
 * - In Desktop / browser dev: sets `?safeMode=1` when HTTP(S) or relaunches Tauri.
 */
export async function enterSafeModeAndRestart(): Promise<void> {
  mountSafeModeTransitionOverlay('enter');
  if (isWebUiShell()) {
    await postWebUiSafeMode('/api/safe-mode/enter');
    reloadOrAssign();
    return;
  }

  if (typeof window !== 'undefined') {
    try {
      const url = new URL(window.location.href);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        url.searchParams.set('safeMode', '1');
        reloadOrAssign(url.toString());
        return;
      }
    } catch {
      // Ignore non-URL location.
    }
  }

  try {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
    return;
  } catch {
    // Fallback to reload.
  }

  reloadOrAssign();
}
