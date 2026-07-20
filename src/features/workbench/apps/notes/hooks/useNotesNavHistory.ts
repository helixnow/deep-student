import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from 'react';
import {
  buildShortcutString,
  formatShortcut,
  normalizeShortcut,
} from '@/command-palette/registry/shortcutUtils';

export type NotesNavResourceType = 'note' | 'mindmap';

/** Workspace tab key shape: `${type}:${id}` (matches NotesWorkspaceApp openResource). */
export interface NotesNavHistoryEntry {
  key: string;
  type: NotesNavResourceType;
  id: string;
}

export const NOTES_NAV_HISTORY_MAX = 100;
export const NOTES_NAV_BACK_SHORTCUT = 'mod+alt+left';
export const NOTES_NAV_FORWARD_SHORTCUT = 'mod+alt+right';

export interface NotesNavHistoryState {
  stack: readonly NotesNavHistoryEntry[];
  /** Cursor into `stack`; `-1` when empty. */
  index: number;
}

type KeyboardLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

export function createNotesNavHistoryState(): NotesNavHistoryState {
  return { stack: [], index: -1 };
}

export function canNavBack(state: NotesNavHistoryState): boolean {
  return state.index > 0;
}

export function canNavForward(state: NotesNavHistoryState): boolean {
  return state.index >= 0 && state.index < state.stack.length - 1;
}

function sameEntry(a: NotesNavHistoryEntry | undefined, b: NotesNavHistoryEntry): boolean {
  return Boolean(a && a.key === b.key && a.type === b.type && a.id === b.id);
}

/**
 * Push a newly activated resource. Ignores no-ops (same as current).
 * Truncates the forward stack, then caps total length at NOTES_NAV_HISTORY_MAX.
 */
export function pushNavHistory(
  state: NotesNavHistoryState,
  entry: NotesNavHistoryEntry,
): NotesNavHistoryState {
  const current = state.index >= 0 ? state.stack[state.index] : undefined;
  if (sameEntry(current, entry)) return state;

  const kept = state.stack.slice(0, state.index + 1);
  kept.push(entry);

  let nextIndex = kept.length - 1;
  if (kept.length > NOTES_NAV_HISTORY_MAX) {
    const overflow = kept.length - NOTES_NAV_HISTORY_MAX;
    kept.splice(0, overflow);
    nextIndex = kept.length - 1;
  }

  return { stack: kept, index: nextIndex };
}

export function backNavHistory(state: NotesNavHistoryState): {
  state: NotesNavHistoryState;
  entry: NotesNavHistoryEntry | null;
} {
  if (!canNavBack(state)) return { state, entry: null };
  const index = state.index - 1;
  return {
    state: { stack: state.stack, index },
    entry: state.stack[index] ?? null,
  };
}

export function forwardNavHistory(state: NotesNavHistoryState): {
  state: NotesNavHistoryState;
  entry: NotesNavHistoryEntry | null;
} {
  if (!canNavForward(state)) return { state, entry: null };
  const index = state.index + 1;
  return {
    state: { stack: state.stack, index },
    entry: state.stack[index] ?? null,
  };
}

/**
 * Drop every entry whose key matches. Adjusts the cursor to stay on the same
 * logical slot when possible; otherwise clamps to the nearest valid index.
 */
export function pruneNavHistory(
  state: NotesNavHistoryState,
  key: string,
): NotesNavHistoryState {
  if (!state.stack.some((entry) => entry.key === key)) return state;

  const current = state.index >= 0 ? state.stack[state.index] : undefined;
  let removedBefore = 0;
  for (let i = 0; i < state.index; i += 1) {
    if (state.stack[i]?.key === key) removedBefore += 1;
  }

  const stack = state.stack.filter((entry) => entry.key !== key);
  if (stack.length === 0) return createNotesNavHistoryState();

  if (current && current.key !== key) {
    // Preserve position among remaining entries (handles duplicate keys).
    return { stack, index: state.index - removedBefore };
  }

  // Current entry was removed — land on the nearest predecessor, else first.
  // `removedBefore` must be discounted, otherwise duplicates of the pruned
  // key sitting before the cursor push the landing slot onto a successor.
  const anchor = state.index - removedBefore;
  return { stack, index: Math.min(Math.max(0, anchor - 1), stack.length - 1) };
}

export function matchNotesNavHistoryShortcut(
  event: KeyboardLike,
): 'back' | 'forward' | null {
  const built = buildShortcutString(event as KeyboardEvent);
  if (!built) return null;
  const normalized = normalizeShortcut(built);
  if (normalized === normalizeShortcut(NOTES_NAV_BACK_SHORTCUT)) return 'back';
  if (normalized === normalizeShortcut(NOTES_NAV_FORWARD_SHORTCUT)) return 'forward';
  return null;
}

export function formatNotesNavHistoryShortcut(direction: 'back' | 'forward'): string {
  return formatShortcut(
    direction === 'back' ? NOTES_NAV_BACK_SHORTCUT : NOTES_NAV_FORWARD_SHORTCUT,
  )
    .replace(/left/gi, '←')
    .replace(/right/gi, '→');
}

export type NotesNavActivateFn = (
  entry: NotesNavHistoryEntry,
) => void | Promise<void>;

export interface UseNotesNavHistoryResult {
  canBack: boolean;
  canForward: boolean;
  /** True while a host activate() from back/forward/runNavigation is in flight. */
  isNavigatingRef: MutableRefObject<boolean>;
  /** Call when a resource becomes active via user action (open / tab click). */
  push: (entry: NotesNavHistoryEntry) => void;
  /**
   * Move cursor backward and return the target entry for the host to activate.
   * Does not call push — host must skip push while `isNavigatingRef.current`,
   * or prefer `runNavigation` / `handleKeyDown(activate)`.
   */
  back: () => NotesNavHistoryEntry | null;
  /** Move cursor forward and return the target entry for the host to activate. */
  forward: () => NotesNavHistoryEntry | null;
  /**
   * Preferred wrapper: sets isNavigating around host activation so openResource
   * / activateTab side-effects that call push are ignored (loop guard).
   */
  runNavigation: (
    direction: 'back' | 'forward',
    activate: NotesNavActivateFn,
  ) => Promise<NotesNavHistoryEntry | null>;
  /** Remove deleted / missing resources. Host should call after a failed activate. */
  prune: (key: string) => void;
  /**
   * Host wires this on the workspace root `onKeyDown`.
   * Pass the same activate used by the buttons; returns true when handled.
   */
  handleKeyDown: (
    event: KeyboardEvent | ReactKeyboardEvent,
    activate: NotesNavActivateFn,
  ) => boolean;
}

/**
 * In-memory Obsidian-style navigation history for one Notes workspace instance.
 * Not persisted across reloads.
 */
export function useNotesNavHistory(): UseNotesNavHistoryResult {
  const stateRef = useRef<NotesNavHistoryState>(createNotesNavHistoryState());
  const isNavigatingRef = useRef(false);
  const [, setEpoch] = useState(0);

  const bump = useCallback(() => {
    setEpoch((value) => value + 1);
  }, []);

  const push = useCallback((entry: NotesNavHistoryEntry) => {
    if (isNavigatingRef.current) return;
    const next = pushNavHistory(stateRef.current, entry);
    if (next === stateRef.current) return;
    stateRef.current = next;
    bump();
  }, [bump]);

  const back = useCallback((): NotesNavHistoryEntry | null => {
    const result = backNavHistory(stateRef.current);
    if (!result.entry) return null;
    stateRef.current = result.state;
    bump();
    return result.entry;
  }, [bump]);

  const forward = useCallback((): NotesNavHistoryEntry | null => {
    const result = forwardNavHistory(stateRef.current);
    if (!result.entry) return null;
    stateRef.current = result.state;
    bump();
    return result.entry;
  }, [bump]);

  const prune = useCallback((key: string) => {
    const next = pruneNavHistory(stateRef.current, key);
    if (next === stateRef.current) return;
    stateRef.current = next;
    bump();
  }, [bump]);

  const runNavigation = useCallback(async (
    direction: 'back' | 'forward',
    activate: (entry: NotesNavHistoryEntry) => void | Promise<void>,
  ): Promise<NotesNavHistoryEntry | null> => {
    // Set the guard before moving the cursor so sync activate()/push side-effects
    // (and any effects scheduled from the bump render) cannot re-enter push.
    isNavigatingRef.current = true;
    try {
      const entry = direction === 'back' ? back() : forward();
      if (!entry) return null;
      await activate(entry);
      return entry;
    } finally {
      isNavigatingRef.current = false;
    }
  }, [back, forward]);

  const handleKeyDown = useCallback((
    event: KeyboardEvent | ReactKeyboardEvent,
    activate: NotesNavActivateFn,
  ): boolean => {
    const matched = matchNotesNavHistoryShortcut(event);
    if (!matched) return false;
    if (matched === 'back' && !canNavBack(stateRef.current)) return false;
    if (matched === 'forward' && !canNavForward(stateRef.current)) return false;
    event.preventDefault();
    event.stopPropagation();
    void runNavigation(matched, activate);
    return true;
  }, [runNavigation]);

  const state = stateRef.current;

  return {
    canBack: canNavBack(state),
    canForward: canNavForward(state),
    isNavigatingRef,
    push,
    back,
    forward,
    runNavigation,
    prune,
    handleKeyDown,
  };
}
