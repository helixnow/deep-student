import React, { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { MeshThreadState, PeerExchangeRecord } from '../types';
import { useAgentMeshStore } from '../store/useAgentMeshStore';

const LazyInlineExternalTurnCard = React.lazy(() =>
  import('./InlineExternalTurnCard').then((m) => ({
    default: m.InlineExternalTurnCard,
  })),
);

const LazyPeerExchangeStrip = React.lazy(() =>
  import('./PeerExchangeStrip').then((m) => ({
    default: m.PeerExchangeStrip,
  })),
);

export interface SessionMeshStreamSectionProps {
  sessionId?: string | null;
  className?: string;
}

type TimelineItem =
  | { kind: 'thread'; createdAt: number; key: string; thread: MeshThreadState }
  | { kind: 'exchange'; createdAt: number; key: string; exchange: PeerExchangeRecord };

const EMPTY_IDS: readonly string[] = Object.freeze([]);
const EMPTY_EXCHANGES: readonly PeerExchangeRecord[] = Object.freeze([]);

export const SessionMeshStreamSection: React.FC<SessionMeshStreamSectionProps> = React.memo(
  ({ sessionId, className }) => {
    const threadOrder = useAgentMeshStore((state) =>
      sessionId ? (state.sessionThreadOrder[sessionId] ?? EMPTY_IDS) : EMPTY_IDS,
    );
    const threadsMap = useAgentMeshStore((state) => state.threads);
    const exchanges = useAgentMeshStore((state) =>
      sessionId ? (state.peerExchanges[sessionId] ?? EMPTY_EXCHANGES) : EMPTY_EXCHANGES,
    );

    const items = useMemo<TimelineItem[]>(() => {
      if (threadOrder.length === 0 && exchanges.length === 0) return [];
      const merged: TimelineItem[] = [];
      for (const id of threadOrder) {
        const thread = threadsMap[id];
        if (thread) {
          merged.push({
            kind: 'thread',
            createdAt: thread.createdAt,
            key: `thread:${thread.threadId}`,
            thread,
          });
        }
      }
      for (const exchange of exchanges) {
        merged.push({
          kind: 'exchange',
          createdAt: exchange.createdAt,
          key: `exchange:${exchange.id}`,
          exchange,
        });
      }
      merged.sort((a, b) => a.createdAt - b.createdAt);
      return merged;
    }, [exchanges, threadOrder, threadsMap]);

    if (items.length === 0) {
      return null;
    }

    return (
      <section
        data-testid="session-mesh-stream-section"
        className={cn(
          'mx-auto w-full max-w-thread space-y-3 px-4 py-2 md:px-8',
          className,
        )}
      >
        <React.Suspense fallback={null}>
          {items.map((item) =>
            item.kind === 'thread' ? (
              <LazyInlineExternalTurnCard key={item.key} thread={item.thread} />
            ) : (
              <LazyPeerExchangeStrip key={item.key} exchange={item.exchange} />
            ),
          )}
        </React.Suspense>
      </section>
    );
  },
);

SessionMeshStreamSection.displayName = 'SessionMeshStreamSection';

export default SessionMeshStreamSection;
