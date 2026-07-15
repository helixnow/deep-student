/**
 * 闪卡库：分页浏览内容卡，并在同一数据面操作对应的 FSRS 调度状态。
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  CaretLeft,
  CaretRight,
  MagnifyingGlass,
  Pause,
  Play,
  PlusCircle,
  Stack,
  Trash,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotionAlertDialog } from '@/components/ui/NotionDialog';
import { Input } from '@/components/ui/shad/Input';
import type { AnkiLibraryCard } from '@/types';
import { FSRS_LIBRARY_REFRESH_EVENT } from '../events';
import {
  FLASHCARDS_LIBRARY_PAGE_SIZE,
  useFlashcardsLibraryStore,
} from '../store/libraryStore';
import { useFsrsReviewStore } from '../store/fsrsReviewStore';

type Translate = (key: string) => string;

function scheduleStateLabel(card: AnkiLibraryCard, t: Translate): string {
  if (!card.enqueued) return t('library.state.notEnqueued');
  if (card.suspended) return t('library.state.suspended');
  switch (card.state) {
    case 0:
      return t('library.state.new');
    case 1:
      return t('library.state.learning');
    case 2:
      return t('library.state.review');
    case 3:
      return t('library.state.relearning');
    default:
      return t('library.state.enqueued');
  }
}

function formatDueTime(dueMs: number | null | undefined): string | null {
  if (typeof dueMs !== 'number' || !Number.isFinite(dueMs)) return null;
  const date = new Date(dueMs);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export const LibraryScreen: React.FC = () => {
  const { t } = useTranslation('flashcards');
  const startBatchSession = useFsrsReviewStore((s) => s.startBatchSession);
  const items = useFlashcardsLibraryStore((state) => state.items);
  const total = useFlashcardsLibraryStore((state) => state.total);
  const page = useFlashcardsLibraryStore((state) => state.page);
  const search = useFlashcardsLibraryStore((state) => state.searchInput);
  const loading = useFlashcardsLibraryStore((state) => state.loading);
  const loadError = useFlashcardsLibraryStore((state) => state.loadError);
  const actionError = useFlashcardsLibraryStore((state) => state.actionError);
  const busyCardId = useFlashcardsLibraryStore((state) => state.busyCardId);
  const setSearch = useFlashcardsLibraryStore((state) => state.setSearchInput);
  const clearActionError = useFlashcardsLibraryStore((state) => state.clearActionError);
  const refresh = useFlashcardsLibraryStore((state) => state.refresh);
  const submitSearch = useFlashcardsLibraryStore((state) => state.submitSearch);
  const goToPage = useFlashcardsLibraryStore((state) => state.goToPage);
  const enqueueCard = useFlashcardsLibraryStore((state) => state.enqueueCard);
  const setCardSuspended = useFlashcardsLibraryStore((state) => state.setCardSuspended);
  const deleteCard = useFlashcardsLibraryStore((state) => state.deleteCard);
  const [deleteCandidate, setDeleteCandidate] = useState<AnkiLibraryCard | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onRefresh = () => void useFlashcardsLibraryStore.getState().refresh();
    window.addEventListener(FSRS_LIBRARY_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(FSRS_LIBRARY_REFRESH_EVENT, onRefresh);
  }, []);

  const handleSearch = () => {
    void submitSearch();
  };

  const handleStartReview = (card: AnkiLibraryCard) => {
    void startBatchSession(
      [card.id],
      [{
        id: card.stateId || card.id,
        ankiCardId: card.id,
        front: card.front || card.fields?.Front || '',
        back: card.back || card.fields?.Back || card.text || '',
        tags: card.tags,
      }],
    );
  };

  const handleToggleSuspended = (card: AnkiLibraryCard) => {
    void setCardSuspended(card.id, !card.suspended);
  };

  const handleDelete = (card: AnkiLibraryCard) => {
    setDeleteCandidate(card);
  };

  const handleConfirmDelete = () => {
    const card = deleteCandidate;
    if (!card) return;
    void deleteCard(card.id).finally(() => setDeleteCandidate(null));
  };

  const pageCount = Math.max(1, Math.ceil(total / FLASHCARDS_LIBRARY_PAGE_SIZE));

  return (
    <div className="wb-fc-screen">
      <header className="wb-fc-header" data-align="end">
        <div className="min-w-0">
          <h2 className="wb-fc-title">
            {t('library.title')}
          </h2>
          <p className="wb-fc-subtitle">
            {loading
              ? t('library.loading')
              : t('library.total', { count: total })}
          </p>
        </div>
        <NotionButton
          type="button"
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => void refresh()}
          className="shrink-0 text-sm"
        >
          <ArrowClockwise size={15} />
          {t('library.refresh')}
        </NotionButton>
      </header>

      <div className="wb-fc-toolbar">
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlass
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label={t('library.searchLabel')}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleSearch();
            }}
            placeholder={t('library.searchPlaceholder')}
            className="h-9 pl-8 text-sm"
          />
        </div>
        <NotionButton type="button" variant="default" onClick={handleSearch} className="text-sm">
          {t('library.search')}
        </NotionButton>
      </div>

      {actionError ? (
        <div role="alert" className="wb-fc-banner flex items-center justify-between gap-3 text-destructive">
          <span className="min-w-0 break-words">{actionError}</span>
          <NotionButton type="button" variant="ghost" size="sm" onClick={clearActionError}>
            {t('library.dismiss')}
          </NotionButton>
        </div>
      ) : null}

      <div className="wb-fc-list">
        {loadError ? (
          <div role="alert" className="wb-fc-empty">
            <p className="break-words text-destructive">{loadError}</p>
            <NotionButton type="button" variant="ghost" size="sm" onClick={() => void refresh()}>
              {t('library.retry')}
            </NotionButton>
          </div>
        ) : loading ? (
          <div className="wb-fc-loading">
            {t('library.loading')}
          </div>
        ) : items.length === 0 ? (
          <div className="wb-fc-empty">
            <Stack size={28} className="text-muted-foreground/50" weight="duotone" />
            <p>{t('library.empty')}</p>
          </div>
        ) : (
          <ul className="wb-fc-list-ul">
            {items.map((card) => {
              const rowBusy = busyCardId !== null;
              const dueTime = formatDueTime(card.dueMs);
              return (
                <li
                  key={card.id}
                  className="wb-fc-row flex items-start gap-3"
                  data-agent-entity={`flashcards:${card.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="wb-fc-row-front">
                      {card.front || card.fields?.Front || t('card.untitled')}
                    </div>
                    <div className="wb-fc-row-back">
                      {card.back || card.fields?.Back || card.text || t('card.noBack')}
                    </div>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span
                        className="rounded-sm bg-muted/60 px-1.5 py-0.5"
                        data-testid={`schedule-state-${card.id}`}
                      >
                        {scheduleStateLabel(card, t)}
                      </span>
                      {card.isDue && !card.suspended ? (
                        <span className="rounded-sm bg-foreground/10 px-1.5 py-0.5 text-foreground/80">
                          {t('library.state.due')}
                        </span>
                      ) : null}
                      {dueTime && card.enqueued ? (
                        <span title={t('library.dueTime')}>{dueTime}</span>
                      ) : null}
                      {card.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="wb-fc-tag">{tag}</span>
                      ))}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {card.enqueued ? (
                      <NotionButton
                        type="button"
                        variant="default"
                        size="sm"
                        disabled={rowBusy || card.suspended}
                        onClick={() => handleStartReview(card)}
                        className="text-xs"
                      >
                        <Play size={14} weight="fill" />
                        {t('library.startReview')}
                      </NotionButton>
                    ) : (
                      <NotionButton
                        type="button"
                        variant="default"
                        size="sm"
                        disabled={rowBusy}
                        onClick={() => void enqueueCard(card.id)}
                        className="text-xs"
                      >
                        <PlusCircle size={14} />
                        {t('library.enqueue')}
                      </NotionButton>
                    )}

                    {card.enqueued ? (
                      <NotionButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        iconOnly
                        disabled={rowBusy}
                        onClick={() => handleToggleSuspended(card)}
                        aria-label={card.suspended
                          ? t('library.resume')
                          : t('library.suspend')}
                        title={card.suspended
                          ? t('library.resume')
                          : t('library.suspend')}
                      >
                        {card.suspended ? <Play size={14} /> : <Pause size={14} />}
                      </NotionButton>
                    ) : null}

                    <NotionButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      iconOnly
                      disabled={rowBusy}
                      onClick={() => handleDelete(card)}
                      aria-label={t('library.delete')}
                      title={t('library.delete')}
                    >
                      <Trash size={14} />
                    </NotionButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{t('library.page', { page, pages: pageCount })}</span>
        <div className="flex items-center gap-1">
          <NotionButton
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading || page <= 1}
            onClick={() => void goToPage(page - 1)}
            aria-label={t('library.previous')}
          >
            <CaretLeft size={14} />
            {t('library.previous')}
          </NotionButton>
          <NotionButton
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading || page >= pageCount}
            onClick={() => void goToPage(page + 1)}
            aria-label={t('library.next')}
          >
            {t('library.next')}
            <CaretRight size={14} />
          </NotionButton>
        </div>
      </footer>

      <NotionAlertDialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => {
          if (!open && busyCardId !== deleteCandidate?.id) setDeleteCandidate(null);
        }}
        title={t('library.delete')}
        description={t('library.confirmDelete')}
        icon={<Trash size={18} />}
        confirmText={t('library.delete')}
        cancelText={t('common:cancel')}
        confirmVariant="danger"
        loading={busyCardId === deleteCandidate?.id}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
};
