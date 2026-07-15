import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, CircleNotch, FileText, LinkSimple, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { dstu, type DstuNode } from '@/dstu';
import {
  getWikiLinkRelationships,
  type UnresolvedWikiLink,
  type WikiLinkRelationship,
  type WikiLinkRelationships,
} from '@/features/notes/wikilinks';
import { cn } from '@/lib/utils';
import './NotesBacklinksPanel.css';

type RelationshipsLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
    status: 'ready';
    relationships: WikiLinkRelationships;
    noteNodes: readonly DstuNode[];
    incomingMayBeIncomplete: boolean;
  }
  | { status: 'error'; message: string };

interface CachedContent {
  version: string;
  content: string;
}

export const NOTE_CONTENT_LOAD_CONCURRENCY = 8;
/**
 * A backlink query may match a popular note thousands of times. The panel
 * deliberately loads a bounded candidate set instead of fetching every note
 * in the workspace on every save.
 */
export const BACKLINK_CANDIDATE_LIMIT = 64;
const BACKLINK_SEARCH_RESULT_LIMIT = BACKLINK_CANDIDATE_LIMIT + 1;
const BACKLINK_WATCH_REFRESH_DEBOUNCE_MS = 120;

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
  className?: string;
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
    queries.add(`[[${target} `);
    queries.add(`[[ ${target}]]`);
    queries.add(`[[ ${target}|`);
    queries.add(`[[ ${target} `);
  }
  return [...queries];
}

async function findBacklinkCandidates(activeResource: DstuNode): Promise<{
  nodes: DstuNode[];
  incomingMayBeIncomplete: boolean;
}> {
  const searchResults = await Promise.all(backlinkSearchQueries(activeResource).map(async (query) => {
    const result = await dstu.search(query, {
      typeFilter: 'note',
      limit: BACKLINK_SEARCH_RESULT_LIMIT,
    });
    if (!result.ok) throw result.error;
    return result.value;
  }));

  const nodesById = new Map<string, DstuNode>();
  let incomingMayBeIncomplete = false;
  for (const result of searchResults) {
    // Asking for one more than the displayed budget lets us distinguish a
    // complete result from a query whose remaining matches were not fetched.
    if (result.length >= BACKLINK_SEARCH_RESULT_LIMIT) incomingMayBeIncomplete = true;
    for (const node of result) {
      if (node.type !== 'note' || node.id === activeResource.id) continue;
      nodesById.set(node.id, node);
    }
  }

  const nodes = Array.from(nodesById.values()).sort(compareNotesByRecentUpdate);
  if (nodes.length > BACKLINK_CANDIDATE_LIMIT) incomingMayBeIncomplete = true;
  return {
    nodes: nodes.slice(0, BACKLINK_CANDIDATE_LIMIT),
    incomingMayBeIncomplete,
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

const LinkedNoteRow: React.FC<{
  relationship: WikiLinkRelationship;
  resource: DstuNode;
  direction: 'inbound' | 'outbound';
  disabled: boolean;
  onOpen: (resource: DstuNode) => void;
  openLabel: (title: string) => string;
}> = ({ relationship, resource, direction, disabled, onOpen, openLabel }) => {
  const displayTitle = relationshipDisplayTitle(relationship, resource, direction);
  const showsAlias = direction === 'outbound'
    && relationship.link.label
    && relationship.link.label !== resource.name;

  return (
    <li>
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
    </li>
  );
};

const UnresolvedLinkRow: React.FC<{ item: UnresolvedWikiLink }> = ({ item }) => (
  <li className="notes-backlinks-panel-unresolved-link">
    <LinkSimple size={15} aria-hidden="true" />
    <code>{item.link.raw}</code>
  </li>
);

export const NotesBacklinksPanel: React.FC<NotesBacklinksPanelProps> = ({
  open,
  activeResource,
  notes,
  onOpenResource,
  onClose,
  className,
}) => {
  const { t } = useTranslation('workbench');
  const [loadState, setLoadState] = useState<RelationshipsLoadState>({ status: 'idle' });
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [openingResourceId, setOpeningResourceId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const contentCacheRef = useRef(new Map<string, CachedContent>());
  const loadSequenceRef = useRef(0);
  const watchRefreshTimerRef = useRef<number | null>(null);
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

        const { nodes: candidateNodes, incomingMayBeIncomplete } = await findBacklinkCandidates(activeNote);
        if (!isCurrentLoad()) return;

        // The resolver still receives every known note title/ID, but content
        // is fetched only for the active note and search-selected sources.
        // That keeps outgoing links exact without an O(all notes) content scan.
        const relationshipNodes = mergeNoteNodes(noteNodes, candidateNodes);
        const contentNodes = [activeNote, ...candidateNodes];
        const contentEntries = await mapWithConcurrency(contentNodes, NOTE_CONTENT_LOAD_CONCURRENCY, async (node) => {
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
        }, isCurrentLoad);

        if (!isCurrentLoad()) return;
        const contents = new Map(contentEntries);
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
          incomingMayBeIncomplete,
        });
      } catch (error) {
        if (!isCurrentLoad()) return;
        setLoadState({
          status: 'error',
          message: getErrorMessage(
            error,
            t('notesWorkspace.backlinks.loadFailed', 'Could not load linked notes.'),
          ),
        });
      }
    })();

    return () => {
      disposed = true;
    };
  }, [activeNoteId, noteNodes, open, refreshVersion, t]);

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
        t('notesWorkspace.backlinks.openFailed', 'Could not open linked note.'),
      ));
    } finally {
      setOpeningResourceId(null);
    }
  }, [onOpenResource, openingResourceId, t]);

  const onPanelKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
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
    ? loadState.relationships.unresolved.filter((item) => item.sourceId === activeNoteId)
    : [];
  const canShowLinks = Boolean(activeNoteId);
  const relationshipNodesById = loadState.status === 'ready'
    ? new Map(loadState.noteNodes.map((node) => [node.id, node]))
    : noteNodesById;
  const panelTitle = t('notesWorkspace.backlinks.title', 'Linked notes');
  const openLinkedNoteLabel = (title: string) => t(
    'notesWorkspace.backlinks.openLinkedNote',
    { defaultValue: 'Open {{title}}', title },
  );

  return (
    <aside
      className={cn('notes-backlinks-panel', className)}
      data-notes-backlinks-panel
      role="complementary"
      aria-labelledby={titleId}
      onKeyDown={onPanelKeyDown}
    >
      <header className="notes-backlinks-panel-header">
        <div>
          <h2 id={titleId}>{panelTitle}</h2>
          {activeResource?.type === 'note' && <span>{activeResource.name}</span>}
        </div>
        <div className="notes-backlinks-panel-actions">
          <button
            type="button"
            className="notes-backlinks-panel-icon-button"
            disabled={loadState.status === 'loading' || !canShowLinks}
            onClick={refresh}
            aria-label={t('notesWorkspace.backlinks.refresh', 'Refresh linked notes')}
            title={t('notesWorkspace.backlinks.refresh', 'Refresh linked notes')}
          >
            <ArrowClockwise size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="notes-backlinks-panel-icon-button"
            onClick={onClose}
            aria-label={t('notesWorkspace.backlinks.close', 'Close linked notes')}
            title={t('notesWorkspace.backlinks.close', 'Close linked notes')}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="notes-backlinks-panel-body" aria-live="polite">
        {!canShowLinks ? (
          <div className="notes-backlinks-panel-message">
            {t('notesWorkspace.backlinks.noActiveNote', 'Select a note to view its links.')}
          </div>
        ) : loadState.status === 'loading' ? (
          <div className="notes-backlinks-panel-message" role="status">
            <CircleNotch className="notes-backlinks-panel-spinner" size={16} aria-hidden="true" />
            {t('notesWorkspace.backlinks.loading', 'Loading linked notes...')}
          </div>
        ) : loadState.status === 'error' ? (
          <div className="notes-backlinks-panel-message notes-backlinks-panel-message-error" role="alert">
            <span>{loadState.message}</span>
            <button type="button" onClick={refresh}>
              {t('notesWorkspace.backlinks.retry', 'Retry')}
            </button>
          </div>
        ) : (
          <>
            <section className="notes-backlinks-panel-section" aria-labelledby={`${titleId}-outgoing`}>
              <h3 id={`${titleId}-outgoing`}>
                {t('notesWorkspace.backlinks.outgoing', 'Outgoing links')} <span>{outgoing.length}</span>
              </h3>
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
              ) : <p>{t('notesWorkspace.backlinks.noOutgoing', 'No outgoing links.')}</p>}
            </section>

            <section className="notes-backlinks-panel-section" aria-labelledby={`${titleId}-incoming`}>
              <h3 id={`${titleId}-incoming`}>
                {t('notesWorkspace.backlinks.incoming', 'Backlinks')} <span>{incoming.length}</span>
              </h3>
              {incoming.length > 0 ? (
                <ul>
                  {incoming.map((relationship, index) => {
                    const resource = relationshipNodesById.get(relationship.sourceId);
                    return resource ? (
                      <LinkedNoteRow
                        key={`${relationship.sourceId}:${relationship.link.start}:${index}`}
                        relationship={relationship}
                        resource={resource}
                        direction="inbound"
                        disabled={openingResourceId !== null}
                        onOpen={(node) => void openLinkedResource(node)}
                        openLabel={openLinkedNoteLabel}
                      />
                    ) : null;
                  })}
                </ul>
              ) : <p>{t('notesWorkspace.backlinks.noIncoming', 'No backlinks.')}</p>}
              {loadState.status === 'ready' && loadState.incomingMayBeIncomplete && (
                <p role="status">
                  {t(
                    'notesWorkspace.backlinks.incomingLimited',
                    {
                      defaultValue: 'Showing backlinks from the {{count}} most recently updated matching notes. Older backlinks may be omitted.',
                      count: BACKLINK_CANDIDATE_LIMIT,
                    },
                  )}
                </p>
              )}
            </section>

            <section className="notes-backlinks-panel-section" aria-labelledby={`${titleId}-unresolved`}>
              <h3 id={`${titleId}-unresolved`}>
                {t('notesWorkspace.backlinks.unresolved', 'Unresolved links')} <span>{unresolved.length}</span>
              </h3>
              {unresolved.length > 0 ? (
                <ul>{unresolved.map((item, index) => (
                  <UnresolvedLinkRow key={`${item.sourceId}:${item.link.start}:${index}`} item={item} />
                ))}</ul>
              ) : <p>{t('notesWorkspace.backlinks.noUnresolved', 'No unresolved links.')}</p>}
            </section>
          </>
        )}
        {openError && <p className="notes-backlinks-panel-open-error" role="alert">{openError}</p>}
      </div>
    </aside>
  );
};

export default NotesBacklinksPanel;
