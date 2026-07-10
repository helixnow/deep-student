/**
 * P2 useWindowPointer → P3 WindowShellPointerHook 适配器（P11 接线）
 *
 * WindowShell 通过 `usePointer` 注入口消费本 hook（也是其默认实现，
 * 见 WindowShell.tsx 的一行替换点）。相比 P3 的临时兜底实现，
 * 本适配器接入完整指针引擎：吸附命中（hitTestSnapZone + ⌥/altKey 扩热区）、Esc/
 * pointercancel/lostpointercapture/blur 四路回退、rAF 合帧 0 重渲染。
 *
 * 按下即跟手：pointerdown 立即 onDragStateChange(true)；
 * 引擎用极小阈值区分「纯点击」（onMoveDismissed 撤壳层）与「拖动 commit」，
 * 以及 maximized/tiled tear-out（仅改 DOM，松手才写 store）。
 *
 * 桌面偏移：吸附命中需要把指针视口坐标换算到桌面坐标系。
 * WorkbenchDesktop 经 ResizeObserver 写入快照后，用
 * setWorkbenchDesktopOffsetProvider 注册「只读缓存」；PointerEngine 仅在
 * 手势开始读一次。ANTI-REGRESSION：provider 内禁止 getBoundingClientRect，
 * 否则起拖样式写入会与同步布局读取相撞（Win/macOS/Linux 同病）。
 */
import { useMemo, useRef } from 'react';
import { useWindowStore } from '../../core/windowStore';
import type { Frame } from '../../core/types';
import { useWindowPointer } from './useWindowPointer';
import type {
  WindowShellPointerArgs,
  WindowShellPointerResult,
} from '../WindowShell';

type OffsetProvider = () => { x: number; y: number };

let desktopOffsetProvider: OffsetProvider | null = null;

/** WorkbenchDesktop 注册桌面区左上角相对视口偏移；传 null 注销 */
export function setWorkbenchDesktopOffsetProvider(provider: OffsetProvider | null): void {
  desktopOffsetProvider = provider;
}

export function getWorkbenchDesktopOffset(): { x: number; y: number } {
  return desktopOffsetProvider?.() ?? { x: 0, y: 0 };
}

/** WindowShellPointerHook 形状的适配实现（引擎与手柄终身稳定，0 重渲染） */
export function useWorkbenchWindowPointer(
  args: WindowShellPointerArgs,
): WindowShellPointerResult {
  const argsRef = useRef(args);
  argsRef.current = args;

  // typeId 只用于 minSize 查询，窗口存续期内不变
  const typeId =
    useWindowStore.getState().windows[args.windowId]?.typeId ?? '';

  const pointer = useWindowPointer({
    typeId,
    getFrame: (): Frame => ({ ...(argsRef.current.frameRef.current as Frame) }),
    callbacks: {
      onFrameChange: (frame) => argsRef.current.callbacks.onFrameChange(frame),
      onSnapZoneChange: (zone) => argsRef.current.callbacks.onSnapZoneChange(zone),
      onCommit: (frame, zone) => {
        // 引擎所有结束路径（松手 / Esc / pointercancel / blur）都会走 onCommit
        // （未过 move 阈值的纯点击不走此处）
        argsRef.current.onDragStateChange?.(false);
        argsRef.current.callbacks.onCommit(frame, zone);
      },
    },
    getDesktopOffset: getWorkbenchDesktopOffset,
    onMoveArmed: (point) => {
      // 过阈值：仅 tear-out（若需要）；壳层已在 pointerdown 抬升
      argsRef.current.onMoveArmed?.(point);
    },
    onMoveDismissed: () => {
      // 纯点击：撤掉 pointerdown 时抬升的壳层
      argsRef.current.onDragStateChange?.(false);
    },
  });

  return useMemo<WindowShellPointerResult>(
    () => ({
      onMovePointerDown: (e) => {
        // 按下即进入拖拽壳层（光标 / 内容 pointer-events），与现代 OS 一致
        argsRef.current.onDragStateChange?.(true);
        pointer.startMove(e);
      },
      onResizePointerDown: (dir, e) => {
        argsRef.current.onDragStateChange?.(true);
        pointer.startResize(e, dir);
      },
    }),
    [pointer],
  );
}
