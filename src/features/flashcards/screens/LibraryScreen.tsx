/**
 * 闪卡库：分页浏览内容卡，并在同一数据面操作对应的 FSRS 调度状态。
 * 支持防抖即时搜索、状态筛选 chips、客户端排序、多选批量操作（shift 连选）、
 * 行内展开编辑与行内删除确认 —— 全部内联交互，无弹窗。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  X,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { UiPresence } from '@/components/ui/UiPresence';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Input } from '@/components/ui/shad/Input';
import type { AnkiLibraryCard, AnkiLibraryCardPatch } from '@/types';
import { FSRS_LIBRARY_REFRESH_EVENT } from '../events';
import {
  FLASHCARDS_LIBRARY_PAGE_SIZE,
  useFlashcardsLibraryStore,
  type LibrarySortKey,
  type LibraryStatusFilter,
} from '../store/libraryStore';
import { useFsrsReviewStore } from '../store/fsrsReviewStore';
import type { ReviewEditTemplate } from '../reviewCardEditFields';
import { LibraryCardRow } from '../library/LibraryCardRow';
import { matchesStatusFilter, sortLibraryCards } from '../library/libraryView';
import '../library/library.css';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const SEARCH_DEBOUNCE_MS = 300;
const BULK_DELETE_DISARM_MS = 4000;

const FILTER_OPTIONS: LibraryStatusFilter[] = [
  'all',
  'due',
  'new',
  'learning',
  'review',
  'suspended',
  'notEnqueued',
];

const SORT_OPTIONS: Array<Exclude<LibrarySortKey, 'default'>> = ['due', 'created', 'front'];

function toReviewContent(card: AnkiLibraryCard) {
  return {
    id: card.stateId || card.id,
    ankiCardId: card.id,
    front: card.front || card.fields?.Front || '',
    back: card.back || card.fields?.Back || card.text || '',
    tags: card.tags,
  };
}

export const LibraryScreen: React.FC = () => {
  const { t } = useTranslation('flashcards');
  const translate = t as Translate;
  const startBatchSession = useFsrsReviewStore((s) => s.startBatchSession);

  const items = useFlashcardsLibraryStore((state) => state.items);
  const total = useFlashcardsLibraryStore((state) => state.total);
  const page = useFlashcardsLibraryStore((state) => state.page);
  const search = useFlashcardsLibraryStore((state) => state.searchInput);
  const query = useFlashcardsLibraryStore((state) => state.query);
  const loading = useFlashcardsLibraryStore((state) => state.loading);
  const loaded = useFlashcardsLibraryStore((state) => state.loaded);
  const loadError = useFlashcardsLibraryStore((state) => state.loadError);
  const actionError = useFlashcardsLibraryStore((state) => state.actionError);
  const busyCardId = useFlashcardsLibraryStore((state) => state.busyCardId);
  const bulkBusy = useFlashcardsLibraryStore((state) => state.bulkBusy);
  const statusFilter = useFlashcardsLibraryStore((state) => state.statusFilter);
  const sortKey = useFlashcardsLibraryStore((state) => state.sortKey);
  const sortDir = useFlashcardsLibraryStore((state) => state.sortDir);
  const setSearch = useFlashcardsLibraryStore((state) => state.setSearchInput);
  const setStatusFilter = useFlashcardsLibraryStore((state) => state.setStatusFilter);
  const toggleSort = useFlashcardsLibraryStore((state) => state.toggleSort);
  const clearSort = useFlashcardsLibraryStore((state) => state.clearSort);
  const clearActionError = useFlashcardsLibraryStore((state) => state.clearActionError);
  const refresh = useFlashcardsLibraryStore((state) => state.refresh);
  const submitSearch = useFlashcardsLibraryStore((state) => state.submitSearch);
  const goToPage = useFlashcardsLibraryStore((state) => state.goToPage);
  const enqueueCard = useFlashcardsLibraryStore((state) => state.enqueueCard);
  const setCardSuspended = useFlashcardsLibraryStore((state) => state.setCardSuspended);
  const updateCard = useFlashcardsLibraryStore((state) => state.updateCard);
  const undoLastReview = useFlashcardsLibraryStore((state) => state.undoLastReview);
  const resetProgress = useFlashcardsLibraryStore((state) => state.resetProgress);
  const deleteCard = useFlashcardsLibraryStore((state) => state.deleteCard);
  const bulkEnqueue = useFlashcardsLibraryStore((state) => state.bulkEnqueue);
  const bulkSetSuspended = useFlashcardsLibraryStore((state) => state.bulkSetSuspended);
  const bulkDelete = useFlashcardsLibraryStore((state) => state.bulkDelete);

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [lastAnchorId, setLastAnchorId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);
  const [bulkDeleteArmed, setBulkDeleteArmed] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const bulkDisarmTimer = useRef<number | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onRefresh = () => void useFlashcardsLibraryStore.getState().refresh();
    window.addEventListener(FSRS_LIBRARY_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(FSRS_LIBRARY_REFRESH_EVENT, onRefresh);
  }, []);

  // 即时搜索：输入停顿后自动提交；显式搜索（回车 / 按钮）会同步 query 从而取消定时器。
  useEffect(() => {
    if (search.trim() === query) return;
    const timer = window.setTimeout(() => {
      void useFlashcardsLibraryStore.getState().submitSearch();
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search, query]);

  // 数据刷新后修剪失效的选择 / 展开 / 删除确认目标。
  useEffect(() => {
    const ids = new Set(items.map((item) => item.id));
    setSelectedIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setExpandedId((prev) => (prev && !ids.has(prev) ? null : prev));
    setDeleteCandidateId((prev) => (prev && !ids.has(prev) ? null : prev));
    setLastAnchorId((prev) => (prev && !ids.has(prev) ? null : prev));
  }, [items]);

  useEffect(() => () => {
    if (bulkDisarmTimer.current !== null) window.clearTimeout(bulkDisarmTimer.current);
  }, []);

  const rowBusy = busyCardId !== null || bulkBusy;

  const visibleItems = useMemo(
    () => sortLibraryCards(
      items.filter((card) => matchesStatusFilter(card, statusFilter)),
      sortKey,
      sortDir,
    ),
    [items, statusFilter, sortKey, sortDir],
  );

  const filterCounts = useMemo(() => {
    const counts = new Map<LibraryStatusFilter, number>();
    for (const option of FILTER_OPTIONS) {
      counts.set(
        option,
        option === 'all'
          ? items.length
          : items.filter((card) => matchesStatusFilter(card, option)).length,
      );
    }
    return counts;
  }, [items]);

  const selectedCards = useMemo(
    () => visibleItems.filter((card) => selectedIds.has(card.id)),
    [visibleItems, selectedIds],
  );
  const allVisibleSelected = visibleItems.length > 0
    && visibleItems.every((card) => selectedIds.has(card.id));

  const disarmBulkDelete = useCallback(() => {
    setBulkDeleteArmed(false);
    if (bulkDisarmTimer.current !== null) {
      window.clearTimeout(bulkDisarmTimer.current);
      bulkDisarmTimer.current = null;
    }
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setLastAnchorId(null);
    disarmBulkDelete();
  }, [disarmBulkDelete]);

  const handleSearchNow = () => {
    void submitSearch();
  };

  const handleToggleSelect = useCallback((cardId: string, shiftKey: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const targetChecked = !prev.has(cardId);
      if (shiftKey && lastAnchorId && lastAnchorId !== cardId) {
        const order = visibleItems.map((card) => card.id);
        const anchorIndex = order.indexOf(lastAnchorId);
        const targetIndex = order.indexOf(cardId);
        if (anchorIndex !== -1 && targetIndex !== -1) {
          const [from, to] = anchorIndex < targetIndex
            ? [anchorIndex, targetIndex]
            : [targetIndex, anchorIndex];
          for (const id of order.slice(from, to + 1)) {
            if (targetChecked) next.add(id);
            else next.delete(id);
          }
          return next;
        }
      }
      if (targetChecked) next.add(cardId);
      else next.delete(cardId);
      return next;
    });
    setLastAnchorId(cardId);
    disarmBulkDelete();
  }, [lastAnchorId, visibleItems, disarmBulkDelete]);

  const handleToggleSelectAll = useCallback(() => {
    if (allVisibleSelected) {
      clearSelection();
      return;
    }
    setSelectedIds(new Set(visibleItems.map((card) => card.id)));
    disarmBulkDelete();
  }, [allVisibleSelected, visibleItems, clearSelection, disarmBulkDelete]);

  const handleToggleExpand = useCallback((cardId: string) => {
    setExpandedId((prev) => (prev === cardId ? null : cardId));
  }, []);

  const handleStartReview = useCallback((card: AnkiLibraryCard) => {
    void startBatchSession([card.id], [toReviewContent(card)]);
  }, [startBatchSession]);

  const handleEnqueue = useCallback((cardId: string) => {
    void enqueueCard(cardId);
  }, [enqueueCard]);

  const handleToggleSuspended = useCallback((card: AnkiLibraryCard) => {
    void setCardSuspended(card.id, !card.suspended);
  }, [setCardSuspended]);

  const handleRequestDelete = useCallback((cardId: string) => {
    setDeleteCandidateId(cardId);
  }, []);

  const handleCancelDelete = useCallback(() => {
    setDeleteCandidateId(null);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    const cardId = deleteCandidateId;
    if (!cardId) return;
    void deleteCard(cardId).finally(() => {
      setDeleteCandidateId((prev) => (prev === cardId ? null : prev));
    });
  }, [deleteCandidateId, deleteCard]);

  const handleSaveEdit = useCallback(
    (
      cardId: string,
      patch: AnkiLibraryCardPatch,
      template?: ReviewEditTemplate | null,
    ) => updateCard(cardId, patch, template),
    [updateCard],
  );

  const handleUndoReview = useCallback((cardId: string) => {
    void undoLastReview(cardId);
  }, [undoLastReview]);

  const handleResetProgress = useCallback((cardId: string) => {
    void resetProgress(cardId);
  }, [resetProgress]);

  const handleRowKeyDown = useCallback((
    event: React.KeyboardEvent<HTMLLIElement>,
    cardId: string,
  ) => {
    if (event.target !== event.currentTarget) return;
    const order = visibleItems.map((card) => card.id);
    const index = order.indexOf(cardId);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const nextId = order[event.key === 'ArrowDown' ? index + 1 : index - 1];
      if (nextId) rowRefs.current.get(nextId)?.focus();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      handleToggleExpand(cardId);
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      handleToggleSelect(cardId, event.shiftKey);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      setDeleteCandidateId(cardId);
    }
  }, [visibleItems, handleToggleExpand, handleToggleSelect]);

  const registerRowRef = useCallback((cardId: string, element: HTMLLIElement | null) => {
    if (element) rowRefs.current.set(cardId, element);
    else rowRefs.current.delete(cardId);
  }, []);

  // ---------- 批量操作 ----------
  const enqueueTargets = selectedCards.filter((card) => !card.enqueued);
  const suspendTargets = selectedCards.filter((card) => card.enqueued && !card.suspended);
  const resumeTargets = selectedCards.filter((card) => card.enqueued && card.suspended);
  const reviewTargets = selectedCards.filter(
    (card) => card.enqueued && !card.suspended && card.stateId,
  );

  const handleBulkEnqueue = () => {
    void bulkEnqueue(enqueueTargets.map((card) => card.id));
  };

  const handleBulkSuspend = () => {
    void bulkSetSuspended(suspendTargets.map((card) => card.id), true);
  };

  const handleBulkResume = () => {
    void bulkSetSuspended(resumeTargets.map((card) => card.id), false);
  };

  const handleBulkReview = () => {
    if (reviewTargets.length === 0) return;
    void startBatchSession(
      reviewTargets.map((card) => card.id),
      reviewTargets.map(toReviewContent),
    );
  };

  const handleBulkDelete = () => {
    if (!bulkDeleteArmed) {
      setBulkDeleteArmed(true);
      if (bulkDisarmTimer.current !== null) window.clearTimeout(bulkDisarmTimer.current);
      bulkDisarmTimer.current = window.setTimeout(() => {
        setBulkDeleteArmed(false);
        bulkDisarmTimer.current = null;
      }, BULK_DELETE_DISARM_MS);
      return;
    }
    disarmBulkDelete();
    const ids = selectedCards.map((card) => card.id);
    void bulkDelete(ids).then((ok) => {
      if (ok) clearSelection();
    });
  };

  const handleClearFilters = () => {
    setStatusFilter('all');
    clearSort();
    if (query) void submitSearch('');
  };

  const pageCount = Math.max(1, Math.ceil(total / FLASHCARDS_LIBRARY_PAGE_SIZE));
  const initialLoading = loading && !loaded;

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
              : translate('library.total', { count: total })}
          </p>
        </div>
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => void refresh()}
          className="shrink-0 text-sm"
        >
          <ArrowClockwise size={15} />
          {t('library.refresh')}
        </DsButton>
      </header>

      <div className="wb-fc-toolbar">
        <div className="wb-fc-search relative min-w-0 flex-1">
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
              if (event.key === 'Enter') handleSearchNow();
            }}
            placeholder={t('library.searchPlaceholder')}
            className="h-9 pl-8 text-sm"
          />
        </div>
        <DsButton type="button" variant="default" onClick={handleSearchNow} className="text-sm">
          {t('library.search')}
        </DsButton>
      </div>

      <div className="fc-lib-filters">
        <div
          className="fc-lib-filters-group"
          role="group"
          aria-label={translate('library.filter.label')}
        >
          {FILTER_OPTIONS.map((option) => {
            const count = filterCounts.get(option) ?? 0;
            return (
              <button
                key={option}
                type="button"
                className="fc-lib-chip"
                data-active={statusFilter === option ? 'true' : undefined}
                aria-pressed={statusFilter === option}
                onClick={() => setStatusFilter(option)}
              >
                {translate(`library.filter.${option}`)}
                {option !== 'all' && count > 0 ? (
                  <span className="fc-lib-chip-count">{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div
          className="fc-lib-filters-group"
          role="group"
          aria-label={translate('library.sort.label')}
        >
          <span className="fc-lib-filters-label">{translate('library.sort.label')}</span>
          {SORT_OPTIONS.map((option) => {
            const active = sortKey === option;
            return (
              <button
                key={option}
                type="button"
                className="fc-lib-chip"
                data-active={active ? 'true' : undefined}
                aria-pressed={active}
                title={active
                  ? translate(sortDir === 'asc' ? 'library.sort.asc' : 'library.sort.desc')
                  : undefined}
                onClick={() => toggleSort(option)}
              >
                {translate(`library.sort.${option}`)}
                {active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : null}
              </button>
            );
          })}
          {sortKey !== 'default' ? (
            <button
              type="button"
              className="fc-lib-chip"
              onClick={clearSort}
              aria-label={translate('library.sort.reset')}
              title={translate('library.sort.reset')}
            >
              <X size={11} />
            </button>
          ) : null}
        </div>
        {visibleItems.length !== items.length ? (
          <span className="fc-lib-result-count">
            {translate('library.filteredCount', {
              shown: visibleItems.length,
              total: items.length,
            })}
          </span>
        ) : null}
      </div>

      <UiPresence
        open={selectedCards.length > 0}
        inClass=""
        outClass=""
        exitMs={160}
        className="fc-lib-bulkbar"
        role="toolbar"
        aria-label={translate('library.bulkLabel')}
      >
          <span className="fc-lib-bulkbar-count">
            {translate('library.selectedCount', { count: selectedCards.length })}
          </span>
          {reviewTargets.length > 0 ? (
            <DsButton
              type="button"
              variant="default"
              size="sm"
              disabled={rowBusy}
              onClick={handleBulkReview}
              className="text-xs"
            >
              <Play size={13} weight="fill" />
              {translate('library.bulkReview', { count: reviewTargets.length })}
            </DsButton>
          ) : null}
          {enqueueTargets.length > 0 ? (
            <DsButton
              type="button"
              variant="default"
              size="sm"
              disabled={rowBusy}
              onClick={handleBulkEnqueue}
              className="text-xs"
            >
              <PlusCircle size={13} />
              {translate('library.bulkEnqueue', { count: enqueueTargets.length })}
            </DsButton>
          ) : null}
          {suspendTargets.length > 0 ? (
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              disabled={rowBusy}
              onClick={handleBulkSuspend}
              className="text-xs"
            >
              <Pause size={13} />
              {translate('library.bulkSuspend', { count: suspendTargets.length })}
            </DsButton>
          ) : null}
          {resumeTargets.length > 0 ? (
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              disabled={rowBusy}
              onClick={handleBulkResume}
              className="text-xs"
            >
              <Play size={13} />
              {translate('library.bulkResume', { count: resumeTargets.length })}
            </DsButton>
          ) : null}
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            disabled={rowBusy}
            onClick={handleBulkDelete}
            className={bulkDeleteArmed ? 'fc-lib-armed text-xs' : 'text-xs'}
          >
            <Trash size={13} />
            {bulkDeleteArmed
              ? translate('library.bulkDeleteConfirm', { count: selectedCards.length })
              : translate('library.bulkDelete', { count: selectedCards.length })}
          </DsButton>
          <span className="fc-lib-bulkbar-spacer" />
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearSelection}
            className="text-xs"
          >
            <X size={13} />
            {translate('library.clearSelection')}
          </DsButton>
      </UiPresence>

      {actionError ? (
        <div role="alert" className="wb-fc-banner flex items-center justify-between gap-3 text-destructive">
          <span className="min-w-0 break-words">{actionError}</span>
          <DsButton type="button" variant="ghost" size="sm" onClick={clearActionError}>
            {t('library.dismiss')}
          </DsButton>
        </div>
      ) : null}

      <CustomScrollArea className="wb-fc-list min-h-0 flex-1">
        {loadError ? (
          <div role="alert" className="wb-fc-empty">
            <p className="break-words text-destructive">{loadError}</p>
            <DsButton type="button" variant="ghost" size="sm" onClick={() => void refresh()}>
              {t('library.retry')}
            </DsButton>
          </div>
        ) : initialLoading ? (
          <div aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="fc-lib-skeleton-row">
                <div className="fc-lib-skeleton" style={{ width: `${52 + (index % 3) * 14}%` }} />
                <div className="fc-lib-skeleton" style={{ width: `${30 + (index % 4) * 10}%`, height: 10 }} />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="wb-fc-empty">
            <Stack size={28} className="text-muted-foreground/50" weight="duotone" />
            <p>{query ? translate('library.noMatches') : t('library.empty')}</p>
            {query ? (
              <DsButton type="button" variant="ghost" size="sm" onClick={handleClearFilters}>
                {translate('library.clearFilters')}
              </DsButton>
            ) : null}
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="wb-fc-empty">
            <Stack size={28} className="text-muted-foreground/50" weight="duotone" />
            <p>{translate('library.noMatches')}</p>
            <DsButton type="button" variant="ghost" size="sm" onClick={handleClearFilters}>
              {translate('library.clearFilters')}
            </DsButton>
          </div>
        ) : (
          <div className={loading ? 'fc-lib-list-dimmed' : undefined}>
            <div className="fc-lib-list-head">
              <Checkbox
                checked={allVisibleSelected}
                aria-label={translate('library.selectAll')}
                disabled={rowBusy}
                onClick={handleToggleSelectAll}
              />
              <span>{translate('library.selectAll')}</span>
              <span className="fc-lib-kbd-hint">{translate('library.keyboardHint')}</span>
            </div>
            <ul className="wb-fc-list-ul">
              {visibleItems.map((card) => (
                <LibraryCardRow
                  key={card.id}
                  card={card}
                  busy={rowBusy}
                  deleting={busyCardId === card.id}
                  selected={selectedIds.has(card.id)}
                  expanded={expandedId === card.id}
                  confirmingDelete={deleteCandidateId === card.id}
                  onToggleSelect={handleToggleSelect}
                  onToggleExpand={handleToggleExpand}
                  onStartReview={handleStartReview}
                  onEnqueue={handleEnqueue}
                  onToggleSuspended={handleToggleSuspended}
                  onRequestDelete={handleRequestDelete}
                  onCancelDelete={handleCancelDelete}
                  onConfirmDelete={handleConfirmDelete}
                  onSaveEdit={handleSaveEdit}
                  onUndoReview={handleUndoReview}
                  onResetProgress={handleResetProgress}
                  onRowKeyDown={handleRowKeyDown}
                  rowRef={registerRowRef}
                />
              ))}
            </ul>
          </div>
        )}
      </CustomScrollArea>

      <footer className="flex shrink-0 items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{translate('library.page', { page, pages: pageCount })}</span>
        <div className="flex items-center gap-1">
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading || page <= 1}
            onClick={() => void goToPage(page - 1)}
            aria-label={t('library.previous')}
          >
            <CaretLeft size={14} />
            {t('library.previous')}
          </DsButton>
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading || page >= pageCount}
            onClick={() => void goToPage(page + 1)}
            aria-label={t('library.next')}
          >
            {t('library.next')}
            <CaretRight size={14} />
          </DsButton>
        </div>
      </footer>
    </div>
  );
};
