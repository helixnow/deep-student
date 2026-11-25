import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkshopComposer } from '@/features/plugin-workshop';
import { usePluginManagerWorkshop } from '@/features/plugin-manager';
import type { AppWindowProps } from '../../core/types';
import { useHostSafeMode } from './hostGatedApp';

export default function PluginWorkshopAppWindow({ onTitleChange }: AppWindowProps) {
  const { t } = useTranslation('plugin_manager');
  const workshop = usePluginManagerWorkshop();
  const safeMode = useHostSafeMode();
  useEffect(() => { onTitleChange(t('workshop.label')); }, [onTitleChange, t]);
  return (
    <div className="h-full min-h-0 overflow-auto bg-background p-5" data-testid="workshop-app">
      <div className="mx-auto max-w-3xl space-y-6">
        <WorkshopComposer workshop={workshop} disabled={safeMode} safeMode={safeMode} />
        {workshop?.allCreations ?? workshop?.creations ?? (
          !safeMode ? (
            <p
              role="status"
              data-testid="workshop-app-unavailable"
              className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground"
            >
              {t('workshop.loading')}
            </p>
          ) : null
        )}
      </div>
    </div>
  );
}
