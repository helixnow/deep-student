import { CaretRight, MagnifyingGlass } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { SettingsAboutFooter } from './SettingsAboutFooter';
import { revealSettingsSection } from './settingsSearchReveal';
import type { SettingsSearchIndexItem, SettingsSidebarCategory, SettingsSidebarNavItem } from './useSettingsNavigation';

interface SettingsMobileNavigationProps {
  categories: SettingsSidebarCategory[];
  items: SettingsSidebarNavItem[];
  searchIndex: SettingsSearchIndexItem[];
  query: string;
  onQueryChange: (query: string) => void;
  onOpenTab: (tab: string) => void;
}

/** Same six categories as desktop; results still jump straight to a setting. */
export function SettingsMobileNavigation({ categories, items, searchIndex, query, onQueryChange, onOpenTab }: SettingsMobileNavigationProps) {
  const { t } = useTranslation(['settings']);
  const normalizedQuery = query.trim().toLowerCase();
  const results = normalizedQuery
    ? searchIndex.filter((item) => item.label.toLowerCase().includes(normalizedQuery)
      || item.keywords.some((keyword) => keyword.toLowerCase().includes(normalizedQuery)))
    : [];

  return (
    <CustomScrollArea
      className="settings-mobile-sheet-body scrollbar-none min-h-0 flex-1 w-full max-w-full"
      viewportClassName="settings-mobile-sheet-scroll-viewport h-full"
      trackOffsetTop={16}
      trackOffsetBottom={16}
      trackOffsetRight={0}
    >
      <div className="mx-auto w-full max-w-[40rem] space-y-4 px-4 pb-[calc(1.25rem+var(--mobile-safe-area-bottom,0px))] pt-4 sm:px-5">
        <div className="relative">
          <MagnifyingGlass aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t('settings:sidebar.search_placeholder')}
            aria-label={t('settings:sidebar.search_placeholder')}
            data-settings-search
            className="h-11 rounded-[14px] border-border/35 bg-[color:var(--surface-elevated)] pl-10 text-base shadow-[var(--shadow-content-subtle)]"
          />
        </div>

        {normalizedQuery ? (
          <div className="rounded-2xl border border-border/40 bg-background px-1.5 py-1.5">
            {results.length === 0 ? (
              <div className="px-3 py-8 text-center text-base text-muted-foreground" role="status">
                {t('settings:sidebar.no_results')}
              </div>
            ) : results.map((item, index) => {
              const section = items.find((nav) => nav.value === item.tab);
              const category = categories.find((group) => group.items.some((nav) => nav.value === item.tab));
              return (
                <DsButton
                  variant="ghost"
                  size="md"
                  key={`${item.tab}-${item.label}-${index}`}
                  onClick={() => {
                    onOpenTab(item.tab);
                    revealSettingsSection(item.label);
                  }}
                  className="!flex !h-auto !min-h-12 !w-full !justify-start !whitespace-normal !border-0 !px-3 !py-2 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-medium text-foreground">{item.label}</span>
                    <span className="block text-sm text-muted-foreground">
                      {category ? `${category.label} / ${section?.label ?? item.tab}` : section?.label}
                    </span>
                  </span>
                  <CaretRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                </DsButton>
              );
            })}
          </div>
        ) : (
          <nav aria-label={t('settings:title')} data-settings-category-list className="overflow-hidden rounded-[22px] border border-border/30 bg-[color:var(--surface-elevated)] shadow-[var(--shadow-shell-soft)]">
            {categories.map((category) => {
              const Icon = category.icon;
              return (
                <DsButton
                  key={category.value}
                  variant="ghost"
                  size="md"
                  onClick={() => onOpenTab(category.items[0].value)}
                  aria-label={category.label}
                  className="!flex !h-auto !min-h-[72px] !w-full !items-center !justify-start !gap-3 !rounded-none !border-0 !border-b !border-border/35 !px-4 !py-3 text-left last:!border-b-0"
                >
                  <Icon className="h-6 w-6 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-medium leading-6 text-foreground">{category.label}</span>
                    <span className="mt-0.5 block whitespace-normal text-sm leading-5 text-muted-foreground">
                      {category.items.map((item) => item.label).join(' · ')}
                    </span>
                  </span>
                  <CaretRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground/55" />
                </DsButton>
              );
            })}
          </nav>
        )}
        <SettingsAboutFooter onOpen={() => onOpenTab('about')} />
      </div>
    </CustomScrollArea>
  );
}
