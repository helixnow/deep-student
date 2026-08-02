/**
 * 侧边栏半透明（毛玻璃）统一应用入口
 *
 * 两层实现：
 * 1. CSS 层：`data-sidebar-translucent` 属性驱动 theme-colors.css 中的
 *    半透明 + backdrop-filter 规则（所有平台可用的应用内毛玻璃）。
 * 2. 原生层（仅 macOS + Tauri）：调用 `set_sidebar_vibrancy` 在窗口底部
 *    挂载 NSVisualEffectView（Sidebar 材质），再由 CSS 透明链让左侧侧栏
 *    和顶部左段共同透出同一块原生材质。
 *
 * 标题栏左侧导航段使用 WebView 内与侧栏相同的表面，不再额外挂载原生
 * NSVisualEffectView，避免它覆盖 WebView 自绘控件；两者共用窗口底层材质。
 */
import { isTauriRuntime } from '@/utils/shared';
import { isMacOS } from '@/utils/platform';

const TRANSLUCENT_ATTR = 'data-sidebar-translucent';
const VIBRANCY_ATTR = 'data-macos-vibrancy';

/** 记录已应用的原生 vibrancy 状态，避免重复的 IPC/原生调用 */
let nativeVibrancyApplied: boolean | null = null;

/** Keep the native Sidebar material in the same light/dark appearance as CSS. */
export async function syncNativeWindowAppearance(isDark: boolean): Promise<void> {
  if (!isTauriRuntime || !isMacOS()) {
    return;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_window_appearance', { dark: isDark });
  } catch (err) {
    console.warn('[sidebarTranslucency] 原生窗口外观同步失败:', err);
  }
}

/** Remove the legacy titlebar overlay that could cover WebView chrome. */
export async function clearNativeTitlebarSidebarMaterial(): Promise<void> {
  if (!isTauriRuntime || !isMacOS()) {
    return;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('sync_titlebar_sidebar_material', {
      enabled: false,
      width: 0,
    });
  } catch (err) {
    console.warn('[sidebarTranslucency] 原生标题栏侧栏材质同步失败:', err);
  }
}

export async function applySidebarTranslucency(enabled: boolean): Promise<void> {
  const root = document.documentElement;
  root.setAttribute(TRANSLUCENT_ATTR, String(enabled));

  if (!isTauriRuntime || !isMacOS()) {
    root.setAttribute(VIBRANCY_ATTR, 'false');
    return;
  }

  if (nativeVibrancyApplied === enabled) {
    root.setAttribute(VIBRANCY_ATTR, String(enabled));
    return;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const native = await invoke<boolean>('set_sidebar_vibrancy', { enabled });
    nativeVibrancyApplied = enabled;
    root.setAttribute(VIBRANCY_ATTR, String(enabled && native === true));
  } catch (err) {
    // 原生调用失败时退回纯 CSS 半透明，不阻塞设置本身
    console.warn('[sidebarTranslucency] 原生 vibrancy 调用失败，退回 CSS 方案:', err);
    nativeVibrancyApplied = null;
    root.setAttribute(VIBRANCY_ATTR, 'false');
  }
}
