import { useEffect, useRef, type KeyboardEvent } from 'react';
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

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % category.items.length;
        break;
      case 'ArrowLeft':
        nextIndex = (index - 1 + category.items.length) % category.items.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = category.items.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    tabListRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]
      ?.focus({ preventScroll: true });
    onTabChange(category.items[nextIndex].value);
  };

  return (
    <header className={compact ? 'mb-4 min-w-0' : 'mb-6 min-w-0 space-y-3'}>
      {!compact && (
        <h1 className="text-xl font-semibold text-foreground">{category.label}</h1>
      )}
      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList
          ref={tabListRef}
          role="tablist"
          aria-label={category.label}
          aria-orientation="horizontal"
          className="h-auto min-h-10 max-w-full overflow-x-auto overflow-y-hidden pb-2"
        >
          {category.items.map((item, index) => (
            <TabsTrigger
              key={item.value}
              value={item.value}
              role="tab"
              id={`${idPrefix}-tab-${item.value}`}
              aria-controls={`${idPrefix}-panel`}
              data-tour-id={item.tourId}
              aria-selected={activeTab === item.value}
              tabIndex={activeTab === item.value ? 0 : -1}
              className="shrink-0"
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </header>
  );
}
