/**
 * 拖拽吸附区：独立于 React Desktop 树，避免每帧 setSnapZone 刷整桌面。
 * SnapPreview 用 useSyncExternalStore 订阅；WindowShell 只调 setActiveSnapZone。
 */
import type { SnapZone } from './types';

let activeZone: SnapZone = null;
const listeners = new Set<() => void>();

export function getActiveSnapZone(): SnapZone {
  return activeZone;
}

export function setActiveSnapZone(zone: SnapZone): void {
  if (zone === activeZone) return;
  activeZone = zone;
  for (const listener of listeners) listener();
}

export function subscribeActiveSnapZone(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
