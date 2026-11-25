import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addTypedEventListener } from '@/events';

export interface UnsavedChangesGuardCopy {
  /** Inline prompt shown when closing a dirty form. */
  message: string;
  /** Safe default action: dismiss prompt and keep editing. */
  continueLabel: string;
  /** Destructive action: discard unsaved edits and proceed with closing. */
  discardLabel: string;
}

export const DEFAULT_UNSAVED_CHANGES_COPY: UnsavedChangesGuardCopy = {
  message: '有未保存修改，确定放弃？',
  continueLabel: '继续编辑',
  discardLabel: '放弃修改',
};

export interface UseUnsavedChangesGuardOptions {
  /**
   * Controlled dirty flag. When omitted, the hook manages an internal dirty flag
   * updated via `markDirty()`, `markClean()`, and `setDirty(next)`.
   */
  isDirty?: boolean;
  /**
   * Optional synchronous dirty reader (e.g., comparing `draftRef` vs `committedRef`)
   * so same-tick close requests never observe stale React state.
   */
  getIsDirty?: () => boolean;
  /** Optional custom copy overrides for the inline confirmation state. */
  copy?: Partial<UnsavedChangesGuardCopy>;
  /** Invoked when the user confirms discarding changes, right before running the pending close callback. */
  onDiscard?: () => void;
  /** Invoked when the user dismisses the confirmation prompt to keep editing. */
  onContinueEditing?: () => void;
  /** Attach a `beforeunload` warning while dirty (default: false). */
  warnBeforeUnload?: boolean;
}

export interface UnsavedChangesGuardResult {
  /** Whether unsaved edits are currently present. */
  isDirty: boolean;
  /** Whether the inline discard confirmation prompt is currently active. */
  isConfirming: boolean;
  /** Resolved prompt and button copy. */
  copy: UnsavedChangesGuardCopy;
  /** Mark internal dirty state as dirty (uncontrolled mode). */
  markDirty: () => void;
  /** Mark internal dirty state as clean and dismiss any active prompt. */
  markClean: () => void;
  /** Set internal dirty state directly (uncontrolled mode). */
  setDirty: (dirty: boolean) => void;
  /**
   * Request to close/leave the current form.
   * - Clean: invokes `onConfirmClose` immediately and returns `true`.
   * - Dirty: enters inline confirmation state, stores `onConfirmClose`, and returns `false`.
   */
  requestClose: (onConfirmClose: () => void) => boolean;
  /** Dismiss the confirmation prompt and stay in editing mode ("继续编辑"). */
  continueEditing: () => void;
  /** Discard unsaved edits, close the prompt, and execute the pending close callback ("放弃修改"). */
  confirmDiscard: () => void;
  /** Dismiss the confirmation prompt without running `onContinueEditing` or `onDiscard`. */
  resetPrompt: () => void;
}

/**
 * Reusable dirty-form protection hook (U03).
 *
 * Intercepts accidental close / Escape / backdrop / tab-switch actions when unsaved edits exist,
 * surfacing a lightweight inline confirmation state ("有未保存修改，确定放弃？" / "继续编辑" / "放弃修改")
 * instead of silently discarding user input.
 */
export function useUnsavedChangesGuard(
  optionsOrDirty?: boolean | UseUnsavedChangesGuardOptions,
): UnsavedChangesGuardResult {
  const normalizedOptions: UseUnsavedChangesGuardOptions =
    typeof optionsOrDirty === 'boolean' ? { isDirty: optionsOrDirty } : (optionsOrDirty ?? {});

  const isControlled = typeof normalizedOptions.isDirty === 'boolean';
  const [internalDirty, setInternalDirty] = useState(false);
  const internalDirtyRef = useRef(false);

  const isDirty = isControlled ? Boolean(normalizedOptions.isDirty) : internalDirty;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const [isConfirming, setIsConfirming] = useState(false);
  const pendingCloseRef = useRef<(() => void) | null>(null);

  const optionsRef = useRef(normalizedOptions);
  optionsRef.current = normalizedOptions;

  const readDirtyNow = useCallback((): boolean => {
    if (typeof optionsRef.current.getIsDirty === 'function') {
      return Boolean(optionsRef.current.getIsDirty());
    }
    return isControlled ? isDirtyRef.current : internalDirtyRef.current;
  }, [isControlled]);

  // If the form becomes clean (e.g., saved externally or reverted back to original),
  // automatically dismiss any open discard-confirmation prompt.
  useEffect(() => {
    if (!isDirty && isConfirming && !readDirtyNow()) {
      pendingCloseRef.current = null;
      setIsConfirming(false);
    }
  }, [isDirty, isConfirming, readDirtyNow]);

  // Optional browser unload guard when callers opt in.
  useEffect(() => {
    if (!normalizedOptions.warnBeforeUnload || !isDirty || typeof window === 'undefined') {
      return;
    }
    return addTypedEventListener<unknown>('beforeunload', (_detail, rawEvent) => {
      if (!readDirtyNow()) return;
      const beforeUnloadEvent = rawEvent as unknown as BeforeUnloadEvent;
      beforeUnloadEvent.preventDefault();
      beforeUnloadEvent.returnValue = '';
    });
  }, [normalizedOptions.warnBeforeUnload, isDirty, readDirtyNow]);

  const setDirty = useCallback((dirty: boolean) => {
    internalDirtyRef.current = dirty;
    setInternalDirty(dirty);
    if (!dirty) {
      pendingCloseRef.current = null;
      setIsConfirming(false);
    }
  }, []);

  const markDirty = useCallback(() => {
    setDirty(true);
  }, [setDirty]);

  const markClean = useCallback(() => {
    setDirty(false);
  }, [setDirty]);

  const requestClose = useCallback(
    (onConfirmClose: () => void): boolean => {
      if (!readDirtyNow()) {
        pendingCloseRef.current = null;
        setIsConfirming(false);
        onConfirmClose();
        return true;
      }
      pendingCloseRef.current = onConfirmClose;
      setIsConfirming(true);
      return false;
    },
    [readDirtyNow],
  );

  const continueEditing = useCallback(() => {
    pendingCloseRef.current = null;
    setIsConfirming(false);
    optionsRef.current.onContinueEditing?.();
  }, []);

  const confirmDiscard = useCallback(() => {
    const pendingClose = pendingCloseRef.current;
    pendingCloseRef.current = null;
    setIsConfirming(false);
    internalDirtyRef.current = false;
    setInternalDirty(false);
    // Run onDiscard BEFORE pendingClose so unmounting components won't auto-flush discarded text.
    optionsRef.current.onDiscard?.();
    pendingClose?.();
  }, []);

  const resetPrompt = useCallback(() => {
    pendingCloseRef.current = null;
    setIsConfirming(false);
  }, []);

  const copy = useMemo<UnsavedChangesGuardCopy>(
    () => ({
      message: normalizedOptions.copy?.message ?? DEFAULT_UNSAVED_CHANGES_COPY.message,
      continueLabel:
        normalizedOptions.copy?.continueLabel ?? DEFAULT_UNSAVED_CHANGES_COPY.continueLabel,
      discardLabel:
        normalizedOptions.copy?.discardLabel ?? DEFAULT_UNSAVED_CHANGES_COPY.discardLabel,
    }),
    [
      normalizedOptions.copy?.message,
      normalizedOptions.copy?.continueLabel,
      normalizedOptions.copy?.discardLabel,
    ],
  );

  return {
    isDirty,
    isConfirming,
    copy,
    markDirty,
    markClean,
    setDirty,
    requestClose,
    continueEditing,
    confirmDiscard,
    resetPrompt,
  };
}

export default useUnsavedChangesGuard;
