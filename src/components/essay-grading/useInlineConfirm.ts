import { useCallback, useEffect, useRef, useState } from 'react';

/** 内联二段确认的自动复位时间 */
const INLINE_CONFIRM_TIMEOUT_MS = 3000;

/**
 * 内联二段确认：第一次点击进入"确认？"态，3 秒无操作自动复位，再次点击才执行。
 * 替代模态确认框（DsAlertDialog），桌面与移动统一交互。
 */
export function useInlineConfirm(onConfirm: () => void) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const handleClick = useCallback(() => {
    if (armed) {
      clearTimer();
      setArmed(false);
      onConfirm();
      return;
    }
    setArmed(true);
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      setArmed(false);
      timerRef.current = null;
    }, INLINE_CONFIRM_TIMEOUT_MS);
  }, [armed, clearTimer, onConfirm]);

  const reset = useCallback(() => {
    clearTimer();
    setArmed(false);
  }, [clearTimer]);

  return { armed, handleClick, reset };
}
