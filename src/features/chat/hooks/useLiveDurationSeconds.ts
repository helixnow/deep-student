import { useEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

export function useLiveDurationSeconds(
  startedAt: number | undefined,
  endedAt: number | undefined,
  isLive: boolean,
): number {
  const prefersReduced = useReducedMotion();
  const tickMs = prefersReduced ? 5000 : 1000;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isLive || !startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(id);
  }, [isLive, startedAt, tickMs]);

  if (!startedAt) return 0;
  const end = endedAt ?? (isLive ? now : startedAt);
  return Math.max(0, Math.ceil((end - startedAt) / 1000));
}
