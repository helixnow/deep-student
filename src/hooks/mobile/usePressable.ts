/**
 * usePressable — 触控按压反馈 hook，配合 .ui-press（src/styles/ui-motion.css）。
 *
 * 纯 CSS 场景直接加 `className="ui-press"` 即可（:active 缩放，
 * reduced-motion 自动降级），无需本 hook。需要 JS 侧感知按压态
 * （改变图标、触发触觉反馈、驱动 framer-motion scale）时使用本 hook。
 *
 * 接入示例：
 * ```tsx
 * const { isPressed, bind, pressClassName } = usePressable({
 *   onPressStart: () => haptics.impact('light'),
 * });
 * return (
 *   <button {...bind} className={cn(pressClassName, isPressed && 'bg-accent')}>
 *     …
 *   </button>
 * );
 * ```
 */

import { useCallback, useMemo, useState } from 'react';
import type * as React from 'react';

export interface UsePressableOptions {
  /** 为 true 时不进入按压态。 */
  disabled?: boolean;
  /** 按下（pointerdown）回调。 */
  onPressStart?: () => void;
  /** 抬起/取消回调（仅在曾进入按压态后触发）。 */
  onPressEnd?: () => void;
}

export interface PressableBind {
  onPointerDown: React.PointerEventHandler;
  onPointerUp: React.PointerEventHandler;
  onPointerCancel: React.PointerEventHandler;
  onPointerLeave: React.PointerEventHandler;
}

export interface UsePressableResult {
  /** 当前是否处于按压态。 */
  isPressed: boolean;
  /** 展开到目标元素上的事件绑定。 */
  bind: PressableBind;
  /** 按压缩放视觉类（等于 'ui-press'，由 CSS token --m-press-* 驱动）。 */
  pressClassName: string;
}

export function usePressable(options: UsePressableOptions = {}): UsePressableResult {
  const { disabled, onPressStart, onPressEnd } = options;
  const [isPressed, setIsPressed] = useState(false);

  const press = useCallback(() => {
    if (disabled) return;
    setIsPressed(true);
    onPressStart?.();
  }, [disabled, onPressStart]);

  const release = useCallback(() => {
    setIsPressed((prev) => {
      if (prev) onPressEnd?.();
      return false;
    });
  }, [onPressEnd]);

  const bind = useMemo<PressableBind>(
    () => ({
      onPointerDown: (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        press();
      },
      onPointerUp: release,
      onPointerCancel: release,
      onPointerLeave: release,
    }),
    [press, release],
  );

  return { isPressed, bind, pressClassName: 'ui-press' };
}

export default usePressable;
