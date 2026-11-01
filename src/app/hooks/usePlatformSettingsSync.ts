import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isMacOS } from '@/utils/platform';
import { applySidebarTranslucency } from '@/utils/sidebarTranslucency';
import { syncAndroidImmersiveModeFromSettings } from '@/utils/androidImmersiveMode';
import { APP_EVENTS, addAppEventListener } from '@/events';

export const MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY = 'macos.native_font_smoothing';
export const POINTER_CURSOR_SETTING_KEY = 'ui.pointer_cursor';

export function applyMacOSFontSmoothingPreference(enabled: boolean) {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.dataset.fontSmoothing = enabled ? 'macos-native' : 'macos-grayscale';
}

export function applyPointerCursorPreference(enabled: boolean) {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.dataset.pointerCursor = enabled ? 'true' : 'false';
}

/**
 * App 壳层：启动时从设置库恢复平台 / 外观偏好并监听 SYSTEM_SETTINGS_CHANGED：
 * Android 沉浸式、桌面顶栏顶部边距、macOS 字体平滑、侧栏半透明、指针光标。
 * 从 App.tsx 原样搬出；返回桌面顶栏顶部边距。
 */
export function usePlatformSettingsSync(isSmallScreen: boolean) {
  // issue 472：Android 沉浸式全屏偏好在启动时下发一次（设置库为权威，原生侧仅作冷启动缓存）
  useEffect(() => {
    void syncAndroidImmersiveModeFromSettings();
  }, []);

  // 顶部栏顶部边距高度设置
  // 桌面端读取用户设置；移动端统一改由 mobile shell safe-area contract 提供。
  const [topbarTopMargin, setTopbarTopMargin] = useState<number>(0);
  useEffect(() => {
    let cancelled = false;
    if (isSmallScreen) {
      setTopbarTopMargin(0);
      return;
    }
    // 桌面端读取用户设置
    const loadSetting = async () => {
      try {
        const v = await invoke<string>('get_setting', { key: 'topbar.top_margin' });
        if (cancelled) return;
        const value = String(v ?? '').trim();
        if (value) {
          const numValue = parseInt(value, 10);
          setTopbarTopMargin(isNaN(numValue) || numValue < 0 ? 0 : numValue);
        } else {
          setTopbarTopMargin(0);
        }
      } catch {
        if (cancelled) return;
        setTopbarTopMargin(0);
      }
    };
    loadSetting();
    // 监听设置变化事件（owner: App shell；dispose 与 cancelled 同生命周期）
    const dispose = addAppEventListener(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, (detail) => {
      if (detail?.topbarTopMargin) {
        void loadSetting();
      }
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [isSmallScreen]); // 响应窗口大小变化，自动切换移动端/桌面端默认值

  useEffect(() => {
    if (!isMacOS()) {
      delete document.documentElement.dataset.fontSmoothing;
      return;
    }

    let cancelled = false;

    const loadFontSmoothingSetting = async () => {
      try {
        const value = await invoke<string | null>('get_setting', {
          key: MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY,
        });
        if (cancelled) return;
        applyMacOSFontSmoothingPreference(String(value ?? '').trim() !== 'false');
      } catch {
        if (cancelled) return;
        applyMacOSFontSmoothingPreference(true);
      }
    };

    void loadFontSmoothingSetting();

    const dispose = addAppEventListener(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, (detail) => {
      if (
        detail?.macosFontSmoothing ||
        detail?.settingKey === MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY
      ) {
        void loadFontSmoothingSetting();
      }
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  // 侧边栏半透明：启动时从持久化设置恢复（CSS 属性 + macOS 原生 vibrancy）
  useEffect(() => {
    let cancelled = false;
    const SIDEBAR_TRANSLUCENT_KEY = 'sidebar.translucent';

    const loadSidebarTranslucentSetting = async () => {
      try {
        const val = await invoke<string | null>('get_setting', { key: SIDEBAR_TRANSLUCENT_KEY });
        if (cancelled) return;
        void applySidebarTranslucency(String(val ?? '').trim() === 'true');
      } catch {
        if (cancelled) return;
        void applySidebarTranslucency(false);
      }
    };
    void loadSidebarTranslucentSetting();

    const dispose = addAppEventListener(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, (detail) => {
      if (detail?.settingKey === SIDEBAR_TRANSLUCENT_KEY) {
        void loadSidebarTranslucentSetting();
      }
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadPointerCursorSetting = async () => {
      try {
        const val = await invoke<string | null>('get_setting', { key: POINTER_CURSOR_SETTING_KEY });
        if (cancelled) return;
        applyPointerCursorPreference(String(val ?? '').trim() !== 'false');
      } catch {
        if (cancelled) return;
        applyPointerCursorPreference(true);
      }
    };

    void loadPointerCursorSetting();

    const dispose = addAppEventListener(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, (detail) => {
      if (
        detail?.pointerCursor ||
        detail?.settingKey === POINTER_CURSOR_SETTING_KEY
      ) {
        const enabled =
          typeof detail?.value === 'boolean'
            ? detail.value
            : String(detail?.value ?? '').trim() !== 'false';
        applyPointerCursorPreference(enabled);
      }
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  return { topbarTopMargin };
}
