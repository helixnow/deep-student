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

/** Own one worker only while this conversation's search UI is open. */
export function useMessageSearch(
  store: StoreApi<ChatStore>,
  isOpen: boolean,
  query: string,
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
    if (!isOpen) return;
    let disposed = false;
    let worker: Worker | null = null;
    let fallback: ReturnType<typeof createMessageSearchIndex> | null = null;
    let requestId = 0;
    let activeQuery = '';
    let sentMessages: MessageSearchDocument[] | null = null;
    let sentBlocks = new Map<string, string>();
    setResult(null);

    const publish = (matches: MessageSearchMatch[]) => {
      const resultQuery = activeQuery;
      const resultRequestId = requestId;
      setResult((previous) => {
        if (disposed || resultRequestId !== requestId) return previous;
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

    // Failure retains search availability with the same bounded index. Do not
    // retry failed workers or introduce another scheduling/caching layer.
    const useFallback = () => {
      if (disposed || fallback) return;
      stopWorker();
      fallback = createMessageSearchIndex();
      sentMessages = null;
      sentBlocks.clear();
      search(activeQuery, true);
    };

    const search = (nextQuery: string, force = false) => {
      if (disposed) return;
      const queryChanged = nextQuery !== activeQuery;
      activeQuery = nextQuery;
      if (!nextQuery.trim()) {
        if (queryChanged) {
          requestId += 1; // Invalidate an in-flight result when the input is cleared.
          publish(EMPTY_MATCHES);
        }
        return;
      }
      const update = collectUpdate();
      if (!force && !queryChanged && !update.messages
        && update.blocks.length === 0 && update.removedBlockIds.length === 0) return;
      const request: MessageSearchRequest = { ...update, query: nextQuery, requestId: ++requestId };
      if (worker) {
        try {
          worker.postMessage(request);
        } catch {
          useFallback();
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
        if (disposed) return;
        if ('error' in data) {
          useFallback();
        } else if (data.requestId === requestId) {
          publish(data.matches);
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        useFallback();
      };
      worker.onmessageerror = useFallback;
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
  }, [store, isOpen]);

  useEffect(() => {
    searchRef.current?.(query);
  }, [store, isOpen, query]);

  return isOpen && result?.store === store && result.query === query
    ? result.matches
    : EMPTY_MATCHES;
}
