/**
 * 闪卡库：分页浏览内容卡，并在同一数据面操作对应的 FSRS 调度状态。
 * 支持防抖即时搜索、状态筛选 chips、客户端排序、多选批量操作（shift 连选）、
 * 行内展开编辑与行内删除确认 —— 全部内联交互，无弹窗。
 */
import React, { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BracketsCurly,
  CaretDoubleLeft,
  CaretDoubleRight,
  CaretDown,
  CaretLeft,
  CaretRight,
  CheckCircle,
  DotsThree,
  DownloadSimple,
  FloppyDisk,
  Funnel,
  ImageSquare,
  MagnifyingGlass,
  Pause,
  Play,
  Plus,
  PlusCircle,
  SlidersHorizontal,
  Stack,
  Trash,
  Tray,
  UploadSimple,
  Warning,
  X,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { AppMenu, AppMenuTrigger, AppMenuContent, AppMenuItem } from '@/components/ui/app-menu/AppMenu';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { cn } from '@/utils/cn';
import { UiPresence } from '@/components/ui/UiPresence';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Input } from '@/components/ui/shad/Input';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { listAnkiLibraryCards } from '@/utils/chatApi';
import type { AnkiLibraryCard, AnkiLibraryCardPatch } from '@/types';
import { summarizeCardMedia } from '../cardMathPreview';
import { hasValidCloze, insertClozeDeletion, nextClozeIndex } from '../cloze';
import { FSRS_LIBRARY_REFRESH_EVENT } from '../events';
import {
  FLASHCARDS_LIBRARY_PAGE_SIZE,
  FLASHCARDS_LIBRARY_PAGE_SIZE_OPTIONS,
  useFlashcardsLibraryStore,
  type LibrarySortKey,
  type LibraryStatusFilter,
} from '../store/libraryStore';
import { useFsrsReviewStore } from '../store/fsrsReviewStore';
import type { ReviewEditTemplate } from '../reviewCardEditFields';
import { LibraryCardRow } from '../library/LibraryCardRow';
import { useFlashcardsMobileChrome } from '../useFlashcardsMobileChrome';
import {
  countDueCards,
  matchesStatusFilter,
  parseTagsInput,
  partitionLibraryQueues,
  sortLibraryCards,
  toReviewContent,
} from '../library/libraryView';
import {
  clearPendingLibraryCardFocus,
  hydrateLibraryStoreFromViewState,
  peekPendingLibraryCardFocus,
  saveLibraryViewState,
  setLibraryReturnOrigin,
  subscribePendingLibraryCardFocus,
  type FlashcardsLibraryViewSnapshot,
} from '../library/libraryViewState';
import { buildDeckTree, flattenDeckTree } from '../library/deckTree';
import '../library/library.css';
import { exportLibraryApkg, exportLibraryCsv } from '../library/exportLibrary';
import { parseFlashcardsFromCsv } from '../library/csvFlashcards';
import { openImageOcclusionBuilder } from '../occlusion/ImageOcclusionBuilderModal';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { usesAndroidSaf } from '@/utils/fileManager';
import { isWebUiShell } from '@/utils/platform';
import { isTauriEnvironment } from '@/utils/urlOpener';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const SEARCH_DEBOUNCE_MS = 180;
const BULK_DELETE_DISARM_MS = 4000;

interface PendingCsvImport {
  file?: File;
  rawText: string;
  fileName: string;
  cardCount: number;
  skippedRows: number;
  deckBuckets: Array<{ csvDeck: string; count: number }>;
}

interface ApkgImportSummary {
  deckName: string;
  deckFilterPath: string | null;
  importedCards: number;
  reviewEnqueued: number;
  reviewWithHistory: number;
  mediaCount: number;
  sampledCards: AnkiLibraryCard[];
}

export interface LibraryScreenProps {
  /** 从今日屏移动顶栏「+ 新建卡片」跳转过来时自动打开新建表单 */
  autoOpenComposer?: boolean;
  onAutoOpenComposerConsumed?: () => void;
}

interface LibrarySearchBarProps {
  storeQuery: string;
  placeholder: string;
  searchLabel: string;
  searchButtonText: string;
  showSearchButton: boolean;
  onSubmitSearch: (query: string, options?: { force?: boolean }) => Promise<boolean>;
}

/** 隔离输入草稿状态与防抖，避免每次击键触发整页及 100 行卡片重渲染。 */
const LibrarySearchBar: React.FC<LibrarySearchBarProps> = React.memo(({
  storeQuery,
  placeholder,
  searchLabel,
  searchButtonText,
  showSearchButton,
  onSubmitSearch,
}) => {
  const [draftSearch, setDraftSearch] = useState(storeQuery);
  const prevStoreQueryRef = useRef(storeQuery);
  const userEditedRef = useRef(false);

  useEffect(() => {
    if (prevStoreQueryRef.current !== storeQuery) {
      prevStoreQueryRef.current = storeQuery;
      userEditedRef.current = false;
      setDraftSearch((current) => (current.trim() === storeQuery ? current : storeQuery));
    }
  }, [storeQuery]);

  useEffect(() => {
    if (!userEditedRef.current) return;
    if (draftSearch.trim() === storeQuery) {
      userEditedRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      userEditedRef.current = false;
      React.startTransition(() => {
        void onSubmitSearch(draftSearch);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draftSearch, storeQuery, onSubmitSearch]);

  const handleSubmitNow = useCallback(() => {
    userEditedRef.current = false;
    React.startTransition(() => {
      void onSubmitSearch(draftSearch, { force: true });
    });
  }, [draftSearch, onSubmitSearch]);

  return (
    <>
      <div className="wb-fc-search relative min-w-0 flex-1">
        <MagnifyingGlass
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label={searchLabel}
          type="search"
          value={draftSearch}
          onChange={(event) => {
            userEditedRef.current = true;
            setDraftSearch(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !isComposingKeyEvent(event)) handleSubmitNow();
          }}
          placeholder={placeholder}
          className="h-9 pl-8 text-sm [@media(pointer:coarse)]:!h-11"
        />
      </div>
      {showSearchButton && (
        <DsButton type="button" variant="default" aria-label={searchButtonText} onClick={handleSubmitNow} className="text-sm">
          {searchButtonText}
        </DsButton>
      )}
    </>
  );
});

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

/** 牌组下拉的「全部」取值：牌组名不会以 `::` 开头，'' 已用于「未分组」 */
const DECK_FILTER_ALL = '::all';

const MemoizedLibraryCardRow = React.memo(LibraryCardRow);

function stripApkgExtension(fileName?: string): string {
  if (!fileName) return '';
  return fileName.replace(/\.apkg$/i, '').trim();
}

function extractCardDeckPath(card: AnkiLibraryCard): string {
  const fromExtra = card.extra_fields?._deck?.trim();
  if (fromExtra) return fromExtra;
  const fromFields = card.fields?._deck?.trim();
  return fromFields || '';
}

function countBatchMedia(cards: readonly AnkiLibraryCard[]): number {
  let total = 0;
  for (const card of cards) {
    const summary = summarizeCardMedia(card);
    total += summary.imageCount + summary.audioCount;
  }
  return total;
}

export const LibraryScreen: React.FC<LibraryScreenProps> = ({
  autoOpenComposer = false,
  onAutoOpenComposerConsumed,
}) => {
  // Hydrate persisted library pagination/filter/scroll snapshot synchronously before
  // selecting store state so returning to the library starts immediately on the saved page.
  const initialHydratedViewRef = useRef<FlashcardsLibraryViewSnapshot | null | undefined>(undefined);
  if (initialHydratedViewRef.current === undefined) {
    initialHydratedViewRef.current = hydrateLibraryStoreFromViewState();
  }
  const initialHydratedView = initialHydratedViewRef.current;

  const { t, i18n } = useTranslation(['flashcards', 'common']);
  const { isSmallScreen } = useBreakpoint();
  const translate = t as Translate;
  const startBatchSession = useFsrsReviewStore((s) => s.startBatchSession);
  const setScreen = useFsrsReviewStore((s) => s.setScreen);
  const backToToday = useCallback(() => setScreen('today'), [setScreen]);

  const items = useFlashcardsLibraryStore((state) => state.items);
  const deferredItems = useDeferredValue(items);
  const total = useFlashcardsLibraryStore((state) => state.total);
  const statusCounts = useFlashcardsLibraryStore((state) => state.statusCounts);
  const page = useFlashcardsLibraryStore((state) => state.page);
  const pageSize = useFlashcardsLibraryStore((state) => state.pageSize);
  const query = useFlashcardsLibraryStore((state) => state.query);
  const loading = useFlashcardsLibraryStore((state) => state.loading);
  const loaded = useFlashcardsLibraryStore((state) => state.loaded);
  const loadError = useFlashcardsLibraryStore((state) => state.loadError);
  const actionError = useFlashcardsLibraryStore((state) => state.actionError);
  const busyCardId = useFlashcardsLibraryStore((state) => state.busyCardId);
  const bulkBusy = useFlashcardsLibraryStore((state) => state.bulkBusy);
  const statusFilter = useFlashcardsLibraryStore((state) => state.statusFilter);
  const deckFilter = useFlashcardsLibraryStore((state) => state.deckFilter);
  const decks = useFlashcardsLibraryStore((state) => state.decks);
  const sortKey = useFlashcardsLibraryStore((state) => state.sortKey);
  const sortDir = useFlashcardsLibraryStore((state) => state.sortDir);
  const setStatusFilter = useFlashcardsLibraryStore((state) => state.setStatusFilter);
  const setDeckFilter = useFlashcardsLibraryStore((state) => state.setDeckFilter);
  const toggleSort = useFlashcardsLibraryStore((state) => state.toggleSort);
  const clearSort = useFlashcardsLibraryStore((state) => state.clearSort);
  const clearActionError = useFlashcardsLibraryStore((state) => state.clearActionError);
  const refresh = useFlashcardsLibraryStore((state) => state.refresh);
  const submitSearch = useFlashcardsLibraryStore((state) => state.submitSearch);
  const goToPage = useFlashcardsLibraryStore((state) => state.goToPage);
  const setPageSize = useFlashcardsLibraryStore((state) => state.setPageSize);
  const enqueueCard = useFlashcardsLibraryStore((state) => state.enqueueCard);
  const setCardSuspended = useFlashcardsLibraryStore((state) => state.setCardSuspended);
  const updateCard = useFlashcardsLibraryStore((state) => state.updateCard);
  const undoLastReview = useFlashcardsLibraryStore((state) => state.undoLastReview);
  const resetProgress = useFlashcardsLibraryStore((state) => state.resetProgress);
  const deleteCard = useFlashcardsLibraryStore((state) => state.deleteCard);
  const bulkEnqueue = useFlashcardsLibraryStore((state) => state.bulkEnqueue);
  const bulkSetSuspended = useFlashcardsLibraryStore((state) => state.bulkSetSuspended);
  const bulkDelete = useFlashcardsLibraryStore((state) => state.bulkDelete);
  const creating = useFlashcardsLibraryStore((state) => state.creating);
  const importing = useFlashcardsLibraryStore((state) => state.importing);
  const createCard = useFlashcardsLibraryStore((state) => state.createCard);
  const importApkg = useFlashcardsLibraryStore((state) => state.importApkg);
  const importCsv = useFlashcardsLibraryStore((state) => state.importCsv);

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [lastAnchorId, setLastAnchorId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(
    () => peekPendingLibraryCardFocus()?.cardId ?? initialHydratedView?.expandedId ?? null,
  );
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);
  const [bulkDeleteArmed, setBulkDeleteArmed] = useState(false);
  // 新建与导入：桌面内联展开；移动宿主接管标题/返回/保存，内容区只展示表单。
  const [composerOpen, setComposerOpen] = useState(false);
  const [importPanelMode, setImportPanelMode] = useState<'apkg' | 'csv' | null>(null);
  const [csvTargetDeck, setCsvTargetDeck] = useState('');
  const [pendingCsvImport, setPendingCsvImport] = useState<PendingCsvImport | null>(null);
  const [apkgImportSummary, setApkgImportSummary] = useState<ApkgImportSummary | null>(null);
  const [studyingImportedDeck, setStudyingImportedDeck] = useState(false);
  const [importDragActive, setImportDragActive] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState<boolean>(
    () => initialHydratedView?.filtersOpen ?? false,
  );
  const filtersId = useId();
  const [draftMode, setDraftMode] = useState<'basic' | 'cloze'>('basic');
  const [draftFront, setDraftFront] = useState('');
  const [draftBack, setDraftBack] = useState('');
  const [draftDeck, setDraftDeck] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [draftTemplateId, setDraftTemplateId] = useState<string>('');
  const [customTemplates, setCustomTemplates] = useState<Array<{ id: string; name: string; note_type?: string }>>([]);
  const [pageJumpInput, setPageJumpInput] = useState(() => String(page));
  const mobileFrontRef = useRef<HTMLTextAreaElement | null>(null);
  const desktopFrontRef = useRef<HTMLInputElement | null>(null);
  const apkgFileInputRef = useRef<HTMLInputElement | null>(null);
  const csvFileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const savedScrollTopRef = useRef<number>(
    peekPendingLibraryCardFocus() ? 0 : (initialHydratedView?.scrollTop ?? 0),
  );
  const scrollRestoredRef = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const bulkDisarmTimer = useRef<number | null>(null);

  const resetScrollPosition = useCallback(() => {
    savedScrollTopRef.current = 0;
    scrollRestoredRef.current = true;
    if (scrollViewportRef.current) {
      scrollViewportRef.current.scrollTop = 0;
    }
    saveLibraryViewState({ scrollTop: 0 });
  }, []);

  const handleSubmitSearch = useCallback(
    (nextQuery: string, options?: { force?: boolean }) => {
      resetScrollPosition();
      return submitSearch(nextQuery, options);
    },
    [resetScrollPosition, submitSearch],
  );

  const handleGoToPage = useCallback(
    (nextPage: number) => {
      resetScrollPosition();
      return goToPage(nextPage);
    },
    [goToPage, resetScrollPosition],
  );

  const handleSetPageSize = useCallback(
    (nextPageSize: number) => {
      resetScrollPosition();
      return setPageSize(nextPageSize);
    },
    [resetScrollPosition, setPageSize],
  );

  const handleSetStatusFilter = useCallback(
    (nextFilter: LibraryStatusFilter) => {
      resetScrollPosition();
      setStatusFilter(nextFilter);
    },
    [resetScrollPosition, setStatusFilter],
  );

  const handleSetDeckFilter = useCallback(
    (nextDeck: string | null) => {
      resetScrollPosition();
      setDeckFilter(nextDeck);
    },
    [resetScrollPosition, setDeckFilter],
  );

  const handleToggleSort = useCallback(
    (key: Exclude<LibrarySortKey, 'default'>) => {
      resetScrollPosition();
      toggleSort(key);
    },
    [resetScrollPosition, toggleSort],
  );

  const handleClearSort = useCallback(() => {
    resetScrollPosition();
    clearSort();
  }, [clearSort, resetScrollPosition]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Listen for Cmd+K deep-jump requests while LibraryScreen is already mounted.
  useEffect(() => {
    return subscribePendingLibraryCardFocus((focus) => {
      if (!focus?.cardId) return;
      savedScrollTopRef.current = 0;
      scrollRestoredRef.current = true;
      setExpandedId(focus.cardId);
    });
  }, []);

  // Track list scroll offset passively so returning from review/edit/tab switch restores exact position.
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      savedScrollTopRef.current = viewport.scrollTop;
      saveLibraryViewState({ scrollTop: viewport.scrollTop });
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      viewport.removeEventListener('scroll', onScroll);
      if (scrollRestoredRef.current || viewport.scrollTop > 0) {
        savedScrollTopRef.current = viewport.scrollTop;
        saveLibraryViewState({ scrollTop: viewport.scrollTop });
      }
    };
  }, [isSmallScreen, composerOpen]);

  // Persist active library filter, pagination, expanded row, and scroll offset into session view state.
  useEffect(() => {
    if (!loaded && expandedId === null && !filtersOpen) return;
    saveLibraryViewState({
      page,
      pageSize,
      query,
      searchInput: query,
      statusFilter,
      deckFilter,
      sortKey,
      sortDir,
      expandedId,
      filtersOpen,
      scrollTop: savedScrollTopRef.current,
    });
  }, [loaded, page, pageSize, query, statusFilter, deckFilter, sortKey, sortDir, expandedId, filtersOpen]);

  useEffect(() => {
    if (!composerOpen) return;
    let cancelled = false;
    void import('@/services/templateService')
      .then(({ TemplateService }) => TemplateService.getInstance().getAllTemplates())
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return;
        setCustomTemplates(
          list.map((tpl) => ({
            id: tpl.id,
            name: tpl.name,
            note_type: tpl.note_type,
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [composerOpen]);

  const onRefreshEvent = useCallback(() => {
    void useFlashcardsLibraryStore.getState().refresh();
  }, []);
  useEventRegistry(
    [{ target: 'window', type: FSRS_LIBRARY_REFRESH_EVENT, listener: onRefreshEvent }],
    [onRefreshEvent],
  );

  // 数据刷新后修剪失效的选择 / 展开 / 删除确认目标（加载中或尚未首载完成时保留待恢复的展开目标）。
  useEffect(() => {
    if (!loaded || loading) return;
    const ids = new Set(items.map((item) => item.id));
    setSelectedIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
    const pendingFocus = peekPendingLibraryCardFocus();
    if (pendingFocus?.cardId) {
      if (ids.has(pendingFocus.cardId)) {
        setExpandedId(pendingFocus.cardId);
        const row = rowRefs.current.get(pendingFocus.cardId);
        row?.scrollIntoView?.({ block: 'center' });
        row?.focus?.();
      } else {
        setExpandedId((prev) => (prev && !ids.has(prev) ? null : prev));
      }
      clearPendingLibraryCardFocus();
      scrollRestoredRef.current = true;
    } else {
      setExpandedId((prev) => (prev && !ids.has(prev) ? null : prev));
      if (!scrollRestoredRef.current && items.length > 0) {
        scrollRestoredRef.current = true;
        const targetScrollTop = savedScrollTopRef.current;
        if (targetScrollTop > 0 && scrollViewportRef.current) {
          scrollViewportRef.current.scrollTop = targetScrollTop;
          if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => {
              if (scrollViewportRef.current && savedScrollTopRef.current === targetScrollTop) {
                scrollViewportRef.current.scrollTop = targetScrollTop;
              }
            });
          }
        }
      }
    }
    setDeleteCandidateId((prev) => (prev && !ids.has(prev) ? null : prev));
    setLastAnchorId((prev) => (prev && !ids.has(prev) ? null : prev));
  }, [items, loaded, loading]);

  useEffect(() => {
    setPageJumpInput(String(page));
  }, [page]);

  useEffect(() => () => {
    if (bulkDisarmTimer.current !== null) window.clearTimeout(bulkDisarmTimer.current);
  }, []);

  const effectivePageSize = pageSize > 0 ? pageSize : FLASHCARDS_LIBRARY_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(total / effectivePageSize));

  const handlePageJumpSubmit = useCallback(() => {
    if (loading) return;
    const trimmed = pageJumpInput.trim();
    if (!trimmed) {
      setPageJumpInput(String(page));
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
      setPageJumpInput(String(page));
      return;
    }
    const bounded = Math.min(pageCount, Math.max(1, parsed));
    setPageJumpInput(String(bounded));
    if (bounded !== page) {
      void handleGoToPage(bounded);
    }
  }, [loading, pageJumpInput, page, pageCount, handleGoToPage]);

  const rowBusy = busyCardId !== null || bulkBusy;

  // 已生成未入队（inbox）与已入队队列（scheduled）分区渲染，视觉上隔离两条队列。
  // deferredItems 防止大页切换（如 100 张含数学公式卡）阻塞交互帧；
  // visibleItems 按「inbox 在前」的渲染顺序拼接，键盘导航 / shift 连选与视觉顺序一致。
  const { inbox: inboxItems, scheduled: scheduledItems } = useMemo(
    () => partitionLibraryQueues(sortLibraryCards(
      deferredItems.filter((card) => matchesStatusFilter(card, statusFilter)),
      sortKey,
      sortDir,
    )),
    [deferredItems, statusFilter, sortKey, sortDir],
  );
  const visibleItems = useMemo(
    () => [...inboxItems, ...scheduledItems],
    [inboxItems, scheduledItems],
  );
  const scheduledDueCount = useMemo(() => countDueCards(scheduledItems), [scheduledItems]);

  // 计数取服务端全集（statusCounts）；旧后端没有时退回本页计数
  const filterCounts = useMemo(() => {
    const counts = new Map<LibraryStatusFilter, number>();
    for (const option of FILTER_OPTIONS) {
      counts.set(
        option,
        statusCounts
          ? statusCounts[option]
          : option === 'all'
            ? deferredItems.length
            : deferredItems.filter((card) => matchesStatusFilter(card, option)).length,
      );
    }
    return counts;
  }, [deferredItems, statusCounts]);

  const deckOptions = useMemo(() => flattenDeckTree(buildDeckTree(decks ?? [])), [decks]);
  const namedDeckPaths = useMemo(
    () => deckOptions.map((node) => node.path).filter((path) => path.length > 0),
    [deckOptions],
  );
  // 存在具名牌组、≥2 个分组或已选中牌组时展示牌组筛选，确保新建首个牌组后立即可按牌组筛选
  const showDeckFilter =
    (decks?.length ?? 0) >= 2 || namedDeckPaths.length > 0 || deckFilter !== null;
  const deckFilterMissing = deckFilter !== null && !deckOptions.some((node) => node.path === deckFilter);

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

  const visibleItemsRef = useRef(visibleItems);
  visibleItemsRef.current = visibleItems;
  const lastAnchorIdRef = useRef(lastAnchorId);
  lastAnchorIdRef.current = lastAnchorId;
  const allVisibleSelectedRef = useRef(allVisibleSelected);
  allVisibleSelectedRef.current = allVisibleSelected;
  const deleteCandidateIdRef = useRef(deleteCandidateId);
  deleteCandidateIdRef.current = deleteCandidateId;

  const handleToggleSelect = useCallback((cardId: string, shiftKey: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const targetChecked = !prev.has(cardId);
      const anchor = lastAnchorIdRef.current;
      if (shiftKey && anchor && anchor !== cardId) {
        const order = visibleItemsRef.current.map((card) => card.id);
        const anchorIndex = order.indexOf(anchor);
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
  }, [disarmBulkDelete]);

  const handleToggleSelectAll = useCallback(() => {
    if (allVisibleSelectedRef.current) {
      clearSelection();
      return;
    }
    setSelectedIds(new Set(visibleItemsRef.current.map((card) => card.id)));
    disarmBulkDelete();
  }, [clearSelection, disarmBulkDelete]);

  const handleToggleExpand = useCallback((cardId: string) => {
    setExpandedId((prev) => (prev === cardId ? null : cardId));
  }, []);

  const handleStartReview = useCallback((card: AnkiLibraryCard) => {
    saveLibraryViewState({
      expandedId: card.id,
      scrollTop: scrollViewportRef.current?.scrollTop ?? savedScrollTopRef.current,
    });
    setLibraryReturnOrigin('library');
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
    const cardId = deleteCandidateIdRef.current;
    if (!cardId) return;
    void deleteCard(cardId).finally(() => {
      setDeleteCandidateId((prev) => (prev === cardId ? null : prev));
    });
  }, [deleteCard]);

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
    const order = visibleItemsRef.current.map((card) => card.id);
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
  }, [handleToggleExpand, handleToggleSelect]);

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

  // 收件箱区头的「加入复习」：把当前页所有未入队卡整批入队（复用 bulkEnqueue 链路）。
  const handleEnqueueInbox = () => {
    if (inboxItems.length === 0) return;
    void bulkEnqueue(inboxItems.map((card) => card.id));
  };

  const handleBulkSuspend = () => {
    void bulkSetSuspended(suspendTargets.map((card) => card.id), true);
  };

  const handleBulkResume = () => {
    void bulkSetSuspended(resumeTargets.map((card) => card.id), false);
  };

  const handleBulkReview = () => {
    if (reviewTargets.length === 0) return;
    saveLibraryViewState({
      scrollTop: scrollViewportRef.current?.scrollTop ?? savedScrollTopRef.current,
    });
    setLibraryReturnOrigin('library');
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
    resetScrollPosition();
    void useFlashcardsLibraryStore.getState().clearFilters();
  };
  // 搜索 / 状态 / 牌组筛选生效时，空列表表示「没有命中」而不是「库是空的」
  const isFiltered = query.length > 0 || statusFilter !== 'all' || deckFilter !== null;
  // 选了牌组时 statusCounts 只是该牌组的全集，全库总数从牌组计数求和
  const libraryAll = deckFilter !== null && decks
    ? decks.reduce((sum, deck) => sum + deck.all, 0)
    : statusCounts?.all;
  const totalLabel = (statusFilter !== 'all' || deckFilter !== null) && libraryAll != null
    ? translate('library.totalFiltered', { count: total, all: libraryAll })
    : translate('library.total', { count: statusCounts?.all ?? total });

  // ---------- 新建 / 导入 ----------
  const draftClozeInvalid = draftMode === 'cloze' && draftFront.trim().length > 0 && !hasValidCloze(draftFront);
  const draftValid = draftFront.trim().length > 0
    && (draftMode === 'cloze' ? hasValidCloze(draftFront) : draftBack.trim().length > 0);
  const openComposerWithDefaultDeck = useCallback(() => {
    setDraftDeck((prev) => {
      if (prev.trim()) return prev;
      return deckFilter && deckFilter !== DECK_FILTER_ALL ? deckFilter : '';
    });
    setImportPanelMode(null);
    setComposerOpen(true);
  }, [deckFilter]);

  useEffect(() => {
    if (!autoOpenComposer) return;
    openComposerWithDefaultDeck();
    onAutoOpenComposerConsumed?.();
  }, [autoOpenComposer, openComposerWithDefaultDeck, onAutoOpenComposerConsumed]);

  const handleInsertDraftCloze = useCallback((el: HTMLTextAreaElement | HTMLInputElement | null) => {
    const { nextValue, nextSelectionStart, nextSelectionEnd } = insertClozeDeletion(
      draftFront,
      el?.selectionStart,
      el?.selectionEnd,
      translate('library.create.clozePlaceholder', { defaultValue: 'Cloze text' }),
    );
    setDraftMode('cloze');
    setDraftFront(nextValue);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextSelectionStart, nextSelectionEnd);
    });
  }, [draftFront, translate]);

  const handleSubmitDraft = useCallback(() => {
    if (!draftValid || creating) return;
    const targetDeck = draftDeck.trim();
    const tags = parseTagsInput(draftTags);
    void createCard({
      front: draftFront,
      back: draftBack,
      tags,
      noteType: draftMode === 'cloze' ? 'Cloze' : 'Basic',
      ...(targetDeck ? { deckName: targetDeck } : {}),
      ...(draftTemplateId ? { templateId: draftTemplateId } : {}),
    }).then((ok) => {
      if (!ok) return;
      setDraftFront('');
      setDraftBack('');
      setDraftTags('');
      setDraftTemplateId('');
      setDraftMode('basic');
      setComposerOpen(false);
      showGlobalNotification('success', translate('library.create.success'));
    });
  }, [draftValid, creating, createCard, draftFront, draftBack, draftDeck, draftTags, draftTemplateId, draftMode, translate]);

  const preferDomFileInput = !isTauriEnvironment() || usesAndroidSaf() || isWebUiShell();

  const runImportApkg = useCallback((file?: File) => {
    if (importing) return;
    const preStore = useFlashcardsLibraryStore.getState();
    const prevDeckCounts = new Map<string, number>(
      (preStore.decks ?? []).map((deck) => [deck.name, deck.all]),
    );
    const prevCardIds = new Set(preStore.items.map((item) => item.id));

    void importApkg(file ? { file } : undefined).then(async (outcome) => {
      if (outcome.status === 'imported') {
        const { importedCards: count, reviewEnqueued: queued, reviewWithHistory: history } = outcome;
        const message =
          queued <= 0
            ? translate('library.import.success', { count })
            : history > 0
              ? translate('library.import.successQueuedWithHistory', { count, queued, history })
              : translate('library.import.successQueued', { count, queued });
        showGlobalNotification('success', message);
        setImportPanelMode(null);

        const postStore = useFlashcardsLibraryStore.getState();
        const deckDeltas = (postStore.decks ?? [])
          .map((deck) => ({ name: deck.name, delta: deck.all - (prevDeckCounts.get(deck.name) ?? 0) }))
          .filter((entry) => entry.delta > 0)
          .sort((a, b) => {
            const aNamed = a.name.length > 0 ? 1 : 0;
            const bNamed = b.name.length > 0 ? 1 : 0;
            if (aNamed !== bNamed) return bNamed - aNamed;
            return b.delta - a.delta;
          });

        const newItems = postStore.items.filter((item) => !prevCardIds.has(item.id));
        const inferredItemDeck = newItems.map(extractCardDeckPath).find((name) => name.length > 0) ?? '';
        const topDeck = deckDeltas[0];
        const deckFilterPath: string | null = topDeck
          ? topDeck.name
          : inferredItemDeck
            ? inferredItemDeck
            : null;
        const fallbackDeckName = stripApkgExtension(file?.name)
          || translate('common:flashcards_import_banner.default_deck', { defaultValue: 'Imported deck' });
        const deckName = (deckFilterPath && deckFilterPath.length > 0)
          ? deckFilterPath
          : deckFilterPath === ''
            ? translate('library.deck.ungrouped', { defaultValue: 'No deck' })
            : fallbackDeckName;

        let sampledCards = newItems;
        if (deckFilterPath !== null && sampledCards.length < count) {
          try {
            const fetched = await listAnkiLibraryCards({
              deck: deckFilterPath,
              page: 1,
              page_size: Math.min(Math.max(count, 20), 200),
              sort: 'created',
              sort_desc: true,
            });
            if (Array.isArray(fetched?.items) && fetched.items.length > 0) {
              sampledCards = fetched.items;
            }
          } catch {
            // Best-effort media & batch sample fetch; keep summary responsive even if lookup fails.
          }
        }

        setApkgImportSummary({
          deckName,
          deckFilterPath,
          importedCards: count,
          reviewEnqueued: queued,
          reviewWithHistory: history,
          mediaCount: countBatchMedia(sampledCards),
          sampledCards,
        });
      }
      // canceled 静默；failed 已写入 actionError 由页内错误条呈现
    });
  }, [importing, importApkg, translate]);

  const handleStudyImportedDeck = useCallback(async () => {
    if (!apkgImportSummary || studyingImportedDeck) return;
    setStudyingImportedDeck(true);
    try {
      let playable: AnkiLibraryCard[] = [];
      try {
        const fetched = await listAnkiLibraryCards({
          ...(apkgImportSummary.deckFilterPath !== null ? { deck: apkgImportSummary.deckFilterPath } : {}),
          page: 1,
          page_size: Math.min(Math.max(apkgImportSummary.importedCards, 50), 200),
          sort: 'created',
          sort_desc: true,
        });
        playable = (fetched?.items ?? []).filter((card) => !card.suspended);
      } catch {
        // Fallback to sampled cards below.
      }
      if (playable.length === 0) {
        playable = apkgImportSummary.sampledCards.filter((card) => !card.suspended);
      }
      if (playable.length === 0) {
        showGlobalNotification(
          'info',
          translate('common:flashcards_import_banner.study_empty', {
            defaultValue: 'No studyable cards are available in this deck yet',
          }),
        );
        return;
      }
      saveLibraryViewState({
        scrollTop: scrollViewportRef.current?.scrollTop ?? savedScrollTopRef.current,
      });
      setLibraryReturnOrigin('library');
      const started = await startBatchSession(
        playable.map((card) => card.id),
        playable.map(toReviewContent),
      );
      if (started) {
        setApkgImportSummary(null);
      }
    } catch {
      showGlobalNotification(
        'error',
        translate('common:flashcards_import_banner.study_failed', {
          defaultValue: 'Could not start studying this deck, please try again',
        }),
      );
    } finally {
      setStudyingImportedDeck(false);
    }
  }, [apkgImportSummary, studyingImportedDeck, startBatchSession, translate]);

  const handleFilterImportedDeck = useCallback(() => {
    if (!apkgImportSummary || apkgImportSummary.deckFilterPath === null) return;
    resetScrollPosition();
    const libStore = useFlashcardsLibraryStore.getState();
    useFlashcardsLibraryStore.setState({
      statusFilter: 'all',
      searchInput: '',
      query: '',
      deckFilter: apkgImportSummary.deckFilterPath,
      page: 1,
      actionError: null,
    });
    void libStore.load('', 1);
  }, [apkgImportSummary, resetScrollPosition]);

  const csvEffectiveFallbackDeck = useMemo(
    () => csvTargetDeck.trim() || (deckFilter && deckFilter !== DECK_FILTER_ALL ? deckFilter : ''),
    [csvTargetDeck, deckFilter],
  );

  const pendingCsvDeckPreview = useMemo(() => {
    if (!pendingCsvImport) return [];
    const counts = new Map<string, number>();
    const ungroupedLabel = translate('library.deck.ungrouped', { defaultValue: 'No deck' });
    for (const bucket of pendingCsvImport.deckBuckets) {
      const resolvedDeck = bucket.csvDeck || csvEffectiveFallbackDeck || ungroupedLabel;
      counts.set(resolvedDeck, (counts.get(resolvedDeck) ?? 0) + bucket.count);
    }
    return Array.from(counts.entries()).map(([deck, count]) => ({ deck, count }));
  }, [pendingCsvImport, csvEffectiveFallbackDeck, translate]);

  const runImportCsv = useCallback((input?: { file?: File; rawText?: string }) => {
    if (importing) return;
    const fallbackDeck = csvEffectiveFallbackDeck;
    void importCsv({
      ...(fallbackDeck ? { targetDeck: fallbackDeck } : {}),
      ...(input?.file ? { file: input.file } : {}),
      ...(typeof input?.rawText === 'string' ? { rawText: input.rawText } : {}),
    }).then((outcome) => {
      if (outcome.status === 'imported') {
        const message =
          outcome.skippedRows > 0
            ? translate('library.import.csvSuccessSkipped', {
                count: outcome.importedCards,
                queued: outcome.reviewEnqueued,
                skipped: outcome.skippedRows,
              })
            : translate('library.import.csvSuccess', {
                count: outcome.importedCards,
                queued: outcome.reviewEnqueued,
              });
        showGlobalNotification('success', message);
        setPendingCsvImport(null);
        setImportPanelMode(null);
      }
      // canceled 静默；failed 已写入 actionError 由页内错误条呈现
    });
  }, [importing, csvEffectiveFallbackDeck, importCsv, translate]);

  const stageCsvPreviewText = useCallback((rawText: string, fileName: string, file?: File) => {
    const parsed = parseFlashcardsFromCsv(rawText);
    if (parsed.cards.length === 0) {
      // 无有效行时走原有错误上报流程，避免空白预览卡住用户
      runImportCsv({ file, rawText });
      return;
    }
    const bucketCounts = new Map<string, number>();
    for (const card of parsed.cards) {
      bucketCounts.set(card.deck, (bucketCounts.get(card.deck) ?? 0) + 1);
    }
    setPendingCsvImport({
      file,
      rawText,
      fileName,
      cardCount: parsed.cards.length,
      skippedRows: parsed.skippedRows,
      deckBuckets: Array.from(bucketCounts.entries()).map(([csvDeck, count]) => ({ csvDeck, count })),
    });
  }, [runImportCsv]);

  const stageCsvPreviewFile = useCallback(async (file: File) => {
    if (importing) return;
    const rawText = typeof (file as { text?: unknown }).text === 'function'
      ? await file.text()
      : await new Response(file).text();
    stageCsvPreviewText(rawText, file.name || 'flashcards.csv', file);
  }, [importing, stageCsvPreviewText]);

  const pickCsvForPreview = useCallback(async () => {
    if (importing) return;
    const { fileManager, extractFileName } = await import('@/utils/fileManager');
    const path = await fileManager.pickSingleFile({
      title: translate('library.import.csvPickTitle'),
      filters: [{ name: 'CSV / TSV', extensions: ['csv', 'tsv', 'txt'] }],
    });
    if (!path) return;
    const rawText = await fileManager.readTextFile(path);
    stageCsvPreviewText(rawText, extractFileName(path) || path);
  }, [importing, translate, stageCsvPreviewText]);

  const handleImportApkg = useCallback(() => {
    if (importing) return;
    setComposerOpen(false);
    setImportDragActive(false);
    setPendingCsvImport(null);
    setImportPanelMode((prev) => (prev === 'apkg' ? null : 'apkg'));
  }, [importing]);

  const handleImportCsv = useCallback(() => {
    if (importing) return;
    setComposerOpen(false);
    setImportDragActive(false);
    setPendingCsvImport(null);
    setImportPanelMode((prev) => {
      if (prev === 'csv') return null;
      setCsvTargetDeck(deckFilter && deckFilter !== DECK_FILTER_ALL ? deckFilter : '');
      return 'csv';
    });
  }, [importing, deckFilter]);

  const handleApkgFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) {
      runImportApkg(file);
    }
  }, [runImportApkg]);

  const handleCsvFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) {
      void stageCsvPreviewFile(file);
    }
  }, [stageCsvPreviewFile]);

  const handleImportDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setImportDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (!file || !importPanelMode) return;
    if (importPanelMode === 'apkg') {
      runImportApkg(file);
    } else {
      void stageCsvPreviewFile(file);
    }
  }, [importPanelMode, runImportApkg, stageCsvPreviewFile]);

  // 导出：有选中导出选中，否则导出整个卡片库
  const [exporting, setExporting] = useState(false);
  const handleExportApkg = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const outcome = await exportLibraryApkg(selectedCards, translate('library.export.deckName', { defaultValue: 'DeepStudent' }));
      if (outcome.status === 'exported') {
        showGlobalNotification(
          outcome.missingMedia > 0 ? 'warning' : 'success',
          outcome.missingMedia > 0
            ? translate('library.export.successMissingMedia', { count: outcome.count, missing: outcome.missingMedia, defaultValue: 'Exported {{count}} cards; {{missing}} media files were missing' })
            : translate('library.export.success', { count: outcome.count, defaultValue: 'Exported {{count}} cards' }),
        );
      } else if (outcome.status === 'empty') {
        showGlobalNotification('info', translate('library.export.empty', { defaultValue: 'The library has no cards yet' }));
      } else if (outcome.status === 'failed') {
        showGlobalNotification('error', translate('library.export.failed', { defaultValue: 'Export failed' }));
      }
    } catch (error: unknown) {
      console.error('[FlashcardsLibrary] export failed:', error);
      showGlobalNotification('error', translate('library.export.failed', { defaultValue: 'Export failed' }));
    } finally {
      setExporting(false);
    }
  }, [exporting, selectedCards, translate]);
  const handleExportCsv = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const outcome = await exportLibraryCsv(selectedCards, {
        defaultDeck: translate('library.export.deckName'),
        fileName: 'flashcards.csv',
        title: translate('library.export.csvTitle'),
      });
      if (outcome.status === 'exported') {
        showGlobalNotification('success', translate('library.export.success', { count: outcome.count }));
      } else if (outcome.status === 'empty') {
        showGlobalNotification('info', translate('library.export.empty'));
      } else if (outcome.status === 'failed') {
        showGlobalNotification('error', translate('library.export.failed'));
      }
    } catch (error: unknown) {
      console.error('[FlashcardsLibrary] export csv failed:', error);
      showGlobalNotification('error', translate('library.export.failed'));
    } finally {
      setExporting(false);
    }
  }, [exporting, selectedCards, translate]);
  const exportLabel = exporting
    ? translate('library.export.running', { defaultValue: 'Exporting…' })
    : selectedCards.length > 0
      ? translate('library.export.selected', { count: selectedCards.length, defaultValue: 'Export selected ({{count}})' })
      : translate('library.export.apkg', { defaultValue: 'Export .apkg' });
  const exportCsvLabel = exporting
    ? translate('library.export.running')
    : selectedCards.length > 0
      ? translate('library.export.csvSelected', { count: selectedCards.length })
      : translate('library.export.csv');

  const closeComposer = useCallback(() => {
    if (!creating) setComposerOpen(false);
  }, [creating]);
  const handleOpenOcclusionBuilder = useCallback(() => {
    openImageOcclusionBuilder({
      defaultDeckName: deckFilter && deckFilter !== DECK_FILTER_ALL ? deckFilter : undefined,
    });
  }, [deckFilter]);
  const mobileChrome = useFlashcardsMobileChrome({
    title: t(composerOpen ? 'library.create.new' : 'library.title'),
    subtitle: composerOpen ? undefined : loading ? t('library.loading') : totalLabel,
    onBack: composerOpen ? closeComposer : backToToday,
    rightActions: composerOpen ? (
      <DsButton variant="ghost" size="icon" className="!min-h-11 !min-w-11" aria-label={t('library.create.save')} disabled={!draftValid || creating} onClick={handleSubmitDraft}>
        <FloppyDisk size={20} />
      </DsButton>
    ) : <>
      <DsButton variant="ghost" size="icon" className="!min-h-11 !min-w-11" data-testid="fc-lib-new-card-mobile" aria-label={t('library.create.new')} onClick={openComposerWithDefaultDeck}>
        <Plus size={20} />
      </DsButton>
      <AppMenu>
        <AppMenuTrigger asChild>
          <DsButton variant="ghost" size="icon" className="!min-h-11 !min-w-11" aria-label={t('common:more')}><DotsThree size={22} /></DsButton>
        </AppMenuTrigger>
        <AppMenuContent align="end" width={200}>
          <AppMenuItem icon={<ImageSquare size={18} />} onClick={handleOpenOcclusionBuilder} data-testid="fc-lib-new-occlusion-mobile">{t('occlusion.newCardButton')}</AppMenuItem>
          <AppMenuItem icon={<UploadSimple size={18} />} disabled={importing} onClick={handleImportApkg} data-testid="fc-lib-import-apkg-mobile">{t(importing ? 'library.import.running' : 'library.import.apkg')}</AppMenuItem>
          <AppMenuItem icon={<UploadSimple size={18} />} disabled={importing} onClick={handleImportCsv} data-testid="fc-lib-import-csv-mobile">{t(importing ? 'library.import.running' : 'library.import.csv')}</AppMenuItem>
          <AppMenuItem icon={<DownloadSimple size={18} />} disabled={exporting} onClick={() => void handleExportApkg()} data-testid="fc-lib-export-apkg">{exportLabel}</AppMenuItem>
          <AppMenuItem icon={<DownloadSimple size={18} />} disabled={exporting} onClick={() => void handleExportCsv()} data-testid="fc-lib-export-csv-mobile">{exportCsvLabel}</AppMenuItem>
        </AppMenuContent>
      </AppMenu>
    </>,
  }, [t, composerOpen, loading, totalLabel, closeComposer, backToToday, draftValid, creating, handleSubmitDraft, openComposerWithDefaultDeck, handleOpenOcclusionBuilder, importing, handleImportApkg, handleImportCsv, exporting, handleExportApkg, handleExportCsv, exportLabel, exportCsvLabel]);

  // A phone composer is a subpage of the library: keep its draft/list state here,
  // while the host owns the title, back and save action.
  if (mobileChrome && composerOpen) {
    return <CustomScrollArea className="min-h-0 flex-1">
      <div className="wb-fc-screen fc-lib-mobile-composer">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            role="group"
            aria-label={translate('library.create.typeLabel', { defaultValue: 'Card type' })}
            className="inline-flex items-center rounded-lg border border-border/50 bg-muted/40 p-0.5"
          >
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={draftMode === 'basic'}
              data-testid="fc-lib-create-mode-basic"
              onClick={() => setDraftMode('basic')}
              className={cn(
                'min-h-[36px] rounded-md px-3 text-xs font-medium',
                draftMode === 'basic'
                  ? 'bg-card text-foreground shadow-sm hover:bg-card'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {translate('library.create.typeBasic', { defaultValue: 'Basic (Q&A)' })}
            </DsButton>
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={draftMode === 'cloze'}
              data-testid="fc-lib-create-mode-cloze"
              onClick={() => setDraftMode('cloze')}
              className={cn(
                'min-h-[36px] rounded-md px-3 text-xs font-medium',
                draftMode === 'cloze'
                  ? 'bg-card text-foreground shadow-sm hover:bg-card'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {translate('library.create.typeCloze', { defaultValue: 'Cloze deletion' })}
            </DsButton>
          </div>
          <DsButton
            type="button"
            variant="default"
            size="sm"
            data-testid="fc-lib-create-insert-cloze"
            onClick={() => handleInsertDraftCloze(mobileFrontRef.current)}
            className="min-h-[36px] gap-1.5 text-xs"
          >
            <BracketsCurly size={14} aria-hidden="true" />
            <span>
              {translate('library.create.insertCloze', { defaultValue: 'Insert cloze' })}
              {' '}
              <code className="font-mono">{`{{c${nextClozeIndex(draftFront)}::...}}`}</code>
            </span>
          </DsButton>
        </div>
        <label className="flex flex-col gap-2 text-sm font-medium">
          {draftMode === 'cloze'
            ? translate('library.create.clozeTextLabel', { defaultValue: 'Cloze text (with {{c1::...}})' })
            : t('library.create.frontLabel')}
          <textarea
            ref={mobileFrontRef}
            autoFocus
            rows={5}
            value={draftFront}
            onChange={(event) => setDraftFront(event.target.value)}
            placeholder={draftMode === 'cloze'
              ? translate('library.create.clozeFrontPlaceholder', { defaultValue: 'Enter text, highlight a key term, and click Insert cloze for {{c1::...}}' })
              : t('library.create.frontPlaceholder')}
            className="w-full resize-y rounded-md border border-border bg-background p-3 text-base font-normal"
          />
        </label>
        {draftClozeInvalid ? (
          <p role="status" className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <Warning size={13} aria-hidden="true" />
            {t('session.invalidClozeEdit')}
          </p>
        ) : null}
        <label className="flex flex-col gap-2 text-sm font-medium">
          {draftMode === 'cloze'
            ? translate('library.create.clozeExtraLabel', { defaultValue: 'Extra note (optional)' })
            : t('library.create.backLabel')}
          <textarea
            rows={4}
            value={draftBack}
            onChange={(event) => setDraftBack(event.target.value)}
            placeholder={draftMode === 'cloze'
              ? translate('library.create.clozeBackPlaceholder', { defaultValue: 'Explanation or source shown on back (optional)' })
              : t('library.create.backPlaceholder')}
            className="w-full resize-y rounded-md border border-border bg-background p-3 text-base font-normal"
          />
        </label>
        <label className="flex flex-col gap-2 text-sm font-medium">
          {translate('library.editTags', { defaultValue: 'Tags (comma separated)' })}
          <Input
            value={draftTags}
            onChange={(event) => setDraftTags(event.target.value)}
            placeholder={translate('library.create.tagsPlaceholder', { defaultValue: 'e.g. Calculus, Key concept' })}
            data-testid="fc-lib-create-tags"
            className="h-11 text-base font-normal"
          />
        </label>
        <label className="flex flex-col gap-2 text-sm font-medium">
          {t('library.create.deckLabel')}
          <Input
            value={draftDeck}
            onChange={(event) => setDraftDeck(event.target.value)}
            list={`${filtersId}-deck-suggestions`}
            placeholder={t('library.create.deckPlaceholder')}
            className="h-11 text-base font-normal"
          />
          <datalist id={`${filtersId}-deck-suggestions`}>
            {namedDeckPaths.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
        </label>
        <p className="text-xs text-muted-foreground">{t(creating ? 'library.create.saving' : 'library.create.hint')}</p>
        {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
      </div>
    </CustomScrollArea>;
  }

  const initialLoading = loading && !loaded;

  // 两个队列分区共用同一行渲染（行为完全一致，仅容器视觉不同）。
  const renderCardRow = (card: AnkiLibraryCard) => (
    <MemoizedLibraryCardRow
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
  );

  const creationActions = (
    <>
      <DsButton
        type="button"
        variant={composerOpen ? 'default' : 'primary'}
        iconOnly={isSmallScreen}
        aria-label={composerOpen ? translate('library.create.cancel') : translate('library.create.new')}
        onClick={() => {
          if (composerOpen) setComposerOpen(false);
          else openComposerWithDefaultDeck();
        }}
        aria-expanded={composerOpen}
        className="fc-lib-create-cta text-sm"
      >
        {composerOpen ? <X size={18} /> : <Plus size={18} />}
        {!isSmallScreen && (composerOpen ? translate('library.create.cancel') : translate('library.create.new'))}
      </DsButton>
      <DsButton
        type="button"
        variant="default"
        iconOnly={isSmallScreen}
        aria-label={translate('occlusion.newCardButton')}
        onClick={handleOpenOcclusionBuilder}
        title={translate('occlusion.newCardButton')}
        className="fc-lib-create-cta text-sm"
        data-testid="fc-lib-new-occlusion"
      >
        <ImageSquare size={18} />
        {!isSmallScreen && translate('occlusion.newCardButton')}
      </DsButton>
      <DsButton
        type="button"
        variant="default"
        iconOnly={isSmallScreen}
        aria-label={importing ? translate('library.import.running') : translate('library.import.apkg')}
        aria-expanded={importPanelMode === 'apkg'}
        disabled={importing}
        onClick={handleImportApkg}
        title={translate('library.import.hint')}
        className="fc-lib-create-cta text-sm"
        data-testid="fc-lib-import-apkg"
      >
        <UploadSimple size={18} />
        {!isSmallScreen && (importing ? translate('library.import.running') : translate('library.import.apkg'))}
      </DsButton>
      <DsButton
        type="button"
        variant="default"
        iconOnly={isSmallScreen}
        aria-label={importing ? translate('library.import.running') : translate('library.import.csv')}
        aria-expanded={importPanelMode === 'csv'}
        disabled={importing}
        onClick={handleImportCsv}
        title={translate('library.import.csvHint')}
        className="fc-lib-create-cta text-sm"
        data-testid="fc-lib-import-csv"
      >
        <UploadSimple size={18} />
        {!isSmallScreen && (importing ? translate('library.import.running') : translate('library.import.csv'))}
      </DsButton>
      <DsButton
        type="button"
        variant="default"
        iconOnly={isSmallScreen}
        aria-label={exportLabel}
        disabled={exporting}
        onClick={() => void handleExportApkg()}
        title={translate('library.export.hint', { defaultValue: "Export as an Anki deck (.apkg) keeping each card's template and styling; exports the whole library when nothing is selected" })}
        className="fc-lib-create-cta text-sm"
        data-testid="fc-lib-export-apkg"
      >
        <DownloadSimple size={18} />
        {!isSmallScreen && exportLabel}
      </DsButton>
      <DsButton
        type="button"
        variant="default"
        iconOnly={isSmallScreen}
        aria-label={exportCsvLabel}
        disabled={exporting}
        onClick={() => void handleExportCsv()}
        title={translate('library.export.csvHint')}
        className="fc-lib-create-cta text-sm"
        data-testid="fc-lib-export-csv"
      >
        <DownloadSimple size={18} />
        {!isSmallScreen && exportCsvLabel}
      </DsButton>
    </>
  );
  const listBody = loadError ? (
    <div role="alert" className="wb-fc-empty">
      <p className="break-words text-destructive">{loadError}</p>
      <DsButton
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void refresh()}
        className="[@media(pointer:coarse)]:!min-h-11"
      >
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
      <p>{isFiltered ? translate('library.noMatches') : t('library.empty')}</p>
      {isFiltered ? (
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClearFilters}
          className="[@media(pointer:coarse)]:!min-h-11"
        >
          {translate('library.clearFilters')}
        </DsButton>
      ) : (
        <>
          <p className="max-w-md text-xs text-muted-foreground">
            {translate('library.emptyHint')}
          </p>
          {!mobileChrome && <div className="fc-lib-empty-actions">
            <DsButton
              type="button"
              variant="primary"
              onClick={() => setComposerOpen(true)}
              className="fc-lib-create-cta text-sm"
            >
              <Plus size={15} />
              {translate('library.create.new')}
            </DsButton>
            <DsButton
              type="button"
              variant="default"
              disabled={importing}
              onClick={handleImportApkg}
              className="fc-lib-create-cta text-sm"
            >
              <UploadSimple size={15} />
              {importing ? translate('library.import.running') : translate('library.import.apkg')}
            </DsButton>
            <DsButton
              type="button"
              variant="default"
              disabled={importing}
              onClick={handleImportCsv}
              className="fc-lib-create-cta text-sm"
              data-testid="fc-lib-empty-import-csv"
            >
              <UploadSimple size={15} />
              {importing ? translate('library.import.running') : translate('library.import.csv')}
            </DsButton>
          </div>}
        </>
      )}
    </div>
  ) : visibleItems.length === 0 ? (
    <div className="wb-fc-empty">
      <Stack size={28} className="text-muted-foreground/50" weight="duotone" />
      <p>{translate('library.noMatches')}</p>
      <DsButton
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleClearFilters}
        className="[@media(pointer:coarse)]:!min-h-11"
      >
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
      {inboxItems.length > 0 ? (
        <section
          className="fc-lib-queue-section"
          data-queue="inbox"
          aria-label={translate('library.queue.inboxTitle', {
            defaultValue: 'Generated · Not in queue',
          })}
        >
          <div className="fc-lib-queue-head" data-queue="inbox">
            <Tray size={14} weight="duotone" aria-hidden="true" />
            <span className="fc-lib-queue-title">
              {translate('library.queue.inboxTitle', { defaultValue: 'Generated · Not in queue' })}
            </span>
            <span className="fc-lib-queue-count font-mono tabular-nums">{inboxItems.length}</span>
            <span className="fc-lib-queue-hint">
              {translate('library.queue.inboxHint', {
                defaultValue: "Not scheduled yet, so these won't appear in the due queue",
              })}
            </span>
            <DsButton
              type="button"
              variant="default"
              size="sm"
              disabled={rowBusy}
              onClick={handleEnqueueInbox}
              className="fc-lib-queue-cta text-xs [@media(pointer:coarse)]:!min-h-11"
            >
              <PlusCircle size={13} />
              {translate('library.queue.enqueueAll', {
                count: inboxItems.length,
                defaultValue: 'Add to review ({{count}})',
              })}
            </DsButton>
          </div>
          <ul className="wb-fc-list-ul">
            {inboxItems.map(renderCardRow)}
          </ul>
        </section>
      ) : null}
      {scheduledItems.length > 0 ? (
        <section
          className="fc-lib-queue-section"
          data-queue="scheduled"
          aria-label={translate('library.queue.scheduledTitle', {
            defaultValue: 'Review queue',
          })}
        >
          {/* 仅当上方存在收件箱时才需要显式的队列区头做视觉分界 */}
          {inboxItems.length > 0 ? (
            <div className="fc-lib-queue-head" data-queue="scheduled">
              <Stack size={14} weight="duotone" aria-hidden="true" />
              <span className="fc-lib-queue-title">
                {translate('library.queue.scheduledTitle', { defaultValue: 'Review queue' })}
              </span>
              <span className="fc-lib-queue-count font-mono tabular-nums">{scheduledItems.length}</span>
              {scheduledDueCount > 0 ? (
                <span className="fc-lib-queue-hint font-mono tabular-nums" data-tone="due">
                  {translate('library.queue.dueCount', {
                    count: scheduledDueCount,
                    defaultValue: '{{count}} due',
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
          <ul className="wb-fc-list-ul">
            {scheduledItems.map(renderCardRow)}
          </ul>
        </section>
      ) : null}
    </div>
  );

  const content = (
    <div className="wb-fc-screen fc-lib-screen">
      {!mobileChrome && <header className="wb-fc-header" data-align="end">
        <div className="fc-lib-heading min-w-0">
          <h2 className="wb-fc-title">
            {t('library.title')}
          </h2>
          <p className="wb-fc-subtitle font-mono tabular-nums">
            {loading
              ? t('library.loading')
              : totalLabel}
          </p>
        </div>
      </header>}

      <div className="wb-fc-toolbar">
        <LibrarySearchBar
          storeQuery={query}
          placeholder={t('library.searchPlaceholder')}
          searchLabel={t('library.searchLabel')}
          searchButtonText={t('library.search')}
          showSearchButton={!isSmallScreen}
          onSubmitSearch={handleSubmitSearch}
        />
        {!mobileChrome && <div className="fc-lib-create">{creationActions}</div>}
        {isSmallScreen && (
          <DsButton
            variant="ghost"
            size="icon"
            aria-label={translate('library.filter.label')}
            aria-expanded={filtersOpen}
            aria-controls={filtersId}
            onClick={() => setFiltersOpen((open) => !open)}
            className="relative min-h-[36px] min-w-[36px]"
          >
            <SlidersHorizontal size={18} />
            {statusFilter !== 'all' || deckFilter !== null || sortKey !== 'default' ? <span className="fc-lib-filter-dot" /> : null}
          </DsButton>
        )}
      </div>

      {apkgImportSummary ? (
        <section
          role="status"
          aria-label={translate('common:flashcards_import_banner.region_label', {
            defaultValue: 'Anki deck import summary',
          })}
          data-testid="fc-lib-apkg-import-summary"
          className="flex flex-col gap-3 rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3.5 text-sm shadow-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <CheckCircle
              size={20}
              weight="duotone"
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
            />
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold text-foreground">
                  {translate('common:flashcards_import_banner.title', { defaultValue: 'Deck imported' })}
                </span>
                <span
                  data-testid="fc-lib-apkg-summary-deck"
                  className="max-w-full truncate rounded-md border border-border/60 bg-background/80 px-2 py-0.5 text-xs font-medium text-foreground"
                >
                  {apkgImportSummary.deckName}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground">
                <span data-testid="fc-lib-apkg-summary-cards">
                  {translate('common:flashcards_import_banner.cards_count', {
                    count: apkgImportSummary.importedCards,
                    defaultValue: '{{count}} cards',
                  })}
                </span>
                {apkgImportSummary.reviewEnqueued > 0 ? (
                  <span>
                    {translate('common:flashcards_import_banner.queued_count', {
                      count: apkgImportSummary.reviewEnqueued,
                      defaultValue: '{{count}} added to review',
                    })}
                  </span>
                ) : null}
                {apkgImportSummary.mediaCount > 0 ? (
                  <span data-testid="fc-lib-apkg-summary-media">
                    {translate('common:flashcards_import_banner.media_count', {
                      count: apkgImportSummary.mediaCount,
                      defaultValue: '{{count}} media files',
                    })}
                  </span>
                ) : null}
                {apkgImportSummary.reviewWithHistory > 0 ? (
                  <span>
                    {translate('common:flashcards_import_banner.history_count', {
                      count: apkgImportSummary.reviewWithHistory,
                      defaultValue: '{{count}} kept review history',
                    })}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <DsButton
              type="button"
              variant="primary"
              size="sm"
              disabled={studyingImportedDeck}
              data-testid="fc-lib-apkg-summary-study"
              onClick={() => void handleStudyImportedDeck()}
              className="gap-1.5 text-xs"
            >
              <Play size={14} weight="fill" aria-hidden="true" />
              {studyingImportedDeck
                ? translate('common:flashcards_import_banner.starting_study', { defaultValue: 'Starting study…' })
                : translate('common:flashcards_import_banner.start_studying', { defaultValue: 'Start Studying Now' })}
            </DsButton>
            {apkgImportSummary.deckFilterPath !== null ? (
              <DsButton
                type="button"
                variant="default"
                size="sm"
                data-testid="fc-lib-apkg-summary-filter"
                onClick={handleFilterImportedDeck}
                className="gap-1.5 text-xs"
              >
                <Funnel size={14} aria-hidden="true" />
                {translate('common:flashcards_import_banner.filter_deck', {
                  defaultValue: 'Filter Deck in Library',
                })}
              </DsButton>
            ) : null}
            <DsButton
              type="button"
              variant="ghost"
              size="icon"
              data-testid="fc-lib-apkg-summary-dismiss"
              aria-label={translate('common:close', { defaultValue: 'Close' })}
              title={translate('common:close', { defaultValue: 'Close' })}
              onClick={() => setApkgImportSummary(null)}
            >
              <X size={16} aria-hidden="true" />
            </DsButton>
          </div>
        </section>
      ) : null}

      {importPanelMode ? (
        <div
          className="fc-lib-composer"
          data-testid="fc-lib-import-panel"
          role="region"
          aria-label={
            importPanelMode === 'apkg'
              ? translate('library.import.apkgPanelTitle', { defaultValue: 'Import Anki deck (.apkg)' })
              : translate('library.import.csvPanelTitle', { defaultValue: 'Import spreadsheet cards (.csv / .tsv)' })
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium text-foreground">
              {importPanelMode === 'apkg'
                ? translate('library.import.apkgPanelTitle', { defaultValue: 'Import Anki deck (.apkg)' })
                : translate('library.import.csvPanelTitle', { defaultValue: 'Import spreadsheet cards (.csv / .tsv)' })}
            </div>
            <DsButton
              type="button"
              variant="ghost"
              size="icon"
              aria-label={translate('common:close', { defaultValue: 'Close' })}
              onClick={() => {
                setPendingCsvImport(null);
                setImportPanelMode(null);
              }}
              data-testid="fc-lib-import-panel-close"
              className="min-h-[32px] min-w-[32px]"
            >
              <X size={16} />
            </DsButton>
          </div>

          {importPanelMode === 'csv' ? (
            <div className="space-y-1.5">
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
                <label
                  htmlFor="fc-lib-csv-target-deck-select"
                  className="shrink-0 text-xs font-medium text-muted-foreground"
                >
                  {translate('library.import.csvTargetDeckLabel', { defaultValue: 'Target deck' })}
                </label>
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  <select
                    id="fc-lib-csv-target-deck-select"
                    data-testid="fc-lib-csv-target-deck-select"
                    aria-label={translate('library.import.csvTargetDeckLabel', { defaultValue: 'Target deck' })}
                    value={
                      csvTargetDeck && namedDeckPaths.includes(csvTargetDeck)
                        ? csvTargetDeck
                        : csvTargetDeck
                          ? '__custom__'
                          : ''
                    }
                    onChange={(event) => {
                      const nextVal = event.target.value;
                      if (nextVal !== '__custom__') {
                        setCsvTargetDeck(nextVal);
                      }
                    }}
                    className="h-9 rounded-md border border-border bg-background px-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <option value="">
                      {translate('library.import.csvTargetDeckDefault', { defaultValue: 'Auto (use CSV deck column or current deck)' })}
                    </option>
                    {namedDeckPaths.map((deckPath) => (
                      <option key={deckPath} value={deckPath}>
                        {deckPath}
                      </option>
                    ))}
                    {csvTargetDeck && !namedDeckPaths.includes(csvTargetDeck) ? (
                      <option value="__custom__">{csvTargetDeck}</option>
                    ) : null}
                  </select>
                  <Input
                    type="text"
                    data-testid="fc-lib-csv-target-deck-input"
                    aria-label={translate('library.import.csvTargetDeckCustom', { defaultValue: 'Custom target deck name' })}
                    placeholder={translate('library.import.csvTargetDeckPlaceholder', {
                      defaultValue: 'Enter a new deck or leave blank to use selection above',
                    })}
                    value={csvTargetDeck}
                    onChange={(event) => setCsvTargetDeck(event.target.value)}
                    className="min-w-[200px] flex-1"
                  />
                </div>
              </div>
              <p
                data-testid="fc-lib-csv-target-summary"
                className="text-xs text-muted-foreground"
              >
                {csvTargetDeck.trim()
                  ? translate('library.import.csvTargetSummaryExplicit', {
                      deck: csvTargetDeck.trim(),
                      defaultValue: 'Cards without a deck column will be imported into “{{deck}}”.',
                    })
                  : deckFilter && deckFilter !== DECK_FILTER_ALL
                    ? translate('library.import.csvTargetSummaryFiltered', {
                        deck: deckFilter,
                        defaultValue: 'Currently viewing deck “{{deck}}”; cards without a deck column will go there (override above).',
                      })
                    : deckFilter === ''
                      ? translate('library.import.csvTargetSummaryUngrouped', {
                          defaultValue: 'Currently viewing “No deck”; cards without a deck column will be ungrouped unless you choose a deck above.',
                        })
                      : translate('library.import.csvTargetSummaryAll', {
                          defaultValue: 'Uses the CSV deck column when present; rows without one will be ungrouped.',
                        })}
              </p>
            </div>
          ) : null}

          <div
            onDragOver={(event) => {
              event.preventDefault();
              setImportDragActive(true);
            }}
            onDragLeave={() => setImportDragActive(false)}
            onDrop={handleImportDrop}
            data-testid="fc-lib-import-dropzone"
            className={cn(
              'flex flex-col items-start justify-between gap-3 rounded-xl border border-dashed p-4 transition-colors sm:flex-row sm:items-center',
              importDragActive
                ? 'border-primary bg-primary/5'
                : 'border-border/70 bg-muted/20',
            )}
          >
            <div className="space-y-1 text-xs text-muted-foreground">
              <p className="text-sm font-medium text-foreground">
                {importPanelMode === 'apkg'
                  ? translate('library.import.apkgDropHint', { defaultValue: 'Drop an .apkg file here, or choose a local file to import' })
                  : translate('library.import.csvDropHint', { defaultValue: 'Drop a .csv / .tsv file here, or choose a local file to import' })}
              </p>
              <p>
                {importPanelMode === 'apkg'
                  ? translate('library.import.hint')
                  : translate('library.import.csvHint')}
              </p>
              {importPanelMode === 'apkg' ? (
                <input
                  ref={apkgFileInputRef}
                  type="file"
                  accept=".apkg,application/octet-stream,application/zip"
                  data-testid="fc-lib-apkg-file-input"
                  aria-label={translate('library.import.apkg')}
                  disabled={importing}
                  onChange={handleApkgFileChange}
                  className="mt-2 block text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:border-border file:bg-background file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-foreground"
                />
              ) : (
                <input
                  ref={csvFileInputRef}
                  type="file"
                  accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
                  data-testid="fc-lib-csv-file-input"
                  aria-label={translate('library.import.csv')}
                  disabled={importing}
                  onChange={handleCsvFileChange}
                  className="mt-2 block text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:border-border file:bg-background file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-foreground"
                />
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <DsButton
                type="button"
                variant="primary"
                size="sm"
                disabled={importing}
                data-testid={importPanelMode === 'apkg' ? 'fc-lib-apkg-choose-btn' : 'fc-lib-csv-choose-btn'}
                onClick={() => {
                  if (importPanelMode === 'apkg') {
                    if (preferDomFileInput && apkgFileInputRef.current) {
                      apkgFileInputRef.current.click();
                    } else {
                      runImportApkg();
                    }
                  } else if (preferDomFileInput && csvFileInputRef.current) {
                    csvFileInputRef.current.click();
                  } else {
                    void pickCsvForPreview();
                  }
                }}
              >
                <UploadSimple size={16} />
                {importing
                  ? translate('library.import.running')
                  : importPanelMode === 'csv'
                    ? translate('library.import.chooseCsvFile', { defaultValue: 'Choose file to preview' })
                    : translate('library.import.chooseFile', { defaultValue: 'Choose file & import' })}
              </DsButton>
            </div>
          </div>

          {importPanelMode === 'csv' && pendingCsvImport ? (
            <div
              data-testid="fc-lib-csv-confirm-banner"
              className="flex flex-col gap-3 rounded-xl border border-primary/35 bg-primary/5 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1 text-xs">
                <p className="text-sm font-medium text-foreground">
                  {translate('library.import.csvConfirmHeading', {
                    fileName: pendingCsvImport.fileName,
                    count: pendingCsvImport.cardCount,
                    defaultValue: 'Confirm import of “{{fileName}}” ({{count}} cards)',
                  })}
                  {pendingCsvImport.skippedRows > 0
                    ? ` · ${translate('library.import.csvConfirmSkipped', {
                        skipped: pendingCsvImport.skippedRows,
                        defaultValue: 'Skipped {{skipped}} blank or invalid rows',
                      })}`
                    : ''}
                </p>
                <p className="text-muted-foreground">
                  {translate('library.import.csvConfirmTargetDecks', {
                    decks: pendingCsvDeckPreview
                      .map((item) => `${item.deck} (${item.count})`)
                      .join((i18n?.resolvedLanguage ?? i18n?.language ?? '').toLowerCase().startsWith('zh') ? '、' : ', '),
                    defaultValue: 'Target decks: {{decks}}',
                  })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <DsButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={importing}
                  data-testid="fc-lib-csv-cancel-btn"
                  onClick={() => setPendingCsvImport(null)}
                >
                  {translate('common:cancel', { defaultValue: 'Cancel' })}
                </DsButton>
                <DsButton
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={importing}
                  data-testid="fc-lib-csv-confirm-btn"
                  onClick={() => runImportCsv({
                    file: pendingCsvImport.file,
                    rawText: pendingCsvImport.rawText,
                  })}
                >
                  {importing
                    ? translate('library.import.running')
                    : translate('library.import.csvConfirmButton', {
                        count: pendingCsvImport.cardCount,
                        defaultValue: 'Confirm import ({{count}})',
                      })}
                </DsButton>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {composerOpen ? (
        <div className="fc-lib-composer">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              role="group"
              aria-label={translate('library.create.typeLabel', { defaultValue: 'Card type' })}
              className="inline-flex items-center rounded-lg border border-border/50 bg-muted/40 p-0.5"
            >
              <DsButton
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={draftMode === 'basic'}
                data-testid="fc-lib-create-mode-basic"
                onClick={() => setDraftMode('basic')}
                className={cn(
                  'min-h-[32px] rounded-md px-2.5 text-xs font-medium',
                  draftMode === 'basic'
                    ? 'bg-card text-foreground shadow-sm hover:bg-card'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {translate('library.create.typeBasic', { defaultValue: 'Basic (Q&A)' })}
              </DsButton>
              <DsButton
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={draftMode === 'cloze'}
                data-testid="fc-lib-create-mode-cloze"
                onClick={() => setDraftMode('cloze')}
                className={cn(
                  'min-h-[32px] rounded-md px-2.5 text-xs font-medium',
                  draftMode === 'cloze'
                    ? 'bg-card text-foreground shadow-sm hover:bg-card'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {translate('library.create.typeCloze', { defaultValue: 'Cloze deletion' })}
              </DsButton>
            </div>
            <DsButton
              type="button"
              variant="default"
              size="sm"
              data-testid="fc-lib-create-insert-cloze"
              onClick={() => handleInsertDraftCloze(desktopFrontRef.current)}
              className="min-h-[36px] gap-1.5 text-xs"
            >
              <BracketsCurly size={14} aria-hidden="true" />
              <span>
                {translate('library.create.insertCloze', { defaultValue: 'Insert cloze' })}
                {' '}
                <code className="font-mono">{`{{c${nextClozeIndex(draftFront)}::...}}`}</code>
              </span>
            </DsButton>
          </div>
          <Input
            ref={desktopFrontRef}
            aria-label={translate('library.create.frontLabel')}
            value={draftFront}
            onChange={(event) => setDraftFront(event.target.value)}
            placeholder={draftMode === 'cloze'
              ? translate('library.create.clozeFrontPlaceholder', { defaultValue: 'Enter text, highlight a key term, and click Insert cloze for {{c1::...}}' })
              : translate('library.create.frontPlaceholder')}
            className="h-10 text-base sm:text-sm [@media(pointer:coarse)]:!h-11"
          />
          {draftClozeInvalid ? (
            <p role="status" className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <Warning size={13} aria-hidden="true" />
              {t('session.invalidClozeEdit')}
            </p>
          ) : null}
          <Input
            aria-label={translate('library.create.backLabel')}
            value={draftBack}
            onChange={(event) => setDraftBack(event.target.value)}
            placeholder={draftMode === 'cloze'
              ? translate('library.create.clozeBackPlaceholder', { defaultValue: 'Explanation or source shown on back (optional)' })
              : translate('library.create.backPlaceholder')}
            className="h-10 text-base sm:text-sm [@media(pointer:coarse)]:!h-11"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Input
              aria-label={translate('library.editTags', { defaultValue: 'Tags (comma separated)' })}
              value={draftTags}
              onChange={(event) => setDraftTags(event.target.value)}
              placeholder={translate('library.create.tagsPlaceholder', { defaultValue: 'e.g. Calculus, Key concept' })}
              className="h-10 text-base sm:text-sm [@media(pointer:coarse)]:!h-11"
              data-testid="fc-lib-create-tags"
            />
            <Input
              aria-label={translate('library.create.deckLabel')}
              value={draftDeck}
              onChange={(event) => setDraftDeck(event.target.value)}
              list={`${filtersId}-deck-suggestions`}
              placeholder={translate('library.create.deckPlaceholder')}
              className="h-10 text-base sm:text-sm [@media(pointer:coarse)]:!h-11"
              data-testid="fc-lib-create-deck"
            />
            <select
              aria-label={translate('library.create.templateLabel', { defaultValue: 'Card template' })}
              value={draftTemplateId}
              onChange={(event) => setDraftTemplateId(event.target.value)}
              className="h-10 rounded-md border border-border/60 bg-background px-2.5 text-sm text-foreground [@media(pointer:coarse)]:!h-11"
              data-testid="fc-lib-create-template"
            >
              <option value="">
                {translate('library.create.defaultTemplateOption', { defaultValue: 'Default standard template' })}
              </option>
              {customTemplates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
            </select>
          </div>
          <datalist id={`${filtersId}-deck-suggestions`}>
            {namedDeckPaths.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
          <div className="fc-lib-composer-actions">
            <DsButton
              type="button"
              variant="primary"
              disabled={!draftValid || creating}
              onClick={handleSubmitDraft}
              title={draftValid ? undefined : translate('library.create.incomplete')}
              className="fc-lib-create-cta text-sm"
            >
              {creating ? translate('library.create.saving') : translate('library.create.save')}
            </DsButton>
            <DsButton
              type="button"
              variant="ghost"
              disabled={creating}
              onClick={closeComposer}
              className="text-sm"
            >
              {translate('common:cancel', { defaultValue: 'Cancel' })}
            </DsButton>
            <p className="fc-lib-composer-hint">{translate('library.create.hint')}</p>
          </div>
        </div>
      ) : null}

      <div id={filtersId} className="fc-lib-filters" hidden={isSmallScreen && !filtersOpen}>
        <div
          className="fc-lib-filters-group"
          role="group"
          aria-label={translate('library.filter.label')}
        >
          {FILTER_OPTIONS.map((option) => {
            const count = filterCounts.get(option) ?? 0;
            const dotTone =
              option === 'due'
                ? 'bg-emerald-500'
                : option === 'new'
                  ? 'bg-primary'
                  : option === 'learning'
                    ? 'bg-amber-500'
                    : null;
            return (
              <button
                key={option}
                type="button"
                className="fc-lib-chip active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
                data-active={statusFilter === option ? 'true' : undefined}
                aria-pressed={statusFilter === option}
                onClick={() => handleSetStatusFilter(option)}
              >
                {dotTone && count > 0 ? (
                  <span
                    aria-hidden="true"
                    className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotTone)}
                  />
                ) : null}
                {translate(`library.filter.${option}`)}
                {option !== 'all' && count > 0 ? (
                  <span className="fc-lib-chip-count font-mono tabular-nums">{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        {showDeckFilter ? (
          <div className="fc-lib-filters-group">
            <label className="fc-lib-filters-label" htmlFor={`${filtersId}-deck`}>
              {translate('library.deck.label')}
            </label>
            <span className="fc-lib-deck-select-wrap">
              <select
                id={`${filtersId}-deck`}
                className="fc-lib-deck-select"
                data-active={deckFilter !== null ? 'true' : undefined}
                value={deckFilter ?? DECK_FILTER_ALL}
                onChange={(event) => handleSetDeckFilter(
                  event.target.value === DECK_FILTER_ALL ? null : event.target.value,
                )}
              >
                <option value={DECK_FILTER_ALL}>{translate('library.deck.all')}</option>
                {deckOptions.map((node) => (
                  <option key={node.path || '::ungrouped'} value={node.path}>
                    {`${'\u3000'.repeat(node.depth)}${node.path ? node.label : translate('library.deck.ungrouped')} (${node.all})`}
                  </option>
                ))}
                {deckFilterMissing ? (
                  <option value={deckFilter ?? ''}>
                    {deckFilter || translate('library.deck.ungrouped')}
                  </option>
                ) : null}
              </select>
              <CaretDown size={10} className="fc-lib-deck-caret" aria-hidden="true" />
            </span>
          </div>
        ) : null}
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
                onClick={() => handleToggleSort(option)}
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
              onClick={handleClearSort}
              aria-label={translate('library.sort.reset')}
              title={translate('library.sort.reset')}
            >
              <X size={11} />
            </button>
          ) : null}
        </div>
        {isFiltered && scheduledItems.length > 0 ? (
          <DsButton
            type="button"
            variant="default"
            size="sm"
            disabled={rowBusy}
            onClick={() => {
              const playable = scheduledItems.filter((c) => !c.suspended && c.stateId);
              if (playable.length > 0) {
                saveLibraryViewState({
                  scrollTop: scrollViewportRef.current?.scrollTop ?? savedScrollTopRef.current,
                });
                setLibraryReturnOrigin('library');
                void startBatchSession(
                  playable.map((c) => c.id),
                  playable.map(toReviewContent),
                );
              }
            }}
            data-testid="fc-lib-review-filtered"
            className="text-xs [@media(pointer:coarse)]:!min-h-11"
          >
            <Play size={13} weight="fill" />
            {translate('library.reviewFiltered', {
              count: scheduledItems.filter((c) => !c.suspended && c.stateId).length,
              defaultValue: 'Review filtered ({{count}})',
            })}
          </DsButton>
        ) : null}
        {visibleItems.length !== items.length ? (
          <span className="fc-lib-result-count font-mono tabular-nums">
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
          <span className="fc-lib-bulkbar-count font-mono tabular-nums">
            {translate('library.selectedCount', { count: selectedCards.length })}
          </span>
          {reviewTargets.length > 0 ? (
            <DsButton
              type="button"
              variant="default"
              size="sm"
              disabled={rowBusy}
              onClick={handleBulkReview}
              className="text-xs [@media(pointer:coarse)]:!min-h-11"
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
              className="text-xs [@media(pointer:coarse)]:!min-h-11"
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
              className="text-xs [@media(pointer:coarse)]:!min-h-11"
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
              className="text-xs [@media(pointer:coarse)]:!min-h-11"
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
            className={
              bulkDeleteArmed
                ? 'fc-lib-armed text-xs [@media(pointer:coarse)]:!min-h-11'
                : 'text-xs [@media(pointer:coarse)]:!min-h-11'
            }
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
            className="text-xs [@media(pointer:coarse)]:!min-h-11"
          >
            <X size={13} />
            {translate('library.clearSelection')}
          </DsButton>
      </UiPresence>

      {actionError ? (
        <div role="alert" className="wb-fc-banner flex items-center justify-between gap-3 text-destructive">
          <span className="min-w-0 break-words">{actionError}</span>
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearActionError}
            className="[@media(pointer:coarse)]:!min-h-11"
          >
            {t('library.dismiss')}
          </DsButton>
        </div>
      ) : null}

      {isSmallScreen ? (
        <div className="wb-fc-list min-h-0 flex-1">{listBody}</div>
      ) : (
        <CustomScrollArea viewportRef={scrollViewportRef} className="wb-fc-list min-h-0 flex-1">
          {listBody}
        </CustomScrollArea>
      )}

      <footer
        aria-label={translate('library.pagination.label', { defaultValue: 'Pagination' })}
        className="fc-lib-pagination flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border/40 pt-2 text-xs text-muted-foreground"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="whitespace-nowrap font-mono tabular-nums">
            {translate('library.page', { page, pages: pageCount })}
          </span>
          <label className="inline-flex items-center gap-1.5">
            <span className="whitespace-nowrap">
              {translate('library.pageSize.label', { defaultValue: 'Per page' })}
            </span>
            <span className="relative inline-flex items-center">
              <select
                data-testid="library-page-size-select"
                aria-label={translate('library.pageSize.ariaLabel', { defaultValue: 'Cards per page' })}
                value={effectivePageSize}
                disabled={loading}
                onChange={(event) => {
                  const nextSize = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(nextSize)) {
                    React.startTransition(() => {
                      void handleSetPageSize(nextSize);
                    });
                  }
                }}
                className="fc-lib-page-size-select min-h-8 appearance-none rounded-md border border-border/60 bg-background pl-2.5 pr-6 font-mono text-xs tabular-nums text-foreground transition-colors hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
              >
                {FLASHCARDS_LIBRARY_PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {translate('library.pageSize.option', { count: size, defaultValue: '{{count}} cards' })}
                  </option>
                ))}
              </select>
              <CaretDown size={10} className="pointer-events-none absolute right-2 text-muted-foreground" aria-hidden="true" />
            </span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1">
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              iconOnly
              data-testid="library-page-first-btn"
              disabled={loading || page <= 1}
              onClick={() => void handleGoToPage(1)}
              aria-label={translate('library.firstPage', { defaultValue: 'First page' })}
              title={translate('library.firstPage', { defaultValue: 'First page' })}
              className="min-h-8 min-w-8 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
            >
              <CaretDoubleLeft size={14} aria-hidden="true" />
            </DsButton>
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              disabled={loading || page <= 1}
              onClick={() => void handleGoToPage(page - 1)}
              aria-label={t('library.previous')}
              className="min-h-8 [@media(pointer:coarse)]:!min-h-11"
            >
              <CaretLeft size={14} aria-hidden="true" />
              {t('library.previous')}
            </DsButton>
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              disabled={loading || page >= pageCount}
              onClick={() => void handleGoToPage(page + 1)}
              aria-label={t('library.next')}
              className="min-h-8 [@media(pointer:coarse)]:!min-h-11"
            >
              {t('library.next')}
              <CaretRight size={14} aria-hidden="true" />
            </DsButton>
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              iconOnly
              data-testid="library-page-last-btn"
              disabled={loading || page >= pageCount}
              onClick={() => void handleGoToPage(pageCount)}
              aria-label={translate('library.lastPage', { defaultValue: 'Last page' })}
              title={translate('library.lastPage', { defaultValue: 'Last page' })}
              className="min-h-8 min-w-8 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
            >
              <CaretDoubleRight size={14} aria-hidden="true" />
            </DsButton>
          </div>

          <form
            noValidate
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              handlePageJumpSubmit();
            }}
          >
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={pageCount}
              step={1}
              data-testid="library-page-jump-input"
              aria-label={translate('library.jumpPage.ariaLabel', { defaultValue: 'Jump to page' })}
              value={pageJumpInput}
              disabled={loading || pageCount <= 1}
              onChange={(event) => setPageJumpInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (!isComposingKeyEvent(event)) {
                    handlePageJumpSubmit();
                  }
                }
              }}
              className="fc-lib-page-jump-input min-h-8 w-14 rounded-md border border-border/60 bg-background px-2 text-center font-mono text-xs tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:w-16"
            />
            <DsButton
              type="submit"
              variant="default"
              size="sm"
              data-testid="library-page-jump-btn"
              disabled={loading || pageCount <= 1}
              className="min-h-8 px-2.5 text-xs [@media(pointer:coarse)]:!min-h-11"
            >
              {translate('library.jumpPage.go', { defaultValue: 'Go' })}
            </DsButton>
          </form>
        </div>
      </footer>
    </div>
  );
  return isSmallScreen ? <CustomScrollArea viewportRef={scrollViewportRef}>{content}</CustomScrollArea> : content;
};
