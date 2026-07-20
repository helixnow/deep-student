export const WORKBENCH_NATIVE_SURFACE_LAYOUT_EVENT = 'workbench:native-surface-layout' as const;

export type NativeSurfaceLayoutPhase = 'suspend' | 'resume' | 'sync';
export type NativeSurfaceLayoutScope = 'window' | 'all';

export interface NativeSurfaceLayoutEventDetail {
  windowId: string;
  phase: NativeSurfaceLayoutPhase;
  scope: NativeSurfaceLayoutScope;
}

// 消费者注册计数：绝大多数窗口没有原生子表面（目前只有 browser 窗监听），
// 无消费者时 sync 热路径（拖拽每帧一次）直接短路，不分配 CustomEvent。
let consumerCount = 0;

/**
 * 注册原生子表面布局事件监听（唯一受支持的监听入口）：
 * 内部走 window 事件转发并维护消费者计数，返回注销函数（幂等）。
 * 直接 addEventListener 的旁路监听不会计入计数，可能收不到 sync 事件。
 */
export function addNativeSurfaceLayoutListener(
  listener: (detail: NativeSurfaceLayoutEventDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<NativeSurfaceLayoutEventDetail>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(WORKBENCH_NATIVE_SURFACE_LAYOUT_EVENT, handler);
  consumerCount += 1;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    consumerCount -= 1;
    window.removeEventListener(WORKBENCH_NATIVE_SURFACE_LAYOUT_EVENT, handler);
  };
}

export function dispatchNativeSurfaceLayout(
  windowId: string,
  phase: NativeSurfaceLayoutPhase,
  scope: NativeSurfaceLayoutScope = 'window',
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<NativeSurfaceLayoutEventDetail>(WORKBENCH_NATIVE_SURFACE_LAYOUT_EVENT, {
      detail: { windowId, phase, scope },
    }),
  );
}

export function suspendNativeSurface(windowId: string): void {
  dispatchNativeSurfaceLayout(windowId, 'suspend');
}

export function resumeNativeSurface(windowId: string): void {
  dispatchNativeSurfaceLayout(windowId, 'resume');
}

/**
 * A compositor-only FLIP animation cannot be mirrored into a native child at
 * every animation frame. Temporarily yield every native surface until it ends.
 */
export function suspendAllNativeSurfaces(windowId: string): void {
  dispatchNativeSurfaceLayout(windowId, 'suspend', 'all');
}

export function resumeAllNativeSurfaces(windowId: string): void {
  dispatchNativeSurfaceLayout(windowId, 'resume', 'all');
}

export function syncNativeSurface(windowId: string): void {
  // 拖拽每帧调用的热路径：无消费者时短路，避免每帧分配事件对象
  if (consumerCount === 0) return;
  dispatchNativeSurfaceLayout(windowId, 'sync');
}
