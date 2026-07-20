/**
 * IndexStatusMiniBar - 学习中心侧栏索引状态常驻小条
 *
 * 借鉴 OpenCode 状态栏理念：把"系统正在为你工作"的状态轻量externalize。
 * - 索引进行中：蓝色旋转图标 + 进度
 * - 有失败项：红色警示 + 数量
 * - 有待索引项：琥珀时钟 + 数量
 * - 全部就绪：不渲染（保持安静）
 *
 * 点击直达索引状态页。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowsClockwise, Clock, WarningCircle } from '@phosphor-icons/react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { cn } from '@/lib/utils';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { getAllIndexStatus } from '@/api/vfsUnifiedIndexApi';
import { MULTIMODAL_INDEX_SUPPORTED } from '@/services/multimodalRagService';

interface IndexStatusMiniBarProps {
  collapsed?: boolean;
  onOpenIndexStatus: () => void;
}

interface MiniSummary {
  pendingCount: number;
  indexingCount: number;
  failedCount: number;
}

const REFRESH_INTERVAL_MS = 60_000;

export const IndexStatusMiniBar: React.FC<IndexStatusMiniBarProps> = ({
  collapsed = false,
  onOpenIndexStatus,
}) => {
  const { t } = useTranslation('learningHub');
  const [summary, setSummary] = useState<MiniSummary | null>(null);
  const [batchProgress, setBatchProgress] = useState<number | null>(null);
  // 原生多模态索引（mm_index_progress）与文本批量索引是两条独立事件流
  const [mmProgress, setMmProgress] = useState<number | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const result = await getAllIndexStatus({ limit: 1 });
      if (!mountedRef.current) return;
      setSummary({
        pendingCount: result.pendingCount,
        indexingCount: result.indexingCount,
        failedCount: result.failedCount,
      });
    } catch {
      // 静默失败：小条属于辅助信息，不打扰用户
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  // 监听索引进度事件：批量索引时展示实时进度，结束后刷新统计
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    listen<{ type: string; progress?: number }>('vfs-index-progress', (event) => {
      const { type, progress } = event.payload;
      switch (type) {
        case 'batch_started':
          setBatchProgress(0);
          break;
        case 'resource_started':
        case 'resource_completed':
        case 'resource_failed':
        case 'embedding_progress':
          if (typeof progress === 'number') setBatchProgress(progress);
          break;
        case 'batch_completed':
          setBatchProgress(null);
          void refresh();
          break;
        case 'completed':
        case 'failed':
          void refresh();
          break;
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    }).catch(() => {
      // 非 Tauri 环境（如测试）忽略
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refresh]);

  // 监听原生多模态索引进度：纯多模态索引任务不发 vfs-index-progress，
  // 只发 mm_index_progress，不订阅会导致侧栏对进行中的任务毫无反应
  useEffect(() => {
    if (!MULTIMODAL_INDEX_SUPPORTED) return;

    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    listen<{ phase: string; progressPercent?: number }>('mm_index_progress', (event) => {
      const { phase, progressPercent } = event.payload;
      if (phase === 'completed' || phase === 'failed') {
        setMmProgress(null);
        void refresh();
      } else if (typeof progressPercent === 'number') {
        setMmProgress(progressPercent);
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    }).catch(() => {
      // 非 Tauri 环境（如测试）忽略
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refresh]);

  const activeProgress = batchProgress ?? mmProgress;
  const isIndexing = activeProgress !== null || (summary?.indexingCount ?? 0) > 0;
  const failedCount = summary?.failedCount ?? 0;
  const pendingCount = summary?.pendingCount ?? 0;

  if (!isIndexing && failedCount === 0 && pendingCount === 0) {
    return null;
  }

  let icon: React.ReactNode;
  let label: string;
  let toneClass: string;

  if (isIndexing) {
    icon = <ArrowsClockwise size={14} className="animate-spin" />;
    label = activeProgress !== null
      ? t('indexMiniBar.indexingWithProgress', { progress: Math.round(activeProgress) })
      : t('indexMiniBar.indexing');
    toneClass = 'text-blue-600 dark:text-blue-400';
  } else if (failedCount > 0) {
    icon = <WarningCircle size={14} />;
    label = t('indexMiniBar.failed', { count: failedCount });
    toneClass = 'text-red-600 dark:text-red-400';
  } else {
    icon = <Clock size={14} />;
    label = t('indexMiniBar.pending', { count: pendingCount });
    toneClass = 'text-warning';
  }

  const button = (
    <button
      type="button"
      onClick={onOpenIndexStatus}
      aria-label={label}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] leading-none transition-colors',
        'hover:bg-[var(--interactive-hover)]',
        collapsed && 'justify-center px-2',
        toneClass
      )}
    >
      <span className="shrink-0" aria-hidden>{icon}</span>
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
    </button>
  );

  return (
    <div className="shrink-0 px-1.5 pb-1" role="status">
      {collapsed ? (
        <CommonTooltip content={<p>{label}</p>} position="right" offset={8}>
          {button}
        </CommonTooltip>
      ) : (
        button
      )}
    </div>
  );
};

export default IndexStatusMiniBar;
