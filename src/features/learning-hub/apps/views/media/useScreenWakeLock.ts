/**
 * 视频播放中保持屏幕常亮（Screen Wake Lock API）。不支持的 WebView 静默跳过；
 * 切后台时系统会自动释放，回到前台且仍在播放时重新申请。
 */
import { useCallback, useEffect, useRef } from 'react';
import { useEventRegistry } from '@/hooks/useEventRegistry';

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
}

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
};

export function useScreenWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const acquire = useCallback(() => {
    const wakeLock = typeof navigator === 'undefined' ? undefined : (navigator as NavigatorWithWakeLock).wakeLock;
    if (!wakeLock || !activeRef.current || document.visibilityState !== 'visible') return;
    if (sentinelRef.current && !sentinelRef.current.released) return;
    wakeLock.request('screen')
      .then((next) => {
        if (activeRef.current) sentinelRef.current = next;
        else void next.release().catch(() => undefined);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    acquire();
    return () => {
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined);
    };
  }, [active, acquire]);

  const onVisibilityChange = useCallback(() => {
    if (document.visibilityState === 'visible') acquire();
  }, [acquire]);
  useEventRegistry(
    active ? [{ target: 'document', type: 'visibilitychange', listener: onVisibilityChange }] : [],
    [active, onVisibilityChange],
  );
}
