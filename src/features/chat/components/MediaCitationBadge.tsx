/**
 * Chat V2 - 媒体时间戳引用徽章 `[媒体@file_xxx:12:34]` →「▶ 12:34 · 文件名」
 *
 * 点击派发 media-ref:open（经典壳 useChatPageEvents / 工作台 WorkbenchEventBridge
 * 打开资源后以 media-ref:focus 带回执重发，媒体视图 seek + 播放）。
 * 文件名经 dstu_get 解析并做模块级缓存（同一回答里多处引用同一资源只查一次）。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Play } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { dispatchOpenMediaRef } from '@/features/learning-hub/apps/views/media/mediaRefEvents';
import { formatMediaRefTimestamp } from '@/features/learning-hub/apps/views/media/mediaRefTime';

const nameCache = new Map<string, Promise<string | null>>();

/** 解析资源显示名（失败返回 null，不缓存失败以便资源恢复后重试） */
export function resolveMediaResourceName(resourceId: string): Promise<string | null> {
  const cached = nameCache.get(resourceId);
  if (cached) return cached;
  const pending = invoke<{ name?: string; title?: string } | null>('dstu_get', {
    path: `/${resourceId}`,
  })
    .then((node) => {
      const name = node?.name || node?.title || null;
      if (!name) nameCache.delete(resourceId);
      return name;
    })
    .catch(() => {
      nameCache.delete(resourceId);
      return null;
    });
  nameCache.set(resourceId, pending);
  return pending;
}

/** 测试用 */
export function clearMediaResourceNameCache(): void {
  nameCache.clear();
}

export interface MediaCitationBadgeProps {
  resourceId: string;
  seconds: number;
  className?: string;
}

export const MediaCitationBadge: React.FC<MediaCitationBadgeProps> = ({
  resourceId,
  seconds,
  className,
}) => {
  const { t } = useTranslation(['learningHub']);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void resolveMediaResourceName(resourceId).then((resolved) => {
      if (alive) setName(resolved);
    });
    return () => {
      alive = false;
    };
  }, [resourceId]);

  const time = formatMediaRefTimestamp(seconds);
  const displayName = name || t('learningHub:mediaRef.unknownMedia');
  const label = t('learningHub:mediaRef.badgeLabel', { name: displayName, time });

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dispatchOpenMediaRef(resourceId, seconds);
    },
    [resourceId, seconds],
  );

  return (
    <button
      type="button"
      onClick={handleClick}
      title={label}
      aria-label={label}
      data-media-ref-badge="true"
      className={cn(
        'mx-0.5 inline-flex max-w-[260px] items-center gap-1 rounded-md px-1.5 py-px align-middle',
        'border border-primary/20 bg-primary/[0.08] text-[0.75rem] font-medium leading-5 text-primary',
        'transition-colors duration-150 hover:border-primary/40 hover:bg-primary/15 motion-reduce:transition-none',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        'dark:bg-primary/15 dark:hover:bg-primary/25',
        className,
      )}
    >
      <Play size={10} weight="fill" aria-hidden="true" className="shrink-0" />
      <span className="shrink-0 tabular-nums">{time}</span>
      {name && (
        <>
          <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
          <span className="min-w-0 truncate">{name}</span>
        </>
      )}
    </button>
  );
};

export default MediaCitationBadge;
