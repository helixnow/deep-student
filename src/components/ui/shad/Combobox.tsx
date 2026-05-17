import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDown, Check, MagnifyingGlass } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { ProviderIcon, isGenericProviderIconPath } from '../ProviderIcon';
import { Input } from './Input';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogBody } from '../NotionDialog';
import { CustomScrollArea } from '../../custom-scroll-area';
import { cn } from '../../../lib/utils';

export type ComboboxOption = { value: string; label: string; icon?: string; iconModelId?: string };

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

  const renderOptionIcon = (option: ComboboxOption) => {
    if (option.iconModelId) {
      return <ProviderIcon modelId={option.iconModelId} size={16} showTooltip={false} variant="color" />;
    }

    if (option.icon) {
      if (isGenericProviderIconPath(option.icon)) {
        return <ProviderIcon modelId="" size={16} showTooltip={false} variant="color" />;
      }

      return (
        <img
          src={option.icon}
          alt=""
 className="w-4 h-4 flex-shrink-0 rounded object-contain"
/>
      );
    }

    return null;
  };

  return (
    <div className={cn('w-full', className)}>
      <NotionButton
        type="button"
        variant="ghost"
        className={cn('w-full justify-between border border-border/30 hover:bg-[var(--interactive-hover)]', buttonClassName)}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <span className="flex items-center gap-2 truncate text-left">
          {selectedOption && renderOptionIcon(selectedOption)}
          <span className="truncate">{buttonLabel}</span>
        </span>
        <CaretDown size={16} className="opacity-70" />
      </NotionButton>

      <NotionDialog open={open} onOpenChange={setOpen} maxWidth="max-w-lg" className="p-0">
        <NotionDialogHeader>
          <NotionDialogTitle className="text-base">{resolvedTitle}</NotionDialogTitle>
        </NotionDialogHeader>
        <div className="px-5 pb-2">
            <div className="mt-2 relative">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground">
                <MagnifyingGlass size={16} />
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

        <NotionDialogBody>
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
                          'w-full flex items-center justify-between rounded-md px-2 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30',
                          'hover:bg-[var(--interactive-hover)] hover:text-accent-foreground',
                          selected
                            ? 'bg-accent text-accent-foreground'
                            : 'text-foreground'
                        )}
                        onClick={() => handleSelect(o.value)}
                      >
                        <span className="flex items-center gap-2 truncate text-left min-w-0">
                          {renderOptionIcon(o)}
                          <span className="truncate">{o.label}</span>
                        </span>
                        {selected && <Check size={16} className="text-accent-foreground flex-shrink-0" />}
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
