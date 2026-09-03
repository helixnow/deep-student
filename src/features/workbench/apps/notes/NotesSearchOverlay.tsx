import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CaretRight, CircleNotch, FileText, MagnifyingGlass, TreeStructure, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { dstu, type DstuListOptions, type DstuNode, type DstuNodeType } from '@/dstu';
import { cn } from '@/lib/utils';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { readCssDurationMs, useMotionPresence } from '@/hooks/useMotionPresence';
import { setWorkbenchDragData } from '../../hooks/useDesktopDrop';
import { highlightRanges } from './highlightRanges';
import {
  nodeMatchesProps,
  nodeMatchesTags,
  parseSearchOperators,
  pathMatchesFilters,
  removeOperatorFromQuery,
  type ParsedPropFilter,
} from './parseTagQuery';
import './NotesSearchOverlay.css';
import './NotesSearchHighlight.css';

export type NotesSearchMode = 'quick-open' | 'full-text';

const DEFAULT_RESOURCE_TYPES: readonly DstuNodeType[] = ['note', 'mindmap'];
const DEFAULT_MAX_RESULTS = 24;
const DEFAULT_DEBOUNCE_MS = 180;
/** How many "recently opened" rows lead the empty-query quick-open list. */
export const QUICK_OPEN_RECENT_LIMIT = 8;

export interface NotesSearchOverlayProps {
  /** Whether the floating search palette is currently visible. */
  open: boolean;
  /**
   * The current workspace resources. Quick open searches this in-memory list,
   * so it remains responsive even while the filesystem is refreshing.
   */
  resources: readonly DstuNode[];
  /**
   * Most-recently-opened resources (newest first). When provided, an
   * empty-query quick open leads with a "Recently opened" group, like the
   * cmd+P recents list in editors.
   */
  recentResources?: readonly DstuNode[];
  /** Called after a result is chosen. Resolve when the resource has been opened. */
  onOpenResource: (
    resource: DstuNode,
    context: { mode: NotesSearchMode; query: string },
  ) => void | Promise<void>;
  /** Closes the overlay. */
  onClose: () => void;
  /** Optional controlled search mode. */
  mode?: NotesSearchMode;
  /** Mode used each time an uncontrolled overlay is opened. */
  initialMode?: NotesSearchMode;
  /** Receives user-initiated mode changes, including uncontrolled ones. */
  onModeChange?: (mode: NotesSearchMode) => void;
  /** Query used each time the overlay is opened. */
  initialQuery?: string;
  /** Resource types allowed in both quick-open and full-text results. */
  resourceTypes?: readonly DstuNodeType[];
  /** Extra DSTU search constraints, such as a folder filter. Types and limit stay owned here. */
  searchOptions?: Omit<DstuListOptions, 'types' | 'limit'>;
  /** Maximum number of visible results. */
  maxResults?: number;
  /** Full-text request debounce interval. Set to zero for immediate search. */
  searchDebounceMs?: number;
  className?: string;
}

interface RankedResource {
  resource: DstuNode;
  rank: number;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function resourceKey(resource: DstuNode): string {
  return `${resource.type}:${resource.id}`;
}

function pathSegments(resource: DstuNode): string[] {
  const segments = resource.path.split('/').filter(Boolean);
  if (segments.at(-1) === resource.id) segments.pop();
  return segments;
}

function pathLabel(resource: DstuNode): string {
  const segments = pathSegments(resource);
  return segments.length > 0 ? segments.join(' / ') : '/';
}

function matchesQuickOpen(resource: DstuNode, query: string): number | null {
  if (!query) return 4;
  const name = normalized(resource.name);
  const path = normalized(pathLabel(resource));
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (path.includes(query)) return 3;
  return null;
}

/** `path:` 匹配的干草堆：文件夹路径 + 资源名（用户视角的完整路径）。 */
function resourcePathHaystack(resource: DstuNode): string {
  return [...pathSegments(resource), resource.name].join('/');
}

interface OperatorFilters {
  tags: readonly string[];
  paths: readonly string[];
  props: readonly ParsedPropFilter[];
}

function resourceMatchesOperators(resource: DstuNode, filters: OperatorFilters): boolean {
  return nodeMatchesTags(resource.metadata, filters.tags)
    && pathMatchesFilters(resourcePathHaystack(resource), filters.paths)
    && nodeMatchesProps(resource.metadata, filters.props);
}

interface LimitedResults {
  results: DstuNode[];
  /** True when matches beyond `maxResults` were dropped by the visible cap. */
  hasMore: boolean;
}

export function getQuickOpenResults(
  resources: readonly DstuNode[],
  allowedTypes: ReadonlySet<DstuNodeType>,
  query: string,
  maxResults: number,
  filters: OperatorFilters = { tags: [], paths: [], props: [] },
): LimitedResults {
  const seen = new Set<string>();
  const ranked: RankedResource[] = [];
  const normalizedQuery = normalized(query);

  for (const resource of resources) {
    if (!allowedTypes.has(resource.type)) continue;
    if (seen.has(resourceKey(resource))) continue;
    if (!resourceMatchesOperators(resource, filters)) continue;
    const rank = matchesQuickOpen(resource, normalizedQuery);
    if (rank === null) continue;
    seen.add(resourceKey(resource));
    ranked.push({ resource, rank });
  }

  const sorted = ranked
    .sort((left, right) => (
      left.rank - right.rank
      || right.resource.updatedAt - left.resource.updatedAt
      || left.resource.name.localeCompare(right.resource.name)
    ))
    .map(({ resource }) => resource);
  return {
    results: sorted.slice(0, maxResults),
    hasMore: sorted.length > maxResults,
  };
}

export function getAllowedFullTextResults(
  resources: readonly DstuNode[],
  allowedTypes: ReadonlySet<DstuNodeType>,
  maxResults: number,
  filters: OperatorFilters = { tags: [], paths: [], props: [] },
): LimitedResults {
  const seen = new Set<string>();
  const results: DstuNode[] = [];
  let hasMore = false;
  for (const resource of resources) {
    if (!allowedTypes.has(resource.type)) continue;
    if (seen.has(resourceKey(resource))) continue;
    if (!resourceMatchesOperators(resource, filters)) continue;
    seen.add(resourceKey(resource));
    if (results.length >= maxResults) {
      hasMore = true;
      break;
    }
    results.push(resource);
  }
  return { results, hasMore };
}

/** Remove optional FTS highlight markup before rendering a result snippet as text. */
export function stripNotesSearchSnippet(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/<\/?b>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/** Render text with `<mark class="nso-hl">` around query hits. */
export function renderHighlightedText(text: string, query: string): React.ReactNode {
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return text;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(
      <mark key={`hl-${index}-${range.start}`} className="nso-hl">
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'toUserMessage' in error) {
    const toUserMessage = (error as { toUserMessage?: unknown }).toUserMessage;
    if (typeof toUserMessage === 'function') {
      const message = toUserMessage.call(error);
      if (typeof message === 'string' && message.trim()) return message;
    }
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

const ResourceIcon: React.FC<{ type: DstuNodeType }> = ({ type }) => (
  type === 'mindmap'
    ? <TreeStructure size={16} aria-hidden="true" />
    : <FileText size={16} aria-hidden="true" />
);

export const NotesSearchOverlay: React.FC<NotesSearchOverlayProps> = ({
  open,
  resources,
  recentResources,
  onOpenResource,
  onClose,
  mode,
  initialMode = 'quick-open',
  onModeChange,
  initialQuery = '',
  resourceTypes = DEFAULT_RESOURCE_TYPES,
  searchOptions,
  maxResults = DEFAULT_MAX_RESULTS,
  searchDebounceMs = DEFAULT_DEBOUNCE_MS,
  className,
}) => {
  const { t } = useTranslation('workbench');
  const [uncontrolledMode, setUncontrolledMode] = useState<NotesSearchMode>(initialMode);
  const [query, setQuery] = useState(initialQuery);
  const [fullTextResults, setFullTextResults] = useState<DstuNode[]>([]);
  const [fullTextHasMore, setFullTextHasMore] = useState(false);
  const [pageCount, setPageCount] = useState(1);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const priorFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(open);
  const searchSequenceRef = useRef(0);
  const overlayId = useId();

  const activeMode = mode ?? uncontrolledMode;
  // 「加载更多」逐页抬高可见上限：24 条只是首屏预算而非硬顶
  const pageSize = Math.max(1, Math.floor(maxResults));
  const visibleResultLimit = pageSize * pageCount;
  const allowedTypes = useMemo(() => new Set(resourceTypes), [resourceTypes]);

  const parsedQuery = useMemo(() => parseSearchOperators(query), [query]);
  const highlightQuery = parsedQuery.textQuery;
  const activeFilterTags = parsedQuery.tags;
  const activeFilterPaths = parsedQuery.paths;
  const activeFilterProps = parsedQuery.props;
  const hasOperatorFilters = activeFilterTags.length > 0
    || activeFilterPaths.length > 0
    || activeFilterProps.length > 0;
  const quickOpenFilterText = highlightQuery;

  // Empty-query quick open leads with the recently opened group; a typed
  // query switches back to pure relevance ranking over the whole library.
  const { results: quickOpenResults, recentCount, hasMore: quickOpenHasMore } = useMemo(() => {
    const filters: OperatorFilters = {
      tags: activeFilterTags,
      paths: activeFilterPaths,
      props: activeFilterProps,
    };
    const base = getQuickOpenResults(
      resources,
      allowedTypes,
      quickOpenFilterText,
      visibleResultLimit,
      filters,
    );
    if (quickOpenFilterText || hasOperatorFilters || !recentResources?.length) {
      return { results: base.results, recentCount: 0, hasMore: base.hasMore };
    }
    const seen = new Set<string>();
    const recents: DstuNode[] = [];
    for (const resource of recentResources) {
      if (!allowedTypes.has(resource.type)) continue;
      const key = resourceKey(resource);
      if (seen.has(key)) continue;
      seen.add(key);
      recents.push(resource);
      if (recents.length >= QUICK_OPEN_RECENT_LIMIT) break;
    }
    if (recents.length === 0) return { results: base.results, recentCount: 0, hasMore: base.hasMore };
    const rest = base.results.filter((resource) => !seen.has(resourceKey(resource)));
    const combined = [...recents, ...rest];
    return {
      results: combined.slice(0, visibleResultLimit),
      recentCount: Math.min(recents.length, visibleResultLimit),
      hasMore: base.hasMore || combined.length > visibleResultLimit,
    };
  }, [
    activeFilterPaths,
    activeFilterProps,
    activeFilterTags,
    allowedTypes,
    hasOperatorFilters,
    quickOpenFilterText,
    recentResources,
    resources,
    visibleResultLimit,
  ]);
  const displayedResults = activeMode === 'quick-open' ? quickOpenResults : fullTextResults;
  const hasMoreResults = activeMode === 'quick-open' ? quickOpenHasMore : fullTextHasMore;
  const showRecentGroups = activeMode === 'quick-open' && recentCount > 0;
  const hasResultList = displayedResults.length > 0 && !searchError && !openError;
  const listId = `${overlayId}-notes-search-results`;
  const activeResult = displayedResults[activeIndex] ?? null;
  const activeDescendantId = activeResult
    ? `${overlayId}-notes-search-result-${activeIndex}`
    : undefined;

  const setSearchMode = useCallback((nextMode: NotesSearchMode) => {
    if (mode === undefined) setUncontrolledMode(nextMode);
    onModeChange?.(nextMode);
  }, [mode, onModeChange]);

  const removeActiveOperator = useCallback((key: string, value: string) => {
    setQuery((current) => removeOperatorFromQuery(current, key, value));
    setOpenError(null);
  }, []);

  const loadMoreResults = useCallback(() => {
    setPageCount((current) => current + 1);
  }, []);

  useEffect(() => {
    const opened = open && !wasOpenRef.current;
    if (opened) {
      if (mode === undefined) setUncontrolledMode(initialMode);
      setQuery(initialQuery);
      setFullTextResults([]);
      setFullTextHasMore(false);
      setPageCount(1);
      setSearchError(null);
      setOpenError(null);
      setIsOpening(false);
      setActiveIndex(0);
    }
    if (!open && wasOpenRef.current) {
      searchSequenceRef.current += 1;
      setIsSearching(false);
    }
    wasOpenRef.current = open;
  }, [initialMode, initialQuery, mode, open]);

  useEffect(() => {
    if (!open) return undefined;
    priorFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => {
      try {
        inputRef.current?.focus({ preventScroll: true });
      } catch {
        inputRef.current?.focus();
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      const previous = priorFocusRef.current;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
    setPageCount(1);
  }, [activeMode, query]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, displayedResults.length - 1)));
  }, [displayedResults.length]);

  const lastFullTextKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || activeMode !== 'full-text') {
      searchSequenceRef.current += 1;
      lastFullTextKeyRef.current = null;
      setFullTextResults([]);
      setFullTextHasMore(false);
      setSearchError(null);
      setIsSearching(false);
      return undefined;
    }

    const { textQuery, tags: queryTags, paths: queryPaths, props: queryProps } = parseSearchOperators(query);
    const hasSearchIntent = Boolean(
      textQuery.trim() || queryTags.length > 0 || queryPaths.length > 0 || queryProps.length > 0,
    );
    const sequence = ++searchSequenceRef.current;
    if (!hasSearchIntent) {
      lastFullTextKeyRef.current = null;
      setFullTextResults([]);
      setFullTextHasMore(false);
      setSearchError(null);
      setIsSearching(false);
      return undefined;
    }

    setIsSearching(true);
    setSearchError(null);
    // Do not leave an old query actionable while the next request is pending.
    // 「加载更多」（仅可见页数变化）保留现有结果，避免列表闪空。
    const queryKey = query;
    if (lastFullTextKeyRef.current !== queryKey) {
      lastFullTextKeyRef.current = queryKey;
      setFullTextResults([]);
      setFullTextHasMore(false);
    }
    const fetchLimit = Math.max(visibleResultLimit * 3, 30);
    const searchText = textQuery.trim();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const optionTags = Array.isArray(searchOptions?.tags) ? searchOptions.tags : [];
          const filterTags = (() => {
            const seen = new Set<string>();
            const merged: string[] = [];
            for (const tag of [...optionTags, ...queryTags]) {
              const trimmed = tag.trim();
              if (!trimmed) continue;
              const key = trimmed.toLocaleLowerCase();
              if (seen.has(key)) continue;
              seen.add(key);
              merged.push(trimmed);
            }
            return merged;
          })();
          const result = await dstu.search(searchText, {
            ...searchOptions,
            ...(filterTags.length > 0 ? { tags: filterTags } : {}),
            ...(queryProps.length > 0 ? { propFilters: queryProps } : {}),
            types: [...resourceTypes],
            limit: fetchLimit,
          });
          if (sequence !== searchSequenceRef.current) return;
          if (!result.ok) {
            setFullTextResults([]);
            setFullTextHasMore(false);
            setSearchError(getErrorMessage(
              result.error,
              t('notesWorkspace.searchOverlay.searchFailed', 'Could not search notes.'),
            ));
            return;
          }
          const limited = getAllowedFullTextResults(
            result.value,
            allowedTypes,
            visibleResultLimit,
            { tags: filterTags, paths: queryPaths, props: queryProps },
          );
          setFullTextResults(limited.results);
          // 后端可能还有未取回的匹配：取满 fetchLimit 也视为「可能有更多」
          setFullTextHasMore(limited.hasMore || result.value.length >= fetchLimit);
        } catch (error) {
          if (sequence !== searchSequenceRef.current) return;
          setFullTextResults([]);
          setFullTextHasMore(false);
          setSearchError(getErrorMessage(
            error,
            t('notesWorkspace.searchOverlay.searchFailed', 'Could not search notes.'),
          ));
        } finally {
          if (sequence === searchSequenceRef.current) setIsSearching(false);
        }
      })();
    }, Math.max(0, searchDebounceMs));

    return () => window.clearTimeout(timer);
  }, [
    activeMode,
    allowedTypes,
    open,
    query,
    resourceTypes,
    searchAttempt,
    searchDebounceMs,
    searchOptions,
    t,
    visibleResultLimit,
  ]);

  useEffect(() => {
    if (!open || !activeResult) return;
    document.getElementById(activeDescendantId ?? '')?.scrollIntoView({ block: 'nearest' });
  }, [activeDescendantId, activeResult, open]);

  const openResult = useCallback(async (resource: DstuNode) => {
    if (isOpening) return;
    setIsOpening(true);
    setOpenError(null);
    try {
      await onOpenResource(resource, { mode: activeMode, query: highlightQuery });
      // `onClose` normally unmounts the overlay. Clear this first so a host
      // that deliberately keeps it mounted does not leave every result disabled.
      setIsOpening(false);
      onClose();
    } catch (error) {
      setOpenError(getErrorMessage(
        error,
        t('notesWorkspace.searchOverlay.openFailed', 'Could not open this resource.'),
      ));
      setIsOpening(false);
    }
  }, [activeMode, highlightQuery, isOpening, onClose, onOpenResource, t]);

  const moveActiveResult = useCallback((direction: 1 | -1) => {
    if (displayedResults.length === 0) return;
    setActiveIndex((current) => (
      (current + direction + displayedResults.length) % displayedResults.length
    ));
  }, [displayedResults.length]);

  const onInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      moveActiveResult(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      moveActiveResult(-1);
      return;
    }
    if (event.key === 'Enter' && activeResult) {
      event.preventDefault();
      event.stopPropagation();
      void openResult(activeResult);
    }
  }, [activeResult, moveActiveResult, openResult]);

  // 无遮罩悬浮面板：不做 Tab 焦点陷阱，仅保留 Escape 关闭与 Ctrl+Tab 切模式
  const onPanelKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Tab' && event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      setSearchMode(activeMode === 'quick-open' ? 'full-text' : 'quick-open');
    }
  }, [activeMode, onClose, setSearchMode]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Obsidian 1.12「Quick switcher: dragging results」对位：结果行可拖出
  // 面板（拖到桌面开窗等），负载复用 O19 的 WB_RESOURCE_MIME 协议，
  // 与 files 列表拖源、桌面落点桥（desktopDragBridge）同构。
  const onResultDragStart = useCallback((
    event: React.DragEvent<HTMLButtonElement>,
    resource: DstuNode,
  ) => {
    try {
      setWorkbenchDragData(event.dataTransfer, {
        resourceId: resource.id,
        resourceType: resource.type,
        title: resource.name,
      });
    } catch {
      // 异常负载（如空标题）：取消本次拖拽，点击打开路径不受影响
      event.preventDefault();
    }
  }, []);

  const onResultDragEnd = useCallback((event: React.DragEvent<HTMLButtonElement>) => {
    // 落点接收（dropEffect 非 none）说明资源已在别处打开，随手关掉面板；
    // 拖拽被取消（Esc / 拖回面板）时保持面板打开，用户可继续检索
    const effect = event.dataTransfer?.dropEffect;
    if (effect && effect !== 'none') onCloseRef.current();
  }, []);

  // 点击面板外任意位置关闭（无遮罩形态下的轻量 dismiss）
  const onOutsidePointerDown = useCallback((event: Event) => {
    const root = rootRef.current;
    if (!root) return;
    if (event.target instanceof Node && root.contains(event.target)) return;
    onCloseRef.current();
  }, []);
  useEventRegistry(
    open
      ? [{ target: 'document', type: 'pointerdown', listener: onOutsidePointerDown, options: true }]
      : [],
    [onOutsidePointerDown, open],
  );

  // Android 返回键：先关搜索面板，不退出笔记工作区
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => {
      // 保活守卫：隐藏工作台里的笔记窗口仍保持挂载，open 态也随之滞留——
      // 此时不消费返回键、不误关搜索面板，交还给当前活跃视图
      // （对照 NotesWorkspaceApp explorer handler 的同款守卫）
      const el = rootRef.current;
      if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
      if (window.getComputedStyle(el).visibility === 'hidden') return false;
      onCloseRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [open]);

  const presence = useMotionPresence(open, {
    exitMs: readCssDurationMs('--dropdown-close-dur', 150),
    enter: 'animation',
  });

  if (!presence.mounted) return null;

  const searchTitle = t('notesWorkspace.searchOverlay.title', 'Search notes');
  const quickOpenLabel = t('notesWorkspace.searchOverlay.quickOpen', 'Quick open');
  const fullTextLabel = t('notesWorkspace.searchOverlay.fullText', 'Search content');
  const placeholder = activeMode === 'quick-open'
    ? t('notesWorkspace.searchOverlay.quickOpenPlaceholder', 'Filter openable files...')
    : t('notesWorkspace.searchOverlay.fullTextPlaceholder', 'Search note contents...');
  const hasSearchIntent = Boolean(highlightQuery.trim() || hasOperatorFilters);
  const tagHint = t('notesWorkspace.searchOverlay.tagHint', 'tag: path: key:value filter results');
  const activeOperatorChips: Array<{ key: string; value: string; label: string }> = [
    ...activeFilterTags.map((tag) => ({ key: 'tag', value: tag, label: `tag:${tag}` })),
    ...activeFilterPaths.map((path) => ({ key: 'path', value: path, label: `path:${path}` })),
    ...activeFilterProps.map(({ key, value }) => ({ key, value, label: `${key}:${value}` })),
  ];

  return (
    // 顶部居中悬浮命令条（无 backdrop / 无 aria-modal；点击外部、Esc、关闭按钮均可退出）
    <div
      ref={rootRef}
      className={cn('notes-search-overlay', presence.exiting ? 'ui-drop-out' : 'ui-drop-in', className)}
      data-state={presence.exiting ? 'closed' : 'open'}
      data-notes-search-overlay
      role="region"
      aria-label={searchTitle}
      onKeyDown={onPanelKeyDown}
    >
      <div className="notes-search-overlay-input-wrap">
        <MagnifyingGlass size={17} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpenError(null);
          }}
          onKeyDown={onInputKeyDown}
          placeholder={placeholder}
          aria-label={searchTitle}
          aria-autocomplete="list"
          aria-controls={hasResultList ? listId : undefined}
          aria-expanded={hasResultList}
          aria-activedescendant={hasResultList ? activeDescendantId : undefined}
          autoComplete="off"
        />
        {query && (
          <button
            className="notes-search-overlay-clear"
            type="button"
            onClick={() => setQuery('')}
            aria-label={t('notesWorkspace.searchOverlay.clear', 'Clear search')}
            title={t('notesWorkspace.searchOverlay.clear', 'Clear search')}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
        <button
          className="notes-search-overlay-close"
          type="button"
          onClick={onClose}
          aria-label={t('notesWorkspace.searchOverlay.close', 'Close search')}
          title={t('notesWorkspace.searchOverlay.close', 'Close search')}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      {activeOperatorChips.length > 0 && (
        <div
          className="notes-search-overlay-active-tags"
          data-notes-search-active-tags
          aria-label={t('workbench:notesWorkspace.searchOverlay.activeTags')}
        >
          <span className="notes-search-overlay-active-tags-label">
            {t('workbench:notesWorkspace.searchOverlay.activeTags')}
          </span>
          {activeOperatorChips.map((chip) => (
            <span key={chip.label} className="notes-search-overlay-active-tag">
              <span className="notes-search-overlay-active-tag-name">
                {chip.key === 'tag' ? chip.value : chip.label}
              </span>
              <button
                type="button"
                className="notes-search-overlay-active-tag-remove"
                onClick={() => removeActiveOperator(chip.key, chip.value)}
                aria-label={t('workbench:notesWorkspace.searchOverlay.removeTag', {
                  tag: chip.key === 'tag' ? chip.value : chip.label,
                })}
                title={t('workbench:notesWorkspace.searchOverlay.removeTag', {
                  tag: chip.key === 'tag' ? chip.value : chip.label,
                })}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        className="notes-search-overlay-modes"
        role="group"
        aria-label={t('notesWorkspace.searchOverlay.modeLabel', 'Search mode')}
      >
        <button
          type="button"
          data-active={activeMode === 'quick-open' ? 'true' : undefined}
          aria-pressed={activeMode === 'quick-open'}
          onClick={() => setSearchMode('quick-open')}
        >
          {quickOpenLabel}
        </button>
        <button
          type="button"
          data-active={activeMode === 'full-text' ? 'true' : undefined}
          aria-pressed={activeMode === 'full-text'}
          onClick={() => setSearchMode('full-text')}
        >
          {fullTextLabel}
        </button>
        <span className="notes-search-overlay-taghint">
          <code>tag:</code>
          {' '}
          {tagHint}
        </span>
      </div>

      <div className="notes-search-overlay-results-wrap">
        <div className="notes-search-overlay-status" aria-live="polite">
          {isSearching && (
            <span>
              <CircleNotch className="notes-search-overlay-spinner" size={14} aria-hidden="true" />
              {t('notesWorkspace.searchOverlay.searching', 'Searching...')}
            </span>
          )}
          {!isSearching && activeMode === 'full-text' && !hasSearchIntent && (
            <span>{t('notesWorkspace.searchOverlay.enterQuery', 'Enter text to search note contents.')}</span>
          )}
        </div>

        {searchError ? (
          <div className="notes-search-overlay-message" role="alert">
            <span>{searchError}</span>
            <button type="button" onClick={() => setSearchAttempt((attempt) => attempt + 1)}>
              {t('notesWorkspace.searchOverlay.retry', 'Retry')}
            </button>
          </div>
        ) : openError ? (
          <div className="notes-search-overlay-message" role="alert">
            {openError}
          </div>
        ) : displayedResults.length > 0 ? (
          <CustomScrollArea
            className="notes-search-overlay-results-scroll"
            trackOffsetTop={6}
            trackOffsetBottom={8}
            trackOffsetRight={3}
          >
            <ul id={listId} className="notes-search-overlay-results" role="listbox" aria-label={searchTitle}>
              {displayedResults.map((resource, index) => {
                const snippet = activeMode === 'full-text'
                  ? stripNotesSearchSnippet(resource.metadata?.snippet)
                  : null;
                const selected = index === activeIndex;
                const crumbs = pathSegments(resource);
                const groupLabel = showRecentGroups && index === 0
                  ? t('notesWorkspace.searchOverlay.recentGroup', 'Recently opened')
                  : showRecentGroups && index === recentCount
                    ? t('notesWorkspace.searchOverlay.allGroup', 'All files')
                    : null;
                return (
                  <React.Fragment key={resourceKey(resource)}>
                    {groupLabel && (
                      <li role="presentation" className="notes-search-overlay-group" aria-hidden="true">
                        {groupLabel}
                      </li>
                    )}
                    <li role="presentation">
                      <button
                    id={`${overlayId}-notes-search-result-${index}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    className="notes-search-overlay-result"
                    aria-selected={selected}
                    data-active={selected ? 'true' : undefined}
                    data-notes-search-index={index}
                    disabled={isOpening}
                    draggable={!isOpening}
                    onDragStart={(event) => onResultDragStart(event, resource)}
                    onDragEnd={onResultDragEnd}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => void openResult(resource)}
                  >
                    <span className="notes-search-overlay-result-icon"><ResourceIcon type={resource.type} /></span>
                    <span className="notes-search-overlay-result-main">
                      <span className="notes-search-overlay-result-title">
                        {renderHighlightedText(resource.name, highlightQuery)}
                      </span>
                      <span className="notes-search-overlay-result-path" title={pathLabel(resource)}>
                        {crumbs.length === 0 ? (
                          <span className="notes-search-overlay-result-crumb">/</span>
                        ) : (
                          crumbs.map((segment, crumbIndex) => (
                            <React.Fragment key={`${crumbIndex}-${segment}`}>
                              {crumbIndex > 0 && (
                                <CaretRight
                                  size={9}
                                  className="notes-search-overlay-result-crumb-sep"
                                  aria-hidden="true"
                                />
                              )}
                              <span className="notes-search-overlay-result-crumb">{segment}</span>
                            </React.Fragment>
                          ))
                        )}
                      </span>
                      {snippet && (
                        <span className="notes-search-overlay-result-snippet">
                          {renderHighlightedText(snippet, highlightQuery)}
                        </span>
                      )}
                    </span>
                    <span className="notes-search-overlay-result-type">
                      {resource.type === 'mindmap'
                        ? t('notesWorkspace.searchOverlay.mindmap', 'Mind map')
                        : t('notesWorkspace.searchOverlay.note', 'Note')}
                    </span>
                      </button>
                    </li>
                  </React.Fragment>
                );
              })}
            </ul>
            {hasMoreResults && (
              <div className="notes-search-overlay-more">
                <button
                  type="button"
                  className="notes-search-overlay-load-more"
                  data-notes-search-load-more
                  disabled={isSearching}
                  onClick={loadMoreResults}
                >
                  {isSearching
                    ? t('notesWorkspace.searchOverlay.loadingMore', 'Loading more...')
                    : t('notesWorkspace.searchOverlay.loadMore', 'Load more results')}
                </button>
              </div>
            )}
          </CustomScrollArea>
        ) : isSearching ? (
          <div className="notes-search-overlay-skeleton" aria-hidden="true">
            {[0, 1, 2].map((row) => (
              <div key={row} className="notes-search-overlay-skeleton-row">
                <i className="notes-search-overlay-skeleton-icon" />
                <span className="notes-search-overlay-skeleton-copy">
                  <i className="notes-search-overlay-skeleton-bar" style={{ width: `${62 - row * 9}%` }} />
                  <i className="notes-search-overlay-skeleton-bar is-sub" style={{ width: `${38 - row * 5}%` }} />
                </span>
              </div>
            ))}
          </div>
        ) : activeMode === 'quick-open' || hasSearchIntent ? (
          <div className="notes-search-overlay-empty">
            <span>{t('notesWorkspace.searchOverlay.empty', 'No matching notes or mind maps.')}</span>
            <span className="notes-search-overlay-empty-hint">
              {activeMode === 'quick-open'
                ? t('notesWorkspace.searchOverlay.emptyQuickOpenHint', 'Try “Search content” for full-text matches.')
                : tagHint}
            </span>
          </div>
        ) : null}
      </div>

      <div className="notes-search-overlay-footer">
        <span>{t('notesWorkspace.searchOverlay.keyboardHint', 'Up/Down to select, Enter to open, Esc to close')}</span>
        {hasResultList && (
          <span>
            {hasMoreResults
              ? t('notesWorkspace.searchOverlay.resultCountMore', {
                count: displayedResults.length,
                defaultValue: '{{count}}+ results',
              })
              : t('notesWorkspace.searchOverlay.resultCount', {
                count: displayedResults.length,
                defaultValue: '{{count}} results',
              })}
          </span>
        )}
      </div>
    </div>
  );
};

export default NotesSearchOverlay;
