import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  NOTES_NAV_HISTORY_MAX,
  backNavHistory,
  canNavBack,
  canNavForward,
  createNotesNavHistoryState,
  forwardNavHistory,
  matchNotesNavHistoryShortcut,
  pruneNavHistory,
  pushNavHistory,
  useNotesNavHistory,
  type NotesNavHistoryEntry,
} from '../hooks/useNotesNavHistory';

function entry(
  type: NotesNavHistoryEntry['type'],
  id: string,
): NotesNavHistoryEntry {
  return { key: `${type}:${id}`, type, id };
}

describe('notesNavHistory pure logic', () => {
  it('push ignores the same entry as the current cursor', () => {
    let state = createNotesNavHistoryState();
    state = pushNavHistory(state, entry('note', 'a'));
    const again = pushNavHistory(state, entry('note', 'a'));
    expect(again).toBe(state);
    expect(again.stack).toHaveLength(1);
  });

  it('push truncates the forward stack', () => {
    let state = createNotesNavHistoryState();
    state = pushNavHistory(state, entry('note', 'a'));
    state = pushNavHistory(state, entry('note', 'b'));
    state = pushNavHistory(state, entry('note', 'c'));
    ({ state } = backNavHistory(state));
    ({ state } = backNavHistory(state));
    expect(state.stack.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(state.index).toBe(0);

    state = pushNavHistory(state, entry('mindmap', 'x'));
    expect(state.stack.map((item) => item.id)).toEqual(['a', 'x']);
    expect(state.index).toBe(1);
    expect(canNavForward(state)).toBe(false);
  });

  it('back and forward move the cursor and return the target entry', () => {
    let state = createNotesNavHistoryState();
    state = pushNavHistory(state, entry('note', 'a'));
    state = pushNavHistory(state, entry('note', 'b'));
    state = pushNavHistory(state, entry('note', 'c'));

    let result = backNavHistory(state);
    expect(result.entry).toEqual(entry('note', 'b'));
    state = result.state;
    expect(canNavBack(state)).toBe(true);
    expect(canNavForward(state)).toBe(true);

    result = backNavHistory(state);
    expect(result.entry).toEqual(entry('note', 'a'));
    state = result.state;
    expect(canNavBack(state)).toBe(false);

    result = forwardNavHistory(state);
    expect(result.entry).toEqual(entry('note', 'b'));
    state = result.state;

    result = forwardNavHistory(state);
    expect(result.entry).toEqual(entry('note', 'c'));
    state = result.state;
    expect(canNavForward(state)).toBe(false);
  });

  it('back/forward at the edges are no-ops', () => {
    const empty = createNotesNavHistoryState();
    expect(backNavHistory(empty)).toEqual({ state: empty, entry: null });
    expect(forwardNavHistory(empty)).toEqual({ state: empty, entry: null });

    let state = pushNavHistory(empty, entry('note', 'only'));
    const back = backNavHistory(state);
    expect(back.entry).toBeNull();
    expect(back.state).toBe(state);

    const forward = forwardNavHistory(state);
    expect(forward.entry).toBeNull();
    expect(forward.state).toBe(state);
  });

  it('caps stack length at NOTES_NAV_HISTORY_MAX and drops the oldest', () => {
    let state = createNotesNavHistoryState();
    for (let i = 0; i < NOTES_NAV_HISTORY_MAX + 5; i += 1) {
      state = pushNavHistory(state, entry('note', `n${i}`));
    }
    expect(state.stack).toHaveLength(NOTES_NAV_HISTORY_MAX);
    expect(state.stack[0]?.id).toBe('n5');
    expect(state.stack[state.stack.length - 1]?.id).toBe(`n${NOTES_NAV_HISTORY_MAX + 4}`);
    expect(state.index).toBe(NOTES_NAV_HISTORY_MAX - 1);
  });

  it('prune removes matching keys and keeps a valid cursor', () => {
    let state = createNotesNavHistoryState();
    state = pushNavHistory(state, entry('note', 'a'));
    state = pushNavHistory(state, entry('note', 'b'));
    state = pushNavHistory(state, entry('note', 'c'));
    state = pushNavHistory(state, entry('note', 'b'));

    state = pruneNavHistory(state, 'note:b');
    expect(state.stack.map((item) => item.id)).toEqual(['a', 'c']);
    expect(state.index).toBe(1);
    expect(state.stack[state.index]?.id).toBe('c');

    state = pruneNavHistory(state, 'note:c');
    expect(state.stack.map((item) => item.id)).toEqual(['a']);
    expect(state.index).toBe(0);

    state = pruneNavHistory(state, 'note:a');
    expect(state).toEqual(createNotesNavHistoryState());
  });

  it('prune lands on the true predecessor when duplicates of the pruned key precede the cursor', () => {
    let state = createNotesNavHistoryState();
    state = pushNavHistory(state, entry('note', 'x'));
    state = pushNavHistory(state, entry('note', 'a'));
    state = pushNavHistory(state, entry('note', 'x'));
    state = pushNavHistory(state, entry('note', 'b'));
    ({ state } = backNavHistory(state));
    expect(state.stack[state.index]?.id).toBe('x');

    state = pruneNavHistory(state, 'note:x');
    expect(state.stack.map((item) => item.id)).toEqual(['a', 'b']);
    // 光标应落在被删项的前驱 a，而不是后继 b
    expect(state.index).toBe(0);
    expect(canNavForward(state)).toBe(true);
  });

  it('prune preserves cursor among duplicate keys when a middle entry is removed', () => {
    let state = createNotesNavHistoryState();
    state = pushNavHistory(state, entry('note', 'a'));
    state = pushNavHistory(state, entry('note', 'b'));
    state = pushNavHistory(state, entry('note', 'a'));
    expect(state.index).toBe(2);

    state = pruneNavHistory(state, 'note:b');
    expect(state.stack.map((item) => item.id)).toEqual(['a', 'a']);
    expect(state.index).toBe(1);
  });

  it('matchNotesNavHistoryShortcut recognizes mod+alt arrows', () => {
    expect(matchNotesNavHistoryShortcut({
      key: 'ArrowLeft',
      metaKey: true,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
    })).toBe('back');

    expect(matchNotesNavHistoryShortcut({
      key: 'ArrowRight',
      metaKey: false,
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
    })).toBe('forward');

    expect(matchNotesNavHistoryShortcut({
      key: 'ArrowLeft',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    })).toBeNull();
  });
});

describe('useNotesNavHistory', () => {
  it('exposes reactive canBack/canForward and supports push/back/forward', () => {
    const { result } = renderHook(() => useNotesNavHistory());

    expect(result.current.canBack).toBe(false);
    expect(result.current.canForward).toBe(false);

    act(() => {
      result.current.push(entry('note', 'a'));
      result.current.push(entry('note', 'b'));
    });
    expect(result.current.canBack).toBe(true);
    expect(result.current.canForward).toBe(false);

    let target: NotesNavHistoryEntry | null = null;
    act(() => {
      target = result.current.back();
    });
    expect(target).toEqual(entry('note', 'a'));
    expect(result.current.canBack).toBe(false);
    expect(result.current.canForward).toBe(true);

    act(() => {
      target = result.current.forward();
    });
    expect(target).toEqual(entry('note', 'b'));
  });

  it('ignores push while navigating (loop guard)', async () => {
    const { result } = renderHook(() => useNotesNavHistory());

    act(() => {
      result.current.push(entry('note', 'a'));
      result.current.push(entry('note', 'b'));
    });

    const activate = vi.fn(async (item: NotesNavHistoryEntry) => {
      // Host openResource/activateTab would normally push here.
      result.current.push(item);
      result.current.push(entry('note', 'should-not-stick'));
    });

    await act(async () => {
      await result.current.runNavigation('back', activate);
    });

    expect(activate).toHaveBeenCalledWith(entry('note', 'a'));
    expect(result.current.canForward).toBe(true);

    // Cursor is on a; forward still has b — the spurious push was ignored.
    let forwardTarget: NotesNavHistoryEntry | null = null;
    act(() => {
      forwardTarget = result.current.forward();
    });
    expect(forwardTarget).toEqual(entry('note', 'b'));
    expect(result.current.canForward).toBe(false);
  });

  it('handleKeyDown runs navigation with the activate callback', async () => {
    const { result } = renderHook(() => useNotesNavHistory());
    act(() => {
      result.current.push(entry('note', 'a'));
      result.current.push(entry('note', 'b'));
    });

    const activate = vi.fn();
    const event = {
      key: 'ArrowLeft',
      metaKey: true,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    let handled = false;
    await act(async () => {
      handled = result.current.handleKeyDown(event as unknown as KeyboardEvent, activate);
      await Promise.resolve();
    });

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith(entry('note', 'a'));
  });

  it('prune is available after a failed host activate', () => {
    const { result } = renderHook(() => useNotesNavHistory());
    act(() => {
      result.current.push(entry('note', 'a'));
      result.current.push(entry('note', 'gone'));
      result.current.push(entry('note', 'c'));
      // Host went back to a deleted resource.
      result.current.back();
    });

    act(() => {
      result.current.prune('note:gone');
    });

    // Cursor lands on the nearest predecessor (`a`); forward still has `c`.
    expect(result.current.canBack).toBe(false);
    expect(result.current.canForward).toBe(true);
    let target: NotesNavHistoryEntry | null = null;
    act(() => {
      target = result.current.forward();
    });
    expect(target).toEqual(entry('note', 'c'));
  });
});

