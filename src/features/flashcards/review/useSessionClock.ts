/**
 * 复习会话前端计时工具：秒级时钟 hook 与时长格式化。
 */
import React from 'react';

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
