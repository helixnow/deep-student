/**
 * 复习会话前端计时工具：秒级时钟 hook 与时长格式化。
 */
import React from 'react';

/** One presentation includes thinking and answer inspection, excluding hidden/editing time. */
export function useCardAnswerClock(presentationKey: string | null, enabled: boolean) {
  const [visible, setVisible] = React.useState(() => !document.hidden);
  React.useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const timer = React.useRef({ elapsed: 0, startedAt: null as number | null });
  React.useLayoutEffect(() => {
    timer.current = { elapsed: 0, startedAt: null };
  }, [presentationKey]);
  React.useLayoutEffect(() => {
    if (!presentationKey || !enabled || !visible) return;
    timer.current.startedAt = Date.now();
    return () => {
      const current = timer.current;
      if (current.startedAt !== null) current.elapsed += Math.max(0, Date.now() - current.startedAt);
      current.startedAt = null;
    };
  }, [presentationKey, enabled, visible]);
  return React.useCallback(() => {
    const { elapsed, startedAt } = timer.current;
    return elapsed + (startedAt === null ? 0 : Math.max(0, Date.now() - startedAt));
  }, []);
}

/** 将毫秒格式化为 `m:ss`（超过 1 小时为 `h:mm:ss`） */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const two = (value: number) => value.toString().padStart(2, '0');
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(seconds)}`
    : `${minutes}:${two(seconds)}`;
}

/**
 * enabled 时每 intervalMs 重渲染一次并返回当前时间戳；
 * disabled 时冻结在最后一次的值（用于完成态定格用时）。
 */
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}
