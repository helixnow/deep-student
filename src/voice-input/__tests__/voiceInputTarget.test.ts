import { describe, expect, it } from 'vitest';

import { applyTranscriptInsertion } from '../targets';

describe('voice input transcript insertion', () => {
  it('replaces the current selection by default', () => {
    expect(
      applyTranscriptInsertion({
        value: 'hello brave world',
        transcript: 'calm',
        selectionStart: 6,
        selectionEnd: 11,
        mode: 'replace-selection',
      })
    ).toEqual({
      nextValue: 'hello calm world',
      nextSelectionStart: 10,
      nextSelectionEnd: 10,
      changed: true,
    });
  });

  it('inserts at the caret when there is no selection', () => {
    expect(
      applyTranscriptInsertion({
        value: 'hello world',
        transcript: ' brave',
        selectionStart: 5,
        selectionEnd: 5,
        mode: 'replace-selection',
      })
    ).toEqual({
      nextValue: 'hello brave world',
      nextSelectionStart: 11,
      nextSelectionEnd: 11,
      changed: true,
    });
  });

  it('ignores empty transcripts and leaves the input untouched', () => {
    expect(
      applyTranscriptInsertion({
        value: 'stay the same',
        transcript: '   ',
        selectionStart: 4,
        selectionEnd: 4,
        mode: 'replace-selection',
      })
    ).toEqual({
      nextValue: 'stay the same',
      nextSelectionStart: 4,
      nextSelectionEnd: 4,
      changed: false,
    });
  });
});
