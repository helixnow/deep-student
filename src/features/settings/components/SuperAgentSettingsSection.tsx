/**
 * 设置 → 自动化 → Super-agent（实验）。
 * 这是启用 Super-agent 模式的**唯一入口**：打开后侧栏才会出现 “Super-agent” 页面。
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsGroup, SwitchRow } from './settingsTabPrimitives';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  useSuperAgentEnabled,
  useSuperAgentEnabledStore,
  useSyncSuperAgentEnabled,
} from '@/stores/superAgentEnabledStore';

export const SuperAgentSettingsSection: React.FC = () => {
  const { t } = useTranslation('superAgent');
  useSyncSuperAgentEnabled();
  const enabled = useSuperAgentEnabled();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await useSuperAgentEnabledStore.getState().setEnabled(next);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup title={t('settings.title')} description={t('settings.description')}>
      <SwitchRow
        title={t('settings.switchTitle')}
        description={t('settings.switchDescription')}
        checked={enabled}
        loading={busy}
        onCheckedChange={(v) => void toggle(v)}
      />
      {error && <p className="px-1 pt-1 text-xs text-destructive">{error}</p>}
      <p className="px-1 pt-2 text-xs leading-relaxed text-muted-foreground/70">{t('settings.safety')}</p>
    </SettingsGroup>
  );
};

export default SuperAgentSettingsSection;
