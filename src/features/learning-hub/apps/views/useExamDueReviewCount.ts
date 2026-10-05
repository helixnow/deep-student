import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { registerDomainListener } from '@/features/workbench/agent/domainEvents';
import { useReviewPlanStore } from '@/stores/reviewPlanStore';

/**
 * 本题目集今天到期（含逾期）的错题复习数，给「更多 › 复习计划」挂角标。
 * 复习会话推进 / 结束、Agent 改动复习计划后重新读取。
 */
export function useExamDueReviewCount(examId: string | null | undefined): number {
  const [count, setCount] = useState(0);
  const sessionMarker = useReviewPlanStore((state) => `${state.session.isActive}:${state.session.completedCount}`);

  useEffect(() => {
    if (!examId) {
      setCount(0);
      return undefined;
    }
    let cancelled = false;
    const load = () => {
      Promise.resolve()
        .then(() => invoke<{ due_today?: number } | null>('review_plan_get_stats', { examId }))
        .then((stats) => {
          if (!cancelled) setCount(stats?.due_today ?? 0);
        })
        .catch(() => {});
    };
    load();
    const unlisten = registerDomainListener('review://changed', load);
    return () => {
      cancelled = true;
      unlisten();
    };
  }, [examId, sessionMarker]);

  return count;
}
