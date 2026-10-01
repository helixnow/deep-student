import React, { useId, useState } from 'react';
import { SettingsShellSidebar } from '@/features/settings/components/SettingsShellSidebar';
import { SettingsCategoryHeader } from '@/features/settings/components/SettingsCategoryHeader';
import { SettingsMobileNavigation } from '@/features/settings/components/SettingsMobileNavigation';
import { ParamsTab } from '@/features/settings/components/ParamsTab';
import { useSettingsNavigation } from '@/features/settings/components/useSettingsNavigation';
import { useSettingsShellStore } from '@/stores/settingsShellStore';
import type { SettingsExtra } from '@/features/settings/components/hookDepsTypes';
import '@/features/settings/styles/settings.css';

/** Real navigation and parameter controls; native calls use the shared CT mocks. */
export function SettingsNavigationHarness({ mobile = false }: { mobile?: boolean }) {
  const { sidebarCategories, sidebarNavItems, settingsSearchIndex } = useSettingsNavigation();
  const activeTab = useSettingsShellStore((state) => state.activeTab);
  const setActiveTab = useSettingsShellStore((state) => state.setActiveTab);
  const category = sidebarCategories.find((entry) => entry.items.some((item) => item.value === activeTab));
  const [query, setQuery] = useState('');
  const [showContent, setShowContent] = useState(!mobile);
  const [extra, setExtra] = useState<SettingsExtra>({ paramsLoaded: true, chatStreamTimeoutSeconds: '120', chatStreamAutoCancel: true });
  const idPrefix = useId();

  return (
    <div
      data-theme="light"
      style={{ display: 'flex', width: '100%', height: '100vh', '--shell-titlebar-height': '0px', '--shell-layout-gap': '0px' } as React.CSSProperties}
    >
      {!mobile && (
        <div style={{ width: 240, flexShrink: 0 }}>
          <SettingsShellSidebar isSmallScreen={false} globalLeftPanelCollapsed={false} />
        </div>
      )}
      <div className="settings bg-[color:var(--shell-workspace-panel)]" style={{ position: 'relative', flex: 1, minWidth: 0, height: '100%' }} data-wb-settings-active-tab={activeTab}>
        {!showContent ? (
          <SettingsMobileNavigation
            categories={sidebarCategories}
            items={sidebarNavItems}
            searchIndex={settingsSearchIndex}
            query={query}
            onQueryChange={setQuery}
            onOpenTab={(tab) => { setActiveTab(tab); setShowContent(true); setQuery(''); }}
          />
        ) : (
          <div className="px-5 pt-4 lg:px-8">
            {category && <SettingsCategoryHeader category={category} activeTab={activeTab} onTabChange={setActiveTab} idPrefix={idPrefix} compact={mobile} />}
            <div id={`${idPrefix}-panel`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-${activeTab}`}>
              {activeTab === 'params' ? (
                <ParamsTab extra={extra} setExtra={setExtra} invoke={null} handleSaveChatStreamTimeout={async () => undefined} handleToggleChatStreamAutoCancel={async () => undefined} />
              ) : (
                <h2>{sidebarNavItems.find((item) => item.value === activeTab)?.label}</h2>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
