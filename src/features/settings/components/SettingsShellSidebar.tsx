import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsSidebar } from './SettingsSidebar';
import { useSlot } from '@/ui-kernel/react';
import type { SettingsSection } from '@/ui-kernel/contracts/settings';
import { settingsNavigation } from '@/ui-plugins/official/settings/navigation';
import { isMobilePlatform } from '@/utils/platform';
import { useSettingsShellStore } from '@/stores/settingsShellStore';

interface SettingsShellSidebarProps {
  isSmallScreen: boolean;
  globalLeftPanelCollapsed: boolean;
  setSidebarOpen?: (open: boolean) => void;
  onBack?: () => void;
}

export const SettingsShellSidebar: React.FC<SettingsShellSidebarProps> = ({
  isSmallScreen,
  globalLeftPanelCollapsed,
  setSidebarOpen,
  onBack,
}) => {
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState('');
  const [sidebarSearchFocused, setSidebarSearchFocused] = useState(false);
  const [internalSidebarOpen, setInternalSidebarOpen] = useState(false);
  const { t } = useTranslation(['settings', 'common', 'data', 'workbench']);
  const entries = useSlot<SettingsSection>('settings.sections');
  const isMobile = isMobilePlatform();
  const { sidebarNavItems, sidebarCategories, settingsSearchIndex } = useMemo(
    () => settingsNavigation(entries, t, { isMobile }),
    [entries, t, isMobile],
  );
  const activeTab = useSettingsShellStore((state) => state.activeTab);
  const setActiveTab = useSettingsShellStore((state) => state.setActiveTab);

  return (
    <SettingsSidebar
      isSmallScreen={isSmallScreen}
      globalLeftPanelCollapsed={globalLeftPanelCollapsed}
      desktopMode="slot"
      sidebarSearchQuery={sidebarSearchQuery}
      setSidebarSearchQuery={setSidebarSearchQuery}
      sidebarSearchFocused={sidebarSearchFocused}
      setSidebarSearchFocused={setSidebarSearchFocused}
      settingsSearchIndex={settingsSearchIndex}
      sidebarNavItems={sidebarNavItems}
      sidebarCategories={sidebarCategories}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      setSidebarOpen={setSidebarOpen ?? setInternalSidebarOpen}
      onBack={onBack}
    />
  );
};
