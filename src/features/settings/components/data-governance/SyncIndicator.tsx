/**
 * 同步指示器徽章
 *
 * 轻量级组件，定期轮询后端 `count_record_conflicts` 并把未解决冲突的总数
 * 以醒目的方式展示出来。放在同步 Tab 概览区，用户不需要展开冲突面板也能
 * 立刻看到"有 N 条冲突待处理"。
 *
 * 为什么要单独做：
 * - __sync_conflicts 表由后端 `apply_downloaded_changes_with_conflict_guard`
 *   自动写入，前端不会主动知道新增。
 * - 轮询间隔保守（30s），在多数"什么都没发生"的时间窗里几乎没开销。
 * - 出错静默，不打扰用户；唯一会呈现的状态是"有冲突"。
 */

import React, { useEffect, useState } from 'react';
import { Warning, CheckCircle } from '@phosphor-icons/react';
import * as DataGovernanceApi from '@/api/dataGovernance';

const POLL_INTERVAL_MS = 30_000;

export const SyncIndicator: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const result = await DataGovernanceApi.countRecordConflicts();
        if (!cancelled) {
          setCounts(result);
        }
      } catch {
        // 静默：后端命令缺失或数据库未就绪时不骚扰用户
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (loading || !counts) return null;

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (total === 0) {
    if (compact) return null;
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
        <CheckCircle size={12} />
        无冲突
      </span>
    );
  }

  const perDb = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([db, n]) => `${db}: ${n}`)
    .join(', ');

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300 ring-1 ring-inset ring-amber-500/30"
      title={`未解决冲突：${perDb}`}
    >
      <Warning size={12} />
      {total} 条冲突
    </span>
  );
};

export default SyncIndicator;
