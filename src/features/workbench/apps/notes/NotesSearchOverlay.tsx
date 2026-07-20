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
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { highlightRanges } from './highlightRanges';
import {
  nodeMatchesTags,
  parseTagQuery,
  removeTagFromQuery,
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

function getQuickOpenResults(
  resources: readonly DstuNode[],
  allowedTypes: ReadonlySet<DstuNodeType>,
  query: string,
  maxResults: number,
): DstuNode[] {
  const seen = new Set<string>();
  const ranked: RankedResource[] = [];
  const normalizedQuery = normalized(query);

  for (const resource of resources) {
    if (!allowedTypes.has(resource.type)) continue;
    if (seen.has(resourceKey(resource))) continue;
    const rank = matchesQuickOpen(resource, normalizedQuery);
    if (rank === null) continue;
    seen.add(resourceKey(resource));
    ranked.push({ resource, rank });
  }

  return ranked
    .sort((left, right) => (
      left.rank - right.rank
      || right.resource.updatedAt - left.resource.updatedAt
      || left.resource.name.localeCompare(right.resource.name)
    ))
    .slice(0, maxResults)
    .map(({ resource }) => resource);
}

function getAllowedFullTextResults(
  resources: readonly DstuNode[],
  allowedTypes: ReadonlySet<DstuNodeType>,
  maxResults: number,
  requiredTags: readonly string[] = [],
): DstuNode[] {
  const seen = new Set<string>();
  const result: DstuNode[] = [];
  for (const resource of resources) {
    if (!allowedTypes.has(resource.type)) continue;
    if (seen.has(resourceKey(resource))) continue;
    if (!nodeMatchesTags(resource.metadata, requiredTags)) continue;
    seen.add(resourceKey(resource));
    result.push(resource);
    if (result.length >= maxResults) break;
  }
  return result;
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
  const visibleResultLimit = Math.max(1, Math.floor(maxResults));
  const allowedTypes = useMemo(() => new Set(resourceTypes), [resourceTypes]);

  const parsedQuery = useMemo(() => parseTagQuery(query), [query]);
  const highlightQuery = parsedQuery.textQuery;
  const activeFilterTags = parsedQuery.tags;
  const quickOpenFilterText = highlightQuery;

  // Empty-query quick open leads with the recently opened group; a typed
  // query switches back to pure relevance ranking over the whole library.
  const { results: quickOpenResults, recentCount } = useMemo(() => {
    const base = getQuickOpenResults(resources, allowedTypes, quickOpenFilterText, visibleResultLimit);
    if (quickOpenFilterText || !recentResources?.length) {
      return { results: base, recentCount: 0 };
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
    if (recents.length === 0) return { results: base, recentCount: 0 };
    const rest = base.filter((resource) => !seen.has(resourceKey(resource)));
    return {
      results: [...recents, ...rest].slice(0, visibleResultLimit),
      recentCount: Math.min(recents.length, visibleResultLimit),
    };
  }, [allowedTypes, quickOpenFilterText, recentResources, resources, visibleResultLimit]);
  const displayedResults = activeMode === 'quick-open' ? quickOpenResults : fullTextResults;
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

  const removeActiveTag = useCallback((tag: string) => {
    setQuery((current) => removeTagFromQuery(current, tag));
    setOpenError(null);
  }, []);

  useEffect(() => {
    const opened = open && !wasOpenRef.current;
    if (opened) {
      if (mode === undefined) setUncontrolledMode(initialMode);
      setQuery(initialQuery);
      setFullTextResults([]);
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
  }, [activeMode, query]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, displayedResults.length - 1)));
  }, [displayedResults.length]);

  useEffect(() => {
    if (!open || activeMode !== 'full-text') {
      searchSequenceRef.current += 1;
      setFullTextResults([]);
      setSearchError(null);
      setIsSearching(false);
      return undefined;
    }

    const { textQuery, tags: queryTags } = parseTagQuery(query);
    const hasSearchIntent = Boolean(textQuery.trim() || queryTags.length > 0);
    const sequence = ++searchSequenceRef.current;
    if (!hasSearchIntent) {
      setFullTextResults([]);
      setSearchError(null);
      setIsSearching(false);
      return undefined;
    }

    setIsSearching(true);
    setSearchError(null);
    // Do not leave an old query actionable while the next request is pending.
    setFullTextResults([]);
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
            types: [...resourceTypes],
            limit: fetchLimit,
          });
          if (sequence !== searchSequenceRef.current) return;
          if (!result.ok) {
            setFullTextResults([]);
            setSearchError(getErrorMessage(
              result.error,
              t('notesWorkspace.searchOverlay.searchFailed', 'Could not search notes.'),
            ));
            return;
          }
          setFullTextResults(getAllowedFullTextResults(
            result.value,
            allowedTypes,
            visibleResultLimit,
            filterTags,
          ));
        } catch (error) {
          if (sequence !== searchSequenceRef.current) return;
          setFullTextResults([]);
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
      onCloseRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [open]);

  if (!open) return null;

  const searchTitle = t('notesWorkspace.searchOverlay.title', 'Search notes');
  const quickOpenLabel = t('notesWorkspace.searchOverlay.quickOpen', 'Quick open');
  const fullTextLabel = t('notesWorkspace.searchOverlay.fullText', 'Search content');
  const placeholder = activeMode === 'quick-open'
    ? t('notesWorkspace.searchOverlay.quickOpenPlaceholder', 'Filter openable files...')
    : t('notesWorkspace.searchOverlay.fullTextPlaceholder', 'Search note contents...');
  const hasSearchIntent = Boolean(highlightQuery.trim() || activeFilterTags.length > 0);
  const tagHint = t('notesWorkspace.searchOverlay.tagHint', 'tag:name filters by tag');

  return (
    // 顶部居中悬浮命令条（无 backdrop / 无 aria-modal；点击外部、Esc、关闭按钮均可退出）
    <div
      ref={rootRef}
      className={cn('notes-search-overlay', 'ui-drop-in', className)}
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

      {activeFilterTags.length > 0 && (
        <div
          className="notes-search-overlay-active-tags"
          data-notes-search-active-tags
          aria-label={t('workbench:notesWorkspace.searchOverlay.activeTags')}
        >
          <span className="notes-search-overlay-active-tags-label">
            {t('workbench:notesWorkspace.searchOverlay.activeTags')}
          </span>
          {activeFilterTags.map((tag) => (
            <span key={tag} className="notes-search-overlay-active-tag">
              <span className="notes-search-overlay-active-tag-name">{tag}</span>
              <button
                type="button"
                className="notes-search-overlay-active-tag-remove"
                onClick={() => removeActiveTag(tag)}
                aria-label={t('workbench:notesWorkspace.searchOverlay.removeTag', { tag })}
                title={t('workbench:notesWorkspace.searchOverlay.removeTag', { tag })}
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
            {t('notesWorkspace.searchOverlay.resultCount', {
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
