import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommandPaletteProvider, useCommandPalette } from '@/command-palette';
import { notesCommands } from '@/command-palette/modules/notes.commands';
import { resetWindowStoreForTests, useWindowStore } from '@/features/workbench/core/windowStore';
import type { WorkbenchWindow } from '@/features/workbench/core/types';

function makeWindow(id: string, typeId: string): WorkbenchWindow {
  return {
    id,
    typeId,
    instanceKey: null,
    title: typeId,
    frame: { x: 0, y: 0, w: 640, h: 480 },
    restoreFrame: null,
    displayMode: 'floating',
    minimized: false,
    zIndex: 10,
    createdAt: 1,
    lastFocusedAt: 1,
  };
}

function ScopeProbe() {
  const { currentView, deps } = useCommandPalette();
  const newNote = notesCommands.find((command) => command.id === 'notes.new');
  return (
    <output data-testid="command-scope">
      {`${currentView}:${deps.getFocusedWorkbenchAppTypeId()}:${String(newNote?.isEnabled?.(deps))}`}
    </output>
  );
}

describe('CommandPaletteProvider Workbench scope', () => {
  beforeEach(() => {
    resetWindowStoreForTests();
  });

  afterEach(() => {
    resetWindowStoreForTests();
  });

  it('uses the Workbench scope and tracks the focused app type for notes commands', () => {
    useWindowStore.setState({
      windows: { notes: makeWindow('notes', 'notes') },
      focusStack: ['notes'],
    });

    render(
      <CommandPaletteProvider
        currentView="chat-v2"
        workbenchActive
        navigate={() => undefined}
        toggleTheme={() => undefined}
        isDarkMode={false}
        switchLanguage={() => undefined}
      >
        <ScopeProbe />
      </CommandPaletteProvider>,
    );

    expect(screen.getByTestId('command-scope')).toHaveTextContent('workbench:notes:true');

    act(() => {
      useWindowStore.setState({
        windows: { files: makeWindow('files', 'files') },
        focusStack: ['files'],
      });
    });

    expect(screen.getByTestId('command-scope')).toHaveTextContent('workbench:files:false');
  });
});
