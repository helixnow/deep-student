import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearPendingNotesFindQueriesForTests,
  consumeNotesFindQuery,
  NOTES_FIND_QUERY_EVENT,
  publishNotesFindQuery,
} from '../findQueryBridge';

afterEach(clearPendingNotesFindQueriesForTests);

describe('notes find query delivery', () => {
  it('delivers immediately and retains the query for a cold editor mount', () => {
    const listener = vi.fn();
    window.addEventListener(NOTES_FIND_QUERY_EVENT, listener);

    publishNotesFindQuery({ noteId: 'note-a', query: '  matrix  ' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      noteId: 'note-a',
      query: 'matrix',
    });
    expect(consumeNotesFindQuery('note-a')).toBe('matrix');
    expect(consumeNotesFindQuery('note-a')).toBeNull();
    window.removeEventListener(NOTES_FIND_QUERY_EVENT, listener);
  });

  it('keeps independent pending queries scoped by note id', () => {
    publishNotesFindQuery({ noteId: 'note-a', query: 'alpha' });
    publishNotesFindQuery({ noteId: 'note-b', query: 'beta' });
    expect(consumeNotesFindQuery('note-b')).toBe('beta');
    expect(consumeNotesFindQuery('note-a')).toBe('alpha');
  });
});
