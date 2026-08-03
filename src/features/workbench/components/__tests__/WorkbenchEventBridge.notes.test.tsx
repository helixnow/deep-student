import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { launch, requestWorkspaceResource } = vi.hoisted(() => ({
  launch: vi.fn(),
  requestWorkspaceResource: vi.fn(async () => 'notes-window'),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../core/workbenchBus', () => ({
  workbenchBus: { launch, activate: vi.fn() },
}));
vi.mock('../../core/windowStore', () => ({
  useWindowStore: {
    getState: () => ({ windows: {}, focusStack: [], focusWindow: vi.fn() }),
  },
}));
vi.mock('../../apps/notes/workspaceRegistry', () => ({ requestWorkspaceResource }));
vi.mock('../../apps/content/typeMap', () => ({
  isNotesWorkspaceResourceType: (type: string) => type === 'note' || type === 'mindmap',
  resourceTypeToAppTypeId: (type: string) => type === 'note' ? 'notes' : type,
}));
vi.mock('../../apps/chat/newSession', () => ({ launchNewChatSession: vi.fn() }));
vi.mock('../../apps/chat/register', () => ({ CHAT_APP_TYPE_ID: 'chat' }));
vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: { getCurrentSessionId: () => null },
}));
vi.mock('../../hooks/useWorkbenchA11y', () => ({ announceWorkbench: vi.fn() }));

import WorkbenchEventBridge from '../WorkbenchEventBridge';
import {
  clearPendingNotesHeadingTargetsForTests,
  consumeNotesHeadingTarget,
} from '@/features/notes/headingTargetBridge';

afterEach(() => {
  cleanup();
  launch.mockReset();
  requestWorkspaceResource.mockClear();
  clearPendingNotesHeadingTargetsForTests();
});

describe('WorkbenchEventBridge note routing', () => {
  it('routes DSTU_OPEN_NOTE into the mounted Notes workspace contract', async () => {
    render(<WorkbenchEventBridge />);

    act(() => {
      window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', {
        detail: { noteId: 'note_target' },
      }));
    });

    await waitFor(() => expect(requestWorkspaceResource).toHaveBeenCalledWith({
      type: 'note',
      id: 'note_target',
    }));
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      typeId: 'notes',
      payload: expect.objectContaining({ resourceType: 'note', resourceId: 'note_target' }),
    }));
  });

  it('retains a wikilink heading until the target editor mounts', async () => {
    render(<WorkbenchEventBridge />);

    act(() => {
      window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', {
        detail: { noteId: 'note_target', heading: 'Methods' },
      }));
    });

    await waitFor(() => expect(requestWorkspaceResource).toHaveBeenCalled());
    expect(consumeNotesHeadingTarget('note_target')).toBe('Methods');
    expect(consumeNotesHeadingTarget('note_target')).toBeNull();
  });

  it('ignores malformed note events', () => {
    render(<WorkbenchEventBridge />);
    act(() => window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', { detail: {} })));
    expect(requestWorkspaceResource).not.toHaveBeenCalled();
  });

  it('leaves explicitly Chat-owned note events to Chat', () => {
    render(<WorkbenchEventBridge />);
    act(() => window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', {
      detail: { noteId: 'note_target', source: 'mcp_tool_block' },
    })));
    expect(requestWorkspaceResource).not.toHaveBeenCalled();
  });
});
