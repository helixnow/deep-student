import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHAT_CHANNEL_THREAD,
  subscribeSuperAgentEvents,
  superAgentApi,
  type FeedItem,
  type IngestOutcome,
  type SuperAgentStatus,
} from './api';

const POLL_MS = 2500;

export interface UseSuperAgent {
  status: SuperAgentStatus | null;
  feed: FeedItem[];
  error: string | null;
  sending: boolean;
  /** Router 正在处理或还有积压事件 */
  thinking: boolean;
  send: (text: string, threadKey?: string) => Promise<IngestOutcome | null>;
  closeWorker: (workerId: string) => Promise<void>;
  reviveWorker: (workerId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * @param active 页面是否可见。不可见时停止轮询（视图层会保活已访问过的页面）。
 */
export function useSuperAgent(active: boolean): UseSuperAgent {
  const [status, setStatus] = useState<SuperAgentStatus | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [s, f] = await Promise.all([superAgentApi.status(), superAgentApi.feed()]);
      if (!mounted.current) return;
      setStatus(s);
      setFeed(f);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(String(e));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    subscribeSuperAgentEvents(() => void refresh())
      .then((u) => (cancelled ? u() : (unlisten = u)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unlisten?.();
    };
  }, [active, refresh]);

  const send = useCallback(
    async (text: string, threadKey: string = CHAT_CHANNEL_THREAD) => {
      const body = text.trim();
      if (!body) return null;
      setSending(true);
      try {
        const outcome = await superAgentApi.send(body, threadKey);
        await refresh();
        return outcome;
      } catch (e) {
        setError(String(e));
        return null;
      } finally {
        if (mounted.current) setSending(false);
      }
    },
    [refresh],
  );

  const closeWorker = useCallback(
    async (workerId: string) => {
      try {
        await superAgentApi.closeWorker(workerId);
      } catch (e) {
        setError(String(e));
      }
      await refresh();
    },
    [refresh],
  );

  const reviveWorker = useCallback(
    async (workerId: string) => {
      try {
        await superAgentApi.reviveWorker(workerId);
      } catch (e) {
        setError(String(e));
      }
      await refresh();
    },
    [refresh],
  );

  const thinking = !!status && status.enabled && (status.routerBusy || status.stats.pendingRouter > 0);

  return { status, feed, error, sending, thinking, send, closeWorker, reviveWorker, refresh };
}
