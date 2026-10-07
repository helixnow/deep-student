/**
 * B 站链接条目的应用内清晰度：请求的 qn（全局偏好，默认最高档）→ 播放地址；
 * 后端回报可选档位与 B 站实际给的档位（请求的档位拿不到时 B 站自动降档）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BILIBILI_DEFAULT_QN,
  bilibiliStreamApi,
  buildBilibiliStreamUrl,
  getBilibiliQualityPreference,
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
}

function initialQn(): number {
  return getBilibiliQualityPreference() ?? BILIBILI_DEFAULT_QN;
}

export function useBilibiliQuality(fileId: string | null): BilibiliQualityState {
  const epoch = useBilibiliAccountEpoch();
  const [requested, setRequested] = useState(initialQn);
  const [info, setInfo] = useState<{ key: string; value: BilibiliStreamQuality } | null>(null);

  // 换条目：回到偏好（别的条目里选的档位也是全局偏好）
  useEffect(() => {
    setRequested(initialQn());
  }, [fileId]);

  const key = fileId ? `${fileId}@${requested}@${epoch}` : null;
  useEffect(() => {
    if (!fileId || !key) return;
    let cancelled = false;
    bilibiliStreamApi
      .quality(fileId, requested, epoch)
      .then((value) => {
        if (!cancelled) setInfo({ key, value });
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, requested, epoch, key]);

  const select = useCallback((qn: number) => {
    setBilibiliQualityPreference(qn);
    setRequested(qn);
  }, []);

  const streamUrl = useMemo(
    () => (fileId ? buildBilibiliStreamUrl(fileId, requested, epoch) : null),
    [fileId, requested, epoch],
  );

  return {
    streamUrl,
    requested,
    info: info && info.key === key ? info.value : null,
    select,
  };
}
