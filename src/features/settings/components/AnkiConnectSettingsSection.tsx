import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { Switch } from '@/components/ui/shad/Switch';
import { Input } from '@/components/ui/shad/Input';
import { ankiConnectClient, AnkiConnectSettings } from '@/services/ankiConnectClient';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { SettingRow, SettingsGroup, SwitchRow } from './settingsTabPrimitives';

interface AnkiConnectSettingsSectionProps {
  compact?: boolean;
}

export const AnkiConnectSettingsSection: React.FC<AnkiConnectSettingsSectionProps> = ({ compact = false }) => {
  const { t } = useTranslation(['common']);
  const [settings, setSettings] = useState<AnkiConnectSettings | null>(null);
  const [testing, setTesting] = useState(false);
  // No deck/model selectors here; only export deck name

  useEffect(() => {
    (async () => {
      const s = await ankiConnectClient.loadSettings();
      setSettings(s);
    })();
  }, []);

  const savePartial = async (patch: Partial<AnkiConnectSettings>) => {
    const next = { ...(settings as any), ...patch } as AnkiConnectSettings;
    setSettings(next);
    try {
      await ankiConnectClient.saveSettings(patch);
      window.dispatchEvent(new CustomEvent('systemSettingsChanged', {
        detail: {
          ankiConnectEnabled: next.anki_connect_enabled,
          ankiConnectAutoImportEnabled: next.anki_connect_auto_import_enabled,
          ankiConnectDeleteApkgAfterImport: next.anki_connect_delete_apkg_after_import,
          ankiConnectOpenFolderOnFailure: next.anki_connect_open_folder_on_failure,
        }
      }));
    } catch (e: any) {
      showGlobalNotification('error', `${t('common:anki.settings.save_failed')}: ${getErrorMessage(e)}`);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      // 更严格的测试：尝试获取牌组与模型
      const ok = await ankiConnectClient.check();
      if (!ok) throw new Error(t('common:anki.settings.unavailable'));
      const [deckNames, modelNames] = await Promise.all([
        (window as any).__TAURI_INTERNALS__ ? (await import('@tauri-apps/api/core')).invoke<string[]>('anki_get_deck_names') : Promise.resolve([]),
        (window as any).__TAURI_INTERNALS__ ? (await import('@tauri-apps/api/core')).invoke<string[]>('get_anki_model_names') : Promise.resolve([])
      ]);
      showGlobalNotification('success', t('common:anki.settings.connection_success', { deckCount: deckNames.length, modelCount: modelNames.length }));
    } catch {
      showGlobalNotification('error', t('common:anki.settings.connection_failed'));
    } finally {
      setTesting(false);
    }
  };

  if (!settings) return null;

  // 紧凑模式 - 用于侧边栏内嵌
  if (compact) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs">{t('common:anki.settings.enable_label')}</span>
          <Switch checked={settings.anki_connect_enabled} onCheckedChange={(v) => savePartial({ anki_connect_enabled: v })} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs">{t('common:anki.settings.auto_import_label')}</span>
          <Switch checked={settings.anki_connect_auto_import_enabled} onCheckedChange={(v) => savePartial({ anki_connect_auto_import_enabled: v })} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs">{t('common:anki.settings.delete_after_import_label')}</span>
          <Switch checked={settings.anki_connect_delete_apkg_after_import} onCheckedChange={(v) => savePartial({ anki_connect_delete_apkg_after_import: v })} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs">{t('common:anki.settings.open_on_failure_label')}</span>
          <Switch checked={settings.anki_connect_open_folder_on_failure} onCheckedChange={(v) => savePartial({ anki_connect_open_folder_on_failure: v })} />
        </div>
        <NotionButton size="sm" className="w-full h-auto py-1.5 text-xs whitespace-normal" onClick={testConnection} disabled={!settings.anki_connect_enabled || testing}>
          {testing ? t('common:anki.settings.testing') : t('common:anki.settings.test_connection_short')}
        </NotionButton>
      </div>
    );
  }

  return (
    <SettingsGroup
      title={t('common:anki.settings.title')}
      description={t('common:anki.settings.description')}
    >
      <SwitchRow
        title={t('common:anki.settings.enable_label')}
        description={t('common:anki.settings.enable_desc')}
        checked={settings.anki_connect_enabled}
        onCheckedChange={(value) => savePartial({ anki_connect_enabled: value })}
      />

      <SwitchRow
        title={t('common:anki.settings.auto_import_label')}
        description={t('common:anki.settings.auto_import_desc')}
        checked={settings.anki_connect_auto_import_enabled}
        onCheckedChange={(value) => savePartial({ anki_connect_auto_import_enabled: value })}
      />

      <SwitchRow
        title={t('common:anki.settings.delete_after_import_label')}
        description={t('common:anki.settings.delete_after_import_desc')}
        checked={settings.anki_connect_delete_apkg_after_import}
        onCheckedChange={(value) => savePartial({ anki_connect_delete_apkg_after_import: value })}
      />

      <SwitchRow
        title={t('common:anki.settings.open_on_failure_label')}
        description={t('common:anki.settings.open_on_failure_desc')}
        checked={settings.anki_connect_open_folder_on_failure}
        onCheckedChange={(value) => savePartial({ anki_connect_open_folder_on_failure: value })}
      />

      <SettingRow
        title={t('common:anki.settings.export_deck_label')}
        description={t('common:anki.settings.export_deck_hint')}
        className="items-center"
      >
        <Input
          placeholder={t('common:anki.settings.export_deck_placeholder')}
          value={settings.anki_connect_default_deck || ''}
          onChange={(event) => savePartial({ anki_connect_default_deck: event.target.value })}
          className="h-8 w-64 max-w-full bg-transparent text-xs"
        />
      </SettingRow>

      <div className="flex justify-end px-1 pt-2.5">
        <NotionButton
          variant="default"
          size="sm"
          onClick={testConnection}
          disabled={!settings.anki_connect_enabled || testing}
        >
          {testing ? t('common:anki.settings.testing') : t('common:anki.settings.test_connection')}
        </NotionButton>
      </div>
    </SettingsGroup>
  );
};

export default AnkiConnectSettingsSection;
