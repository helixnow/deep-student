import { useCallback, useEffect, useRef } from 'react';
import type React from 'react';

/** WebKit / Safari 在 compositionend 后仍派发同帧确认 Enter 的保护时间窗（ms） */
const POST_COMPOSITION_ENTER_GUARD_MS = 100;

export type ImeKeyEventLike =
  | KeyboardEvent
  | React.KeyboardEvent
  | {
      key?: string;
      isComposing?: boolean;
      keyCode?: number;
      nativeEvent?: {
        isComposing?: boolean;
        keyCode?: number;
      };
    };

export interface ImeCompositionGuard {
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  isComposingKeyEvent: (e: ImeKeyEventLike) => boolean;
}

/**
 * 共享 WebKit IME 组合输入守卫（兼容 macOS Tauri WKWebView / Safari）。
 *
 * Safari / WKWebView 在中文拼音、日文假名等输入法按 Enter 选词上屏时，
 * 可能先派发 `compositionend`，再在同帧或数毫秒内派发 `isComposing === false` 的 `keydown(Enter)`。
 * 本 Hook 同时追踪：
 * 1. 原生 `isComposing` / `keyCode === 229`；
 * 2. 组合进行态 ref（`compositionend` 后延后一帧经 `requestAnimationFrame` 复位）；
 * 3. `compositionend` 后 100ms 内的 `Enter` 按键保护窗口。
 */
export function useImeCompositionGuard(): ImeCompositionGuard {
  const composingRef = useRef(false);
  const endedAtRef = useRef(-Infinity);
  const resetFrameRef = useRef<number | null>(null);

  const cancelPendingReset = useCallback(() => {
    if (resetFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(resetFrameRef.current);
      resetFrameRef.current = null;
    }
  }, []);

  useEffect(() => cancelPendingReset, [cancelPendingReset]);

  const onCompositionStart = useCallback(() => {
    cancelPendingReset();
    composingRef.current = true;
  }, [cancelPendingReset]);

  const onCompositionEnd = useCallback(() => {
    endedAtRef.current = performance.now();
    cancelPendingReset();
    if (typeof requestAnimationFrame === 'function') {
      resetFrameRef.current = requestAnimationFrame(() => {
        resetFrameRef.current = null;
        composingRef.current = false;
      });
    } else {
      composingRef.current = false;
    }
  }, [cancelPendingReset]);

  const isComposingKeyEvent = useCallback((e: ImeKeyEventLike): boolean => {
    const native = 'nativeEvent' in e && e.nativeEvent ? e.nativeEvent : e;
    const isNativeComposing = 'isComposing' in native && native.isComposing === true;
    const keyCode =
      ('keyCode' in native ? native.keyCode : undefined) ??
      ('keyCode' in e ? e.keyCode : undefined);

    if (isNativeComposing || keyCode === 229 || composingRef.current) {
      return true;
    }
    if (
      e.key === 'Enter' &&
      performance.now() - endedAtRef.current < POST_COMPOSITION_ENTER_GUARD_MS
    ) {
      return true;
    }
    return false;
  }, []);

  return {
    onCompositionStart,
    onCompositionEnd,
    isComposingKeyEvent,
  };
}
