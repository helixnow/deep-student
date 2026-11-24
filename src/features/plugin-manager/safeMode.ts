import { isWebUiShell } from '@/utils/platform';

/**
 * Exits plugin Safe Mode and restarts / reloads the session cleanly:
 * - In WebUI (or URL-forced `?safeMode=1` / `?safe_mode=1`): navigates without safe-mode params.
 * - In Desktop (Tauri): relaunches the app process via `@tauri-apps/plugin-process`, falling back to reload.
 */
export async function exitSafeModeAndRestart(): Promise<void> {
  if (typeof window !== 'undefined') {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('safeMode') || url.searchParams.has('safe_mode')) {
        url.searchParams.delete('safeMode');
        url.searchParams.delete('safe_mode');
        window.location.assign(url.toString());
        return;
      }
    } catch {
      // Non-URL location (e.g. about:blank in tests): fall through safely.
    }
  }

  if (!isWebUiShell()) {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
      return;
    } catch {
      // Browser/dev/test runtime without Tauri process plugin: reload below.
    }
  }

  if (typeof window !== 'undefined') {
    try {
      window.location.reload();
    } catch {
      // Ignore read-only location stubs in headless test environments.
    }
  }
}
