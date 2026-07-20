import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowClockwise,
  CaretDown,
  CaretRight,
  CircleNotch,
  FileText,
  LinkSimple,
  MagnifyingGlass,
  Plus,
  X,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { dstu, type DstuNode } from '@/dstu';
import {
  getWikiLinkRelationships,
  type UnresolvedWikiLink,
  type WikiLink,
  type WikiLinkRelationship,
  type WikiLinkRelationships,
} from '@/features/notes/wikilinks';
import {
  findUnlinkedMentions,
  UNLINKED_MENTION_MIN_TITLE_LENGTH,
  type UnlinkedMention,
} from '@/features/notes/unlinkedMentions';
import {
  backlinkRowToRelationship,
  fetchBacklinksFromBackend,
  type NoteBacklinkDto,
} from './backlinksBackend';
import { cn } from '@/lib/utils';
import './NotesBacklinksPanel.css';
import './notes-backlinks-extras.css';

type RelationshipsLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
    status: 'ready';
    relationships: WikiLinkRelationships;
    noteNodes: readonly DstuNode[];
    contentsByNoteId: ReadonlyMap<string, string>;
    incomingMayBeIncomplete: boolean;
    scannedCandidateCount: number;
    /** 'backend' = persistent note_links graph; 'client' = bounded search scan. */
    source: 'backend' | 'client';
  }
  | { status: 'error'; message: string };

interface CachedContent {
  version: string;
  content: string;
}

type SectionKey = 'outgoing' | 'incoming' | 'mentions' | 'unresolved';

interface SectionCollapseState {
  outgoing: boolean;
  incoming: boolean;
  mentions: boolean;
  unresolved: boolean;
}

interface UnlinkedMentionRow {
  node: DstuNode;
  mention: UnlinkedMention;
  content: string;
}

type MentionsLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; entries: readonly UnlinkedMentionRow[]; mayBeIncomplete: boolean }
  | { status: 'error'; message: string };

export const NOTE_CONTENT_LOAD_CONCURRENCY = 8;
/**
 * A backlink query may match a popular note thousands of times. The panel
 * deliberately loads a bounded candidate set instead of fetching every note
 * in the workspace on every save. "加载更多" raises the budget one page at a
 * time (see `candidateLimit`).
 */
export const BACKLINK_CANDIDATE_LIMIT = 256;
/**
 * Backend mode: how many backlink sources get their markdown fetched for
 * context snippets. Rows beyond this budget still render (title + open),
 * just without an inline excerpt.
 */
export const BACKEND_CONTEXT_SOURCE_LIMIT = 64;
export const UNLINKED_MENTION_CANDIDATE_LIMIT = 64;
const UNLINKED_MENTION_MAX_PER_NOTE = 3;
const BACKLINK_WATCH_REFRESH_DEBOUNCE_MS = 120;
const CONTEXT_RADIUS_DEFAULT = 80;
const CONTEXT_RADIUS_EXPANDED = 220;
const SECTION_COLLAPSE_STORAGE_KEY = 'notes-backlinks-panel:section-collapse';
const MORE_CONTEXT_STORAGE_KEY = 'notes-backlinks-panel:more-context';

const DEFAULT_SECTION_COLLAPSE: SectionCollapseState = {
  outgoing: false,
  incoming: false,
  mentions: false,
  unresolved: false,
};

export interface NotesBacklinksPanelProps {
  /** Whether the panel is rendered and allowed to fetch note content. */
  open: boolean;
  /** The note currently shown by the workspace, or null when no note is active. */
  activeResource: DstuNode | null;
  /** Note nodes available to the workspace. Non-note nodes are ignored defensively. */
  notes: readonly DstuNode[];
  /** Opens a resolved linked note in the owning workspace. */
  onOpenResource: (resource: DstuNode) => void | Promise<void>;
  /** Closes the panel without changing the active workspace resource. */
  onClose: () => void;
  /**
   * Creates a note from an unresolved wiki-link target title, then opens it.
   * Host owns real create/open logic. When omitted, create buttons are hidden.
   */
  onCreateFromUnresolved?: (title: string) => void | Promise<void>;
  /**
   * Optional host refresh hook after an optimistic create succeeds.
   * The panel also triggers its own internal data reload.
   */
  onRefresh?: () => void;
  /**
   * 统一右侧栏：提供时头部渲染「属性 / 链接」页签，属性页显示该内容。
   * 与笔记内嵌属性浮层互斥（宿主应同时隐藏内嵌浮层）。
   */
  propertiesContent?: React.ReactNode;
  requestedTab?: NotesBacklinksTabRequest | null;
  className?: string;
}

type PanelTab = 'properties' | 'links';

export interface NotesBacklinksTabRequest {
  tab: PanelTab;
  requestId: number;
}

const PANEL_TAB_STORAGE_KEY = 'notes-backlinks-panel:active-tab';

function readInitialPanelTab(): PanelTab {
  try {
    const raw = window.localStorage.getItem(PANEL_TAB_STORAGE_KEY);
    return raw === 'properties' || raw === 'links' ? raw : 'links';
  } catch {
    return 'links';
  }
}

export function useRequestedPanelTab(
  hasPropertiesTab: boolean,
  requestedTab: NotesBacklinksTabRequest | null | undefined,
): readonly [PanelTab, (tab: PanelTab) => void] {
  const [activeTab, setActiveTab] = useState<PanelTab>(readInitialPanelTab);
  useEffect(() => {
    if (requestedTab && (requestedTab.tab === 'links' || hasPropertiesTab)) {
      setActiveTab(requestedTab.tab);
    }
  }, [hasPropertiesTab, requestedTab?.requestId, requestedTab?.tab]);
  const switchTab = useCallback((tab: PanelTab) => {
    setActiveTab(tab);
    try {
      window.localStorage.setItem(PANEL_TAB_STORAGE_KEY, tab);
    } catch {
      // localStorage unavailable: retain the in-memory selection only.
    }
  }, []);
  return [activeTab, switchTab] as const;
}

export interface ContextSnippet {
  before: string;
  match: string;
  after: string;
  truncatedStart: boolean;
  truncatedEnd: boolean;
}

/** Extract ~radius chars around a wiki-link occurrence for backlink context. */
export function extractContextSnippet(
  content: string,
  start: number,
  end: number,
  radius: number,
): ContextSnippet | null {
  if (!content || start < 0 || end <= start || start >= content.length) return null;
  const safeEnd = Math.min(end, content.length);
  const sliceStart = Math.max(0, start - radius);
  const sliceEnd = Math.min(content.length, safeEnd + radius);
  return {
    before: content.slice(sliceStart, start).replace(/\s+/g, ' '),
    match: content.slice(start, safeEnd),
    after: content.slice(safeEnd, sliceEnd).replace(/\s+/g, ' '),
    truncatedStart: sliceStart > 0,
    truncatedEnd: sliceEnd < content.length,
  };
}

function compareNoteIds(left: DstuNode, right: DstuNode): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function collectNoteNodes(activeResource: DstuNode | null, notes: readonly DstuNode[]): DstuNode[] {
  const nodesById = new Map<string, DstuNode>();
  for (const node of notes) {
    if (node.type === 'note') nodesById.set(node.id, node);
  }
  if (activeResource?.type === 'note') nodesById.set(activeResource.id, activeResource);
  return Array.from(nodesById.values()).sort(compareNoteIds);
}

function cacheVersion(node: DstuNode): string {
  return `${node.path}\u0000${node.updatedAt}`;
}

function compareNotesByRecentUpdate(left: DstuNode, right: DstuNode): number {
  return right.updatedAt - left.updatedAt || compareNoteIds(left, right);
}

function backlinkSearchQueries(activeResource: DstuNode): string[] {
  const targets = new Set([activeResource.id, activeResource.name.trim()].filter(Boolean));
  const queries = new Set<string>();
  for (const target of targets) {
    // `parseWikiLinks` trims the target, so candidate discovery must include
    // the equivalent common space-padded forms. Keep these literals narrow:
    // a broad `[[${target}` prefix would also pull `[[Chapter 10]]` while
    // looking for `[[Chapter 1]]` and could exhaust the bounded candidate set.
    queries.add(`[[${target}]]`);
    queries.add(`[[${target}|`);
    queries.add(`[[${target}#`);
    queries.add(`[[${target} `);
    queries.add(`[[ ${target}]]`);
    queries.add(`[[ ${target}|`);
    queries.add(`[[ ${target}#`);
    queries.add(`[[ ${target} `);
  }
  // `@` mentions serialize to `[Title](note://id)`, so ID search is exact and
  // avoids the title-collision ambiguity of wiki-link candidate discovery.
  queries.add(`note://${activeResource.id}`);
  return [...queries];
}

async function findBacklinkCandidates(activeResource: DstuNode, candidateLimit: number): Promise<{
  nodes: DstuNode[];
  incomingMayBeIncomplete: boolean;
  scannedCandidateCount: number;
}> {
  const searchResultLimit = candidateLimit + 1;
  const searchResults = await Promise.all(backlinkSearchQueries(activeResource).map(async (query) => {
    const result = await dstu.search(query, {
      typeFilter: 'note',
      limit: searchResultLimit,
    });
    if (!result.ok) throw result.error;
    return result.value;
  }));

  const nodesById = new Map<string, DstuNode>();
  let incomingMayBeIncomplete = false;
  for (const result of searchResults) {
    // Asking for one more than the displayed budget lets us distinguish a
    // complete result from a query whose remaining matches were not fetched.
    if (result.length >= searchResultLimit) incomingMayBeIncomplete = true;
    for (const node of result) {
      if (node.type !== 'note' || node.id === activeResource.id) continue;
      nodesById.set(node.id, node);
    }
  }

  const nodes = Array.from(nodesById.values()).sort(compareNotesByRecentUpdate);
  if (nodes.length > candidateLimit) incomingMayBeIncomplete = true;
  const limited = nodes.slice(0, candidateLimit);
  return {
    nodes: limited,
    incomingMayBeIncomplete,
    scannedCandidateCount: limited.length,
  };
}

function mergeNoteNodes(
  knownNodes: readonly DstuNode[],
  candidateNodes: readonly DstuNode[],
): DstuNode[] {
  const nodesById = new Map(knownNodes.map((node) => [node.id, node]));
  for (const node of candidateNodes) nodesById.set(node.id, node);
  return Array.from(nodesById.values()).sort(compareNoteIds);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
  shouldContinue: () => boolean,
): Promise<R[]> {
  const results: R[] = [];
  const workerCount = Math.min(Math.max(1, limit), values.length);
  let nextIndex = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    while (!stopped && shouldContinue()) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index]);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
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

function relationshipDisplayTitle(
  relationship: WikiLinkRelationship,
  target: DstuNode,
  direction: 'inbound' | 'outbound',
): string {
  return direction === 'inbound' ? target.name : relationship.link.label || target.name;
}

function readSectionCollapseState(): SectionCollapseState {
  try {
    const raw = window.localStorage.getItem(SECTION_COLLAPSE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SECTION_COLLAPSE };
    const parsed = JSON.parse(raw) as Partial<SectionCollapseState>;
    return {
      outgoing: Boolean(parsed.outgoing),
      incoming: Boolean(parsed.incoming),
      mentions: Boolean(parsed.mentions),
      unresolved: Boolean(parsed.unresolved),
    };
  } catch {
    return { ...DEFAULT_SECTION_COLLAPSE };
  }
}

function writeSectionCollapseState(state: SectionCollapseState): void {
  try {
    window.localStorage.setItem(SECTION_COLLAPSE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota / private-mode failures.
  }
}

function readMoreContextPreference(): boolean {
  try {
    return window.localStorage.getItem(MORE_CONTEXT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMoreContextPreference(value: boolean): void {
  try {
    window.localStorage.setItem(MORE_CONTEXT_STORAGE_KEY, value ? '1' : '0');
  } catch {
    // Ignore quota / private-mode failures.
  }
}

/** Yield to the browser before sync wiki-link graph parsing (may touch 256 notes). */
function yieldForIdleWork(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(() => done(), { timeout: 120 });
      void idleId;
      return;
    }
    window.setTimeout(done, 0);
  });
}

/** Human-readable link text for context snippets, mirroring the editor view. */
export function wikiLinkDisplayText(link: WikiLink): string {
  return link.label?.trim() || link.target;
}

const ContextSnippetView: React.FC<{ snippet: ContextSnippet; matchDisplay?: string }> = ({
  snippet,
  matchDisplay,
}) => (
  <p className="notes-backlinks-panel-context">
    {snippet.truncatedStart && <span className="notes-backlinks-panel-context-ellipsis">…</span>}
    <span>{snippet.before}</span>
    <mark className="notes-backlinks-panel-context-mark">{matchDisplay ?? snippet.match}</mark>
    <span>{snippet.after}</span>
    {snippet.truncatedEnd && <span className="notes-backlinks-panel-context-ellipsis">…</span>}
  </p>
);

const LinkedNoteRow: React.FC<{
  relationship: WikiLinkRelationship;
  resource: DstuNode;
  direction: 'inbound' | 'outbound';
  disabled: boolean;
  onOpen: (resource: DstuNode) => void;
  openLabel: (title: string) => string;
  contextSnippet?: ContextSnippet | null;
}> = ({
  relationship,
  resource,
  direction,
  disabled,
  onOpen,
  openLabel,
  contextSnippet,
}) => {
  const displayTitle = relationshipDisplayTitle(relationship, resource, direction);
  const showsAlias = direction === 'outbound'
    && relationship.link.label
    && relationship.link.label !== resource.name;

  return (
    <li className="notes-backlinks-panel-link-row">
      <button
        type="button"
        className="notes-backlinks-panel-link"
        data-direction={direction}
        disabled={disabled}
        onClick={() => onOpen(resource)}
        aria-label={openLabel(resource.name)}
      >
        <FileText size={15} aria-hidden="true" />
        <span className="notes-backlinks-panel-link-copy">
          <span className="notes-backlinks-panel-link-title">{displayTitle}</span>
          {showsAlias && <span className="notes-backlinks-panel-link-name">{resource.name}</span>}
        </span>
      </button>
      {contextSnippet && (
        <ContextSnippetView
          snippet={contextSnippet}
          matchDisplay={wikiLinkDisplayText(relationship.link)}
        />
      )}
    </li>
  );
};

const UnlinkedMentionRowView: React.FC<{
  row: UnlinkedMentionRow;
  disabled: boolean;
  contextRadius: number;
  onOpen: (resource: DstuNode) => void;
  openLabel: (title: string) => string;
  convertLabel: (title: string) => string;
}> = ({ row, disabled, contextRadius, onOpen, openLabel, convertLabel }) => {
  const snippet = extractContextSnippet(
    row.content,
    row.mention.start,
    row.mention.end,
    contextRadius,
  );

  return (
    <li className="notes-backlinks-panel-link-row notes-backlinks-panel-mention-row">
      <div className="notes-backlinks-panel-mention-main">
        <button
          type="button"
          className="notes-backlinks-panel-link"
          data-direction="mention"
          disabled={disabled}
          onClick={() => onOpen(row.node)}
          aria-label={openLabel(row.node.name)}
        >
          <FileText size={15} aria-hidden="true" />
          <span className="notes-backlinks-panel-link-copy">
            <span className="notes-backlinks-panel-link-title">{row.node.name}</span>
          </span>
        </button>
        <button
          type="button"
          className="notes-backlinks-panel-create-button"
          disabled={disabled}
          onClick={() => onOpen(row.node)}
          aria-label={convertLabel(row.node.name)}
          title={convertLabel(row.node.name)}
        >
          <LinkSimple size={14} aria-hidden="true" />
        </button>
      </div>
      {snippet && <ContextSnippetView snippet={snippet} />}
    </li>
  );
};

const UnresolvedLinkRow: React.FC<{
  item: UnresolvedWikiLink;
  canCreate: boolean;
  creating: boolean;
  onCreate: (title: string) => void;
  createLabel: (title: string) => string;
}> = ({ item, canCreate, creating, onCreate, createLabel }) => {
  const title = item.link.target;

  return (
    <li className="notes-backlinks-panel-unresolved-row">
      <LinkSimple size={15} aria-hidden="true" />
      <code>{item.link.raw}</code>
      {canCreate && (
        <button
          type="button"
          className="notes-backlinks-panel-create-button"
          disabled={creating}
          onClick={() => onCreate(title)}
          aria-label={createLabel(title)}
          title={createLabel(title)}
        >
          {creating
            ? <CircleNotch className="notes-backlinks-panel-spinner" size={14} aria-hidden="true" />
            : <Plus size={14} aria-hidden="true" />}
        </button>
      )}
    </li>
  );
};

const EmptySection: React.FC<{
  icon: React.ReactNode;
  message: string;
}> = ({ icon, message }) => (
  <div className="notes-backlinks-panel-empty">
    {icon}
    <p>{message}</p>
  </div>
);

export const NotesBacklinksPanel: React.FC<NotesBacklinksPanelProps> = ({
  open,
  activeResource,
  notes,
  onOpenResource,
  onClose,
  onCreateFromUnresolved,
  onRefresh,
  propertiesContent,
  requestedTab,
  className,
}) => {
  const { t } = useTranslation('workbench');
  const hasPropertiesTab = propertiesContent !== undefined;
  const [activeTab, switchTab] = useRequestedPanelTab(hasPropertiesTab, requestedTab);
  const resolvedTab: PanelTab = hasPropertiesTab ? activeTab : 'links';
  const [loadState, setLoadState] = useState<RelationshipsLoadState>({ status: 'idle' });
  const [mentionsState, setMentionsState] = useState<MentionsLoadState>({ status: 'idle' });
  const [candidateLimit, setCandidateLimit] = useState(BACKLINK_CANDIDATE_LIMIT);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [openingResourceId, setOpeningResourceId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [creatingTitles, setCreatingTitles] = useState<ReadonlySet<string>>(() => new Set());
  const [resolvedCreatedTitles, setResolvedCreatedTitles] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sectionCollapse, setSectionCollapse] = useState<SectionCollapseState>(readSectionCollapseState);
  const [moreContext, setMoreContext] = useState(readMoreContextPreference);
  const contentCacheRef = useRef(new Map<string, CachedContent>());
  const loadSequenceRef = useRef(0);
  const mentionsSequenceRef = useRef(0);
  const watchRefreshTimerRef = useRef<number | null>(null);
  const creatingTitlesRef = useRef(new Set<string>());
  const titleId = useId();

  const noteNodes = useMemo(
    () => collectNoteNodes(activeResource, notes),
    [activeResource, notes],
  );
  const noteNodesById = useMemo(
    () => new Map(noteNodes.map((node) => [node.id, node])),
    [noteNodes],
  );
  const activeNoteId = activeResource?.type === 'note' ? activeResource.id : null;

  useEffect(() => {
    creatingTitlesRef.current = new Set();
    setCreatingTitles(new Set());
    setResolvedCreatedTitles(new Set());
    setCandidateLimit(BACKLINK_CANDIDATE_LIMIT);
  }, [activeNoteId]);

  useEffect(() => {
    if (!open) return undefined;

    const unwatch = dstu.watch('*', (event) => {
      if (event.type !== 'updated' || event.node?.type !== 'note') return;

      // NotesWorkspaceApp intentionally does not replace resource objects for
      // content-only saves. Invalidate this local cache from the event instead
      // so an open panel never keeps showing the previous markdown snapshot.
      contentCacheRef.current.delete(event.node.id);
      if (watchRefreshTimerRef.current !== null) {
        window.clearTimeout(watchRefreshTimerRef.current);
      }
      watchRefreshTimerRef.current = window.setTimeout(() => {
        watchRefreshTimerRef.current = null;
        setRefreshVersion((value) => value + 1);
      }, BACKLINK_WATCH_REFRESH_DEBOUNCE_MS);
    });

    return () => {
      unwatch();
      if (watchRefreshTimerRef.current !== null) {
        window.clearTimeout(watchRefreshTimerRef.current);
        watchRefreshTimerRef.current = null;
      }
    };
  }, [open]);

  useEffect(() => {
    const sequence = ++loadSequenceRef.current;
    if (!open || !activeNoteId) {
      setLoadState({ status: 'idle' });
      setOpenError(null);
      return undefined;
    }

    let disposed = false;
    const isCurrentLoad = () => !disposed && sequence === loadSequenceRef.current;
    setLoadState({ status: 'loading' });
    setOpenError(null);

    void (async () => {
      try {
        const activeNote = activeResource?.type === 'note' ? activeResource : null;
        if (!activeNote) return;

        const fetchContent = async (node: DstuNode) => {
          const version = cacheVersion(node);
          const cached = contentCacheRef.current.get(node.id);
          if (cached?.version === version) return [node.id, cached.content] as const;

          const result = await dstu.getContent(node.path);
          if (!result.ok) throw result.error;
          const content = typeof result.value === 'string'
            ? result.value
            : await result.value.text();
          if (isCurrentLoad()) contentCacheRef.current.set(node.id, { version, content });
          return [node.id, content] as const;
        };

        // Backend-first: the persistent note_links graph answers "who links
        // here" for the whole library in one query. Any failure (command
        // missing, VFS not configured) silently falls back to the legacy
        // bounded client scan below.
        let backendRows: NoteBacklinkDto[] | null = null;
        try {
          backendRows = await fetchBacklinksFromBackend(activeNote.id);
        } catch {
          backendRows = null;
        }
        if (!isCurrentLoad()) return;

        if (backendRows !== null) {
          const rows = backendRows
            .filter((row) => row.sourceId !== activeNote.id)
            .sort((left, right) => (
              (Date.parse(right.sourceUpdatedAt) || 0) - (Date.parse(left.sourceUpdatedAt) || 0)
              || (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0)
              || left.position - right.position
            ));

          const sourceNodes: DstuNode[] = [];
          const seenSources = new Set<string>();
          for (const row of rows) {
            if (seenSources.has(row.sourceId)) continue;
            seenSources.add(row.sourceId);
            sourceNodes.push(noteNodesById.get(row.sourceId) ?? {
              id: row.sourceId,
              sourceId: row.sourceId,
              path: `/${row.sourceId}`,
              name: row.sourceTitle,
              type: 'note',
              createdAt: 0,
              updatedAt: Date.parse(row.sourceUpdatedAt) || 0,
            });
          }

          const contentNodes = [activeNote, ...sourceNodes.slice(0, BACKEND_CONTEXT_SOURCE_LIMIT)];
          const contentEntries = await mapWithConcurrency(
            contentNodes,
            NOTE_CONTENT_LOAD_CONCURRENCY,
            fetchContent,
            isCurrentLoad,
          );
          if (!isCurrentLoad()) return;
          const contents = new Map(contentEntries);

          await yieldForIdleWork();
          if (!isCurrentLoad()) return;

          // Outgoing / unresolved links still come from parsing the ACTIVE
          // note's fresh markdown: a link typed moments ago must show up even
          // though DSTU content saves do not update the backend graph until
          // the next rebuild. Title resolution sees every known note.
          const relationshipNodes = mergeNoteNodes(noteNodes, sourceNodes);
          const clientGraph = getWikiLinkRelationships(new Map(
            relationshipNodes.map((node) => [node.id, {
              title: node.name,
              content: node.id === activeNote.id ? contents.get(node.id) ?? '' : '',
            }]),
          ));
          const inbound = rows.map((row) => backlinkRowToRelationship(
            row,
            activeNote.id,
            activeNote.name,
            contents.get(row.sourceId),
          ));
          setLoadState({
            status: 'ready',
            relationships: {
              outboundByNoteId: clientGraph.outboundByNoteId,
              inboundByNoteId: {
                ...clientGraph.inboundByNoteId,
                [activeNote.id]: inbound,
              },
              unresolved: clientGraph.unresolved,
            },
            noteNodes: relationshipNodes,
            contentsByNoteId: contents,
            incomingMayBeIncomplete: false,
            scannedCandidateCount: sourceNodes.length,
            source: 'backend',
          });
          return;
        }

        const {
          nodes: candidateNodes,
          incomingMayBeIncomplete,
          scannedCandidateCount,
        } = await findBacklinkCandidates(activeNote, candidateLimit);
        if (!isCurrentLoad()) return;

        // The resolver still receives every known note title/ID, but content
        // is fetched only for the active note and search-selected sources.
        // That keeps outgoing links exact without an O(all notes) content scan.
        const relationshipNodes = mergeNoteNodes(noteNodes, candidateNodes);
        const contentNodes = [activeNote, ...candidateNodes];
        const contentEntries = await mapWithConcurrency(
          contentNodes,
          NOTE_CONTENT_LOAD_CONCURRENCY,
          fetchContent,
          isCurrentLoad,
        );

        if (!isCurrentLoad()) return;
        const contents = new Map(contentEntries);

        // Sync graph build can touch hundreds of markdown strings — yield first
        // so the loading indicator can paint, then parse on an idle slice.
        await yieldForIdleWork();
        if (!isCurrentLoad()) return;

        const relationships = getWikiLinkRelationships(new Map(
          relationshipNodes.map((node) => [node.id, {
            title: node.name,
            content: contents.get(node.id) ?? '',
          }]),
        ));
        setLoadState({
          status: 'ready',
          relationships,
          noteNodes: relationshipNodes,
          contentsByNoteId: contents,
          incomingMayBeIncomplete,
          scannedCandidateCount,
          source: 'client',
        });
      } catch (error) {
        if (!isCurrentLoad()) return;
        setLoadState({
          status: 'error',
          message: getErrorMessage(
            error,
            t('notesWorkspace.backlinks.loadFailed'),
          ),
        });
      }
    })();

    return () => {
      disposed = true;
    };
  }, [activeNoteId, candidateLimit, noteNodes, noteNodesById, open, refreshVersion, t]);

  // Unlinked mentions: plain-text hits on the active title that no note has
  // linked yet. Runs after the relationship graph so linked sources can be
  // filtered out, and reuses the same content cache.
  useEffect(() => {
    const sequence = ++mentionsSequenceRef.current;
    const activeNote = activeResource?.type === 'note' ? activeResource : null;
    if (!open || !activeNote || loadState.status !== 'ready') {
      setMentionsState({ status: 'idle' });
      return undefined;
    }

    const title = activeNote.name.trim();
    if (title.length < UNLINKED_MENTION_MIN_TITLE_LENGTH) {
      setMentionsState({ status: 'ready', entries: [], mayBeIncomplete: false });
      return undefined;
    }

    let disposed = false;
    const isCurrentLoad = () => !disposed && sequence === mentionsSequenceRef.current;
    setMentionsState({ status: 'loading' });

    const linkedSourceIds = new Set(
      (loadState.relationships.inboundByNoteId[activeNote.id] ?? [])
        .map((relationship) => relationship.sourceId),
    );

    void (async () => {
      try {
        const result = await dstu.search(title, {
          typeFilter: 'note',
          limit: UNLINKED_MENTION_CANDIDATE_LIMIT + 1,
        });
        if (!result.ok) throw result.error;
        if (!isCurrentLoad()) return;

        const mayBeIncomplete = result.value.length > UNLINKED_MENTION_CANDIDATE_LIMIT;
        const candidates = result.value
          .filter((node) => node.type === 'note'
            && node.id !== activeNote.id
            && !linkedSourceIds.has(node.id))
          .sort(compareNotesByRecentUpdate)
          .slice(0, UNLINKED_MENTION_CANDIDATE_LIMIT);

        const contentEntries = await mapWithConcurrency(
          candidates,
          NOTE_CONTENT_LOAD_CONCURRENCY,
          async (node) => {
            const version = cacheVersion(node);
            const cached = contentCacheRef.current.get(node.id);
            if (cached?.version === version) return [node, cached.content] as const;

            const contentResult = await dstu.getContent(node.path);
            if (!contentResult.ok) throw contentResult.error;
            const content = typeof contentResult.value === 'string'
              ? contentResult.value
              : await contentResult.value.text();
            if (isCurrentLoad()) contentCacheRef.current.set(node.id, { version, content });
            return [node, content] as const;
          },
          isCurrentLoad,
        );
        if (!isCurrentLoad()) return;

        const entries: UnlinkedMentionRow[] = [];
        for (const [node, content] of contentEntries) {
          const mentions = findUnlinkedMentions(content, title, {
            maxMentions: UNLINKED_MENTION_MAX_PER_NOTE,
          });
          for (const mention of mentions) entries.push({ node, mention, content });
        }
        setMentionsState({ status: 'ready', entries, mayBeIncomplete });
      } catch (error) {
        if (!isCurrentLoad()) return;
        setMentionsState({
          status: 'error',
          message: getErrorMessage(
            error,
            t('notesWorkspace.backlinks.mentionsFailed', { defaultValue: '无法扫描未链接提及。' }),
          ),
        });
      }
    })();

    return () => {
      disposed = true;
    };
  }, [activeResource, loadState, open, t]);

  const loadMoreCandidates = useCallback(() => {
    setCandidateLimit((value) => value + BACKLINK_CANDIDATE_LIMIT);
  }, []);

  const refresh = useCallback(() => {
    contentCacheRef.current.clear();
    setRefreshVersion((value) => value + 1);
  }, []);

  const openLinkedResource = useCallback(async (resource: DstuNode) => {
    if (openingResourceId) return;
    setOpeningResourceId(resource.id);
    setOpenError(null);
    try {
      await onOpenResource(resource);
    } catch (error) {
      setOpenError(getErrorMessage(
        error,
        t('notesWorkspace.backlinks.openFailed'),
      ));
    } finally {
      setOpeningResourceId(null);
    }
  }, [onOpenResource, openingResourceId, t]);

  const createFromUnresolved = useCallback(async (title: string) => {
    if (!onCreateFromUnresolved || creatingTitlesRef.current.has(title)) return;
    creatingTitlesRef.current.add(title);
    setCreatingTitles(new Set(creatingTitlesRef.current));
    setOpenError(null);
    try {
      await onCreateFromUnresolved(title);
      setResolvedCreatedTitles((prev) => new Set(prev).add(title));
      refresh();
      onRefresh?.();
    } catch (error) {
      setOpenError(getErrorMessage(
        error,
        t('notesWorkspace.backlinks.createFailed'),
      ));
    } finally {
      creatingTitlesRef.current.delete(title);
      setCreatingTitles(new Set(creatingTitlesRef.current));
    }
  }, [onCreateFromUnresolved, onRefresh, refresh, t]);

  const toggleSection = useCallback((key: SectionKey) => {
    setSectionCollapse((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      writeSectionCollapseState(next);
      return next;
    });
  }, []);

  const toggleMoreContext = useCallback(() => {
    setMoreContext((prev) => {
      const next = !prev;
      writeMoreContextPreference(next);
      return next;
    });
  }, []);

  const onPanelKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    // 属性页内的输入控件（如标签输入）用 Esc 取消编辑，不应关闭整个面板
    const target = event.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }, [onClose]);

  if (!open) return null;

  const outgoing = loadState.status === 'ready'
    ? loadState.relationships.outboundByNoteId[activeNoteId ?? ''] ?? []
    : [];
  const incoming = loadState.status === 'ready'
    ? loadState.relationships.inboundByNoteId[activeNoteId ?? ''] ?? []
    : [];
  const unresolved = loadState.status === 'ready'
    ? loadState.relationships.unresolved
      .filter((item) => item.sourceId === activeNoteId)
      .filter((item) => !resolvedCreatedTitles.has(item.link.target))
    : [];
  const canShowLinks = Boolean(activeNoteId);
  const relationshipNodesById = loadState.status === 'ready'
    ? new Map(loadState.noteNodes.map((node) => [node.id, node]))
    : noteNodesById;
  const contentsByNoteId = loadState.status === 'ready'
    ? loadState.contentsByNoteId
    : null;
  const contextRadius = moreContext ? CONTEXT_RADIUS_EXPANDED : CONTEXT_RADIUS_DEFAULT;
  const panelTitle = t('notesWorkspace.backlinks.title');
  const openLinkedNoteLabel = (title: string) => t('notesWorkspace.backlinks.openLinkedNote', { title },);
  const createNoteLabel = (title: string) => t('notesWorkspace.backlinks.createFromUnresolved', { title },);
  const convertMentionLabel = (title: string) => t('notesWorkspace.backlinks.convertMention', {
    defaultValue: '在「{{title}}」中转为链接',
    title,
  });
  const canCreate = typeof onCreateFromUnresolved === 'function';

  const renderSectionHeader = (
    key: SectionKey,
    headingId: string,
    label: string,
    count: number,
  ) => {
    const collapsed = sectionCollapse[key];
    return (
      <h3 id={headingId}>
        <button
          type="button"
          className="notes-backlinks-panel-section-toggle"
          aria-expanded={!collapsed}
          aria-controls={`${headingId}-body`}
          onClick={() => toggleSection(key)}
        >
          <span className="notes-backlinks-panel-section-toggle-label">
            {collapsed
              ? <CaretRight size={12} aria-hidden="true" />
              : <CaretDown size={12} aria-hidden="true" />}
            {label}
          </span>
          <span className="notes-backlinks-panel-section-count">{count}</span>
        </button>
      </h3>
    );
  };

  return (
    <aside
      className={cn('notes-backlinks-panel', className)}
      data-notes-backlinks-panel
      role="complementary"
      {...(hasPropertiesTab
        ? { 'aria-label': t('notesWorkspace.backlinks.panelAria', { defaultValue: '笔记信息面板' }) }
        : { 'aria-labelledby': titleId })}
      onKeyDown={onPanelKeyDown}
    >
      <header className="notes-backlinks-panel-header">
        {hasPropertiesTab ? (
          <div
            className="notes-backlinks-panel-tabs"
            role="tablist"
            aria-label={t('notesWorkspace.backlinks.panelAria', { defaultValue: '笔记信息面板' })}
          >
            <button
              type="button"
              role="tab"
              id={`${titleId}-tab-properties`}
              className="notes-backlinks-panel-tab"
              aria-selected={resolvedTab === 'properties'}
              onClick={() => switchTab('properties')}
            >
              {t('notesWorkspace.backlinks.tabProperties', { defaultValue: '属性' })}
            </button>
            <button
              type="button"
              role="tab"
              id={`${titleId}-tab-links`}
              className="notes-backlinks-panel-tab"
              aria-selected={resolvedTab === 'links'}
              onClick={() => switchTab('links')}
            >
              {t('notesWorkspace.backlinks.tabLinks', { defaultValue: '链接' })}
            </button>
          </div>
        ) : (
          <div className="notes-backlinks-panel-heading">
            <h2 id={titleId}>{panelTitle}</h2>
            {activeResource?.type === 'note' && <span>{activeResource.name}</span>}
          </div>
        )}
        <div className="notes-backlinks-panel-actions">
          {resolvedTab === 'links' && (
            <button
              type="button"
              className="notes-backlinks-panel-icon-button"
              disabled={loadState.status === 'loading' || !canShowLinks}
              onClick={refresh}
              aria-label={t('notesWorkspace.backlinks.refresh')}
              title={t('notesWorkspace.backlinks.refresh')}
            >
              <ArrowClockwise size={15} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="notes-backlinks-panel-icon-button"
            onClick={onClose}
            aria-label={t('notesWorkspace.backlinks.close')}
            title={t('notesWorkspace.backlinks.close')}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      {hasPropertiesTab && activeResource?.type === 'note' && (
        <div className="notes-backlinks-panel-note" title={activeResource.name}>
          <FileText size={13} aria-hidden="true" />
          <span>{activeResource.name}</span>
        </div>
      )}

      {hasPropertiesTab && resolvedTab === 'properties' ? (
        <div
          className="notes-backlinks-panel-properties"
          role="tabpanel"
          aria-labelledby={`${titleId}-tab-properties`}
        >
          {propertiesContent}
        </div>
      ) : (
      <div
        className="notes-backlinks-panel-body"
        aria-live="polite"
        {...(hasPropertiesTab
          ? { role: 'tabpanel' as const, 'aria-labelledby': `${titleId}-tab-links` }
          : {})}
      >
        {!canShowLinks ? (
          <div className="notes-backlinks-panel-message">
            <FileText size={22} aria-hidden="true" />
            {t('notesWorkspace.backlinks.noActiveNote')}
          </div>
        ) : loadState.status === 'loading' ? (
          <div className="notes-backlinks-panel-message" role="status">
            <CircleNotch className="notes-backlinks-panel-spinner" size={16} aria-hidden="true" />
            {t('notesWorkspace.backlinks.loading')}
          </div>
        ) : loadState.status === 'error' ? (
          <div className="notes-backlinks-panel-message notes-backlinks-panel-message-error" role="alert">
            <span>{loadState.message}</span>
            <button type="button" onClick={refresh}>
              {t('notesWorkspace.backlinks.retry')}
            </button>
          </div>
        ) : (
          <>
            <section
              className={cn(
                'notes-backlinks-panel-section',
                sectionCollapse.outgoing && 'notes-backlinks-panel-section-collapsed',
              )}
              aria-labelledby={`${titleId}-outgoing`}
            >
              {renderSectionHeader(
                'outgoing',
                `${titleId}-outgoing`,
                t('notesWorkspace.backlinks.outgoing'),
                outgoing.length,
              )}
              <div
                id={`${titleId}-outgoing-body`}
                className="notes-backlinks-panel-section-body"
              >
                <div className="notes-backlinks-panel-section-body-inner">
                  {outgoing.length > 0 ? (
                    <ul>
                      {outgoing.map((relationship, index) => {
                        const resource = relationshipNodesById.get(relationship.targetId);
                        return resource ? (
                          <LinkedNoteRow
                            key={`${relationship.sourceId}:${relationship.link.start}:${index}`}
                            relationship={relationship}
                            resource={resource}
                            direction="outbound"
                            disabled={openingResourceId !== null}
                            onOpen={(node) => void openLinkedResource(node)}
                            openLabel={openLinkedNoteLabel}
                          />
                        ) : null;
                      })}
                    </ul>
                  ) : (
                    <EmptySection
                      icon={<LinkSimple size={18} aria-hidden="true" />}
                      message={t('notesWorkspace.backlinks.noOutgoing')}
                    />
                  )}
                </div>
              </div>
            </section>

            <section
              className={cn(
                'notes-backlinks-panel-section',
                sectionCollapse.incoming && 'notes-backlinks-panel-section-collapsed',
              )}
              data-more-context={moreContext ? 'true' : 'false'}
              aria-labelledby={`${titleId}-incoming`}
            >
              {renderSectionHeader(
                'incoming',
                `${titleId}-incoming`,
                t('notesWorkspace.backlinks.incoming'),
                incoming.length,
              )}
              <div
                id={`${titleId}-incoming-body`}
                className="notes-backlinks-panel-section-body"
              >
                <div className="notes-backlinks-panel-section-body-inner">
                  {incoming.length > 0 ? (
                    <>
                      <button
                        type="button"
                        className="notes-backlinks-panel-more-context"
                        aria-pressed={moreContext}
                        onClick={toggleMoreContext}
                      >
                        {moreContext
                          ? t('notesWorkspace.backlinks.lessContext')
                          : t('notesWorkspace.backlinks.moreContext')}
                      </button>
                      <ul>
                        {incoming.map((relationship, index) => {
                          const resource = relationshipNodesById.get(relationship.sourceId);
                          const sourceContent = contentsByNoteId?.get(relationship.sourceId) ?? '';
                          const contextSnippet = extractContextSnippet(
                            sourceContent,
                            relationship.link.start,
                            relationship.link.end,
                            contextRadius,
                          );
                          return resource ? (
                            <LinkedNoteRow
                              key={`${relationship.sourceId}:${relationship.link.start}:${index}`}
                              relationship={relationship}
                              resource={resource}
                              direction="inbound"
                              disabled={openingResourceId !== null}
                              onOpen={(node) => void openLinkedResource(node)}
                              openLabel={openLinkedNoteLabel}
                              contextSnippet={contextSnippet}
                            />
                          ) : null;
                        })}
                      </ul>
                    </>
                  ) : (
                    <EmptySection
                      icon={<MagnifyingGlass size={18} aria-hidden="true" />}
                      message={t('notesWorkspace.backlinks.noIncoming')}
                    />
                  )}
                  {loadState.status === 'ready' && loadState.incomingMayBeIncomplete && (
                    <div className="notes-backlinks-panel-scanned-hint" role="status">
                      <p>
                        {t('notesWorkspace.backlinks.incomingLimited', { scanned: loadState.scannedCandidateCount,
                            count: BACKLINK_CANDIDATE_LIMIT },)}
                      </p>
                      <button
                        type="button"
                        className="notes-backlinks-panel-load-more"
                        onClick={loadMoreCandidates}
                      >
                        {t('notesWorkspace.backlinks.loadMore', { defaultValue: '加载更多来源' })}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section
              className={cn(
                'notes-backlinks-panel-section',
                sectionCollapse.mentions && 'notes-backlinks-panel-section-collapsed',
              )}
              aria-labelledby={`${titleId}-mentions`}
            >
              {renderSectionHeader(
                'mentions',
                `${titleId}-mentions`,
                t('notesWorkspace.backlinks.mentions', { defaultValue: '未链接提及' }),
                mentionsState.status === 'ready' ? mentionsState.entries.length : 0,
              )}
              <div
                id={`${titleId}-mentions-body`}
                className="notes-backlinks-panel-section-body"
              >
                <div className="notes-backlinks-panel-section-body-inner">
                  {mentionsState.status === 'loading' || mentionsState.status === 'idle' ? (
                    <div className="notes-backlinks-panel-mentions-loading">
                      <CircleNotch className="notes-backlinks-panel-spinner" size={13} aria-hidden="true" />
                      {t('notesWorkspace.backlinks.mentionsLoading', { defaultValue: '正在扫描提及…' })}
                    </div>
                  ) : mentionsState.status === 'error' ? (
                    <p className="notes-backlinks-panel-mentions-error">{mentionsState.message}</p>
                  ) : mentionsState.entries.length > 0 ? (
                    <ul>
                      {mentionsState.entries.map((row, index) => (
                        <UnlinkedMentionRowView
                          key={`${row.node.id}:${row.mention.start}:${index}`}
                          row={row}
                          disabled={openingResourceId !== null}
                          contextRadius={contextRadius}
                          onOpen={(node) => void openLinkedResource(node)}
                          openLabel={openLinkedNoteLabel}
                          convertLabel={convertMentionLabel}
                        />
                      ))}
                    </ul>
                  ) : (
                    <EmptySection
                      icon={<MagnifyingGlass size={18} aria-hidden="true" />}
                      message={t('notesWorkspace.backlinks.noMentions', { defaultValue: '没有找到未链接的提及' })}
                    />
                  )}
                  {mentionsState.status === 'ready' && mentionsState.mayBeIncomplete && (
                    <p className="notes-backlinks-panel-scanned-hint">
                      {t('notesWorkspace.backlinks.mentionsLimited', {
                        defaultValue: '仅扫描最近 {{count}} 篇候选笔记。',
                        count: UNLINKED_MENTION_CANDIDATE_LIMIT,
                      })}
                    </p>
                  )}
                </div>
              </div>
            </section>

            {unresolved.length > 0 && (
              <section
                className={cn(
                  'notes-backlinks-panel-section',
                  sectionCollapse.unresolved && 'notes-backlinks-panel-section-collapsed',
                )}
                aria-labelledby={`${titleId}-unresolved`}
              >
                {renderSectionHeader(
                  'unresolved',
                  `${titleId}-unresolved`,
                  t('notesWorkspace.backlinks.unresolved'),
                  unresolved.length,
                )}
                <div
                  id={`${titleId}-unresolved-body`}
                  className="notes-backlinks-panel-section-body"
                >
                  <div className="notes-backlinks-panel-section-body-inner">
                    <ul>
                      {unresolved.map((item, index) => (
                        <UnresolvedLinkRow
                          key={`${item.sourceId}:${item.link.start}:${index}`}
                          item={item}
                          canCreate={canCreate}
                          creating={creatingTitles.has(item.link.target)}
                          onCreate={(title) => void createFromUnresolved(title)}
                          createLabel={createNoteLabel}
                        />
                      ))}
                    </ul>
                  </div>
                </div>
              </section>
            )}
          </>
        )}
        {openError && <p className="notes-backlinks-panel-open-error" role="alert">{openError}</p>}
      </div>
      )}
    </aside>
  );
};

export default NotesBacklinksPanel;
