/**
 * B 站链接条目的应用内清晰度：请求的 qn（全局偏好，默认最高档）→ 播放地址；
 * 后端回报可选档位与 B 站实际给的档位（请求的档位拿不到时 B 站自动降档）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getErrorMessage } from '@/utils/errorUtils';
import { isAndroid, isLinux } from '@/utils/platform';
import { useBilibiliTransport } from './bilibiliTransport';
import {
  BILIBILI_DEFAULT_QN,
  bilibiliStreamApi,
  buildBilibiliStreamUrl,
  getBilibiliQualityPreference,
  nextBilibiliPlaybackAttempt,
  setBilibiliQualityPreference,
  useBilibiliAccountEpoch,
  type BilibiliStreamQuality,
} from './bilibiliAccount';

export interface BilibiliQualityState {
  /** 应用内播放地址（含 qn / 账号代次）；fileId 为空时为 null */
  streamUrl: string | null;
  /** 请求的清晰度 */
  requested: number;
  /** 与当前请求对应的后端回报；查询中 / 失败时为 null */
  info: BilibiliStreamQuality | null;
  /** 用户选了一档：记为全局偏好并换地址 */
  select: (qn: number) => void;
  error: string | null;
  retry: () => void;
}

function initialQn(): number {
  return getBilibiliQualityPreference() ?? BILIBILI_DEFAULT_QN;
}

export function useBilibiliQuality(fileId: string | null): BilibiliQualityState {
  const epoch = useBilibiliAccountEpoch();
  const transport = useBilibiliTransport(Boolean(fileId));
  const routeKey = transport ? `${transport.settings.mode}:${transport.settings.proxyUrl ?? ''}` : '';
  const [requested, setRequested] = useState(initialQn);
  const [info, setInfo] = useState<{ key: string; value: BilibiliStreamQuality } | null>(null);
  const [attempt, setAttempt] = useState(nextBilibiliPlaybackAttempt);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);

  // 换条目：回到偏好（别的条目里选的档位也是全局偏好）
  useEffect(() => {
    setRequested(initialQn());
  }, [fileId]);
  const previousRoute = useRef(routeKey);
  useEffect(() => {
    if (previousRoute.current && routeKey && previousRoute.current !== routeKey) setAttempt(nextBilibiliPlaybackAttempt());
    previousRoute.current = routeKey;
  }, [routeKey]);

  const key = fileId ? `${fileId}@${requested}@${epoch}@${attempt}` : null;
  useEffect(() => {
    if (!fileId || !key) return;
    let cancelled = false;
    bilibiliStreamApi
      .quality(fileId, requested, epoch, attempt)
      .then((value) => {
        if (!cancelled) setInfo({ key, value });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setInfo(null);
          setFailure({ key, message: getErrorMessage(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, requested, epoch, attempt, key]);

  useEffect(() => {
    if (!fileId || !key) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ fileId: string; qn: number; epoch: number; attempt: number; message: string }>(
      'media_bilibili_playback_error',
      ({ payload }) => {
        if (!disposed && payload.fileId === fileId && payload.qn === requested && payload.epoch === epoch && payload.attempt === attempt) {
          setFailure({ key, message: payload.message });
        }
      },
    ).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [fileId, requested, epoch, attempt, key]);

  const select = useCallback((qn: number) => {
    setBilibiliQualityPreference(qn);
    setFailure(null);
    setRequested(qn);
    // The requested quality can already be 1080P while the actual stream is 720P.
    if (qn === requested) setAttempt(nextBilibiliPlaybackAttempt());
  }, [requested]);

  const streamUrl = useMemo(
    () => {
      if (!fileId) return null;
      if (info?.key === key && info.value.streamUrl) return info.value.streamUrl;
      if (isLinux() && !isAndroid()) return null;
      return buildBilibiliStreamUrl(fileId, requested, epoch, attempt);
    },
    [fileId, requested, epoch, attempt, info, key],
  );
  const retry = useCallback(() => {
    setFailure(null);
    setAttempt(nextBilibiliPlaybackAttempt());
  }, []);

  return {
    streamUrl,
    requested,
    info: info && info.key === key ? info.value : null,
    select,
    error: failure?.key === key ? failure.message : null,
    retry,
  };
}
