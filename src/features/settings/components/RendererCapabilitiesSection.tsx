import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { SettingsGroup, SwitchRow } from './settingsTabPrimitives';
import {
  DEFAULT_RENDERER_CAPABILITIES,
  type RendererCapabilities,
  loadRendererCapabilities,
  saveRendererCapabilities,
} from '@/features/chat/components/renderers/rendererCapabilities';

const CAPABILITY_ROWS: Array<{
  key: keyof RendererCapabilities;
  titleKey: string;
  descriptionKey: string;
}> = [
  { key: 'chemicalStructures', titleKey: 'chemicalStructures', descriptionKey: 'chemicalStructures_description' },
  { key: 'charts', titleKey: 'charts', descriptionKey: 'charts_description' },
  { key: 'graphviz', titleKey: 'graphviz', descriptionKey: 'graphviz_description' },
  { key: 'music', titleKey: 'music', descriptionKey: 'music_description' },
  { key: 'timing', titleKey: 'timing', descriptionKey: 'timing_description' },
  { key: 'chemicalFiles', titleKey: 'chemicalFiles', descriptionKey: 'chemicalFiles_description' },
  { key: 'molecular3d', titleKey: 'molecular3d', descriptionKey: 'molecular3d_description' },
  { key: 'geojson', titleKey: 'geojson', descriptionKey: 'geojson_description' },
];

/** 用户显式选择哪些专用正文渲染器可用，开关同时控制模型契约注入。 */
export const RendererCapabilitiesSection: React.FC = () => {
  const { t } = useTranslation(['settings', 'common']);
  const [capabilities, setCapabilities] = useState<RendererCapabilities | null>(null);
  const [savingKey, setSavingKey] = useState<keyof RendererCapabilities | null>(null);

  useEffect(() => {
    void loadRendererCapabilities().then(setCapabilities).catch(() => setCapabilities(DEFAULT_RENDERER_CAPABILITIES));
  }, []);

  const update = async (key: keyof RendererCapabilities, enabled: boolean) => {
    if (!capabilities || savingKey) return;
    const previous = capabilities;
    const next = { ...previous, [key]: enabled };
    setCapabilities(next);
    setSavingKey(key);
    try {
      await saveRendererCapabilities(next);
      showGlobalNotification('success', t('settings:renderer_capabilities.saved'));
    } catch (error) {
      setCapabilities(previous);
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <SettingsGroup
      title={t('settings:renderer_capabilities.title')}
      description={t('settings:renderer_capabilities.description')}
      className="mt-8"
    >
      {CAPABILITY_ROWS.map(({ key, titleKey, descriptionKey }) => (
        <SwitchRow
          key={key}
          title={t(`settings:renderer_capabilities.${titleKey}`)}
          description={t(`settings:renderer_capabilities.${descriptionKey}`)}
          checked={capabilities?.[key] ?? false}
          loading={capabilities === null || savingKey === key}
          disabled={savingKey !== null}
          onCheckedChange={(enabled) => void update(key, enabled)}
        />
      ))}
    </SettingsGroup>
  );
};

export default RendererCapabilitiesSection;
