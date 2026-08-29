import { describe, expect, it } from 'vitest';
import { normalizeRestoredComposerState } from '../composerStateMigration';

describe('normalizeRestoredComposerState', () => {
  it('preserves v0.9.44 draft text and current panel values', () => {
    expect(normalizeRestoredComposerState({
      inputValue: 'unfinished question',
      panelStates: {
        rag: true,
        search: true,
        learn: true,
        mcp: true,
        model: false,
        advanced: true,
        attachment: false,
      },
    })).toEqual({
      inputValue: 'unfinished question',
      panelStates: {
        mcp: true,
        model: false,
        advanced: true,
        attachment: false,
        skill: false,
      },
    });
  });

  it('fills fields missing from an old partial InputBar state', () => {
    expect(normalizeRestoredComposerState({
      inputValue: '',
      panelStates: { attachment: true },
    })).toEqual({
      inputValue: '',
      panelStates: {
        mcp: false,
        model: false,
        advanced: false,
        attachment: true,
        skill: false,
      },
    });
  });

  it('rejects non-string drafts and non-boolean panel values', () => {
    expect(normalizeRestoredComposerState({
      inputValue: { text: 'would crash .trim()' },
      panelStates: {
        mcp: 'true',
        model: 1,
        advanced: null,
        attachment: [],
        skill: {},
      },
    })).toEqual({
      inputValue: '',
      panelStates: {
        mcp: false,
        model: false,
        advanced: false,
        attachment: false,
        skill: false,
      },
    });
  });

  it('defaults null, array, and scalar payloads without throwing', () => {
    for (const payload of [null, [], 'legacy', 44]) {
      expect(normalizeRestoredComposerState(payload)).toEqual({
        inputValue: '',
        panelStates: {
          mcp: false,
          model: false,
          advanced: false,
          attachment: false,
          skill: false,
        },
      });
    }
  });
});
