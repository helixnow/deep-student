import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Check, Search } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from './Input';
import { CustomScrollArea } from '../../custom-scroll-area';
import { cn } from '../../../lib/utils';

export type CollapsibleModelOption = { value: string; label: string; icon?: string };

export interface CollapsibleModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
  options: CollapsibleModelOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  disabled?: boolean;
  buttonClassName?: string;
  title?: string;
  totalCount?: number;
  isFromCache?: boolean;
  cacheTimeText?: string;
}

export function CollapsibleModelSelector({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  className,
  disabled,
  buttonClassName,
  title,
  totalCount,
  isFromCache,
  cacheTimeText,
}: CollapsibleModelSelectorProps) {
  const { t } = useTranslation('common');
  const resolvedPlaceholder = placeholder ?? t('actions.select');
  const resolvedSearchPlaceholder = searchPlaceholder ?? t('actions.search');
  const resolvedEmptyText = emptyText ?? t('noResults');
  const [expanded, setExpanded] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const selectedOption = options.find(o => o.value === value);
  const buttonLabel = selectedOption?.label ?? resolvedPlaceholder;

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const handleSelect = (v: string) => {
    onChange(v);
    setExpanded(false);
    setQuery('');
  };

  const toggleExpanded = () => {
    if (!disabled) {
      setExpanded(prev => !prev);
      if (expanded) {
        setQuery('');
      }
    }
  };

  return (
    <div className={cn('w-full', className)}>
      <NotionButton
        type="button"
        variant="outline"
        className={cn('w-full justify-between', buttonClassName)}
        disabled={disabled}
        onClick={toggleExpanded}
      >
        <span className="flex items-center gap-2 truncate text-left">
          {selectedOption?.icon && (
            <img 
              src={selectedOption.icon} 
              alt="" 
              className="h-4 w-4 flex-shrink-0 rounded object-contain"
              style={{ opacity: selectedOption.icon.includes('generic.svg') ? 0.5 : 1 }}
            />
          )}
          <span className="truncate">{buttonLabel}</span>
        </span>
        {expanded ? (
          <ChevronUp className="h-4 w-4 opacity-70" />
        ) : (
          <ChevronDown className="h-4 w-4 opacity-70" />
        )}
      </NotionButton>

      <div 
        className={cn(
          "grid transition-all duration-300 ease-in-out",
          expanded ? "grid-rows-[1fr] opacity-100 mt-2" : "grid-rows-[0fr] opacity-0"
        )}
      >
        <div className="overflow-hidden">
          <div className="rounded-lg border border-border bg-card">
            <div className="p-3 border-b border-border/60">
              <div className="relative">
                <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground">
                  <Search className="h-4 w-4" />
                </span>
                <Input
                  autoFocus={expanded}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={resolvedSearchPlaceholder}
                  className="pl-8"
                />
              </div>
              {totalCount !== undefined && (
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{t('model_selector.total_model_count', { count: totalCount })}</span>
                  {cacheTimeText && (
                    <span className="flex items-center gap-1">
                      {isFromCache && <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted">{t('model_selector.cached')}</span>}
                      {cacheTimeText}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="h-[min(280px,40vh)]">
              <CustomScrollArea className="h-full" viewportClassName="px-2 py-2">
                {filtered.length === 0 ? (
                  <div className="px-2 py-6 text-sm text-muted-foreground text-center">{resolvedEmptyText}</div>
                ) : (
                  <ul className="space-y-1">
                    {filtered.map((o) => {
                      const selected = o.value === value;
                      return (
                        <li key={o.value}>
                          <button
                            type="button"
                            className={cn(
                              'w-full flex items-center justify-between rounded-md px-2 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                              'hover:bg-accent/70 hover:text-accent-foreground',
                              selected
                                ? 'bg-accent text-accent-foreground'
                                : 'text-foreground'
                            )}
                            onClick={() => handleSelect(o.value)}
                          >
                            <span className="flex items-center gap-2 truncate text-left min-w-0">
                              {o.icon && (
                                <img 
                                  src={o.icon} 
                                  alt="" 
                                  className="h-4 w-4 flex-shrink-0 rounded object-contain"
                                  style={{ opacity: o.icon.includes('generic.svg') ? 0.5 : 1 }}
                                />
                              )}
                              <span className="truncate">{o.label}</span>
                            </span>
                            {selected && <Check className="h-4 w-4 text-accent-foreground flex-shrink-0" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CustomScrollArea>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
