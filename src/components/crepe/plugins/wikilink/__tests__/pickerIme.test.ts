import { fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWikilinkCandidatePicker, closeWikilinkCandidatePicker } from '../candidatePicker';
import { openWikilinkCreateConfirm, closeWikilinkCreateConfirm, isWikilinkCreateConfirmOpenFor } from '../createConfirm';

afterEach(() => { closeWikilinkCandidatePicker(); closeWikilinkCreateConfirm(); });

describe.each([{ isComposing: true }, { keyCode: 229 }])('wikilink IME (%j)', (composition) => {
  it('preserves candidate selection and does not navigate until a normal Enter', async () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const opened = vi.fn();
    window.addEventListener('DSTU_OPEN_NOTE', opened);
    try {
      openWikilinkCandidatePicker({ anchor, target: '中文', candidateIds: ['note-1', 'note-2'], getNotes: () => [
        { id: 'note-1', title: 'First' }, { id: 'note-2', title: 'Second' },
      ] });
      await waitFor(() => expect(document.querySelectorAll('.crepe-wikilink-candidates [role="option"]')).toHaveLength(2));
      for (const key of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp']) {
        expect(fireEvent.keyDown(anchor, { key, ...composition })).toBe(true);
      }
      expect(opened).not.toHaveBeenCalled();
      fireEvent.keyDown(anchor, { key: 'ArrowDown' });
      fireEvent.keyDown(anchor, { key: 'Enter' });
      expect(opened).toHaveBeenCalledOnce();
      expect(opened.mock.calls[0][0].detail.noteId).toBe('note-2');
    } finally { window.removeEventListener('DSTU_OPEN_NOTE', opened); anchor.remove(); }
  });

  it('does not create or dismiss an unresolved link on candidate keys', () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const confirm = vi.fn();
    try {
      openWikilinkCreateConfirm({ anchor, title: '中文', onConfirm: confirm });
      for (const key of ['Enter', 'Escape', 'ArrowDown']) {
        expect(fireEvent.keyDown(anchor, { key, ...composition })).toBe(true);
        expect(isWikilinkCreateConfirmOpenFor(anchor)).toBe(true);
      }
      expect(confirm).not.toHaveBeenCalled();
      fireEvent.keyDown(anchor, { key: 'Enter' });
      expect(confirm).toHaveBeenCalledOnce();
      expect(isWikilinkCreateConfirmOpenFor(anchor)).toBe(false);
    } finally { anchor.remove(); }
  });
});
