/**
 * useWindowPointer（主责 P2）— WindowShell 消费的拖拽/缩放 hook
 *
 * 实现冻结接口 WindowPointerCallbacks 的消费端封装：
 * - 返回稳定的 startMove / startResize 手柄绑定函数，hook 自身 0 状态、0 重渲染；
 * - 过程回调（onFrameChange/onSnapZoneChange）由调用方直写 DOM；
 * - minSize 从 appRegistry 按 typeId 读取（缺省 FALLBACK_MIN_SIZE）；
 * - desktopSize 手势期间从 windowStore 非响应式读取（getState）。
 * - move 启动阈值：过 MOVE_ARM_THRESHOLD_PX 后才触发 onMoveArmed（tear-out / 壳层抬升）。
 * - ⌥/Alt：引擎从 PointerEvent.altKey 传入 snapZones，扩大平铺热区（L5）。
 *
 * 用法（P3 WindowShell）：
 *   const pointer = useWindowPointer({ typeId, getFrame, callbacks, onMoveArmed });
 *   <div className="wb-titlebar" onPointerDown={pointer.startMove} />
 *   <div className="wb-resize-e" onPointerDown={(e) => pointer.startResize(e, 'e')} />
 */
import { useEffect, useMemo, useRef } from 'react';
import type React from 'react';
import type { Frame, Size, WindowPointerCallbacks } from '../../core/types';
import {
  FALLBACK_MIN_SIZE,
  WindowPointerEngine,
  type GestureKind,
  type ResizeEdge,
} from '../../core/pointerEngine';
import { appRegistry } from '../../core/appRegistry';
import { useWindowStore } from '../../core/windowStore';
import type { EdgeSnapCandidates } from '../../core/edgeSnapping';

export type { ResizeEdge } from '../../core/pointerEngine';

export interface UseWindowPointerOptions {
  /** 用于从 appRegistry 读取 minSize */
  typeId: string;
  /** 手势起始时读取当前视觉 frame（tiled/maximized 窗口传 computeTiledFrame 结果） */
  getFrame: () => Frame;
  callbacks: WindowPointerCallbacks;
  /** 桌面区左上角相对视口的偏移（吸附命中用），缺省 (0,0) */
  getDesktopOffset?: () => { x: number; y: number };
  /** move 手势吸附开关，缺省 true */
  enableSnap?: boolean;
  /** 释放惯性滑行开关，缺省 false（跟手优先） */
  enableInertia?: boolean;
  /** 吸附磁吸位移开关，缺省 false（避免误吸） */
  enableMagnet?: boolean;
  /**
   * 邻窗边缘磁吸候选线（Sequoia 拖窗对齐）：move 手势开始时读取一次并快照。
   * 缺省 / 返回 null 时关闭。provider 内禁止查询 DOM 布局。
   */
  getEdgeSnapCandidates?: () => EdgeSnapCandidates | null;
  /** true 时忽略所有手势启动（如窗口 minimized 动画期间） */
  disabled?: boolean;
  /**
   * move 越过启动阈值时回调一次（tear-out）。
   * resize 不触发（resize 在 startResize 时即武装）。
   */
  onMoveArmed?: (point: { x: number; y: number }) => void;
  /** move 未过阈值就结束（纯点击）——撤掉 pointerdown 壳层抬升 */
  onMoveDismissed?: () => void;
}

export interface UseWindowPointerResult {
  /** 绑定到标题栏 onPointerDown */
  startMove: (e: React.PointerEvent) => void;
  /** 绑定到缩放手柄 onPointerDown */
  startResize: (e: React.PointerEvent, edge: ResizeEdge) => void;
  /** 强制取消当前手势（回退到起始 frame）；settle 动画阶段则立即定格 commit */
  cancel: () => void;
  /** 非响应式查询：当前是否有进行中手势 / 手势类型 */
  isDragging: () => boolean;
  /** 非响应式：move 是否已过启动阈值（resize 起始即 true） */
  isArmed: () => boolean;
  activeGesture: () => GestureKind | null;
  /** 非响应式查询：释放后的惯性/回弹动画是否进行中（O2） */
  isSettling: () => boolean;
}

export function useWindowPointer(options: UseWindowPointerOptions): UseWindowPointerResult {
  // 全部通过 ref 透传，保证 engine 与返回的手柄函数终身稳定（0 重渲染）
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const engineRef = useRef<WindowPointerEngine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = new WindowPointerEngine({
      getFrame: () => optionsRef.current.getFrame(),
      getDesktopSize: () => useWindowStore.getState().desktopSize,
      getMinSize: (): Size =>
        appRegistry.get(optionsRef.current.typeId)?.minSize ?? FALLBACK_MIN_SIZE,
      getCallbacks: (): WindowPointerCallbacks => optionsRef.current.callbacks,
      getDesktopOffset: () => optionsRef.current.getDesktopOffset?.() ?? { x: 0, y: 0 },
      getEdgeSnapCandidates: () => optionsRef.current.getEdgeSnapCandidates?.() ?? null,
      get enableSnap() {
        return optionsRef.current.enableSnap !== false;
      },
      get enableInertia() {
        return optionsRef.current.enableInertia === true;
      },
      get enableMagnet() {
        return optionsRef.current.enableMagnet === true;
      },
      onMoveArmed: (point) => optionsRef.current.onMoveArmed?.(point),
      onMoveDismissed: () => optionsRef.current.onMoveDismissed?.(),
    });
  }

  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
    };
  }, []);

  return useMemo<UseWindowPointerResult>(() => {
    const engine = engineRef.current!;
    return {
      startMove: (e) => {
        if (optionsRef.current.disabled) return;
        engine.startMove(e.nativeEvent, e.currentTarget as Element);
      },
      startResize: (e, edge) => {
        if (optionsRef.current.disabled) return;
        engine.startResize(e.nativeEvent, edge, e.currentTarget as Element);
      },
      cancel: () => engine.cancel(),
      isDragging: () => engine.isActive(),
      isArmed: () => engine.isArmed(),
      activeGesture: () => engine.currentGesture(),
      isSettling: () => engine.isSettling(),
    };
  }, []);
}
