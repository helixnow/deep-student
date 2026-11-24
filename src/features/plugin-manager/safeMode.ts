import { isWebUiShell } from '@/utils/platform';

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
