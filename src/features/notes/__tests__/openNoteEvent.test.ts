import { describe, expect, it } from 'vitest';

import {
  isNotesOwnedOpenNoteSource,
  resolveClassicShellOpenNoteTarget,
  shouldChatHandleOpenNote,
  shouldWorkbenchHandleOpenNote,
} from '../openNoteEvent';

const NOTES_OWNED_SOURCES = [
  'notes-editor',
  'wikilink',
  'mention',
  // 卡片库 / 复习「查看出处」：要的是笔记 markdown 原文，不能进聊天画布（#482）
  'flashcards-library',
  'flashcards-review',
] as const;

describe('DSTU_OPEN_NOTE ownership', () => {
  it.each(NOTES_OWNED_SOURCES)(
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
    it.each([...NOTES_OWNED_SOURCES, undefined])(
      'routes Notes-owned / source-less (%s) events to the learning hub in every view',
      (source) => {
        for (const view of ['chat-v2', 'learning-hub', 'task-dashboard']) {
          expect(resolveClassicShellOpenNoteTarget({ noteId: 'note_1', source }, view)).toBe('learning-hub');
        }
      },
    );

    it('keeps Chat-owned events in chat only while chat is the current view', () => {
      const detail = { noteId: 'note_1', source: 'mcp_tool_block' };
      expect(resolveClassicShellOpenNoteTarget(detail, 'chat-v2')).toBe('chat');
      expect(resolveClassicShellOpenNoteTarget(detail, 'learning-hub')).toBe('learning-hub');
      expect(resolveClassicShellOpenNoteTarget(detail, 'task-dashboard')).toBe('learning-hub');
    });

    it('opens the note source of a flashcard in the learning hub even from chat', () => {
      // #482：卡片「查看出处」点了要回 markdown 原文；经典壳下聊天页当前可见时
      // 也不能落进聊天画布。
      for (const source of ['flashcards-library', 'flashcards-review']) {
        expect(resolveClassicShellOpenNoteTarget({ noteId: 'note_1', source }, 'chat-v2'))
          .toBe('learning-hub');
      }
    });

    it('ignores malformed events', () => {
      expect(resolveClassicShellOpenNoteTarget(undefined, 'chat-v2')).toBeNull();
      expect(resolveClassicShellOpenNoteTarget({ noteId: '' }, 'learning-hub')).toBeNull();
    });
  });
});
