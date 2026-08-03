import { describe, expect, it } from 'vitest';

import {
  isNotesOwnedOpenNoteSource,
  shouldChatHandleOpenNote,
  shouldWorkbenchHandleOpenNote,
} from '../openNoteEvent';

describe('DSTU_OPEN_NOTE ownership', () => {
  it.each(['notes-editor', 'wikilink', 'mention'])(
    'assigns %s navigation to the Notes workspace',
    (source) => {
      expect(isNotesOwnedOpenNoteSource(source)).toBe(true);
      expect(shouldChatHandleOpenNote({ noteId: 'note_1', source })).toBe(false);
      expect(shouldWorkbenchHandleOpenNote({ noteId: 'note_1', source })).toBe(true);
    },
  );

  it('assigns explicit non-Notes sources to Chat and source-less legacy events to Workbench', () => {
    expect(shouldChatHandleOpenNote({ noteId: 'note_1', source: 'mcp_tool_block' })).toBe(true);
    expect(shouldChatHandleOpenNote({ noteId: 'note_1', source: 'note_tool_preview' })).toBe(true);
    expect(shouldWorkbenchHandleOpenNote({ noteId: 'note_1', source: 'mcp_tool_block' })).toBe(false);
    expect(shouldChatHandleOpenNote({ noteId: 'note_1' })).toBe(false);
    expect(shouldWorkbenchHandleOpenNote({ noteId: 'note_1' })).toBe(true);
  });

  it('rejects malformed events', () => {
    expect(shouldChatHandleOpenNote(undefined)).toBe(false);
    expect(shouldChatHandleOpenNote({ noteId: '', source: 'mcp_tool_block' })).toBe(false);
    expect(shouldWorkbenchHandleOpenNote(undefined)).toBe(false);
  });
});
