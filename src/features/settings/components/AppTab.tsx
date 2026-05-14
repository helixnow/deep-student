/**
 * 应用设置 Tab 组件
 * 从 Settings.tsx 拆分，包含主题、语言、缩放等应用设置
 * Notion 风格：简洁、无边框、hover 效果
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
// Phosphor icons for the theme-mode SegmentedControl — rounded weight sits
// more comfortably inside the control's 36px thumb than lucide's SunMedium.
import { Monitor, Moon, Sun, CircleNotch } from '@phosphor-icons/react';
import { debugMasterSwitch } from '@/debug-panel/debugMasterSwitch';
import { NotionButton } from '@/components/ui/NotionButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/shad/Input';
import { Switch } from '@/components/ui/shad/Switch';
import { SettingSection } from './SettingsCommon';
import { MemorySettingsSection } from './MemorySettingsSection';
import { VoiceInputSettingsSection } from './VoiceInputSettingsSection';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { setPendingSettingsTab } from '@/utils/pendingSettingsTab';
import { isAndroid, isMacOS } from '@/utils/platform';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import {
  type ThemeMode,
  type ThemePalette,
} from '@/hooks/useTheme';
import { AccentPicker } from './AccentPicker';
import { DEFAULT_UI_FONT, DEFAULT_UI_FONT_SIZE, UI_FONT_PRESET_GROUPS, UI_FONT_SIZE_PRESETS } from '@/config/fontConfig';
import { AppSelect, type AppSelectGroup } from '@/components/ui/app-menu';
import { UserAgreementDialog } from '@/components/legal/UserAgreementDialog';
import { getDefaultConfig, configFromPreset, type CopyFilterConfig } from '@/features/chat/hooks/useDevShowRawRequest';
import type { VoiceInputAssignedModel } from '@/voice-input/types';

const DEFAULT_UI_ZOOM = 1.0;
const MACOS_NATIVE_FONT_SMOOTHING_SETTING_KEY = 'macos.native_font_smoothing';
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

// 内部组件：设置行 - Notion 风格（无 icon，与其他 Tab 保持一致）
const SettingRow = ({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) => (
  <div className={cn("group flex flex-col sm:flex-row sm:items-start gap-2 py-2.5 px-1 rounded overflow-hidden", className)}>
    <div className="flex-1 min-w-0 pt-1.5 sm:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <div className="flex-shrink-0">
      {children}
    </div>
  </div>
);

// 内部组件：带开关的设置行 - 与其他 Tab 保持一致
const SwitchRow = ({
  title,
  description,
  checked,
  onCheckedChange,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) => (
  <div className="group flex items-center justify-between gap-4 py-2.5 px-1 rounded">
    <div className="flex-1 min-w-0">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <Switch checked={checked} onCheckedChange={onCheckedChange} />
  </div>
);

// 分组标题 - 与其他 Tab 保持一致
const GroupTitle = ({ title }: { title: string }) => (
  <div className="px-1 mb-3 mt-0">
    <h3 className="text-base font-semibold text-foreground">{title}</h3>
  </div>
);

// Phase 3.1: 调色板预览样式函数已被 AccentPicker 取代

interface AppTabProps {
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
  topbarTopMargin: string;
  setTopbarTopMargin: (value: string) => void;
  logTypeForOpen: string;
  setLogTypeForOpen: (value: string) => void;
  showRawRequest: boolean;
  setShowRawRequest: (value: boolean) => void;
  isTauriEnvironment: boolean;
  invoke: typeof tauriInvoke | null;
  voiceInputAssignedModel: VoiceInputAssignedModel;
}

export const AppTab: React.FC<AppTabProps> = ({
  uiZoom, zoomLoading, zoomSaving, zoomStatus, handleZoomChange, handleZoomReset,
  uiFont, fontLoading, fontSaving, handleFontChange, handleFontReset,
  uiFontSize, fontSizeLoading, fontSizeSaving, handleFontSizeChange, handleFontSizeReset,
  themeMode, isSystemDark, setThemeMode,
  themePalette, setThemePalette, customColor, setCustomColor, topbarTopMargin, setTopbarTopMargin,
  logTypeForOpen, setLogTypeForOpen, showRawRequest, setShowRawRequest,
  isTauriEnvironment, invoke, voiceInputAssignedModel,
}) => {
  const { t, i18n } = useTranslation(['settings', 'common']);

  // 调试日志总开关状态
  const [debugLogEnabled, setDebugLogEnabled] = useState(() => debugMasterSwitch.isEnabled());

  // 🆕 Sentry 错误报告开关（合规要求：默认关闭）
  const SENTRY_CONSENT_KEY = 'sentry_error_reporting_enabled';
  const [sentryEnabled, setSentryEnabled] = useState(false);
  const [sentryLoading, setSentryLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const val = await tauriInvoke('get_setting', { key: SENTRY_CONSENT_KEY }) as string | null;
        setSentryEnabled(val === 'true');
      } catch {
        setSentryEnabled(false);
      } finally {
        setSentryLoading(false);
      }
    })();
  }, []);
  
  // 隐私协议预览弹窗状态
  const [showAgreementPreview, setShowAgreementPreview] = useState(false);
  const [macosNativeFontSmoothingEnabled, setMacosNativeFontSmoothingEnabled] = useState(true);

  // 侧边栏半透明开关
  const SIDEBAR_TRANSLUCENT_KEY = 'sidebar.translucent';
  const [sidebarTranslucent, setSidebarTranslucent] = useState(false);
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
    return () => { cancelled = true; };
  }, []);

  // 调试日志持久化 + 过滤配置
  const [debugPersistLogs, setDebugPersistLogs] = useState(false);
  const [filterConfig, setFilterConfig] = useState<CopyFilterConfig>(getDefaultConfig);
  const [debugLogsInfo, setDebugLogsInfo] = useState<{ count: number; total_size_display: string } | null>(null);
  const [debugLogsClearing, setDebugLogsClearing] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [persistVal, configVal, legacyLevelVal] = await Promise.all([
          tauriInvoke('get_setting', { key: 'debug.persist_logs' }).catch(() => 'false') as Promise<string>,
          tauriInvoke('get_setting', { key: 'debug.filter_config' }).catch(() => '') as Promise<string>,
          tauriInvoke('get_setting', { key: 'debug.filter_level' }).catch(() => '') as Promise<string>,
        ]);
        setDebugPersistLogs(String(persistVal ?? '') === 'true');
        const raw = String(configVal ?? '').trim();
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            setFilterConfig({ ...getDefaultConfig(), ...parsed });
          } catch { /* ignore parse error */ }
        } else {
          const lv = String(legacyLevelVal ?? '').trim().toLowerCase();
          if (lv === 'full' || lv === 'compact') {
            setFilterConfig(configFromPreset(lv as 'full' | 'compact'));
          }
        }
      } catch { /* defaults */ }
    })();
  }, []);

  useEffect(() => {
    if (!isMacOS()) {
      return;
    }

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

  const refreshDebugLogsInfo = React.useCallback(async () => {
    try {
      const info = await tauriInvoke('get_debug_logs_info') as { count: number; total_size_display: string };
      setDebugLogsInfo(info);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { refreshDebugLogsInfo(); }, [refreshDebugLogsInfo]);

  // 监听总开关变化
  useEffect(() => {
    const unsubscribe = debugMasterSwitch.addListener((enabled) => {
      setDebugLogEnabled(enabled);
    });
    return unsubscribe;
  }, []);

  // 将字体预设转换为 AppSelect 分组格式
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

  const languageOptions = React.useMemo(() => [
    { value: 'zh-CN', label: t('settings:language.chinese', '中文') },
    { value: 'en-US', label: t('settings:language.english', 'English') },
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

  // Phase 3.1: customPalettePreviewSwatch 已被 AccentPicker 取代（它直接使用 customColor）

  return (
    <div className="space-y-1 pb-10 text-left animate-in fade-in duration-500" data-tour-id="app-settings">
      <SettingSection
        title={t('settings:theme.title')}
        description={t('settings:theme.description')}
        className="overflow-visible"
        dataTourId="theme-section"
        hideHeader
      >
        {/* 1. 界面外观 */}
        <div>
          <GroupTitle title={t('settings:groups.appearance', '界面外观')} />
          <div className="space-y-px">
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
                      {/* Phosphor icons pick their visual weight via the
                          `weight` prop; `bold` sits closest to lucide
                          SunMedium/strokeWidth=2 density without ever
                          triggering currentColor re-hint jitter. */}
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

            {/* 侧边栏半透明 */}
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

            {/* 语言切换 */}
            <SettingRow
              title={t('settings:language.title')}
              description={t('common:status.current', '当前') + ': ' + (i18n.language === 'zh-CN' ? t('settings:language.chinese', '中文') : t('settings:language.english', 'English'))}
              className="items-center"
            >
              <SegmentedControl
                ariaLabel={t('settings:language.select_label', '选择语言')}
                value={i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US'}
                onValueChange={(nextValue) => {
                  void i18n.changeLanguage(nextValue);
                }}
                stretch
                options={languageOptions.map((option) => ({
                  value: option.value,
                  label: <span>{option.label}</span>,
                }))}
              />
            </SettingRow>

            {/* 界面缩放 */}
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

            {/* 界面字体 */}
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

            {/* 字体大小 */}
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

            {/* 强调色 */}
            <div className="group py-2.5 px-1">
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
          </div>
        </div>

        <VoiceInputSettingsSection assignedModel={voiceInputAssignedModel} />

        {/* 2. 开发者选项 */}
        <div className="mt-8">
          <GroupTitle title={t('settings:cards.developer_options_title')} />
          <div className="space-y-px">
            {/* 顶部栏边距 */}
            <SettingRow
              title={t('settings:developer.topbar_top_margin.title', '顶部栏顶部边距高度')}
              description={t('settings:developer.topbar_top_margin.desc', '调整顶部边距高度')}
            >
              <div className="flex items-center gap-2">
                <Input 
                  type="number" 
                  value={topbarTopMargin} 
                  onChange={(e) => setTopbarTopMargin(e.target.value.trim())} 
                  onBlur={async () => {
                    if (!invoke) return;
                    try {
                      const numValue = parseInt(topbarTopMargin, 10);
                      const platformDefault = isAndroid() ? 30 : 0;
                      if (isNaN(numValue) || numValue < 0) { 
                        setTopbarTopMargin(String(platformDefault)); 
                        return; 
                      }
                      await (invoke as typeof tauriInvoke)('save_setting', { key: 'topbar.top_margin', value: String(numValue) });
                      setTopbarTopMargin(String(numValue));
                      showGlobalNotification('success', t('settings:save_success'));
                      try { 
                        window.dispatchEvent(new CustomEvent('systemSettingsChanged', { detail: { topbarTopMargin: true } })); 
                      } catch {
                        // noop: this event is best-effort
                      }
                    } catch (error: unknown) { 
                      showGlobalNotification('error', getErrorMessage(error)); 
                    }
                  }} 
                  placeholder={isAndroid() ? '30' : '0'} 
                  className="!w-20 h-8 text-xs bg-transparent" 
                  min="0" 
                />
                <span className="text-[11px] text-muted-foreground/70">{t('settings:developer.units.px')}</span>
              </div>
            </SettingRow>

            {/* 调试日志总开关 */}
            <SwitchRow
              title={t('settings:developer.debug_log_switch.title', '调试日志总开关')}
              description={t('settings:developer.debug_log_switch.desc', '关闭后，前端控制台不会输出调试日志，可避免生产环境性能问题。开启后，调试面板插件才会正常工作。')}
              checked={debugLogEnabled}
              onCheckedChange={(newValue) => {
                if (newValue) {
                  debugMasterSwitch.enable();
                } else {
                  debugMasterSwitch.disable();
                }
              }}
            />

            {/* 打开调试面板 */}
            <NotionButton 
              variant="default" 
              size="sm" 
              onClick={() => { 
                try { 
                  const win: any = window; 
                  if (typeof win.DSTU_OPEN_DEBUGGER === 'function') {
                    win.DSTU_OPEN_DEBUGGER(); 
                  } else { 
                    window.dispatchEvent(new Event('DSTU_OPEN_DEBUGGER')); 
                  } 
                } catch {
                  // noop: opening the unified debugger is best-effort
                }
              }}
            >
              {t('common:debug_panel.open_unified', t('common:debug_panel.open'))}
            </NotionButton>

            {/* 日志文件夹 */}
            <SettingRow
              title={t('settings:developer.log_type', '日志类型')}
              description={t('settings:developer.log_type_hint', '选择并打开对应类型的日志文件夹')}
            >
              <div className="flex items-center gap-2">
                <AppSelect
                  value={logTypeForOpen}
                  onValueChange={setLogTypeForOpen}
                  placeholder={t('settings:developer.log_type_placeholder', '选择')}
                  options={[
                    { value: 'backend', label: t('settings:developer.log_types.backend', '后端') },
                    { value: 'frontend', label: t('settings:developer.log_types.frontend', '前端') },
                    { value: 'debug', label: t('settings:developer.log_types.debug', '调试') },
                    { value: 'crash', label: t('settings:developer.log_types.crash', '崩溃') },
                  ]}
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs bg-transparent hover:bg-[var(--interactive-hover)] transition-colors"
                  width={80}
                />
                <NotionButton 
                  variant="primary" 
                  size="sm" 
                  onClick={async () => { 
                    try { 
                      await tauriInvoke('open_logs_folder', { logType: logTypeForOpen }); 
                    } catch (e: unknown) { 
                      showGlobalNotification('error', t('settings:developer.open_logs_failed', '打开日志文件夹失败')); 
                    } 
                  }}
                >
                  {t('settings:developer.open_logs', '打开')}
                </NotionButton>
              </div>
            </SettingRow>

            {/* 预览隐私协议 */}
            <SettingRow
              title={t('settings:developer.preview_agreement.title', '预览隐私协议')}
              description={t('settings:developer.preview_agreement.desc', '打开首次安装时显示的用户协议与隐私政策弹窗，用于预览效果。')}
            >
              <NotionButton 
                variant="default" 
                size="sm" 
                onClick={() => setShowAgreementPreview(true)}
              >
                {t('settings:developer.preview_agreement.button', '打开预览')}
              </NotionButton>
            </SettingRow>

            {/* 显示消息请求体 */}
            <SwitchRow
              title={t('settings:developer.show_raw_request.title', '显示消息请求体')}
              description={t('settings:developer.show_raw_request.desc', '开启后，Chat V2 中每条助手消息下方将显示完整的 API 请求体，便于调试。')}
              checked={showRawRequest}
              onCheckedChange={async (newValue) => {
                setShowRawRequest(newValue);
                if (!invoke) return;
                try {
                  await (invoke as typeof tauriInvoke)('save_setting', { key: 'dev.show_raw_request', value: String(newValue) });
                  showGlobalNotification('success', t('settings:save_notifications.saved', '已保存'));
                  try { 
                    window.dispatchEvent(new CustomEvent('systemSettingsChanged', { detail: { showRawRequest: newValue } })); 
                  } catch {
                    // noop: this event is best-effort
                  }
                } catch (error: unknown) { 
                  showGlobalNotification('error', getErrorMessage(error)); 
                }
              }}
            />

            {/* 复制内容过滤配置 */}
            {(() => {
              const saveConfig = async (next: typeof filterConfig) => {
                const cfg = { ...next, preset: 'custom' as const };
                setFilterConfig(cfg);
                try {
                  await tauriInvoke('save_setting', { key: 'debug.filter_config', value: JSON.stringify(cfg) });
                  window.dispatchEvent(new CustomEvent('systemSettingsChanged', { detail: { copyFilterConfig: cfg } }));
                } catch {
                  // noop: local persistence already updated optimistic state
                }
              };

              return (
                <div className="py-2.5 px-1">
                  <div className="pt-1.5 pb-1 px-1">
                    <h3 className="text-sm text-foreground/90 leading-tight">{t('settings:developer.copy_filter.title')}</h3>
                    <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5">{t('settings:developer.copy_filter.desc')}</p>
                  </div>
                  <div className="mt-1.5 space-y-1.5 pl-1">
                    <div className="flex items-center justify-between gap-3 rounded px-1 py-1">
                      <span className="text-xs text-muted-foreground">{t('settings:developer.copy_filter.fields.images')}</span>
                      <AppSelect
                        value={filterConfig.images}
                        onValueChange={(val) => saveConfig({ ...filterConfig, images: val as typeof filterConfig.images })}
                        options={[
                          { value: 'full', label: t('settings:developer.copy_filter.options.images.full') },
                          { value: 'placeholder', label: t('settings:developer.copy_filter.options.images.placeholder') },
                          { value: 'remove', label: t('settings:developer.copy_filter.options.images.remove') },
                        ]}
                        size="sm" variant="ghost"
                        className="h-7 text-xs bg-transparent hover:bg-[var(--interactive-hover)]" width={140}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3 rounded px-1 py-1">
                      <span className="text-xs text-muted-foreground">{t('settings:developer.copy_filter.fields.tools')}</span>
                      <AppSelect
                        value={filterConfig.tools}
                        onValueChange={(val) => saveConfig({ ...filterConfig, tools: val as typeof filterConfig.tools })}
                        options={[
                          { value: 'full', label: t('settings:developer.copy_filter.options.tools.full') },
                          { value: 'summary', label: t('settings:developer.copy_filter.options.tools.summary') },
                          { value: 'names_only', label: t('settings:developer.copy_filter.options.tools.names_only') },
                          { value: 'remove', label: t('settings:developer.copy_filter.options.tools.remove') },
                        ]}
                        size="sm" variant="ghost"
                        className="h-7 text-xs bg-transparent hover:bg-[var(--interactive-hover)]" width={140}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3 rounded px-1 py-1">
                      <span className="text-xs text-muted-foreground">{t('settings:developer.copy_filter.fields.messages')}</span>
                      <AppSelect
                        value={filterConfig.messages}
                        onValueChange={(val) => saveConfig({ ...filterConfig, messages: val as typeof filterConfig.messages })}
                        options={[
                          { value: 'full', label: t('settings:developer.copy_filter.options.messages.full') },
                          { value: 'truncate', label: t('settings:developer.copy_filter.options.messages.truncate') },
                          { value: 'summary', label: t('settings:developer.copy_filter.options.messages.summary') },
                        ]}
                        size="sm" variant="ghost"
                        className="h-7 text-xs bg-transparent hover:bg-[var(--interactive-hover)]" width={140}
                      />
                    </div>
                    {filterConfig.messages === 'truncate' && (
                      <div className="flex items-center justify-between gap-3 rounded px-1 py-1">
                        <span className="text-xs text-muted-foreground">{t('settings:developer.copy_filter.fields.truncate_length')}</span>
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="number"
                            min={100}
                            max={50000}
                            step={100}
                            value={filterConfig.messageTruncateLength}
                            onChange={(e) => {
                              const v = parseInt(e.target.value, 10);
                              if (!isNaN(v) && v >= 100) saveConfig({ ...filterConfig, messageTruncateLength: v });
                            }}
                            className="h-7 w-20 text-xs"
                          />
                          <span className="text-[10px] text-muted-foreground/60">{t('common:unit.chars')}</span>
                        </div>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-3 rounded px-1 py-1">
                      <span className="text-xs text-muted-foreground">{t('settings:developer.copy_filter.fields.thinking')}</span>
                      <AppSelect
                        value={filterConfig.thinking}
                        onValueChange={(val) => saveConfig({ ...filterConfig, thinking: val as typeof filterConfig.thinking })}
                        options={[
                          { value: 'full', label: t('settings:developer.copy_filter.options.thinking.full') },
                          { value: 'remove', label: t('settings:developer.copy_filter.options.thinking.remove') },
                        ]}
                        size="sm" variant="ghost"
                        className="h-7 text-xs bg-transparent hover:bg-[var(--interactive-hover)]" width={140}
                      />
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* 调试日志持久化 */}
            <SwitchRow
              title={t('settings:developer.persist_logs.title')}
              description={t('settings:developer.persist_logs.desc')}
              checked={debugPersistLogs}
              onCheckedChange={async (newValue) => {
                setDebugPersistLogs(newValue);
                try {
                  await tauriInvoke('save_setting', { key: 'debug.persist_logs', value: String(newValue) });
                  showGlobalNotification('success', t('settings:save_notifications.saved', '已保存'));
                } catch (error: unknown) {
                  showGlobalNotification('error', getErrorMessage(error));
                }
              }}
            />

            {/* 调试日志管理 */}
            {debugPersistLogs && (
              <SettingRow
                title={t('settings:developer.debug_logs.title')}
                description={debugLogsInfo
                  ? t('settings:developer.debug_logs.summary', { count: debugLogsInfo.count, size: debugLogsInfo.total_size_display })
                  : t('settings:developer.debug_logs.loading')}
              >
                <div className="flex items-center gap-2">
                  <NotionButton
                    variant="default"
                    size="sm"
                    onClick={async () => {
                      try {
                        const debugLogsDir = await tauriInvoke('ensure_debug_log_dir') as string;
                        const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
                        await revealItemInDir(debugLogsDir);
                      } catch {
                        showGlobalNotification('error', t('settings:developer.debug_logs.open_failed'));
                      }
                    }}
                  >
                    {t('settings:developer.debug_logs.open')}
                  </NotionButton>
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    disabled={debugLogsClearing}
                    onClick={async () => {
                      setDebugLogsClearing(true);
                      try {
                        const removed = await tauriInvoke('clear_debug_logs') as number;
                        showGlobalNotification('success', t('settings:developer.debug_logs.cleared', { count: removed }));
                        await refreshDebugLogsInfo();
                      } catch (error: unknown) {
                        showGlobalNotification('error', getErrorMessage(error));
                      } finally {
                        setDebugLogsClearing(false);
                      }
                    }}
                  >
                    {debugLogsClearing ? <CircleNotch size={12} className="animate-spin" /> : t('settings:developer.debug_logs.clear_all')}
                  </NotionButton>
                </div>
              </SettingRow>
            )}
          </div>
        </div>

        {/* 3. 记忆设置 */}
        <div className="mt-8">
          <GroupTitle title={t('settings:memory.title', '记忆设置')} />
          <MemorySettingsSection embedded />
        </div>

        {/* 4. 隐私与数据（合规要求） */}
        <div className="mt-8">
          <GroupTitle title={t('common:legal.settingsSection.title', '隐私与数据')} />
          <div className="space-y-px">
            <SwitchRow
              title={t('common:legal.settingsSection.sentryToggle.title', '匿名错误报告')}
              description={t('common:legal.settingsSection.sentryToggle.description', '允许发送匿名崩溃报告以帮助改善软件质量')}
              checked={sentryEnabled}
              onCheckedChange={async (newValue) => {
                setSentryEnabled(newValue);
                try {
                  await tauriInvoke('save_setting', {
                    key: SENTRY_CONSENT_KEY,
                    value: String(newValue),
                  });
                  showGlobalNotification(
                    'success',
                    newValue
                      ? t('common:legal.settingsSection.sentryToggle.enabled', '已开启')
                      : t('common:legal.settingsSection.sentryToggle.disabled', '已关闭')
                  );
                  // 提示需重启生效
                  if (newValue) {
                    showGlobalNotification('info', t('settings:save_notifications.restart_hint', '部分设置需重启应用后生效'));
                  }
                } catch (error: unknown) {
                  showGlobalNotification('error', getErrorMessage(error));
                  setSentryEnabled(!newValue);
                }
              }}
            />

            {/* 数据流向说明 */}
            <div className="px-1 py-3">
              <h4 className="text-sm font-medium text-foreground mb-2">
                {t('common:legal.settingsSection.dataFlow.title', '数据流向说明')}
              </h4>
              <div className="space-y-2">
                {[
                  {
                    key: 'localData',
                  },
                  {
                    key: 'llmData',
                  },
                  {
                    key: 'syncData',
                  },
                  {
                    key: 'sentryData',
                  },
                  {
                    key: 'crossBorderNote',
                  },
                ].map((item) => (
                  <div
                    key={item.key}
                    className="rounded px-1 py-2 transition-colors"
                  >
                    <div className="text-xs leading-5">
                      <span className="font-medium text-foreground">
                        {t(`common:legal.settingsSection.dataFlow.${item.key}`)}
                      </span>
                      <span className="ml-1 text-muted-foreground">
                        {t(`common:legal.settingsSection.dataFlow.${item.key}Desc`)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 数据权利：导航到数据治理 */}
            <div className="mt-3 pt-3 border-t border-border/40">
              <SettingRow
                title={t('common:legal.dataRights.manageData', '管理我的数据')}
                description={t('common:legal.dataRights.manageDataDesc', '导出、备份或删除您的所有数据')}
              >
                <NotionButton
                  variant="default"
                  size="sm"
                  onClick={() => {
                    setPendingSettingsTab('data-governance');
                    window.dispatchEvent(new CustomEvent('settingsTabChange', { detail: 'data-governance' }));
                  }}
                >
                  {t('common:legal.dataRights.goToDataGovernance', '前往数据治理')}
                </NotionButton>
              </SettingRow>
            </div>
          </div>
        </div>

      </SettingSection>

      {/* 隐私协议预览弹窗 */}
      {showAgreementPreview && (
        <UserAgreementDialog
          preview
          open={showAgreementPreview}
          onAccept={() => setShowAgreementPreview(false)}
          onClose={() => setShowAgreementPreview(false)}
        />
      )}
    </div>
  );
};

export default AppTab;
