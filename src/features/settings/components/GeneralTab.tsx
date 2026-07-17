import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { CircleNotch } from '@phosphor-icons/react';

import { SettingSection } from './SettingsCommon';
import { VoiceInputSettingsSection } from './VoiceInputSettingsSection';
import { MemorySettingsSection } from './MemorySettingsSection';
import { MarkdownEditorWindowSettings } from './MarkdownEditorWindowSettings';
import { WorkbenchSettingsSection } from './WorkbenchSettingsSection';
import { AnkiConnectSettingsSection } from './AnkiConnectSettingsSection';
import { SettingRow, SettingsGroup, SwitchRow } from './settingsTabPrimitives';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { NotionButton } from '@/components/ui/NotionButton';
import { AppSelect } from '@/components/ui/app-menu';
import { Input } from '@/components/ui/shad/Input';
import { UserAgreementDialog } from '@/components/legal/UserAgreementDialog';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { setPendingSettingsTab } from '@/utils/pendingSettingsTab';
import { useQueueSettings } from '@/features/chat/queue/useQueueSettings';
import { debugMasterSwitch } from '@/debug-panel/debugMasterSwitch';
import { isAndroid } from '@/utils/platform';
import { getDefaultConfig, configFromPreset, type CopyFilterConfig } from '@/features/chat/hooks/useDevShowRawRequest';
import {
  getSystemNotificationPolicy,
  setSystemNotificationPolicy,
  type SystemNotificationPolicy,
} from '@/utils/systemNotification';
import type { VoiceInputAssignedModel } from '@/voice-input/types';

const SENTRY_CONSENT_KEY = 'sentry_error_reporting_enabled';

interface GeneralTabProps {
  voiceInputAssignedModel: VoiceInputAssignedModel;
  topbarTopMargin: string;
  topbarTopMarginLoaded: boolean;
  setTopbarTopMargin: (value: string) => void;
  logTypeForOpen: string;
  setLogTypeForOpen: (value: string) => void;
  showRawRequest: boolean;
  showRawRequestLoaded: boolean;
  setShowRawRequest: (value: boolean) => void;
  invoke: typeof tauriInvoke | null;
}

export const GeneralTab: React.FC<GeneralTabProps> = ({
  voiceInputAssignedModel,
  topbarTopMargin,
  topbarTopMarginLoaded,
  setTopbarTopMargin,
  logTypeForOpen,
  setLogTypeForOpen,
  showRawRequest,
  showRawRequestLoaded,
  setShowRawRequest,
  invoke,
}) => {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const [sentryEnabled, setSentryEnabled] = useState<boolean | null>(null);
  const [showAgreementPreview, setShowAgreementPreview] = useState(false);
  const [debugLogEnabled, setDebugLogEnabled] = useState(() => debugMasterSwitch.isEnabled());
  const [debugPersistLogs, setDebugPersistLogs] = useState<boolean | null>(null);
  const [filterConfig, setFilterConfig] = useState<CopyFilterConfig>(getDefaultConfig);
  const [debugLogsInfo, setDebugLogsInfo] = useState<{ count: number; total_size_display: string } | null>(null);
  const [debugLogsClearing, setDebugLogsClearing] = useState(false);
  const { mode, loading: queueModeLoading, setMode } = useQueueSettings();
  const [notificationPolicy, setNotificationPolicy] = useState<SystemNotificationPolicy>(() => getSystemNotificationPolicy());

  useEffect(() => {
    (async () => {
      try {
        const val = await tauriInvoke('get_setting', { key: SENTRY_CONSENT_KEY }) as string | null;
        setSentryEnabled(val === 'true');
      } catch {
        setSentryEnabled(false);
      }
    })();
  }, []);

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
          } catch {
            // ignore parse error
          }
        } else {
          const lv = String(legacyLevelVal ?? '').trim().toLowerCase();
          if (lv === 'full' || lv === 'compact') {
            setFilterConfig(configFromPreset(lv as 'full' | 'compact'));
          }
        }
      } catch {
        // keep defaults
      }
    })();
  }, []);

  useEffect(() => {
    const unsubscribe = debugMasterSwitch.addListener((enabled) => {
      setDebugLogEnabled(enabled);
    });
    return unsubscribe;
  }, []);

  const refreshDebugLogsInfo = React.useCallback(async () => {
    try {
      const info = await tauriInvoke('get_debug_logs_info') as { count: number; total_size_display: string };
      setDebugLogsInfo(info);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refreshDebugLogsInfo();
  }, [refreshDebugLogsInfo]);

  const languageOptions = React.useMemo(() => [
    { value: 'zh-CN', label: t('settings:language.chinese') },
    { value: 'en-US', label: t('settings:language.english', 'English') },
  ], [t]);

  return (
    <div className="space-y-1 pb-10 text-left ui-fade-in-slow" data-tour-id="general-settings">
      <SettingSection
        title={t('settings:tabs.general')}
        description={t('settings:study_ui_descriptions.general')}
        className="overflow-visible"
        hideHeader
      >
        <SettingsGroup
          title={t('settings:tabs.general')}
          description={t('settings:study_ui_descriptions.general')}
        >
            <SettingRow
              title={t('settings:language.title')}
              description={t('common:status.current') + ': ' + (i18n.language === 'zh-CN' ? t('settings:language.chinese') : t('settings:language.english', 'English'))}
              className="items-center"
            >
              <SegmentedControl
                ariaLabel={t('settings:language.select_label')}
                value={i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US'}
                onValueChange={(nextValue) => {
                  void i18n.changeLanguage(nextValue);
                }}
                size="compact"
                stretch
                options={languageOptions.map((option) => ({
                  value: option.value,
                  label: <span>{option.label}</span>,
                }))}
              />
            </SettingRow>

            <SettingRow
              title={t('chatV2:queue.settings.modeTitle')}
              description={t('chatV2:queue.settings.modeDescription')}
              className="items-center"
            >
              <SegmentedControl
                ariaLabel={t('chatV2:queue.settings.modeLabel')}
                value={mode}
                onValueChange={(nextMode) => { void setMode(nextMode); }}
                size="compact"
                className={queueModeLoading ? 'invisible' : undefined}
                options={[
                  { value: 'queue', label: t('chatV2:queue.settings.modeQueue') },
                  { value: 'guide', label: t('chatV2:queue.settings.modeGuide') },
                ]}
              />
              {queueModeLoading && <div aria-hidden="true" className="h-7 w-[132px] animate-pulse rounded-[var(--radius-shell-control)] bg-muted/50" />}
            </SettingRow>

            <MarkdownEditorWindowSettings />

            <SettingRow
              title={t('settings:system_notification.title')}
              description={t('settings:system_notification.desc')}
              className="items-center"
            >
              <SegmentedControl
                ariaLabel={t('settings:system_notification.title')}
                value={notificationPolicy}
                onValueChange={(next) => {
                  const policy = next as SystemNotificationPolicy;
                  setNotificationPolicy(policy);
                  setSystemNotificationPolicy(policy);
                }}
                size="compact"
                options={[
                  { value: 'background', label: t('settings:system_notification.background') },
                  { value: 'always', label: t('settings:system_notification.always') },
                  { value: 'never', label: t('settings:system_notification.never') },
                ]}
              />
            </SettingRow>

            <SettingRow
              title={t('settings:developer.preview_agreement.title')}
              description={t('settings:developer.preview_agreement.desc')}
            >
              <NotionButton
                variant="default"
                size="sm"
                onClick={() => setShowAgreementPreview(true)}
              >
                {t('settings:developer.preview_agreement.button')}
              </NotionButton>
            </SettingRow>
        </SettingsGroup>

        <div className="mt-8">
          <AnkiConnectSettingsSection />
        </div>

        <div className="mt-8 rounded-2xl border border-border/40 bg-background px-3 py-3 sm:px-4">
          <VoiceInputSettingsSection embedded assignedModel={voiceInputAssignedModel} />
        </div>

        <div className="mt-8 rounded-2xl border border-border/40 bg-background px-3 py-3 sm:px-4">
          <div className="px-1 mb-3 mt-0">
            <h3 className="text-base font-semibold text-foreground">{t('settings:memory.title')}</h3>
          </div>
          <MemorySettingsSection embedded />
        </div>

        <WorkbenchSettingsSection className="mt-8" />

        <SettingsGroup
          title={t('settings:cards.developer_options_title')}
          className="mt-8"
        >
          <SettingRow
            title={t('settings:developer.topbar_top_margin.title')}
            description={t('settings:developer.topbar_top_margin.desc')}
          >
            <div className="flex items-center gap-2">
              <Input
                type="number"
                value={topbarTopMargin}
                disabled={!topbarTopMarginLoaded}
                onChange={(e) => setTopbarTopMargin(e.target.value.trim())}
                onBlur={async () => {
                  if (!topbarTopMarginLoaded) return;
                  if (!invoke) return;
                  try {
                    const numValue = parseInt(topbarTopMargin, 10);
                    const platformDefault = isAndroid() ? 30 : 0;
                    if (isNaN(numValue) || numValue < 0) {
                      setTopbarTopMargin(String(platformDefault));
                      return;
                    }
                    await invoke('save_setting', { key: 'topbar.top_margin', value: String(numValue) });
                    setTopbarTopMargin(String(numValue));
                    showGlobalNotification('success', t('settings:save_success'));
                    try {
                      window.dispatchEvent(new CustomEvent('systemSettingsChanged', { detail: { topbarTopMargin: true } }));
                    } catch {
                      // noop
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

          <SwitchRow
            title={t('settings:developer.debug_log_switch.title')}
            description={t('settings:developer.debug_log_switch.desc')}
            checked={debugLogEnabled}
            onCheckedChange={(newValue) => {
              if (newValue) {
                debugMasterSwitch.enable();
              } else {
                debugMasterSwitch.disable();
              }
            }}
          />

          <SettingRow
            title={t('common:debug_panel.open_unified', t('common:debug_panel.open'))}
            description={t('settings:developer.description')}
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
                } catch {
                  // noop
                }
              }}
            >
              {t('common:debug_panel.open_unified', t('common:debug_panel.open'))}
            </NotionButton>
          </SettingRow>

          <SettingRow
            title={t('settings:developer.log_type')}
            description={t('settings:developer.log_type_hint')}
          >
            <div className="flex items-center gap-2">
              <AppSelect
                value={logTypeForOpen}
                onValueChange={setLogTypeForOpen}
                placeholder={t('settings:developer.log_type_placeholder')}
                options={[
                  { value: 'backend', label: t('settings:developer.log_types.backend') },
                  { value: 'frontend', label: t('settings:developer.log_types.frontend') },
                  { value: 'debug', label: t('settings:developer.log_types.debug') },
                  { value: 'crash', label: t('settings:developer.log_types.crash') },
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
                  } catch {
                    showGlobalNotification('error', t('settings:developer.open_logs_failed'));
                  }
                }}
              >
                {t('settings:developer.open_logs')}
              </NotionButton>
            </div>
          </SettingRow>

          <SwitchRow
            title={t('settings:developer.show_raw_request.title')}
            description={t('settings:developer.show_raw_request.desc')}
            checked={showRawRequest}
            loading={!showRawRequestLoaded}
            onCheckedChange={async (newValue) => {
              if (!showRawRequestLoaded) return;
              setShowRawRequest(newValue);
              if (!invoke) return;
              try {
                await invoke('save_setting', { key: 'dev.show_raw_request', value: String(newValue) });
                showGlobalNotification('success', t('settings:save_notifications.saved'));
                try {
                  window.dispatchEvent(new CustomEvent('systemSettingsChanged', { detail: { showRawRequest: newValue } }));
                } catch {
                  // noop
                }
              } catch (error: unknown) {
                showGlobalNotification('error', getErrorMessage(error));
              }
            }}
          />

          {(() => {
            const saveConfig = async (next: typeof filterConfig) => {
              const cfg = { ...next, preset: 'custom' as const };
              setFilterConfig(cfg);
              try {
                await tauriInvoke('save_setting', { key: 'debug.filter_config', value: JSON.stringify(cfg) });
                window.dispatchEvent(new CustomEvent('systemSettingsChanged', { detail: { copyFilterConfig: cfg } }));
              } catch {
                // noop
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
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs bg-transparent hover:bg-[var(--interactive-hover)]"
                      width={140}
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
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs bg-transparent hover:bg-[var(--interactive-hover)]"
                      width={140}
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
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs bg-transparent hover:bg-[var(--interactive-hover)]"
                      width={140}
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
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs bg-transparent hover:bg-[var(--interactive-hover)]"
                      width={140}
                    />
                  </div>
                </div>
              </div>
            );
          })()}

          <SwitchRow
            title={t('settings:developer.persist_logs.title')}
            description={t('settings:developer.persist_logs.desc')}
            checked={debugPersistLogs ?? false}
            loading={debugPersistLogs === null}
            onCheckedChange={async (newValue) => {
              if (debugPersistLogs === null) return;
              setDebugPersistLogs(newValue);
              try {
                await tauriInvoke('save_setting', { key: 'debug.persist_logs', value: String(newValue) });
                showGlobalNotification('success', t('settings:save_notifications.saved'));
              } catch (error: unknown) {
                showGlobalNotification('error', getErrorMessage(error));
              }
            }}
          />

          {debugPersistLogs === true && (
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
        </SettingsGroup>

        <SettingsGroup
          title={t('common:legal.settingsSection.title')}
          className="mt-8"
        >
            <SwitchRow
              title={t('common:legal.settingsSection.sentryToggle.title')}
              description={t('common:legal.settingsSection.sentryToggle.description')}
              checked={sentryEnabled ?? false}
              loading={sentryEnabled === null}
              onCheckedChange={async (newValue) => {
                if (sentryEnabled === null) return;
                setSentryEnabled(newValue);
                try {
                  await tauriInvoke('save_setting', {
                    key: SENTRY_CONSENT_KEY,
                    value: String(newValue),
                  });
                  showGlobalNotification(
                    'success',
                    newValue
                      ? t('common:legal.settingsSection.sentryToggle.enabled')
                      : t('common:legal.settingsSection.sentryToggle.disabled')
                  );
                  if (newValue) {
                    showGlobalNotification('info', t('settings:save_notifications.restart_hint'));
                  }
                } catch (error: unknown) {
                  showGlobalNotification('error', getErrorMessage(error));
                  setSentryEnabled(!newValue);
                }
              }}
            />

            <div className="px-1 py-3">
              <h4 className="text-sm font-medium text-foreground mb-2">
                {t('common:legal.settingsSection.dataFlow.title')}
              </h4>
              <div className="space-y-2">
                {[
                  { key: 'localData' },
                  { key: 'llmData' },
                  { key: 'syncData' },
                  { key: 'sentryData' },
                  { key: 'crossBorderNote' },
                ].map((item) => (
                  <div key={item.key} className="rounded px-1 py-2 transition-colors">
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

            <div className="mt-3 pt-3 border-t border-border/40">
              <SettingRow
                title={t('common:legal.dataRights.manageData')}
                description={t('common:legal.dataRights.manageDataDesc')}
              >
                <NotionButton
                  variant="default"
                  size="sm"
                  onClick={() => {
                    // Settings 已挂载时靠 SETTINGS_NAVIGATE_TAB 事件即时切换；
                    // pending 值兜底 Settings 尚未挂载的竞态（与 openArchivedSessionsSettings 同模式）
                    setPendingSettingsTab('data-governance');
                    window.dispatchEvent(new CustomEvent('SETTINGS_NAVIGATE_TAB', { detail: { tab: 'data-governance' } }));
                  }}
                >
                  {t('common:legal.dataRights.goToDataGovernance')}
                </NotionButton>
              </SettingRow>
            </div>
        </SettingsGroup>
      </SettingSection>

      <UserAgreementDialog
        preview
        open={showAgreementPreview}
        onAccept={() => setShowAgreementPreview(false)}
        onClose={() => setShowAgreementPreview(false)}
      />
    </div>
  );
};

export default GeneralTab;
