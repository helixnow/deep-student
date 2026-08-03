import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

import {
  notesCommands,
  NOTES_WORKSPACE_COMMAND_EVENT,
  type NotesWorkspaceCommandDetail,
} from '@/command-palette/modules/notes.commands';
import type { DependencyResolver } from '@/command-palette/registry/types';
import {
  registerWorkspaceHost,
  resetWorkspaceRegistryForTests,
} from '@/features/workbench/apps/notes/workspaceRegistry';

function createDeps(
  view: ReturnType<DependencyResolver['getCurrentView']>,
  focusedWorkbenchAppTypeId: string | null = null,
): DependencyResolver {
  return {
    navigate: () => undefined,
    getCurrentView: () => view,
    getFocusedWorkbenchAppTypeId: () => focusedWorkbenchAppTypeId,
    t: ((key: string) => key) as unknown as TFunction,
    showNotification: () => undefined,
    toggleTheme: () => undefined,
    isDarkMode: () => false,
    switchLanguage: () => undefined,
    getCurrentLanguage: () => 'zh-CN',
    openCommandPalette: () => undefined,
    closeCommandPalette: () => undefined,
  };
}

describe('notes command workbench scope', () => {
  const newNote = notesCommands.find((command) => command.id === 'notes.new');

  afterEach(() => resetWorkspaceRegistryForTests());

  it('exposes only active Notes commands in the Workbench and removes AI continue', () => {
    expect(newNote?.visibleInViews).toContain('workbench');
    expect(newNote?.isEnabled?.(createDeps('workbench', 'notes'))).toBe(true);
    expect(newNote?.isEnabled?.(createDeps('workbench', 'files'))).toBe(false);
    expect(newNote?.isEnabled?.(createDeps('chat-v2'))).toBe(false);
    expect(notesCommands.some((command) => command.id === 'notes.ai-continue')).toBe(false);
  });

  it('uses the workspace bridge instead of the legacy new-note event in the Workbench', () => {
    if (!newNote) throw new Error('notes.new command must be registered');

    const workspaceListener = vi.fn();
    const legacyListener = vi.fn();
    window.addEventListener(NOTES_WORKSPACE_COMMAND_EVENT, workspaceListener);
    window.addEventListener('NOTES_CREATE_NEW', legacyListener);

    try {
      newNote.execute(createDeps('workbench', 'notes'));

      expect(legacyListener).not.toHaveBeenCalled();
      expect(workspaceListener).toHaveBeenCalledTimes(1);
      const event = workspaceListener.mock.calls[0][0] as CustomEvent<NotesWorkspaceCommandDetail>;
      expect(event.detail).toEqual({ action: 'create-note' });
    } finally {
      window.removeEventListener(NOTES_WORKSPACE_COMMAND_EVENT, workspaceListener);
      window.removeEventListener('NOTES_CREATE_NEW', legacyListener);
    }
  });

  it('keeps the legacy event path for Learning Hub', () => {
    if (!newNote) throw new Error('notes.new command must be registered');

    const workspaceListener = vi.fn();
    const legacyListener = vi.fn();
    window.addEventListener(NOTES_WORKSPACE_COMMAND_EVENT, workspaceListener);
    window.addEventListener('NOTES_CREATE_NEW', legacyListener);

    try {
      newNote.execute(createDeps('learning-hub'));

      expect(workspaceListener).not.toHaveBeenCalled();
      expect(legacyListener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(NOTES_WORKSPACE_COMMAND_EVENT, workspaceListener);
      window.removeEventListener('NOTES_CREATE_NEW', legacyListener);
    }
  });

  it('does not present Markdown-editor commands as runnable for a mind map tab', () => {
    const editorCommandIds = [
      'notes.save',
      'notes.toggle-outline',
      'notes.insert-math',
      'notes.insert-table',
      'notes.insert-codeblock',
      'notes.insert-link',
      'notes.insert-image',
    ];
    registerWorkspaceHost('notes-window', {
      openResource: vi.fn(),
      getActiveResource: () => ({ type: 'mindmap', id: 'mindmap_1' }),
    });
    const workbenchNotes = createDeps('workbench', 'notes');

    for (const id of editorCommandIds) {
      expect(notesCommands.find((command) => command.id === id)?.isEnabled?.(workbenchNotes), id).toBe(false);
    }
    expect(notesCommands.find((command) => command.id === 'notes.toggle-sidebar')?.isEnabled?.(workbenchNotes)).toBe(true);
    expect(notesCommands.find((command) => command.id === 'notes.export-current')?.isEnabled?.(workbenchNotes)).toBe(true);
  });
});
