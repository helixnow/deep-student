import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Check, Search } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from './Input';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogBody } from '../NotionDialog';
import { CustomScrollArea } from '../../custom-scroll-area';
import { cn } from '../../../lib/utils';

export type ComboboxOption = { value: string; label: string; icon?: string };

export interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  disabled?: boolean;
  buttonClassName?: string;
  title?: string;
}

export function Combobox({
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
}: ComboboxProps) {
  const { t } = useTranslation('common');
  const resolvedPlaceholder = placeholder ?? t('actions.select');
  const resolvedSearchPlaceholder = searchPlaceholder ?? t('actions.search');
  const resolvedEmptyText = emptyText ?? t('noResults');
  const resolvedTitle = title ?? t('selectModel');
  const [open, setOpen] = React.useState(false);
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
    setOpen(false);
  };

  return (
    <div className={cn('w-full', className)}>
      <NotionButton
        type="button"
        variant="outline"
        className={cn('w-full justify-between', buttonClassName)}
        disabled={disabled}
        onClick={() => setOpen(true)}
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
        <ChevronDown className="h-4 w-4 opacity-70" />
      </NotionButton>

      <NotionDialog open={open} onOpenChange={setOpen} maxWidth="max-w-lg" className="p-0">
        <NotionDialogHeader>
          <NotionDialogTitle className="text-base">{resolvedTitle}</NotionDialogTitle>
        </NotionDialogHeader>
        <div className="px-5 pb-2">
            <div className="mt-2 relative">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground">
                <Search className="h-4 w-4" />
              </span>
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={resolvedSearchPlaceholder}
                className="pl-8"
              />
            </div>
        </div>

        <NotionDialogBody nativeScroll>
          <CustomScrollArea className="h-[min(320px,50vh)]" viewportClassName="px-2 pb-2">
            {filtered.length === 0 ? (
              <div className="px-2 py-6 text-sm text-muted-foreground text-center">{resolvedEmptyText}</div>
            ) : (
              <ul className="py-1">
                {filtered.map((o) => {
                  const selected = o.value === value;
                  return (
                    <li key={o.value}>
                      <button
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
        </NotionDialogBody>
      </NotionDialog>
    </div>
  );
}
