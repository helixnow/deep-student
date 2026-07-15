/**
 * Browser content WebviewWindow 协调（B2a）
 *
 * 对标 `pomodoro/miniWindow.ts`。一期 content 窗由 Rust `BrowserService` 创建；
 * TS 侧以 getByLabel + focus / show / hide / close 为主，不擅自 new WebviewWindow
 *（避免与零 capability / 独立 profile 冲突）。ensure 仅在窗已存在时聚焦。
 */
import { BROWSER_CONTENT_LABEL } from './types';
import {
  getSurfaceHostMode,
  isCommandMissingError,
  setSurfaceVisibility,
} from './browserApi';

export { BROWSER_CONTENT_LABEL };

function isTauri(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
}

async function getContentWindow() {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  return WebviewWindow.getByLabel(BROWSER_CONTENT_LABEL);
}

/** 若 content 窗已存在则聚焦；不存在则返回 false（由 Rust open_session 创建） */
export async function ensureBrowserContentWindow(sessionId?: string | null): Promise<boolean> {
  if (!isTauri()) return false;
  if (sessionId) {
    try {
      const mode = await getSurfaceHostMode();
      // Embedded content is revealed only after the React slot has sent bounds.
      if (mode === 'embedded') return true;
      await setSurfaceVisibility(sessionId, true, true);
      return true;
    } catch (error) {
      if (!isCommandMissingError(error)) {
        console.warn('[BrowserContent] ensure native surface failed:', error);
        return false;
      }
      // Older Rust builds fall through to the legacy WebviewWindow path.
    }
  }
  try {
    const existing = await getContentWindow();
    if (!existing) return false;
    await existing.setFocus();
    try {
      await existing.show();
    } catch {
      /* show 在部分平台可能 no-op */
    }
    return true;
  } catch (e) {
    console.warn('[BrowserContent] ensureBrowserContentWindow failed:', e);
    return false;
  }
}

/** 显示并聚焦 content 浮窗（「显示页面」） */
export async function showBrowserContentWindow(sessionId?: string | null): Promise<boolean> {
  if (!isTauri()) return false;
  if (sessionId) {
    try {
      const mode = await getSurfaceHostMode();
      // Embedded visibility is owned by the active BrowserAppWindow slot so
      // imperative calls cannot reveal stale bounds or steal focus.
      if (mode === 'embedded') return true;
      await setSurfaceVisibility(sessionId, true, true);
      return true;
    } catch (error) {
      if (!isCommandMissingError(error)) {
        console.warn('[BrowserContent] show native surface failed:', error);
        return false;
      }
    }
  }
  try {
    const existing = await getContentWindow();
    if (!existing) return false;
    try {
      await existing.show();
    } catch {
      /* ignore */
    }
    await existing.setFocus();
    return true;
  } catch (e) {
    console.warn('[BrowserContent] showBrowserContentWindow failed:', e);
    return false;
  }
}

/** 隐藏 content 浮窗（不销毁；销毁走 close / Rust close_session） */
export async function hideBrowserContentWindow(sessionId?: string | null): Promise<void> {
  if (!isTauri()) return;
  if (sessionId) {
    try {
      await setSurfaceVisibility(sessionId, false, false);
      return;
    } catch (error) {
      if (!isCommandMissingError(error)) return;
    }
  }
  try {
    const existing = await getContentWindow();
    if (existing) await existing.hide();
  } catch {
    // 窗口已不存在
  }
}

/** 关闭 content 浮窗（若存在） */
export async function closeBrowserContentWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const existing = await getContentWindow();
    if (existing) await existing.close();
  } catch {
    // 窗口已不存在
  }
}

export async function isBrowserContentWindowOpen(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const existing = await getContentWindow();
    return Boolean(existing);
  } catch {
    return false;
  }
}
