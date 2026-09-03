import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, Moon, Sun, CircleNotch } from '@phosphor-icons/react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { AppSelect, type AppSelectGroup } from '@/components/ui/app-menu';
import { SettingSection } from './SettingsCommon';
import { AccentPicker } from './AccentPicker';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { isMacOS, isMobilePlatform } from '@/utils/platform';
import { applySidebarTranslucency } from '@/utils/sidebarTranslucency';
import type { ThemeMode, ThemePalette } from '@/hooks/useTheme';
import {
  DEFAULT_UI_FONT,
  DEFAULT_UI_FONT_SIZE,
  UI_FONT_PRESET_GROUPS,
  UI_FONT_SIZE_PRESETS,
} from '@/config/fontConfig';
import { SettingRow, SettingsGroup, SwitchRow } from './settingsTabPrimitives';
import { APP_EVENTS, addAppEventListener, dispatchAppEvent } from '@/events';

const DEFAULT_UI_ZOOM = 1.0;
const MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY = 'macos.native_font_smoothing';
const SIDEBAR_TRANSLUCENT_KEY = 'sidebar.translucent';
const POINTER_CURSOR_SETTING_KEY = 'ui.pointer_cursor';
const THINKING_AUTO_COLLAPSE_KEY = 'thinking.auto_collapse';
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
  const [macosNativeFontSmoothingEnabled, setMacosNativeFontSmoothingEnabled] = useState<boolean | null>(null);
  const [sidebarTranslucent, setSidebarTranslucent] = useState<boolean | null>(null);
  const [pointerCursorEnabled, setPointerCursorEnabled] = useState<boolean | null>(null);
  const [thinkingAutoCollapse, setThinkingAutoCollapse] = useState<boolean | null>(null);

  useEffect(() => {
    if (isMobilePlatform()) return;

    let cancelled = false;
    const loadSidebarTranslucent = async () => {
      try {
        const val = await tauriInvoke<string | null>('get_setting', { key: SIDEBAR_TRANSLUCENT_KEY }).catch(() => null);
        if (cancelled) return;
        const enabled = String(val ?? '').trim() === 'true';
        setSidebarTranslucent(enabled);
        void applySidebarTranslucency(enabled);
      } catch {
        if (cancelled) return;
        setSidebarTranslucent(false);
      }
    };
    void loadSidebarTranslucent();

    const dispose = addAppEventListener(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, (detail) => {
      if (detail?.settingKey === SIDEBAR_TRANSLUCENT_KEY) {
        void loadSidebarTranslucent();
      }
    });

    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    if (isMobilePlatform()) return;

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
    let cancelled = false;
    (async () => {
      try {
        const raw = await tauriInvoke<string | null>('get_setting', {
          key: THINKING_AUTO_COLLAPSE_KEY,
        }).catch(() => null);
        if (cancelled) return;
        const enabled = String(raw ?? '').trim() !== 'false';
        setThinkingAutoCollapse(enabled);
        document.documentElement.setAttribute('data-auto-collapse-thinking', String(enabled));
        dispatchAppEvent(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, {
          settingKey: THINKING_AUTO_COLLAPSE_KEY,
          value: enabled,
        });
      } catch {
        if (cancelled) return;
        setThinkingAutoCollapse(true);
        document.documentElement.setAttribute('data-auto-collapse-thinking', 'true');
        dispatchAppEvent(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, {
          settingKey: THINKING_AUTO_COLLAPSE_KEY,
          value: true,
        });
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
      label: t('settings:theme.modes.light'),
      icon: Sun,
    },
    {
      mode: 'dark' as const,
      label: t('settings:theme.modes.dark'),
      icon: Moon,
    },
    {
      mode: 'auto' as const,
      label: t('settings:theme.system_default'),
      icon: Monitor,
      title: t('settings:theme.system_default_hint'),
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
    if (macosNativeFontSmoothingEnabled === null) return;
    const previousValue = macosNativeFontSmoothingEnabled;
    setMacosNativeFontSmoothingEnabled(checked);

    if (!invoke) return;

    try {
      await (invoke as typeof tauriInvoke)('save_setting', {
        key: MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY,
        value: String(checked),
      });

      dispatchAppEvent(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, {
        macosFontSmoothing: true,
        settingKey: MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY,
      });
    } catch (error: unknown) {
      setMacosNativeFontSmoothingEnabled(previousValue);
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [invoke, macosNativeFontSmoothingEnabled]);

  const handleSidebarTranslucentChange = React.useCallback(async (checked: boolean) => {
    if (sidebarTranslucent === null) return;
    const previousValue = sidebarTranslucent;
    setSidebarTranslucent(checked);
    void applySidebarTranslucency(checked);

    if (!invoke) return;

    try {
      await (invoke as typeof tauriInvoke)('save_setting', {
        key: SIDEBAR_TRANSLUCENT_KEY,
        value: String(checked),
      });
    } catch (error: unknown) {
      setSidebarTranslucent(previousValue);
      void applySidebarTranslucency(previousValue);
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [invoke, sidebarTranslucent]);

  const handlePointerCursorChange = React.useCallback(async (checked: boolean) => {
    if (pointerCursorEnabled === null) return;
    const previousValue = pointerCursorEnabled;
    setPointerCursorEnabled(checked);
    document.documentElement.setAttribute('data-pointer-cursor', String(checked));

    if (!invoke) return;

    try {
      await (invoke as typeof tauriInvoke)('save_setting', {
        key: POINTER_CURSOR_SETTING_KEY,
        value: String(checked),
      });

      dispatchAppEvent(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, {
        pointerCursor: true,
        settingKey: POINTER_CURSOR_SETTING_KEY,
        value: checked,
      });
    } catch (error: unknown) {
      setPointerCursorEnabled(previousValue);
      document.documentElement.setAttribute('data-pointer-cursor', String(previousValue));
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [invoke, pointerCursorEnabled]);

  // 同步 DB 副本 theme_palette（localStorage 是主源，DB 副本供 Agent 工具/导出读取，
  // 之前只在设置页 autoSave 链路里偶发写入，长期漂移）
  const persistThemePalette = React.useCallback((palette: ThemePalette) => {
    if (!invoke) return;
    void (invoke as typeof tauriInvoke)('save_setting', { key: 'theme_palette', value: palette })
      .catch((error: unknown) => {
        console.warn('Failed to persist theme_palette:', getErrorMessage(error));
      });
  }, [invoke]);

  const handleThemePaletteChange = React.useCallback((palette: ThemePalette) => {
    setThemePalette(palette);
    persistThemePalette(palette);
  }, [persistThemePalette, setThemePalette]);

  const handleCustomColorChange = React.useCallback((color: string) => {
    setCustomColor(color);
    persistThemePalette('custom');
  }, [persistThemePalette, setCustomColor]);

  const handleThinkingAutoCollapseChange = React.useCallback(async (checked: boolean) => {
    if (thinkingAutoCollapse === null) return;
    const previousValue = thinkingAutoCollapse;
    setThinkingAutoCollapse(checked);
    document.documentElement.setAttribute('data-auto-collapse-thinking', String(checked));

    dispatchAppEvent(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, {
      settingKey: THINKING_AUTO_COLLAPSE_KEY,
      value: checked,
    });

    if (!invoke) return;

    try {
      await (invoke as typeof tauriInvoke)('save_setting', {
        key: THINKING_AUTO_COLLAPSE_KEY,
        value: String(checked),
      });
    } catch (error: unknown) {
      setThinkingAutoCollapse(previousValue);
      document.documentElement.setAttribute('data-auto-collapse-thinking', String(previousValue));
      dispatchAppEvent(APP_EVENTS.SYSTEM_SETTINGS_CHANGED, {
        settingKey: THINKING_AUTO_COLLAPSE_KEY,
        value: previousValue,
      });
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [invoke, thinkingAutoCollapse]);

  return (
    <div className="space-y-1 pb-10 text-left ui-fade-in-slow" data-tour-id="appearance-settings">
      <SettingSection
        title={t('settings:tabs.appearance')}
        description={t('settings:study_ui_descriptions.appearance')}
        className="overflow-visible"
        dataTourId="theme-section"
        hideHeader
      >
        <SettingsGroup
          title={t('settings:groups.appearance')}
        >
            <SettingRow
              title={t('settings:theme.row_title')}
              className="items-stretch md:!items-center"
            >
              <SegmentedControl
                ariaLabel={t('settings:theme.mode_label')}
                value={themeMode}
                onValueChange={(nextMode) => { void handleThemeModeChange(nextMode); }}
                stretch
                className="w-full md:w-auto"
                itemClassName="[@media(pointer:coarse)]:!min-h-11"
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
                title={t('settings:theme.font_smoothing_title')}
                description={t('settings:theme.font_smoothing_description')}
                checked={macosNativeFontSmoothingEnabled ?? true}
                loading={macosNativeFontSmoothingEnabled === null}
                onCheckedChange={(checked) => {
                  void handleMacosNativeFontSmoothingChange(checked);
                }}
              />
            )}

            {!isMobilePlatform() && (
              <SwitchRow
                title={t('settings:theme.sidebar_translucent_title')}
                description={t('settings:theme.sidebar_translucent_description')}
                checked={sidebarTranslucent ?? false}
                loading={sidebarTranslucent === null}
                onCheckedChange={(checked) => {
                  void handleSidebarTranslucentChange(checked);
                }}
              />
            )}

            {!isMobilePlatform() && (
              <SwitchRow
                title={t('settings:theme.pointer_cursor_title')}
                description={t('settings:theme.pointer_cursor_description')}
                checked={pointerCursorEnabled ?? true}
                loading={pointerCursorEnabled === null}
                onCheckedChange={(checked) => {
                  void handlePointerCursorChange(checked);
                }}
              />
            )}

            <SwitchRow
              title={t('settings:theme.thinking_auto_collapse_title')}
              description={t('settings:theme.thinking_auto_collapse_description')}
              checked={thinkingAutoCollapse ?? true}
              loading={thinkingAutoCollapse === null}
              onCheckedChange={(checked) => {
                void handleThinkingAutoCollapseChange(checked);
              }}
            />

            <SettingRow
              title={t('settings:zoom.title')}
              description={zoomLoading ? t('settings:zoom.loading') : t('settings:zoom.status_current', { value: formatZoomLabel(uiZoom) })}
            >
              {isTauriEnvironment ? (
                <div className="flex w-full flex-wrap items-center justify-end gap-2 md:w-auto md:justify-start">
                  <AppSelect
                    value={uiZoom.toString()}
                    onValueChange={val => { void handleZoomChange(parseFloat(val)); }}
                    disabled={zoomSaving || zoomLoading}
                    placeholder={t('settings:zoom.select_placeholder')}
                    options={UI_ZOOM_PRESETS.map(option => ({ value: option.value.toString(), label: option.label }))}
                    variant="outline"
                    className="bg-transparent transition-colors hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:!min-h-11"
                    width={90}
                  />
                  <DsButton
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={zoomSaving || Math.abs(uiZoom - DEFAULT_UI_ZOOM) < 0.0001}
                    onClick={handleZoomReset}
                    className="min-h-11 md:min-h-0 [@media(pointer:coarse)]:!min-h-11"
                  >
                    {zoomSaving && <CircleNotch size={12} className="animate-spin mr-1" />}
                    {t('settings:zoom.reset')}
                  </DsButton>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground/70">
                  {t('settings:zoom.not_supported')}
                </div>
              )}
            </SettingRow>

            <SettingRow
              title={t('settings:font.title')}
              description={fontLoading ? t('settings:font.loading') : t('settings:font.status_current', { font: t(`settings:font.presets.${uiFont.replace(/-/g, '_')}`) })}
            >
              <div className="flex w-full flex-wrap items-center justify-end gap-2 md:w-auto md:justify-start">
                <DsButton
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={fontSaving || uiFont === DEFAULT_UI_FONT}
                  onClick={handleFontReset}
                  className="min-h-11 md:min-h-0 [@media(pointer:coarse)]:!min-h-11"
                >
                  {fontSaving && <CircleNotch size={12} className="animate-spin mr-1" />}
                  {t('settings:font.reset')}
                </DsButton>
                <AppSelect
                  value={uiFont}
                  onValueChange={val => { void handleFontChange(val); }}
                  groups={fontSelectGroups}
                  placeholder={t('settings:font.select_placeholder')}
                  disabled={fontSaving || fontLoading}
                  width={180}
                  variant="outline"
                  className="max-w-full bg-transparent transition-colors hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:!min-h-11"
                />
              </div>
            </SettingRow>

            <SettingRow
              title={t('settings:font.size_title')}
              description={fontSizeLoading ? t('settings:font.size_loading') : t('settings:font.size_status_current', { value: formatFontSizeLabel(uiFontSize) })}
            >
              <div className="flex w-full flex-wrap items-center justify-end gap-2 md:w-auto md:justify-start">
                <AppSelect
                  value={uiFontSize.toString()}
                  onValueChange={val => { void handleFontSizeChange(parseFloat(val)); }}
                  disabled={fontSizeSaving || fontSizeLoading}
                  placeholder={t('settings:font.size_select_placeholder')}
                  options={UI_FONT_SIZE_PRESETS.map(option => ({ value: option.value.toString(), label: option.label }))}
                  variant="outline"
                  className="bg-transparent transition-colors hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:!min-h-11"
                  width={90}
                />
                <DsButton
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={fontSizeSaving || Math.abs(uiFontSize - DEFAULT_UI_FONT_SIZE) < 0.0001}
                  onClick={handleFontSizeReset}
                  className="min-h-11 md:min-h-0 [@media(pointer:coarse)]:!min-h-11"
                >
                  {fontSizeSaving && <CircleNotch size={12} className="animate-spin mr-1" />}
                  {t('settings:font.size_reset')}
                </DsButton>
              </div>
            </SettingRow>

            <div className="group rounded-[var(--button-radius)] px-1 py-2.5">
              <div className="mb-3">
                <h3 className="text-sm text-foreground/90 leading-tight">
                  {t('settings:theme.accent_label')}
                </h3>
                <p className="text-xs text-muted-foreground/70 leading-relaxed mt-0.5">
                  {t('settings:theme.accent_hint')}
                </p>
              </div>
              <AccentPicker
                palette={themePalette}
                customColor={customColor}
                onSelectPreset={handleThemePaletteChange}
                onSelectCustomColor={handleCustomColorChange}
              />
            </div>
        </SettingsGroup>
      </SettingSection>
    </div>
  );
};

export default AppearanceTab;
