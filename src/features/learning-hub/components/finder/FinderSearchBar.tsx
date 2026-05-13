import React from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/shad/Input';

interface FinderSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSearch: () => void;
  isLoading?: boolean;
}

export function FinderSearchBar({ value, onChange, onSearch, isLoading }: FinderSearchBarProps) {
  const { t } = useTranslation('learningHub');

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onSearch();
    }
  };

  return (
    <div className="px-2 py-2 border-b bg-background">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder={t('finder.search.placeholder')}
          className="pl-9 h-9 bg-muted/30 focus-visible:bg-background transition-colors"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
}
