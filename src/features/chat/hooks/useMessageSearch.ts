import { useEffect, useRef, useState } from 'react';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../core/types';
import {
  createMessageSearchIndex,
  type MessageSearchDocument,
  type MessageSearchMatch,
  type MessageSearchRequest,
  type MessageSearchResponse,
  type MessageSearchUpdate,
} from '../components/messageSearch';

const EMPTY_MATCHES: MessageSearchMatch[] = [];

function sameDocuments(a: MessageSearchDocument[] | null, b: MessageSearchDocument[]): boolean {
  return a !== null && a.length === b.length && a.every((message, index) => {
    const next = b[index];
    return message.messageId === next.messageId
      && (message.blockIds === next.blockIds
        || (message.blockIds.length === next.blockIds.length
          && message.blockIds.every((id, blockIndex) => id === next.blockIds[blockIndex])));
  });
}

/** Own one worker only while this conversation's search UI is open and active. */
export function useMessageSearch(
  store: StoreApi<ChatStore>,
  isOpen: boolean,
  query: string,
  suspended = false,
): MessageSearchMatch[] {
  const [result, setResult] = useState<{
    store: StoreApi<ChatStore>;
    query: string;
    matches: MessageSearchMatch[];
  } | null>(null);
  const searchRef = useRef<((query: string) => void) | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    if (!isOpen || suspended) return;
    let disposed = false;
    let worker: Worker | null = null;
    let fallback: ReturnType<typeof createMessageSearchIndex> | null = null;
    let requestId = 0;
    let activeQuery = '';
    let queryRevision = 0;
    let sentQueryRevision = -1;
    let inFlight: { requestId: number; queryRevision: number } | null = null;
    let pendingSearch = false;
    let sentMessages: MessageSearchDocument[] | null = null;
    let sentBlocks = new Map<string, string>();
    setResult(null);

    const publish = (matches: MessageSearchMatch[]) => {
      const resultQuery = activeQuery;
      const resultRequestId = requestId;
      const resultQueryRevision = queryRevision;
      setResult((previous) => {
        if (disposed || resultRequestId !== requestId
          || resultQueryRevision !== queryRevision) return previous;
        if (previous?.store === store && previous.query === resultQuery
          && previous.matches.length === matches.length
          && previous.matches.every((match, index) => match.messageId === matches[index].messageId
            && match.occurrenceIndex === matches[index].occurrenceIndex)) return previous;
        return { store, query: resultQuery, matches };
      });
    };

    const collectUpdate = (): MessageSearchUpdate => {
      const state = store.getState();
      const messages: MessageSearchDocument[] = [];
      const currentBlocks = new Map<string, string>();
      for (const messageId of state.messageOrder) {
        const message = state.messageMap.get(messageId);
        if (!message) continue;
        messages.push({ messageId, blockIds: message.blockIds });
        for (const blockId of message.blockIds) {
          const block = state.blocks.get(blockId);
          if (block) currentBlocks.set(blockId, block.content ?? '');
        }
      }
      const update: MessageSearchUpdate = { blocks: [], removedBlockIds: [] };
      if (!sameDocuments(sentMessages, messages)) update.messages = messages;
      for (const [id, content] of currentBlocks) {
        if (sentBlocks.get(id) !== content) update.blocks.push({ id, content });
      }
      for (const id of sentBlocks.keys()) {
        if (!currentBlocks.has(id)) update.removedBlockIds.push(id);
      }
      sentMessages = messages;
      sentBlocks = currentBlocks;
      return update;
    };

    const stopWorker = () => {
      if (!worker) return;
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      worker = null;
    };

    // Failure retains search availability with the same index and latest store
    // state. Do not retry the failed worker or replay its queued snapshots.
    const activateFallback = () => {
      if (disposed || fallback) return;
      stopWorker();
      inFlight = null;
      pendingSearch = false;
      fallback = createMessageSearchIndex();
      sentMessages = null;
      sentBlocks.clear();
      sentQueryRevision = -1;
      search(activeQuery, true);
    };

    const search = (nextQuery: string, force = false) => {
      if (disposed) return;
      const queryChanged = nextQuery !== activeQuery;
      activeQuery = nextQuery;
      if (queryChanged) queryRevision += 1;
      if (!nextQuery.trim()) {
        pendingSearch = false;
        if (queryChanged) {
          publish(EMPTY_MATCHES);
        }
        return;
      }
      // Keep only one in-flight request. Store/query changes while it runs are
      // represented by this flag, not copied text or precomputed deltas. On its
      // reply, collect from the current store against the last sent snapshot.
      if (inFlight) {
        pendingSearch = true;
        return;
      }
      const update = collectUpdate();
      if (!force && sentQueryRevision === queryRevision && !update.messages
        && update.blocks.length === 0 && update.removedBlockIds.length === 0) return;
      const request: MessageSearchRequest = { ...update, query: nextQuery, requestId: ++requestId };
      sentQueryRevision = queryRevision;
      if (worker) {
        inFlight = { requestId: request.requestId, queryRevision };
        try {
          worker.postMessage(request);
        } catch {
          activateFallback();
        }
      } else if (fallback) {
        fallback.update(update);
        publish(fallback.find(nextQuery));
      }
    };

    try {
      worker = new Worker(new URL('../components/messageSearch.worker.ts', import.meta.url), {
        type: 'module',
        name: 'chat-message-search',
      });
      worker.onmessage = ({ data }: MessageEvent<MessageSearchResponse>) => {
        if (disposed || data.requestId !== inFlight?.requestId) return;
        const completed = inFlight;
        inFlight = null;
        if ('error' in data) {
          activateFallback();
          return;
        }
        if (pendingSearch) {
          pendingSearch = false;
          search(activeQuery);
        }
        // A newer query or content delta requires its own result. A status-only
        // store update may have set pendingSearch without changing searchable
        // text; in that case no new request was sent and this result is valid.
        if (!inFlight && completed.requestId === requestId
          && completed.queryRevision === queryRevision && activeQuery.trim()) {
          publish(data.matches);
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        activateFallback();
      };
      worker.onmessageerror = activateFallback;
    } catch {
      fallback = createMessageSearchIndex();
    }

    searchRef.current = search;
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.blocks !== previous.blocks || state.messageMap !== previous.messageMap
        || state.messageOrder !== previous.messageOrder) search(activeQuery);
    });
    search(queryRef.current);
    return () => {
      disposed = true;
      searchRef.current = null;
      unsubscribe();
      stopWorker();
    };
  }, [store, isOpen, suspended]);

  useEffect(() => {
    searchRef.current?.(query);
  }, [store, isOpen, query, suspended]);

  return isOpen && !suspended && result?.store === store && result.query === query
    ? result.matches
    : EMPTY_MATCHES;
}
