import React, { useEffect, useRef } from 'react';
import { CaretDown, CaretUp, MagnifyingGlass, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/utils/cn';
import Z_INDEX from '@/config/zIndex';

export interface MessageSearchBarProps {
  placement?: 'floating' | 'header';
  query: string;
  matchCount: number;
  activeMatchIndex: number;
  activeMessageId: string | null;
  activeOccurrenceIndex: number;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  onNavigate: (messageId: string, occurrenceIndex: number) => void | Promise<unknown>;
}

export const MessageSearchBar: React.FC<MessageSearchBarProps> = ({
  placement = 'floating',
  query,
  matchCount,
  activeMatchIndex,
  activeMessageId,
  activeOccurrenceIndex,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
  onNavigate,
}) => {
  const { t } = useTranslation('chatV2');
  const inputRef = useRef<HTMLInputElement>(null);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (!activeMessageId) return;
    void onNavigateRef.current(activeMessageId, activeOccurrenceIndex);
  }, [activeMessageId, activeOccurrenceIndex, query]);

  const hasMatches = matchCount > 0;
  const resultLabel = query.trim()
    ? hasMatches
      ? t('messageList.search.results', {
          current: activeMatchIndex + 1,
          count: matchCount,
        })
      : t('messageList.search.noResults')
    : '';

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
    }
  };

  const isHeaderPlacement = placement === 'header';

  return (
    <div
      className={cn(
        isHeaderPlacement
          ? 'relative flex h-full min-w-0 w-full items-center justify-end'
          : 'pointer-events-none fixed right-4 top-2 z-[1101] flex w-[min(28rem,calc(100vw-2rem))] justify-end md:right-8 md:top-1',
      )}
      style={isHeaderPlacement ? undefined : { zIndex: Z_INDEX.desktopTitlebar + 1 }}
      data-no-drag
      data-slot="message-search-bar"
    >
      <div
        role="search"
        className={cn(
          'pointer-events-auto ml-auto flex min-w-0 w-full max-w-sm items-center gap-1.5',
          'rounded-[var(--chat-radius-pill)] border border-border/70',
          'bg-background/95',
          isHeaderPlacement
            ? 'h-8 px-2 py-0 shadow-sm'
            : 'px-2 py-1.5 shadow-floating backdrop-blur-sm',
        )}
      >
        <MagnifyingGlass
          size={18}
          weight="regular"
          aria-hidden="true"
          className="ml-1 shrink-0 text-muted-foreground"
        />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('messageList.search.placeholder')}
          aria-label={t('messageList.search.open')}
          className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <span
          aria-live="polite"
          className={cn(
            'shrink-0 whitespace-nowrap px-1 text-xs tabular-nums',
            hasMatches ? 'text-muted-foreground' : 'text-destructive',
          )}
        >
          {resultLabel}
        </span>
        <div aria-hidden="true" className="mx-0.5 h-5 w-px bg-border/70" />
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onPrevious}
          disabled={!hasMatches}
          aria-label={t('messageList.search.previous')}
          title={t('messageList.search.previous')}
          className="!size-8 !rounded-full text-muted-foreground hover:text-foreground"
        >
          <CaretUp size={16} weight="bold" aria-hidden="true" />
        </DsButton>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onNext}
          disabled={!hasMatches}
          aria-label={t('messageList.search.next')}
          title={t('messageList.search.next')}
          className="!size-8 !rounded-full text-muted-foreground hover:text-foreground"
        >
          <CaretDown size={16} weight="bold" aria-hidden="true" />
        </DsButton>
        <div aria-hidden="true" className="mx-0.5 h-5 w-px bg-border/70" />
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onClose}
          aria-label={t('messageList.search.close')}
          title={t('messageList.search.close')}
          className="!size-8 !rounded-full text-muted-foreground hover:text-foreground"
        >
          <X size={17} weight="regular" aria-hidden="true" />
        </DsButton>
      </div>
    </div>
  );
};
