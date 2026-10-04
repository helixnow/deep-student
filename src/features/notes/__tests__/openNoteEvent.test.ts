import { describe, expect, it } from 'vitest';

import {
  isNotesOwnedOpenNoteSource,
  resolveClassicShellOpenNoteTarget,
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

  describe('classic shell routing', () => {
    it.each(['notes-editor', 'wikilink', 'mention', undefined])(
      'routes Notes-owned / source-less (%s) events to the learning hub in every view',
      (source) => {
        for (const view of ['chat-v2', 'learning-hub', 'task-dashboard']) {
          expect(resolveClassicShellOpenNoteTarget({ noteId: 'note_1', source }, view)).toBe('learning-hub');
        }
      },
    );

    it('keeps Chat-owned events in chat only while chat is the current view', () => {
      const detail = { noteId: 'note_1', source: 'flashcards-library' };
      expect(resolveClassicShellOpenNoteTarget(detail, 'chat-v2')).toBe('chat');
      expect(resolveClassicShellOpenNoteTarget(detail, 'learning-hub')).toBe('learning-hub');
      expect(resolveClassicShellOpenNoteTarget(detail, 'task-dashboard')).toBe('learning-hub');
    });

    it('ignores malformed events', () => {
      expect(resolveClassicShellOpenNoteTarget(undefined, 'chat-v2')).toBeNull();
      expect(resolveClassicShellOpenNoteTarget({ noteId: '' }, 'learning-hub')).toBeNull();
    });
  });
});
