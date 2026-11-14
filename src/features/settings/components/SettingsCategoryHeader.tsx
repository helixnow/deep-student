import { useEffect, useRef } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';
import type { SettingsSidebarCategory } from './useSettingsNavigation';

type SettingsCategoryHeaderProps = {
  category: SettingsSidebarCategory;
  activeTab: string;
  onTabChange: (tab: string) => void;
  idPrefix: string;
  compact?: boolean;
};

/** Navigation only: the settings shell keeps rendering just the active section. */
export function SettingsCategoryHeader({
  category,
  activeTab,
  onTabChange,
  idPrefix,
  compact = false,
}: SettingsCategoryHeaderProps) {
  const tabListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Deep links and search can change the active section without clicking a tab.
    tabListRef.current
      ?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab, category.value]);

  return (
    <header className={compact ? 'mb-4 min-w-0' : 'mb-6 min-w-0 space-y-3'}>
      {!compact && (
        <h1 className="text-xl font-semibold text-foreground">{category.label}</h1>
      )}
      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList
          ref={tabListRef}
          aria-label={category.label}
          aria-orientation="horizontal"
          className="h-auto min-h-10 max-w-full overflow-x-auto overflow-y-hidden pb-2"
        >
          {category.items.map((item) => (
            <TabsTrigger
              key={item.value}
              value={item.value}
              // The section is rendered by the settings shell (Settings.tsx), outside these Tabs.
              id={`${idPrefix}-tab-${item.value}`}
              aria-controls={`${idPrefix}-panel`}
              data-tour-id={item.tourId}
              className="shrink-0"
            >
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </header>
  );
}
