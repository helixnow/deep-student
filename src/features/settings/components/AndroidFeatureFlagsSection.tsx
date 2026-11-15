import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { DsButton } from '@/components/ui/DsButton';
import { getErrorMessage } from '@/utils/errorUtils';
import { SettingRow, SettingsGroup, SwitchRow } from './settingsTabPrimitives';

// This gate is used by the Android note and mind map tool routing. Do not expose
// switches for desktop capabilities (e.g. embedded browser) in Android settings.
const inEditorTools = 'tools.workbench_agent';
type FlagState = 'Enabled' | 'Disabled' | { Gradual: number } | { UserSpecific: string[] };
type FlagSnapshot = { configured: FlagState; enabled: boolean };

export function AndroidFeatureFlagsSection({ invoke }: { invoke: typeof tauriInvoke }) {
  const { t } = useTranslation('settings');
  const [snapshot, setSnapshot] = useState<FlagSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async (): Promise<FlagSnapshot> => {
    const { flags } = await invoke<{ flags: Array<{ name: string; state: FlagState }> }>('get_feature_flags');
    const configured = flags.find(flag => flag.name === inEditorTools)?.state;
    if (!configured) throw new Error(t('feature_flags.flag_unavailable'));
    const enabled = await invoke<boolean>('is_feature_enabled', { featureName: inEditorTools });
    return { configured, enabled };
  }, [invoke, t]);

  useEffect(() => {
    let current = true;
    void read().then(
      (next) => { if (current) { setSnapshot(next); setError(null); } },
      (failure: unknown) => { if (current) setError(getErrorMessage(failure)); },
    );
    return () => { current = false; };
  }, [read]);

  const update = async (action?: 'enable' | 'disable' | 'reset') => {
    setBusy(true);
    setError(null);
    try {
      if (action) {
        const result = await invoke<{ success: boolean; message: string }>('update_feature_flag', {
          featureName: inEditorTools, action,
        });
        if (!result.success) throw new Error(result.message);
      }
      setSnapshot(await read());
    } catch (failure) {
      // If saving succeeded but readback failed, the old value is no longer authoritative.
      setSnapshot(null);
      setError(getErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const configuredLabel = snapshot === null ? '' : snapshot.configured === 'Enabled'
    ? t('feature_flags.on') : snapshot.configured === 'Disabled'
      ? t('feature_flags.off') : t('feature_flags.conditional');
  return (
    <SettingsGroup title={t('feature_flags.title')} className="mt-8">
      <SwitchRow
        title={t('feature_flags.editor_tools')}
        description={t('feature_flags.editor_tools_description')}
        checked={snapshot?.configured === 'Enabled'}
        loading={snapshot === null && !error}
        disabled={busy || snapshot === null}
        onCheckedChange={(enabled) => void update(enabled ? 'enable' : 'disable')}
      />
      {snapshot && (
        <SettingRow
          title={t('feature_flags.status', {
            configured: configuredLabel,
            effective: t(snapshot.enabled ? 'feature_flags.on' : 'feature_flags.off'),
          })}
        >
          <DsButton variant="outline" size="sm" disabled={busy} onClick={() => void update('reset')}>
            {t('feature_flags.reset')}
          </DsButton>
        </SettingRow>
      )}
      {error && (
        <div role="alert">
          <SettingRow title={error}>
            <DsButton variant="outline" size="sm" disabled={busy} onClick={() => void update()}>
              {t('feature_flags.retry')}
            </DsButton>
          </SettingRow>
        </div>
      )}
    </SettingsGroup>
  );
}
