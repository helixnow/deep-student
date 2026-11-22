import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { NotesFocusModeEventDetail } from '../focusModeOwnership';

/** 焦点模式 chrome 淡出/淡入时长（与 notes-editor-chrome.css 的过渡对齐） */
export const FOCUS_CHROME_TRANSITION_MS = 200;

export type FocusChromePhase = 'visible' | 'exiting' | 'hidden' | 'restoring';

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface UseNoteFocusModeOptions {
  /** Focus-mode events affect only this owning Notes workspace. */
  focusModeScopeId?: string;
}

export interface UseNoteFocusModeResult {
  focusMode: boolean;
  setFocusMode: React.Dispatch<React.SetStateAction<boolean>>;
  focusModeRef: React.MutableRefObject<boolean>;
  focusModeOwnerId: string;
  focusChromePhase: FocusChromePhase;
  /** True only after chrome fade-out finishes (for `data-focus-mode="true"`). */
  isChromeHidden: boolean;
  toggleFocusMode: () => void;
}

export function useNoteFocusMode({
  focusModeScopeId,
}: UseNoteFocusModeOptions = {}): UseNoteFocusModeResult {
  const [focusMode, setFocusMode] = useState(false);
  const focusModeOwnerId = useId();
  const focusModeRef = useRef(false);

  // 焦点模式沉浸过渡：进入时 chrome 先 200ms 淡出再真正隐藏（display:none），
  // 退出时立即恢复布局并播放 200ms 淡入；reduced-motion 下直接切换。
  const [focusChromePhase, setFocusChromePhase] = useState<FocusChromePhase>('visible');

  useEffect(() => {
    if (focusMode) {
      if (prefersReducedMotion()) {
        setFocusChromePhase('hidden');
        return;
      }
      setFocusChromePhase('exiting');
      const timer = window.setTimeout(
        () => setFocusChromePhase('hidden'),
        FOCUS_CHROME_TRANSITION_MS,
      );
      return () => window.clearTimeout(timer);
    }
    if (prefersReducedMotion()) {
      setFocusChromePhase('visible');
      return;
    }
    setFocusChromePhase((prev) => (prev === 'visible' ? prev : 'restoring'));
    const timer = window.setTimeout(
      () => setFocusChromePhase('visible'),
      FOCUS_CHROME_TRANSITION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [focusMode]);

  const toggleFocusMode = useCallback(() => {
    setFocusMode((enabled) => !enabled);
  }, []);

  const publishFocusMode = useCallback(
    (enabled: boolean) => {
      if (!focusModeScopeId) return;
      window.dispatchEvent(
        new CustomEvent<NotesFocusModeEventDetail>('notes:focus-mode-changed', {
          detail: { ownerId: focusModeOwnerId, scopeId: focusModeScopeId, enabled },
        }),
      );
    },
    [focusModeOwnerId, focusModeScopeId],
  );

  useEffect(() => {
    focusModeRef.current = focusMode;
    publishFocusMode(focusMode);
  }, [focusMode, publishFocusMode]);

  useEffect(
    () => () => {
      if (focusModeRef.current) publishFocusMode(false);
    },
    [publishFocusMode],
  );

  return {
    focusMode,
    setFocusMode,
    focusModeRef,
    focusModeOwnerId,
    focusChromePhase,
    isChromeHidden: focusMode && focusChromePhase === 'hidden',
    toggleFocusMode,
  };
}
