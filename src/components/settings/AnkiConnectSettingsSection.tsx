import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/shad/Card';
import { NotionButton } from '../ui/NotionButton';
import { Switch } from '../ui/shad/Switch';
import { Input } from '../ui/shad/Input';
import { ankiConnectClient, AnkiConnectSettings } from '../../services/ankiConnectClient';
import { showGlobalNotification } from '../UnifiedNotification';
import { getErrorMessage } from '../../utils/errorUtils';

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
      // 向全局派发连接状态事件，供页面顶部状态同步
      window.dispatchEvent(new CustomEvent('ankiConnectStatusUpdated', {
        detail: { available: true, deckNames, modelNames }
      }));
      showGlobalNotification('success', t('common:anki.settings.connection_success', { deckCount: deckNames.length, modelCount: modelNames.length }));
    } catch (e: any) {
      window.dispatchEvent(new CustomEvent('ankiConnectStatusUpdated', {
        detail: { available: false, error: e?.message || String(e) }
      }));
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
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>{t('common:anki.settings.title')}</CardTitle>
        <CardDescription>{t('common:anki.settings.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between p-3 rounded-lg border">
            <div>
              <div className="font-medium">{t('common:anki.settings.enable_label')}</div>
              <div className="text-xs text-muted-foreground">{t('common:anki.settings.enable_desc')}</div>
            </div>
            <Switch checked={settings.anki_connect_enabled} onCheckedChange={(v) => savePartial({ anki_connect_enabled: v })} />
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg border">
            <div>
              <div className="font-medium">{t('common:anki.settings.auto_import_label')}</div>
              <div className="text-xs text-muted-foreground">{t('common:anki.settings.auto_import_desc')}</div>
            </div>
            <Switch checked={settings.anki_connect_auto_import_enabled} onCheckedChange={(v) => savePartial({ anki_connect_auto_import_enabled: v })} />
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg border">
            <div>
              <div className="font-medium">{t('common:anki.settings.delete_after_import_label')}</div>
              <div className="text-xs text-muted-foreground">{t('common:anki.settings.delete_after_import_desc')}</div>
            </div>
            <Switch checked={settings.anki_connect_delete_apkg_after_import} onCheckedChange={(v) => savePartial({ anki_connect_delete_apkg_after_import: v })} />
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg border">
            <div>
              <div className="font-medium">{t('common:anki.settings.open_on_failure_label')}</div>
              <div className="text-xs text-muted-foreground">{t('common:anki.settings.open_on_failure_desc')}</div>
            </div>
            <Switch checked={settings.anki_connect_open_folder_on_failure} onCheckedChange={(v) => savePartial({ anki_connect_open_folder_on_failure: v })} />
          </div>

          <div className="p-3 rounded-lg border">
            <div className="font-medium mb-2">{t('common:anki.settings.export_deck_label')}</div>
            <Input
              placeholder={t('common:anki.settings.export_deck_placeholder')}
              value={settings.anki_connect_export_deck || ''}
              onChange={(e) => savePartial({ anki_connect_export_deck: e.target.value })}
            />
            <div className="mt-1 text-xs text-muted-foreground">{t('common:anki.settings.export_deck_hint')}</div>
          </div>

          <div className="col-span-1 md:col-span-2">
            <NotionButton onClick={testConnection} disabled={!settings.anki_connect_enabled || testing}>
              {testing ? t('common:anki.settings.testing') : t('common:anki.settings.test_connection')}
            </NotionButton>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default AnkiConnectSettingsSection;
