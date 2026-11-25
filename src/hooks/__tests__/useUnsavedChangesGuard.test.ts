import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UNSAVED_CHANGES_COPY,
  useUnsavedChangesGuard,
} from '../useUnsavedChangesGuard';

describe('useUnsavedChangesGuard (U03)', () => {
  it('closes immediately without prompting when clean', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useUnsavedChangesGuard({ isDirty: false }));

    expect(result.current.isDirty).toBe(false);
    expect(result.current.isConfirming).toBe(false);
    expect(result.current.copy).toEqual(DEFAULT_UNSAVED_CHANGES_COPY);

    let closed = false;
    act(() => {
      closed = result.current.requestClose(onClose);
    });

    expect(closed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.current.isConfirming).toBe(false);
  });

  it('intercepts close when dirty, supports continueEditing and confirmDiscard with onDiscard before close', () => {
    const events: string[] = [];
    const onClose = vi.fn(() => events.push('close'));
    const onDiscard = vi.fn(() => events.push('discard'));
    const onContinueEditing = vi.fn(() => events.push('continue'));

    const { result } = renderHook(() =>
      useUnsavedChangesGuard({
        onDiscard,
        onContinueEditing,
      }),
    );

    act(() => {
      result.current.markDirty();
    });
    expect(result.current.isDirty).toBe(true);

    let closed = true;
    act(() => {
      closed = result.current.requestClose(onClose);
    });

    expect(closed).toBe(false);
    expect(result.current.isConfirming).toBe(true);
    expect(result.current.copy.message).toBe('有未保存修改，确定放弃？');
    expect(result.current.copy.continueLabel).toBe('继续编辑');
    expect(result.current.copy.discardLabel).toBe('放弃修改');
    expect(onClose).not.toHaveBeenCalled();

    // Choosing "继续编辑" keeps dirty state and stays open
    act(() => {
      result.current.continueEditing();
    });
    expect(result.current.isConfirming).toBe(false);
    expect(result.current.isDirty).toBe(true);
    expect(onContinueEditing).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    // Request close again and choose "放弃修改"
    act(() => {
      result.current.requestClose(onClose);
    });
    expect(result.current.isConfirming).toBe(true);

    act(() => {
      result.current.confirmDiscard();
    });

    expect(result.current.isConfirming).toBe(false);
    expect(result.current.isDirty).toBe(false);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['continue', 'discard', 'close']);
  });

  it('auto-dismisses confirmation prompt when controlled isDirty transitions back to false', () => {
    const onClose = vi.fn();
    const { result, rerender } = renderHook(
      ({ dirty }: { dirty: boolean }) => useUnsavedChangesGuard(dirty),
      { initialProps: { dirty: true } },
    );

    act(() => {
      result.current.requestClose(onClose);
    });
    expect(result.current.isConfirming).toBe(true);

    // Form saved externally -> dirty becomes false -> prompt auto-dismisses without closing
    rerender({ dirty: false });
    expect(result.current.isConfirming).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('uses synchronous getIsDirty reader so same-tick edits cannot slip past requestClose', () => {
    let draftDirty = false;
    const onClose = vi.fn();
    const { result } = renderHook(() =>
      useUnsavedChangesGuard({
        isDirty: false,
        getIsDirty: () => draftDirty,
      }),
    );

    draftDirty = true;
    let closed = true;
    act(() => {
      closed = result.current.requestClose(onClose);
    });

    expect(closed).toBe(false);
    expect(result.current.isConfirming).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('registers beforeunload warning only when warnBeforeUnload is enabled and form is dirty', () => {
    const { rerender, unmount } = renderHook(
      ({ dirty }: { dirty: boolean }) =>
        useUnsavedChangesGuard({ isDirty: dirty, warnBeforeUnload: true }),
      { initialProps: { dirty: true } },
    );

    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);

    rerender({ dirty: false });
    const cleanEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    unmount();
  });
});
