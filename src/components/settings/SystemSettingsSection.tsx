import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';
/**
 * System Settings Section Component
 * Split from the large Settings component
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import useTheme, { type ThemeMode } from '../../hooks/useTheme'; // P1修复：暗色主题支持
import useAttachmentSettings from '../../hooks/useAttachmentSettings'; // P2增强：附件设置
import { 
  CheckCircle, 
  XCircle, 
  Save, 
  Globe, 
  Palette, 
  Database,
  Bell,
  MessageSquare,
  Bug,
  RotateCcw,
  Check,
  Sun,
  Moon,
  Monitor,
  Paperclip,
  Image,
  FileText,
  HelpCircle
} from 'lucide-react';
import { showGlobalNotification } from '../UnifiedNotification';
import { CustomScrollArea } from '../custom-scroll-area';
import { Switch } from '../ui/shad/Switch';
import { NotionButton } from '../ui/NotionButton';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

const SettingSection = ({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) => (
  <div className="rounded-2xl border border-transparent ring-1 ring-border/40 bg-card/90 p-6 shadow-sm transition-shadow duration-300 hover:shadow-md">
    <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <h2 className="m-0 text-2xl font-semibold text-[hsl(var(--card-foreground, 222.2 47.4% 11.2%))] dark:text-[hsl(var(--card-foreground, 210 40% 98%))]">{title}</h2>
        {description && (
          <p className="m-0 text-sm text-[hsl(var(--muted-foreground))]">{description}</p>
        )}
      </div>
    </div>
    <div className="space-y-4">
      {children}
    </div>
  </div>
);

const SettingItem = ({ label, description, children, badge, badgeType }: { 
  label: string; 
  description?: string; 
  children: React.ReactNode; 
  badge?: string;
  badgeType?: 'beta' | 'debug' | 'default';
}) => (
  <div className="py-3">
    <div className="flex items-start justify-between">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-foreground">{label}</label>
          {badge && (
            <span className={`px-2 py-0.5 text-xs rounded-full ${
              badgeType === 'beta'
                ? 'bg-primary/15 text-primary'
                : badgeType === 'debug'
                  ? 'bg-warning/15 text-warning'
                  : 'bg-accent/40 text-accent-foreground'
            }`}>
              {badge}
            </span>
          )}
        </div>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{description}</p>
        )}
      </div>
      <div className="ml-4">
        {children}
      </div>
    </div>
  </div>
);

const SelectDropdown = ({ value, onChange, options }: { 
  value: string; 
  onChange: (value: string) => void; 
  options: Array<{ value: string; label: string }> 
}) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className="rounded-lg border border-input bg-muted px-4 py-2 text-sm text-foreground transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
  >
    {options.map(option => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ))}
  </select>
);

export const SystemSettingsSection: React.FC = () => {
  const { t } = useTranslation(['settings', 'common']);
  const {
    settings,
    loading,
    saving,
    saveSetting,
    saveAllSettings,
    resetSettings,
    updateSetting,
    validateSettings,
    getSettingsSummary,
    isAutoSaveEnabled,
    isDarkTheme: _isDarkTheme,
    isDebugMode,
    markdownRendererMode
  } = useSystemSettings();
  
  // P1修复：暗色主题管理
  const { mode: themeMode, isDarkMode, isSystemDark, setThemeMode } = useTheme();
  
  // P2增强：附件设置管理
  const { 
    settings: attachmentSettings, 
    saveSettings: saveAttachmentSettings, 
    resetSettings: resetAttachmentSettings,
    getLimitsSummary,
    formatFileSize 
  } = useAttachmentSettings();

  // 教材导学：最大选页数（独立设置项，直接读写后端settings）
  const [textbookMaxPages, setTextbookMaxPages] = React.useState<number>(12);
  React.useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const raw = await tauriInvoke<string | null>('get_setting', { key: 'textbook.max_pages' }).catch(() => null);
        if (disposed) return;
        const v = raw != null ? parseInt(String(raw), 10) : NaN;
        setTextbookMaxPages(Number.isFinite(v) && v > 0 ? v : 12);
      } catch {
        if (!disposed) setTextbookMaxPages(12);
      }
    })();
    return () => { disposed = true; };
  }, []);
  const handleSaveTextbookMaxPages = React.useCallback(async (value: number) => {
    try {
      const clamped = Math.max(1, Math.min(50, Math.floor(value)));
      setTextbookMaxPages(clamped);
      await tauriInvoke('save_setting', { key: 'textbook.max_pages', value: String(clamped) });
      showGlobalNotification('success', t('common:config_saved'));
    } catch (e: unknown) {
      showGlobalNotification('error', t('common:messages.error.update_failed', { error: String(e) }));
    }
  }, [t]);

  const emitMarkdownRendererModeChange = useCallback((mode: string) => {
    try {
      window.dispatchEvent(new CustomEvent('systemSettingsChanged', { detail: { markdownRendererMode: mode } }));
    } catch (error: unknown) {
      console.error('Failed to broadcast Markdown renderer mode change:', error);
    }
  }, []);

  // 处理设置变更
  const handleSettingChange = async <K extends keyof typeof settings>(
    key: K,
    value: typeof settings[K],
    autoSave: boolean = true
  ) => {
    updateSetting(key, value);
    
    if (autoSave && isAutoSaveEnabled) {
      const success = await saveSetting(key, value);
      if (!success) {
        showGlobalNotification('error', t('common:system_settings.save_setting_failed', { key }));
      } else if (key === 'markdownRendererMode') {
        emitMarkdownRendererModeChange(String(value));
      }
    } else if (key === 'markdownRendererMode') {
      emitMarkdownRendererModeChange(String(value));
    }
  };

  // 手动保存所有设置
  const handleSaveAll = async () => {
    const errors = validateSettings(settings);
    if (errors.length > 0) {
      showGlobalNotification('warning', t('common:system_settings.validation_failed', { errors: errors.join(', ') }));
      return;
    }

    const success = await saveAllSettings(settings);
    if (success) {
      showGlobalNotification('success', t('common:system_settings.all_settings_saved'));
      emitMarkdownRendererModeChange(markdownRendererMode);
    } else {
      showGlobalNotification('error', t('common:system_settings.save_settings_failed'));
    }
  };

  // 重置所有设置
  const handleReset = async () => {
  const confirmed = await Promise.resolve(unifiedConfirm(t('common:system_settings.reset_confirm')));
  if (confirmed) {
      const success = await resetSettings();
      if (success) {
        showGlobalNotification('success', t('common:system_settings.reset_success'));
        emitMarkdownRendererModeChange('legacy');
      } else {
        showGlobalNotification('error', t('common:system_settings.reset_failed'));
      }
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">{t('common:system_settings.loading')}</div>
      </div>
    );
  }

  const summary = getSettingsSummary();

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto py-8 px-4">
        <h1 className="text-2xl font-semibold text-foreground mb-8">{t('settings:system_settings.page_title')}</h1>
        
        <div className="space-y-6">
          {/* General Settings */}
          <SettingSection title={t('settings:system_settings.general.title')} description={t('settings:system_settings.general.description')}>
            <SettingItem 
              label={t('settings:system_settings.general.auto_save_label')} 
              description={t('settings:system_settings.general.auto_save_description')}
            >
              <Switch checked={settings.autoSave} onCheckedChange={(value) => handleSettingChange('autoSave', value)} />
            </SettingItem>
            
            <div className="border-t border-border/60 pt-4">
              <SettingItem 
                label={t('settings:system_settings.general.language_label')} 
                description={t('settings:system_settings.general.language_description')}
              >
                <div className="flex items-center space-x-2">
                  <span className={settings.language === 'zh-CN' ? 'text-foreground font-medium' : 'text-muted-foreground'}>{t('settings:system_settings.general.chinese')}</span>
                  <Switch
                    checked={settings.language === 'en-US'}
                    onCheckedChange={(value) => handleSettingChange('language', value ? 'en-US' : 'zh-CN')}
                    aria-label={t('settings:system_settings.general.language_label')}
                  />
                  <span className={settings.language === 'en-US' ? 'text-foreground font-medium' : 'text-muted-foreground'}>{t('settings:system_settings.general.english')}</span>
                </div>
              </SettingItem>
            </div>
            
            <div className="border-t border-border/60 pt-4">
              <SettingItem 
                label={t('settings:system_settings.general.theme_label')} 
                description={t('settings:system_settings.general.theme_current', { 
                  theme: isDarkMode ? t('settings:system_settings.general.theme_dark') : t('settings:system_settings.general.theme_light'),
                  mode: themeMode === 'auto' ? t('settings:system_settings.general.theme_auto') : '',
                  force: ''
                })}
              >
                <div className="flex items-center gap-3">
                  {/* 主题切换器 - 使用shadcn样式 */}
                  <NotionButton
                    variant={themeMode === 'light' ? 'primary' : 'default'}
                    size="sm"
                    onClick={() => setThemeMode('light')}
                    className={themeMode === 'light' ? 'border-2 border-primary shadow-sm' : 'border border-transparent ring-1 ring-border/40'}
                    title={t('settings:system_settings.general.theme_light')}
                  >
                    <Sun size={16} />
                    <span className="text-sm font-medium">{t('settings:system_settings.general.theme_light_button')}</span>
                  </NotionButton>
                  
                  <NotionButton
                    variant={themeMode === 'dark' ? 'primary' : 'default'}
                    size="sm"
                    onClick={() => setThemeMode('dark')}
                    className={themeMode === 'dark' ? 'border-2 border-primary shadow-sm' : 'border border-transparent ring-1 ring-border/40'}
                    title={t('settings:system_settings.general.theme_dark')}
                  >
                    <Moon size={16} />
                    <span className="text-sm font-medium">{t('settings:system_settings.general.theme_dark_button')}</span>
                  </NotionButton>
                  
                  <NotionButton
                    variant={themeMode === 'auto' ? 'primary' : 'default'}
                    size="sm"
                    onClick={() => setThemeMode('auto')}
                    className={themeMode === 'auto' ? 'border-2 border-primary shadow-sm' : 'border border-transparent ring-1 ring-border/40'}
                    title={t('settings:system_settings.general.theme_follow_title', { 
                      system: isSystemDark ? t('settings:system_settings.general.theme_dark') : t('settings:system_settings.general.theme_light')
                    })}
                  >
                    <Monitor size={16} />
                    <span className="text-sm font-medium">{t('settings:system_settings.general.theme_follow_button')}</span>
                  </NotionButton>
                </div>
              </SettingItem>
            </div>

          </SettingSection>

          {/* 功能设置 */}
          <SettingSection title={t('settings:features.title')} description={t('settings:features.description')}>
            <SettingItem 
              label={t('settings:features.notifications_label')} 
              description={t('settings:features.notifications_desc')}
            >
              <Switch checked={settings.enableNotifications} onCheckedChange={(value) => handleSettingChange('enableNotifications', value)} />
            </SettingItem>
            
            <div className="border-t border-border/60 pt-4">
              <SettingItem 
                label={t('settings:features.chat_history_label')} 
                description={t('settings:features.chat_history_desc')}
              >
                <input
                  type="number"
                  min="10"
                  max="1000"
                  value={settings.maxChatHistory}
                  onChange={(e) => handleSettingChange('maxChatHistory', parseInt(e.target.value, 10))}
                  disabled={saving}
                  className="w-20 rounded-lg border border-input bg-muted px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                />
              </SettingItem>
            </div>

            <div className="border-t border-border/60 pt-4">
              <SettingItem 
                label={t('settings:markdown.render_mode_label')}
                description={t('settings:markdown.render_mode_desc')}
                badge="Beta"
              >
                <SelectDropdown
                  value={markdownRendererMode}
                  onChange={(value) => handleSettingChange('markdownRendererMode', value === 'enhanced' ? 'enhanced' : 'legacy')}
                  options={[
                    { value: 'legacy', label: t('settings:markdown.mode_legacy') },
                    { value: 'enhanced', label: t('settings:markdown.mode_enhanced') }
                  ]}
                />
              </SettingItem>
            </div>

            <div className="border-t border-border/60 pt-4">
              <SettingItem 
                label={t('settings:textbook.max_pages_label')} 
                description={t('settings:textbook.max_pages_desc')}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={textbookMaxPages}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      setTextbookMaxPages(Number.isFinite(v) ? v : 12);
                    }}
                    onBlur={() => handleSaveTextbookMaxPages(textbookMaxPages)}
                    className="w-24 rounded-lg border border-input bg-muted px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                  />
                  <span className="text-xs text-muted-foreground">{t('settings:textbook.max_pages_hint')}</span>
                </div>
              </SettingItem>
            </div>

            <div className="border-t border-border/60 pt-4">
              <SettingItem 
                label={t('settings:textbook.render_scale_label')} 
                description={t('settings:textbook.render_scale_desc')}
              >
                <TextbookScaleSetting />
              </SettingItem>
            </div>

            <div className="border-t border-border/60 pt-4">
              <SettingItem 
                label={t('settings:textbook.export_concurrency_label')} 
                description={t('settings:textbook.export_concurrency_desc')}
              >
                <TextbookConcurrencySetting />
              </SettingItem>
            </div>
          </SettingSection>

          {/* MCP 工具协议设置已移除全局启用项：是否启用仅依赖消息级选择 */}

          {/* 开发功能设置 */}
          <SettingSection title={t('settings:developer.title')} description={t('settings:developer.description')}>
            <SettingItem 
              label={t('settings:developer.debug_mode_label')} 
              description={t('settings:developer.debug_mode_desc')}
              badge={t('settings:developer.badge_in_development')}
            >
              <Switch checked={settings.debugMode} onCheckedChange={(value) => handleSettingChange('debugMode', value)} />
            </SettingItem>
            
            {isDebugMode && (
              <div className="border-t border-border/60 pt-4">
                <SettingItem 
                  label={t('settings:developer.debug_info_label')} 
                  description={t('settings:developer.debug_info_desc')}
                >
                  <CustomScrollArea className="max-w-md" viewportClassName="max-h-40 rounded-lg bg-muted p-4">
                    <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
                      {JSON.stringify(summary, null, 2)}
                    </pre>
                  </CustomScrollArea>
                </SettingItem>
              </div>
            )}
          </SettingSection>
        </div>

        {/* 保存提示 */}
        {isAutoSaveEnabled && (
          <div className="mt-8 flex items-center justify-center text-sm text-muted-foreground">
            <Check className="w-4 h-4 mr-1" />
            <span>{t('settings:auto_saved')}</span>
          </div>
        )}

        {/* 操作按钮 */}
        {!isAutoSaveEnabled && (
          <div className="mt-8 flex gap-4 justify-center">
            <NotionButton onClick={handleSaveAll} disabled={saving} variant="primary">
              <Save className="w-3.5 h-3.5" />
              {saving ? t('common:status.saving') : t('settings:developer.save_all_settings')}
            </NotionButton>
            
            <NotionButton
              variant="ghost"
              onClick={handleReset}
              disabled={saving}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {t('common:actions.reset_default')}
            </NotionButton>
          </div>
        )}
      </div>
    </div>
  );
};

// 子组件：教材导学渲染缩放设置
const TextbookScaleSetting: React.FC = () => {
  const { t } = useTranslation(['settings', 'common']);
  const [value, setValue] = React.useState<number>(2.0);
  React.useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const raw = await tauriInvoke<string | null>('get_setting', { key: 'textbook.render_scale' }).catch(() => null);
        if (disposed) return;
        const v = raw != null ? parseFloat(String(raw)) : NaN;
        setValue(Number.isFinite(v) ? Math.max(1.0, Math.min(3.0, v)) : 2.0);
      } catch {
        if (!disposed) setValue(2.0);
      }
    })();
    return () => { disposed = true; };
  }, []);
  const handleSave = React.useCallback(async (v: number) => {
    const clamped = Math.max(1.0, Math.min(3.0, v));
    setValue(clamped);
    try {
      await tauriInvoke('save_setting', { key: 'textbook.render_scale', value: String(clamped) });
      showGlobalNotification('success', t('common:config_saved'));
    } catch (e: unknown) {
      showGlobalNotification('error', t('common:messages.error.update_failed', { error: String(e) }));
    }
  }, [t]);
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min="1"
        max="3"
        step="0.1"
        value={value}
        onChange={(e) => setValue(parseFloat(e.target.value))}
        onBlur={() => handleSave(value)}
        className="w-24 rounded-lg border border-input bg-muted px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
      />
      <span className="text-xs text-muted-foreground">{t('settings:textbook.render_scale_hint')}</span>
    </div>
  );
};

// 子组件：教材导出并发设置
const TextbookConcurrencySetting: React.FC = () => {
  const { t } = useTranslation(['settings', 'common']);
  const [value, setValue] = React.useState<number>(2);
  React.useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const raw = await tauriInvoke<string | null>('get_setting', { key: 'textbook.export_concurrency' }).catch(() => null);
        if (disposed) return;
        const v = raw != null ? parseInt(String(raw), 10) : NaN;
        setValue(Number.isFinite(v) ? Math.max(1, Math.min(4, v)) : 2);
      } catch {
        if (!disposed) setValue(2);
      }
    })();
    return () => { disposed = true; };
  }, []);
  const handleSave = React.useCallback(async (v: number) => {
    const clamped = Math.max(1, Math.min(4, Math.floor(v)));
    setValue(clamped);
    try {
      await tauriInvoke('save_setting', { key: 'textbook.export_concurrency', value: String(clamped) });
      showGlobalNotification('success', t('common:config_saved'));
    } catch (e: unknown) {
      showGlobalNotification('error', t('common:messages.error.update_failed', { error: String(e) }));
    }
  }, [t]);
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min="1"
        max="4"
        value={value}
        onChange={(e) => setValue(parseInt(e.target.value, 10))}
        onBlur={() => handleSave(value)}
        className="w-24 rounded-lg border border-input bg-muted px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
      />
      <span className="text-xs text-muted-foreground">{t('settings:textbook.export_concurrency_hint')}</span>
    </div>
  );
};
