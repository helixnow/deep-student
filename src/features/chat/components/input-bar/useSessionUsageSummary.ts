/**
 * ★ 1.2 会话级累计用量 hook
 *
 * 查询当前会话的累计 token / 费用（按 llm_usage 的 caller_id 聚合），
 * 在每轮回复结束（lastRoundKey 变化）后刷新。查询失败静默降级为 null。
 */
import { useEffect, useRef, useState } from 'react';
import { LlmUsageApi, type SessionUsageSummary } from '@/api/llmUsageApi';

const REFRESH_DEBOUNCE_MS = 1_500;

export function useSessionUsageSummary(
  sessionId: string | null | undefined,
  lastRoundKey: unknown,
): SessionUsageSummary | null {
  const [summary, setSummary] = useState<SessionUsageSummary | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setSummary(null);
      return;
    }

    let cancelled = false;
    // 流结束后 usage 落库有延迟，延迟一拍再查询
    timerRef.current = setTimeout(() => {
      LlmUsageApi.getSessionSummary(sessionId)
        .then((result) => {
          if (!cancelled) {
            setSummary(result.requestCount > 0 ? result : null);
          }
        })
        .catch(() => {
          if (!cancelled) setSummary(null);
        });
    }, REFRESH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [sessionId, lastRoundKey]);

  return summary;
}
