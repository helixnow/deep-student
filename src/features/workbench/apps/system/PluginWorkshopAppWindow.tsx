import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkshopComposer } from '@/features/plugin-workshop';
import { usePluginManagerWorkshop } from '@/features/plugin-manager';
import type { AppWindowProps } from '../../core/types';

export default function PluginWorkshopAppWindow({ onTitleChange }: AppWindowProps) {
  const { t } = useTranslation('plugin_manager');
  const workshop = usePluginManagerWorkshop();
  useEffect(() => { onTitleChange(t('workshop.label')); }, [onTitleChange, t]);
  return <div className="h-full min-h-0 overflow-auto bg-background p-5" data-testid="workshop-app">
    <div className="mx-auto max-w-3xl space-y-6">
      <WorkshopComposer workshop={workshop} />
      {workshop?.allCreations ?? workshop?.creations}
    </div>
  </div>;
}
