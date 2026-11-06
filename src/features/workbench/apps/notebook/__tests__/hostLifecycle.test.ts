import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetWindowStoreForTests, useWindowStore } from '../../../core/windowStore';
import { confirmWindowClose, isWindowDirty } from '../../../core/windowCloseGuard';
import { recomputeLifecycles, resetSchedulerTransientsForTests, setFreezeGraceOverride, setMemoryBudgetOverride } from '../../../core/scheduler';
import { __resetContentDirtyRegistry, hasContentSaveHandler, isContentDirty, registerContentDirtyChecker, registerContentSaveHandler, saveContentNow } from '../../content/contentDirtyRegistry';
import { flushInkEditor, hasDirtyInkEditor, registerInkEditorSession } from '@/features/ink/editorSession';
import { notebookAppDefinition } from '../register';
import { canCloseNotebook, canSuspendNotebook, notifyNotebookHostChanged, registerNotebookHost, type NotebookHostState } from '../hostLifecycle';

beforeEach(() => {
  resetWindowStoreForTests();
  resetSchedulerTransientsForTests();
  setMemoryBudgetOverride(null);
  setFreezeGraceOverride(null);
  __resetContentDirtyRegistry();
});

function hostState(overrides: Partial<NotebookHostState> = {}): NotebookHostState {
  return { writing: false, busy: false, isDirty: () => false, flush: async () => true, ...overrides };
}

function openNotebook(): string {
  return useWindowStore.getState().openWindow({ typeId: notebookAppDefinition.typeId });
}

describe('notebook host lifecycle guards', () => {
  it('fails closed before the lazy consumer reports its state', async () => {
    const windowId = openNotebook();
    expect(canSuspendNotebook()).toBe(false);
    await expect(confirmWindowClose(windowId)).resolves.toBe(false);
    registerNotebookHost(windowId, () => null);
    expect(isWindowDirty(windowId)).toBe(true);
    await expect(confirmWindowClose(windowId)).resolves.toBe(false);
  });

  it('allows clean idle library close and safe frozen unmount', async () => {
    const windowId = openNotebook();
    const unregister = registerNotebookHost(windowId, () => hostState());
    expect(canSuspendNotebook()).toBe(true);
    expect(isWindowDirty(windowId)).toBe(false);
    await expect(confirmWindowClose(windowId)).resolves.toBe(true);
    unregister();
    expect(canSuspendNotebook()).toBe(true);
    await expect(confirmWindowClose(windowId)).resolves.toBe(true);
  });

  it('waits for a real ink editor session flush and rechecks dirty state', async () => {
    const windowId = openNotebook();
    let dirty = true;
    let resolveSave!: () => void;
    const flush = vi.fn(() => new Promise<void>((resolve) => { resolveSave = () => { dirty = false; resolve(); }; }));
    const unregisterSession = registerInkEditorSession({
      key: { document_id: 'file_guard', page_id: 'page_guard' },
      isDirty: () => dirty, flush, persistDraft: async () => undefined,
    });
    const state = hostState({
      writing: true, isDirty: () => hasDirtyInkEditor('file_guard'),
      flush: async () => (await flushInkEditor('file_guard')).ok,
    });
    registerNotebookHost(windowId, () => state);
    try {
      const closing = confirmWindowClose(windowId);
      await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
      expect(canSuspendNotebook()).toBe(false);
      expect(isWindowDirty(windowId)).toBe(true);
      expect(useWindowStore.getState().windows[windowId]).toBeDefined();
      resolveSave();
      await expect(closing).resolves.toBe(true);
      expect(canSuspendNotebook()).toBe(false);
    } finally {
      unregisterSession();
    }
  });

  it.each(['false', 'throw', 'still-dirty'] as const)('retains the window after a %s save failure', async (failure) => {
    const windowId = openNotebook();
    const state = hostState({ writing: true, isDirty: () => failure === 'still-dirty', flush: async () => {
      if (failure === 'throw') throw new Error('save failed');
      return failure !== 'false';
    } });
    registerNotebookHost(windowId, () => state);
    await expect(confirmWindowClose(windowId)).resolves.toBe(false);
    expect(useWindowStore.getState().windows[windowId]).toBeDefined();
    expect(canSuspendNotebook()).toBe(false);
  });

  it('saves text notes through real registered save handlers and refuses missing handlers', async () => {
    const windowId = openNotebook();
    let dirty = true;
    const stopDirty = registerContentDirtyChecker('note', 'note_guard', () => dirty);
    const state = hostState({
      writing: true, isDirty: () => isContentDirty('note', 'note_guard'),
      flush: async () => hasContentSaveHandler('note', 'note_guard') && await saveContentNow('note', 'note_guard'),
    });
    registerNotebookHost(windowId, () => state);
    await expect(confirmWindowClose(windowId)).resolves.toBe(false);
    const save = vi.fn(async () => { dirty = false; });
    const stopSave = registerContentSaveHandler('note', 'note_guard', save);
    try {
      await expect(confirmWindowClose(windowId)).resolves.toBe(true);
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      stopSave();
      stopDirty();
    }
  });

  it('does not allow an asynchronous save result to close a different active resource', async () => {
    const windowId = openNotebook();
    let resolveSave!: (result: boolean) => void;
    let state = hostState({ writing: true, flush: () => new Promise((resolve) => { resolveSave = resolve; }) });
    registerNotebookHost(windowId, () => state);
    const closing = confirmWindowClose(windowId);
    await vi.waitFor(() => expect(resolveSave).toBeTypeOf('function'));
    state = hostState({ writing: true, isDirty: () => true });
    notifyNotebookHostChanged(windowId);
    resolveSave(true);
    await expect(closing).resolves.toBe(false);
  });

  it('does not freeze busy, writing, or dirty notebook windows under memory pressure', () => {
    setMemoryBudgetOverride(0);
    setFreezeGraceOverride(0);
    try {
      const windowId = openNotebook();
      let state = hostState({ writing: true });
      registerNotebookHost(windowId, () => state);
      useWindowStore.getState().minimizeWindow(windowId);
      recomputeLifecycles();
      expect(useWindowStore.getState().lifecycles[windowId]).toBe('background');
      state = hostState({ busy: true });
      notifyNotebookHostChanged(windowId);
      recomputeLifecycles();
      expect(useWindowStore.getState().lifecycles[windowId]).toBe('background');
      state = hostState({ isDirty: () => true });
      notifyNotebookHostChanged(windowId);
      recomputeLifecycles();
      expect(useWindowStore.getState().lifecycles[windowId]).toBe('background');
      state = hostState();
      notifyNotebookHostChanged(windowId);
      recomputeLifecycles();
      expect(useWindowStore.getState().lifecycles[windowId]).toBe('frozen');
    } finally {
      setMemoryBudgetOverride(null);
      setFreezeGraceOverride(null);
    }
  });

  it('treats missing consumers and throwing dirty checks as unsafe', async () => {
    const windowId = openNotebook();
    registerNotebookHost(windowId, () => hostState({ isDirty: () => { throw new Error('dirty query failed'); } }));
    expect(canSuspendNotebook()).toBe(false);
    await expect(canCloseNotebook()).resolves.toBe(false);
  });
});
