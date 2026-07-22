import React from 'react';
import { Database, ShieldCheck } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { DsButton } from '@/components/ui/DsButton';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { setPendingSettingsRoute } from '@/utils/pendingSettingsTab';
import { APP_EVENTS, dispatchAppEvent } from '@/events';

interface FeatureUnavailablePanelProps {
  component: string;
  title: string;
}

export const FeatureUnavailablePanel: React.FC<FeatureUnavailablePanelProps> = ({
  component,
  title,
}) => {
  const { t } = useTranslation(['common', 'data']);
  const issue = useSystemStatusStore((state) =>
    state.componentHealth.find((entry) => entry.component === component),
  );

  if (!issue || issue.status === 'healthy') return null;

  const openRecovery = () => {
    const route = {
      tab: 'data-governance' as const,
      dataGovernanceTab: 'recovery',
    };
    setPendingSettingsRoute(route);
    dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_TAB, { tabName: 'settings' });
    dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, route);
  };

  return (
    <div className="flex h-full min-h-[320px] items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg rounded-[var(--radius-shell-panel)] border border-warning/30 bg-[color:var(--surface-panel)] p-6 shadow-[var(--shadow-shell-soft)]">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning">
            <Database size={20} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-foreground">{title}</h2>
              <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                {t('common:maintenance.component_unavailable')}
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {issue.reason || t('common:maintenance.component_unavailable_description')}
            </p>
            {issue.dependency && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('common:maintenance.blocked_by_dependency', { dependency: issue.dependency })}
              </p>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <DsButton onClick={openRecovery}>
                <ShieldCheck size={16} className="mr-1.5" />
                {t('common:maintenance.go_to_data_governance')}
              </DsButton>
              <span className="text-xs text-muted-foreground">
                {t('common:maintenance.other_features_available')}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FeatureUnavailablePanel;
