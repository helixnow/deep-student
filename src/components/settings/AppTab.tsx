/**
 * 应用设置 Tab 组件
 * 从 Settings.tsx 拆分，包含主题、语言、缩放等应用设置
 * Notion 风格：简洁、无边框、hover 效果
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { debugMasterSwitch } from '../../debug-panel/debugMasterSwitch';
import { NotionButton } from '../ui/NotionButton';
import { Input } from '../ui/shad/Input';
import { Switch } from '../ui/shad/Switch';
import { SettingSection } from './SettingsCommon';
import { MemorySettingsSection } from './MemorySettingsSection';
import { cn } from '../../lib/utils';
import { showGlobalNotification } from '../UnifiedNotification';
import { getErrorMessage } from '../../utils/errorUtils';
import { setPendingSettingsTab } from '../../utils/pendingSettingsTab';
import { isAndroid } from '../../utils/platform';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { PRESET_PALETTES, PALETTE_PREVIEW_COLORS, type ThemePalette } from '../../hooks/useTheme';
import { DEFAULT_UI_FONT, DEFAULT_UI_FONT_SIZE, UI_FONT_PRESET_GROUPS, UI_FONT_SIZE_PRESETS } from '../../config/fontConfig';
import { AppSelect, type AppSelectGroup } from '../ui/app-menu';
import { UserAgreementDialog } from '../legal/UserAgreementDialog';

const DEFAULT_UI_ZOOM = 1.0;
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

// 内部组件：设置行 - Notion 风格（无 icon，简洁）
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
  <div className={cn("group flex flex-col sm:flex-row sm:items-start gap-2 py-2.5 px-1 hover:bg-muted/30 rounded transition-colors overflow-hidden", className)}>
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

// 内部组件：带开关的设置行
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
  <div className="group flex items-center justify-between gap-4 py-2.5 px-1 hover:bg-muted/30 rounded transition-colors">
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

// 分组标题
const GroupTitle = ({ title }: { title: string }) => (
  <div className="px-1 mb-3 mt-8 first:mt-0">
    <h3 className="text-base font-semibold text-foreground">{title}</h3>
  </div>
);

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
}

export const AppTab: React.FC<AppTabProps> = ({
  uiZoom, zoomLoading, zoomSaving, zoomStatus, handleZoomChange, handleZoomReset,
  uiFont, fontLoading, fontSaving, handleFontChange, handleFontReset,
  uiFontSize, fontSizeLoading, fontSizeSaving, handleFontSizeChange, handleFontSizeReset,
  themePalette, setThemePalette, customColor, setCustomColor, topbarTopMargin, setTopbarTopMargin,
  logTypeForOpen, setLogTypeForOpen, showRawRequest, setShowRawRequest,
  isTauriEnvironment, invoke,
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

  // 调试日志持久化 + 过滤级别
  const [debugPersistLogs, setDebugPersistLogs] = useState(false);
  const [debugFilterLevel, setDebugFilterLevel] = useState<'full' | 'standard' | 'compact'>('standard');
  const [debugLogsInfo, setDebugLogsInfo] = useState<{ count: number; total_size_display: string } | null>(null);
  const [debugLogsClearing, setDebugLogsClearing] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [persistVal, levelVal] = await Promise.all([
          tauriInvoke('get_setting', { key: 'debug.persist_logs' }).catch(() => 'false') as Promise<string>,
          tauriInvoke('get_setting', { key: 'debug.filter_level' }).catch(() => 'standard') as Promise<string>,
        ]);
        setDebugPersistLogs(String(persistVal ?? '') === 'true');
        const lv = String(levelVal ?? '').trim().toLowerCase();
        if (lv === 'full' || lv === 'compact') setDebugFilterLevel(lv);
      } catch { /* defaults */ }
    })();
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
            {/* 语言切换 */}
            <SettingRow
              title={t('settings:language.title')}
              description={t('common:status.current', '当前') + ': ' + (i18n.language === 'zh-CN' ? t('settings:language.chinese', '中文') : t('settings:language.english', 'English'))}
            >
              <div className="flex items-center gap-2">
                <NotionButton
                  type="button"
                  variant={i18n.language === 'zh-CN' ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => i18n.changeLanguage('zh-CN')}
                >
                  {t('settings:language.chinese', '中文')}
                </NotionButton>
                <NotionButton
                  type="button"
                  variant={i18n.language === 'en-US' ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => i18n.changeLanguage('en-US')}
                >
                  {t('settings:language.english', 'English')}
                </NotionButton>
              </div>
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
                    className="h-8 text-xs bg-transparent hover:bg-muted/20 transition-colors"
                    width={90}
                  />
                  <NotionButton 
                    type="button" 
                    variant="ghost" 
                    size="sm" 
                    disabled={zoomSaving || Math.abs(uiZoom - DEFAULT_UI_ZOOM) < 0.0001} 
                    onClick={handleZoomReset}
                  >
                    {zoomSaving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
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
                  {fontSaving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
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
                  className="h-8 text-xs bg-transparent hover:bg-muted/20 transition-colors"
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
                  className="h-8 text-xs bg-transparent hover:bg-muted/20 transition-colors"
                  width={90}
                />
                <NotionButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={fontSizeSaving || Math.abs(uiFontSize - DEFAULT_UI_FONT_SIZE) < 0.0001}
                  onClick={handleFontSizeReset}
                >
                  {fontSizeSaving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                  {t('settings:font.size_reset')}
                </NotionButton>
              </div>
            </SettingRow>

            {/* 调色板 */}
            <div className="group py-2.5 px-1 hover:bg-muted/30 rounded transition-colors">
              <div className="mb-3">
                <h3 className="text-sm text-foreground/90 leading-tight">{t('settings:theme.palette_label')}</h3>
                <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5">
                  {t('settings:theme.palette_hint')}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {PRESET_PALETTES.map((paletteKey) => {
                  const isSelected = themePalette === paletteKey;
                  const previewColor = PALETTE_PREVIEW_COLORS[paletteKey];
                  return (
                    <NotionButton 
                      key={paletteKey} 
                      variant="ghost"
                      size="sm"
                      onClick={() => setThemePalette(paletteKey)} 
                      className={cn(
                        'group/palette relative !h-auto flex-col items-center gap-1.5 !rounded-lg !p-2',
                        isSelected && 'bg-muted'
                      )} 
                      title={t(`settings:theme.palettes.${paletteKey}_desc`)}
                    >
                      <div 
                        className={cn(
                          'h-7 w-7 rounded-full shadow-sm transition-transform duration-200',
                          'group-hover/palette:scale-105',
                          isSelected && 'ring-1 ring-primary/30'
                        )} 
                        style={{ backgroundColor: previewColor }} 
                      />
                      <span className={cn(
                        'text-[10px] font-medium transition-colors',
                        isSelected ? 'text-foreground' : 'text-muted-foreground/70'
                      )}>
                        {t(`settings:theme.palettes.${paletteKey}_name`)}
                      </span>
                    </NotionButton>
                  );
                })}
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setCustomColor(customColor)}
                  className={cn(
                    'group/palette relative !h-auto flex-col items-center gap-1.5 !rounded-lg !p-2',
                    themePalette === 'custom' && 'bg-muted'
                  )}
                  title={t('settings:theme.palettes.custom_desc')}
                >
                  <div className="relative">
                    <div
                      className={cn(
                        'h-7 w-7 rounded-full shadow-sm transition-transform duration-200',
                        'group-hover/palette:scale-105',
                        themePalette === 'custom' && 'ring-1 ring-primary/30'
                      )}
                      style={{
                        // Intentional decorative: rainbow conic-gradient for color picker preview
                        background: `conic-gradient(from 0deg, #f44, #f90, #ff0, #0c0, #09f, #a0f, #f44)`,
                      }}
                    />
                    <input
                      type="color"
                      value={customColor}
                      onChange={(e) => setCustomColor(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      title={t('settings:theme.palettes.custom_desc')}
                    />
                  </div>
                  <span className={cn(
                    'text-[10px] font-medium transition-colors',
                    themePalette === 'custom' ? 'text-foreground' : 'text-muted-foreground/70'
                  )}>
                    {t('settings:theme.palettes.custom_name')}
                  </span>
                </NotionButton>
              </div>
            </div>
          </div>
        </div>

        {/* 2. 开发者选项 */}
        <div>
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
                      } catch {}
                    } catch (error: unknown) { 
                      showGlobalNotification('error', getErrorMessage(error)); 
                    }
                  }} 
                  placeholder={isAndroid() ? '30' : '0'} 
                  className="!w-20 h-8 text-xs bg-transparent" 
                  min="0" 
                />
                <span className="text-[11px] text-muted-foreground/70">px</span>
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
            <SettingRow
              title={t('common:debug_panel.open_unified', t('common:debug_panel.open'))}
              description={t('settings:debug.description', '用于调试全局流式会话与事件')}
            >
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
                  } catch {} 
                }}
              >
                {t('common:debug_panel.open_unified', t('common:debug_panel.open'))}
              </NotionButton>
            </SettingRow>

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
                  className="h-8 text-xs bg-transparent hover:bg-muted/20 transition-colors"
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
                  } catch {}
                } catch (error: unknown) { 
                  showGlobalNotification('error', getErrorMessage(error)); 
                }
              }}
            />

            {/* 复制过滤级别 */}
            <SettingRow
              title="复制内容过滤级别"
              description={'控制「复制请求体」时包含的信息量。完整：含 base64 图片和 tool schema；标准：图片替换为占位符；精简：仅元数据骨架。'}
            >
              <AppSelect
                value={debugFilterLevel}
                onValueChange={async (val) => {
                  const level = val as 'full' | 'standard' | 'compact';
                  setDebugFilterLevel(level);
                  try {
                    await tauriInvoke('save_setting', { key: 'debug.filter_level', value: level });
                    window.dispatchEvent(new CustomEvent('systemSettingsChanged', { detail: { debugFilterLevel: level } }));
                  } catch {}
                }}
                options={[
                  { value: 'full', label: '完整（含图片）' },
                  { value: 'standard', label: '标准（默认）' },
                  { value: 'compact', label: '精简（仅骨架）' },
                ]}
                size="sm"
                variant="ghost"
                className="h-8 text-xs bg-transparent hover:bg-muted/20 transition-colors"
                width={130}
              />
            </SettingRow>

            {/* 调试日志持久化 */}
            <SwitchRow
              title="持久化调试日志"
              description="开启后，每次 LLM 请求的完整请求体（含图片、工具等）将以 JSON 文件保存到数据目录，不受过滤级别影响。"
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
                title="调试日志管理"
                description={debugLogsInfo ? `${debugLogsInfo.count} 个文件，共 ${debugLogsInfo.total_size_display}` : '加载中...'}
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
                        showGlobalNotification('error', '打开调试日志文件夹失败');
                      }
                    }}
                  >
                    打开
                  </NotionButton>
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    disabled={debugLogsClearing}
                    onClick={async () => {
                      setDebugLogsClearing(true);
                      try {
                        const removed = await tauriInvoke('clear_debug_logs') as number;
                        showGlobalNotification('success', `已清理 ${removed} 个日志文件`);
                        await refreshDebugLogsInfo();
                      } catch (error: unknown) {
                        showGlobalNotification('error', getErrorMessage(error));
                      } finally {
                        setDebugLogsClearing(false);
                      }
                    }}
                  >
                    {debugLogsClearing ? <Loader2 className="h-3 w-3 animate-spin" /> : '清理全部'}
                  </NotionButton>
                </div>
              </SettingRow>
            )}
          </div>
        </div>

        {/* 3. 记忆设置 */}
        <div className="mt-8">
          <MemorySettingsSection embedded />
        </div>

        {/* 4. 隐私与数据（合规要求） */}
        <div className="mt-8">
          <GroupTitle title={t('common:legal.settingsSection.title', '隐私与数据')} />
          <div className="space-y-1">
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
                    color: 'bg-emerald-500',
                  },
                  {
                    key: 'llmData',
                    color: 'bg-blue-500',
                  },
                  {
                    key: 'syncData',
                    color: 'bg-sky-500',
                  },
                  {
                    key: 'sentryData',
                    color: 'bg-orange-500',
                  },
                  {
                    key: 'crossBorderNote',
                    color: 'bg-amber-500',
                  },
                ].map((item) => (
                  <div key={item.key} className="flex items-start gap-2 text-xs">
                    <div className={cn('w-2 h-2 rounded-full mt-1.5 flex-shrink-0', item.color)} />
                    <div>
                      <span className="font-medium text-foreground">
                        {t(`common:legal.settingsSection.dataFlow.${item.key}`)}
                      </span>
                      <span className="text-muted-foreground ml-1">
                        — {t(`common:legal.settingsSection.dataFlow.${item.key}Desc`)}
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
