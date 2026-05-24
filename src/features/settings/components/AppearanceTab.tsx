import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, Moon, Sun, CircleNotch } from '@phosphor-icons/react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

import { NotionButton } from '@/components/ui/NotionButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { AppSelect, type AppSelectGroup } from '@/components/ui/app-menu';
import { SettingSection } from './SettingsCommon';
import { AccentPicker } from './AccentPicker';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { isMacOS } from '@/utils/platform';
import type { ThemeMode, ThemePalette } from '@/hooks/useTheme';
import {
  DEFAULT_UI_FONT,
  DEFAULT_UI_FONT_SIZE,
  UI_FONT_PRESET_GROUPS,
  UI_FONT_SIZE_PRESETS,
} from '@/config/fontConfig';
import { SettingRow, SettingsGroup, SwitchRow } from './settingsTabPrimitives';

const DEFAULT_UI_ZOOM = 1.0;
const MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY = 'macos.native_font_smoothing';
const SIDEBAR_TRANSLUCENT_KEY = 'sidebar.translucent';
const POINTER_CURSOR_SETTING_KEY = 'ui.pointer_cursor';
const UI_ZOOM_PRESETS = [
  { value: 0.8, label: '80%' },
  { value: 0.9, label: '90%' },
  { value: 1.0, label: '100%' },
  { value: 1.1, label: '110%' },
  { value: 1.2, label: '120%' },
  { value: 1.3, label: '130%' },
  { value: 1.5, label: '150%' },
];

const formatZoomLabel = (val: number) => `${Math.round(val * 100)}%`;
const formatFontSizeLabel = (val: number) => `${Math.round(val * 100)}%`;

interface AppearanceTabProps {
  uiZoom: number;
  zoomLoading: boolean;
  zoomSaving: boolean;
  zoomStatus: { type: 'idle' | 'success' | 'error'; message?: string };
  handleZoomChange: (value: number) => Promise<void>;
  handleZoomReset: () => void;
  uiFont: string;
  fontLoading: boolean;
  fontSaving: boolean;
  handleFontChange: (value: string) => Promise<void>;
  handleFontReset: () => void;
  uiFontSize: number;
  fontSizeLoading: boolean;
  fontSizeSaving: boolean;
  handleFontSizeChange: (value: number) => Promise<void>;
  handleFontSizeReset: () => void;
  themeMode: ThemeMode;
  isSystemDark: boolean;
  setThemeMode: (mode: ThemeMode) => void;
  themePalette: ThemePalette;
  setThemePalette: (palette: ThemePalette) => void;
  customColor: string;
  setCustomColor: (color: string) => void;
  isTauriEnvironment: boolean;
  invoke: typeof tauriInvoke | null;
}

export const AppearanceTab: React.FC<AppearanceTabProps> = ({
  uiZoom,
  zoomLoading,
  zoomSaving,
  zoomStatus: _zoomStatus,
  handleZoomChange,
  handleZoomReset,
  uiFont,
  fontLoading,
  fontSaving,
  handleFontChange,
  handleFontReset,
  uiFontSize,
  fontSizeLoading,
  fontSizeSaving,
  handleFontSizeChange,
  handleFontSizeReset,
  themeMode,
  isSystemDark: _isSystemDark,
  setThemeMode,
  themePalette,
  setThemePalette,
  customColor,
  setCustomColor,
  isTauriEnvironment,
  invoke,
}) => {
  const { t } = useTranslation(['settings']);
  const [macosNativeFontSmoothingEnabled, setMacosNativeFontSmoothingEnabled] = useState(true);
  const [sidebarTranslucent, setSidebarTranslucent] = useState(false);
  const [pointerCursorEnabled, setPointerCursorEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const val = await tauriInvoke<string | null>('get_setting', { key: SIDEBAR_TRANSLUCENT_KEY }).catch(() => null);
        if (cancelled) return;
        const enabled = String(val ?? '').trim() === 'true';
        setSidebarTranslucent(enabled);
        document.documentElement.setAttribute('data-sidebar-translucent', String(enabled));
      } catch {
        if (cancelled) return;
        setSidebarTranslucent(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await tauriInvoke<string | null>('get_setting', {
          key: POINTER_CURSOR_SETTING_KEY,
        }).catch(() => null);
        if (cancelled) return;
        const enabled = String(raw ?? '').trim() !== 'false';
        setPointerCursorEnabled(enabled);
        document.documentElement.setAttribute('data-pointer-cursor', String(enabled));
      } catch {
        if (cancelled) return;
        setPointerCursorEnabled(true);
        document.documentElement.setAttribute('data-pointer-cursor', 'true');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isMacOS()) return;

    let cancelled = false;
    (async () => {
      try {
        const raw = await tauriInvoke<string | null>('get_setting', {
          key: MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY,
        }).catch(() => null);
        if (cancelled) return;
        setMacosNativeFontSmoothingEnabled(String(raw ?? '').trim() !== 'false');
      } catch {
        if (cancelled) return;
        setMacosNativeFontSmoothingEnabled(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const fontSelectGroups = React.useMemo<AppSelectGroup[]>(() => {
    return UI_FONT_PRESET_GROUPS.map(group => ({
      label: t(group.groupKey),
      options: group.presets.map(preset => ({
        value: preset.value,
        label: t(preset.labelKey),
      })),
    }));
  }, [t]);

  const themeModeOptions = React.useMemo(() => [
    {
      mode: 'light' as const,
      label: t('settings:theme.modes.light', '浅色'),
      icon: Sun,
    },
    {
      mode: 'dark' as const,
      label: t('settings:theme.modes.dark', '深色'),
      icon: Moon,
    },
    {
      mode: 'auto' as const,
      label: t('settings:theme.system_default', '系统默认'),
      icon: Monitor,
      title: t('settings:theme.system_default_hint', '匹配系统外观设置'),
    },
  ], [t]);

  const handleThemeModeChange = React.useCallback(async (nextMode: ThemeMode) => {
    if (nextMode === themeMode) return;

    const previousMode = themeMode;
    setThemeMode(nextMode);

    if (!invoke) return;

    try {
      await (invoke as typeof tauriInvoke)('save_setting', { key: 'theme', value: nextMode });
    } catch (error: unknown) {
      setThemeMode(previousMode);
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [invoke, setThemeMode, themeMode]);

  const handleMacosNativeFontSmoothingChange = React.useCallback(async (checked: boolean) => {
    const previousValue = macosNativeFontSmoothingEnabled;
    setMacosNativeFontSmoothingEnabled(checked);

    if (!invoke) return;

    try {
      await (invoke as typeof tauriInvoke)('save_setting', {
        key: MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY,
        value: String(checked),
      });

      window.dispatchEvent(
        new CustomEvent('systemSettingsChanged', {
          detail: {
            macosFontSmoothing: true,
            settingKey: MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY,
          },
        }),
      );
    } catch (error: unknown) {
      setMacosNativeFontSmoothingEnabled(previousValue);
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [invoke, macosNativeFontSmoothingEnabled]);

  const handleSidebarTranslucentChange = React.useCallback(async (checked: boolean) => {
    const previousValue = sidebarTranslucent;
    setSidebarTranslucent(checked);
    document.documentElement.setAttribute('data-sidebar-translucent', String(checked));

    if (!invoke) return;

    try {
      await (invoke as typeof tauriInvoke)('save_setting', {
        key: SIDEBAR_TRANSLUCENT_KEY,
        value: String(checked),
      });
    } catch (error: unknown) {
      setSidebarTranslucent(previousValue);
      document.documentElement.setAttribute('data-sidebar-translucent', String(previousValue));
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [invoke, sidebarTranslucent]);

  const handlePointerCursorChange = React.useCallback(async (checked: boolean) => {
    const previousValue = pointerCursorEnabled;
    setPointerCursorEnabled(checked);
    document.documentElement.setAttribute('data-pointer-cursor', String(checked));

    if (!invoke) return;

    try {
      await (invoke as typeof tauriInvoke)('save_setting', {
        key: POINTER_CURSOR_SETTING_KEY,
        value: String(checked),
      });

      window.dispatchEvent(
        new CustomEvent('systemSettingsChanged', {
          detail: {
            pointerCursor: true,
            settingKey: POINTER_CURSOR_SETTING_KEY,
          },
        }),
      );
    } catch (error: unknown) {
      setPointerCursorEnabled(previousValue);
      document.documentElement.setAttribute('data-pointer-cursor', String(previousValue));
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [invoke, pointerCursorEnabled]);

  return (
    <div className="space-y-1 pb-10 text-left animate-in fade-in duration-500" data-tour-id="appearance-settings">
      <SettingSection
        title={t('settings:tabs.appearance', '外观')}
        description={t('settings:study_ui_descriptions.appearance', '自定义主题、字体、缩放和界面视觉风格。')}
        className="overflow-visible"
        dataTourId="theme-section"
        hideHeader
      >
        <SettingsGroup
          title={t('settings:groups.appearance', '界面外观')}
          description={t('settings:study_ui_descriptions.appearance', '自定义主题、字体、缩放和界面视觉风格。')}
        >
            <SettingRow
              title={t('settings:theme.row_title', '外观 / 主题')}
              description={t('settings:theme.row_description', '使用浅色、深色，或匹配系统设置')}
              className="items-center"
            >
              <SegmentedControl
                ariaLabel={t('settings:theme.mode_label', '选择主题模式')}
                value={themeMode}
                onValueChange={(nextMode) => { void handleThemeModeChange(nextMode); }}
                stretch
                options={themeModeOptions.map(({ mode, label, icon: Icon, title }) => ({
                  value: mode,
                  title,
                  label: (
                    <>
                      <Icon className="h-[18px] w-[18px]" weight="bold" aria-hidden="true" />
                      <span>{label}</span>
                    </>
                  ),
                }))}
              />
            </SettingRow>

            {isMacOS() && (
              <SwitchRow
                title={t('settings:theme.font_smoothing_title', 'macOS 原生字体平滑')}
                description={t(
                  'settings:theme.font_smoothing_description',
                  '在 macOS 下优先跟随系统默认字体平滑策略，不再全局强制 antialiased。关闭后回退为兼容旧版观感的灰度平滑。',
                )}
                checked={macosNativeFontSmoothingEnabled}
                onCheckedChange={(checked) => {
                  void handleMacosNativeFontSmoothingChange(checked);
                }}
              />
            )}

            <SwitchRow
              title={t('settings:theme.sidebar_translucent_title', '侧边栏半透明')}
              description={t(
                'settings:theme.sidebar_translucent_description',
                '开启后侧边栏背景变为半透明毛玻璃效果，可透视桌面内容。',
              )}
              checked={sidebarTranslucent}
              onCheckedChange={(checked) => {
                void handleSidebarTranslucentChange(checked);
              }}
            />

            <SwitchRow
              title={t('settings:theme.pointer_cursor_title', '使用指针光标')}
              description={t(
                'settings:theme.pointer_cursor_description',
                '悬停交互元素时切换为指针光标。',
              )}
              checked={pointerCursorEnabled}
              onCheckedChange={(checked) => {
                void handlePointerCursorChange(checked);
              }}
            />

            <SettingRow
              title={t('settings:zoom.title')}
              description={zoomLoading ? t('settings:zoom.loading') : t('settings:zoom.status_current', { value: formatZoomLabel(uiZoom) })}
            >
              {isTauriEnvironment ? (
                <div className="flex items-center gap-2">
                  <AppSelect
                    value={uiZoom.toString()}
                    onValueChange={val => { void handleZoomChange(parseFloat(val)); }}
                    disabled={zoomSaving || zoomLoading}
                    placeholder={t('settings:zoom.select_placeholder')}
                    options={UI_ZOOM_PRESETS.map(option => ({ value: option.value.toString(), label: option.label }))}
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs bg-transparent hover:bg-[var(--interactive-hover)] transition-colors"
                    width={90}
                  />
                  <NotionButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={zoomSaving || Math.abs(uiZoom - DEFAULT_UI_ZOOM) < 0.0001}
                    onClick={handleZoomReset}
                  >
                    {zoomSaving && <CircleNotch size={12} className="animate-spin mr-1" />}
                    {t('settings:zoom.reset')}
                  </NotionButton>
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground/70">
                  {t('settings:zoom.not_supported')}
                </div>
              )}
            </SettingRow>

            <SettingRow
              title={t('settings:font.title')}
              description={fontLoading ? t('settings:font.loading') : t('settings:font.status_current', { font: t(`settings:font.presets.${uiFont.replace(/-/g, '_')}`) })}
            >
              <div className="flex items-center gap-2">
                <NotionButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={fontSaving || uiFont === DEFAULT_UI_FONT}
                  onClick={handleFontReset}
                >
                  {fontSaving && <CircleNotch size={12} className="animate-spin mr-1" />}
                  {t('settings:font.reset')}
                </NotionButton>
                <AppSelect
                  value={uiFont}
                  onValueChange={val => { void handleFontChange(val); }}
                  groups={fontSelectGroups}
                  placeholder={t('settings:font.select_placeholder')}
                  disabled={fontSaving || fontLoading}
                  width={180}
                  variant="outline"
                  className="h-8 text-xs bg-transparent hover:bg-[var(--interactive-hover)] transition-colors"
                />
              </div>
            </SettingRow>

            <SettingRow
              title={t('settings:font.size_title')}
              description={fontSizeLoading ? t('settings:font.size_loading') : t('settings:font.size_status_current', { value: formatFontSizeLabel(uiFontSize) })}
            >
              <div className="flex items-center gap-2">
                <AppSelect
                  value={uiFontSize.toString()}
                  onValueChange={val => { void handleFontSizeChange(parseFloat(val)); }}
                  disabled={fontSizeSaving || fontSizeLoading}
                  placeholder={t('settings:font.size_select_placeholder')}
                  options={UI_FONT_SIZE_PRESETS.map(option => ({ value: option.value.toString(), label: option.label }))}
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs bg-transparent hover:bg-[var(--interactive-hover)] transition-colors"
                  width={90}
                />
                <NotionButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={fontSizeSaving || Math.abs(uiFontSize - DEFAULT_UI_FONT_SIZE) < 0.0001}
                  onClick={handleFontSizeReset}
                >
                  {fontSizeSaving && <CircleNotch size={12} className="animate-spin mr-1" />}
                  {t('settings:font.size_reset')}
                </NotionButton>
              </div>
            </SettingRow>

            <div className="group rounded-[var(--button-radius)] px-1 py-2.5">
              <div className="mb-3">
                <h3 className="text-sm text-foreground/90 leading-tight">
                  {t('settings:theme.accent_label', '强调色')}
                </h3>
                <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5">
                  {t('settings:theme.accent_hint', '只调整按钮、链接和选中态的颜色。不影响背景、卡片和文本。')}
                </p>
              </div>
              <AccentPicker
                palette={themePalette}
                customColor={customColor}
                onSelectPreset={setThemePalette}
                onSelectCustomColor={setCustomColor}
              />
            </div>
        </SettingsGroup>
      </SettingSection>
    </div>
  );
};

export default AppearanceTab;
