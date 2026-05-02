import React, { useState } from 'react';
import { SettingsSidebar } from './SettingsSidebar';
import { useSettingsNavigation } from './useSettingsNavigation';
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
  const { sidebarNavItems, settingsSearchIndex } = useSettingsNavigation();
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
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      setSidebarOpen={setSidebarOpen ?? setInternalSidebarOpen}
      onBack={onBack}
    />
  );
};
