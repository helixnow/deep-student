/**
 * 音视频库数据：media_library_list + 实时更新。
 *
 * - 转写进度（media-processing-progress）就地更新对应条目的状态徽章，
 *   完成 / 失败事件后节流重拉（拿到准确的段计数与来源）；
 * - 资源变化（DSTU watch：导入 / 重命名 / 删除 / 恢复）防抖重拉；
 * - 回到前台（visibilitychange）重拉：Android 切后台期间转写可能已推进或完成。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { dstu } from '@/dstu';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { getErrorMessage } from '@/utils/errorUtils';
import { subscribeMediaProcessingEvents } from '@/features/learning-hub/apps/views/media/mediaTranscriptApi';
import { mediaStudioApi, type MediaLibraryItem } from './api';

const REFETCH_DEBOUNCE_MS = 600;

export interface MediaLibraryState {
  items: MediaLibraryItem[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** 乐观移除（删除后立即从列表消失，随后的重拉校正） */
  removeLocal: (id: string) => void;
}

export function useMediaLibrary(enabled = true): MediaLibraryState {
  const [items, setItems] = useState<MediaLibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const idsRef = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    try {
      const next = await mediaStudioApi.listLibrary();
      if (generation !== generationRef.current) return;
      idsRef.current = new Set(next.map((item) => item.id));
      setItems(next);
      setError(null);
      // 行内「卡 N · 题 M」：台账单独一次批量查询，列表先出、计数后补，失败不影响列表
      void mediaStudioApi.studyLedger(next.map((item) => item.id))
        .then((ledgers) => {
          if (generation !== generationRef.current) return;
          const byId = new Map(ledgers.map((ledger) => [ledger.resourceId, ledger]));
          setItems((prev) => prev.map((item) => {
            const ledger = byId.get(item.id);
            return ledger ? { ...item, cardCount: ledger.cardCount, questionCount: ledger.questionCount } : item;
          }));
        })
        .catch(() => undefined);
    } catch (err: unknown) {
      if (generation !== generationRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (generation === generationRef.current) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void refresh();
    }, REFETCH_DEBOUNCE_MS);
  }, [refresh]);

  const removeLocal = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  // 转写事件
  useEffect(() => {
    if (!enabled) return;
    return subscribeMediaProcessingEvents((event) => {
      if (event.kind === 'progress') {
        const { progress } = event;
        setItems((prev) =>
          prev.map((item) =>
            item.id === event.resourceId
              ? {
                  ...item,
                  transcript: {
                    ...item.transcript,
                    status: progress.stage === 'queued' ? 'queued' : 'running',
                    completedSegments: progress.completedSegments,
                    totalSegments: progress.totalSegments,
                  },
                }
              : item,
          ),
        );
        return;
      }
      scheduleRefresh();
    });
  }, [enabled, scheduleRefresh]);

  // 资源变化（新导入的媒体不在 idsRef 里，created 事件一律重拉）
  useEffect(() => {
    if (!enabled) return;
    return dstu.watch('*', (event) => {
      const id = event.node?.id ?? event.path?.replace(/^\/+/, '').split('/').pop() ?? '';
      if (event.type === 'created' || event.type === 'restored' || idsRef.current.has(id)) {
        scheduleRefresh();
      }
    });
  }, [enabled, scheduleRefresh]);

  // 回到前台
  const handleVisibility = useCallback(() => {
    if (enabled && document.visibilityState === 'visible') scheduleRefresh();
  }, [enabled, scheduleRefresh]);
  useEventRegistry([
    { target: 'document', type: 'visibilitychange', listener: handleVisibility },
  ], [handleVisibility]);

  return { items, loading, loaded, error, refresh, removeLocal };
}
