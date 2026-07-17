import React from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlass, CircleNotch, X } from '@phosphor-icons/react';
import { Input } from '@/components/ui/shad/Input';
import { NotionButton } from '@/components/ui/NotionButton';

interface FinderSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSearch: () => void;
  isLoading?: boolean;
}

export function FinderSearchBar({ value, onChange, onSearch, isLoading }: FinderSearchBarProps) {
  const { t } = useTranslation(['learningHub', 'common']);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onSearch();
    } else if (e.key === 'Escape' && value) {
      // Esc 清空搜索词（有内容时拦截，避免误关闭外层容器）
      e.stopPropagation();
      onChange('');
    }
  };

  return (
    <div className="px-2 py-2 border-b bg-background">
      <div className="finder-search relative">
        {isLoading ? (
          <CircleNotch size={16} className="absolute left-2.5 top-2.5 text-muted-foreground animate-spin" />
        ) : (
          <MagnifyingGlass size={16} className="absolute left-2.5 top-2.5 text-muted-foreground" />
        )}
        <Input
          type="search"
          placeholder={t('finder.search.placeholder')}
          className="pl-9 pr-8 h-9 bg-muted/30 focus-visible:bg-background transition-colors"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {value && (
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => onChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 !h-5 !w-5 !p-0.5 hover:bg-[var(--interactive-hover)]"
            aria-label={t('common:clear')}
          >
            <X size={14} className="text-muted-foreground/60" />
          </NotionButton>
        )}
      </div>
    </div>
  );
}
