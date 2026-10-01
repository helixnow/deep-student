import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { launch, activate } = vi.hoisted(() => ({ launch: vi.fn(), activate: vi.fn(async () => true) }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../core/workbenchBus', () => ({ workbenchBus: { launch, activate } }));
vi.mock('../../core/windowStore', () => ({
  useWindowStore: { getState: () => ({ windows: {}, focusStack: [], focusWindow: vi.fn() }) },
}));
vi.mock('../../apps/notes/workspaceRegistry', () => ({ requestWorkspaceResource: vi.fn(async () => 'w') }));
vi.mock('../../apps/content/typeMap', () => ({
  isNotesWorkspaceResourceType: (type: string) => type === 'note' || type === 'mindmap',
  resourceTypeToAppTypeId: (type: string) => type,
}));
vi.mock('../../apps/chat/newSession', () => ({ launchNewChatSession: vi.fn() }));
vi.mock('../../apps/chat/register', () => ({ CHAT_APP_TYPE_ID: 'chat' }));
vi.mock('@/features/chat/core/session/sessionManager', () => ({ sessionManager: { getCurrentSessionId: () => null } }));
vi.mock('../../hooks/useWorkbenchA11y', () => ({ announceWorkbench: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

import WorkbenchEventBridge from '../WorkbenchEventBridge';

afterEach(() => { cleanup(); launch.mockReset(); activate.mockClear(); });

const fire = (type: string, detail: unknown) => act(() => { window.dispatchEvent(new CustomEvent(type, { detail })); });

describe('WorkbenchEventBridge classic navigation events (previously dead in workbench)', () => {
  it('opens the question set window for navigateToExamSheet', () => {
    render(<WorkbenchEventBridge />);
    fire('navigateToExamSheet', { sessionId: 'exam_1' });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ typeId: 'exam', instanceKey: 'exam_1' }));
  });

  it('opens the resource window for NAVIGATE_TO_VIEW{openResource} and ignores plain view switches', () => {
    render(<WorkbenchEventBridge />);
    fire('NAVIGATE_TO_VIEW', { view: 'learning-hub' });
    expect(launch).not.toHaveBeenCalled();
    fire('NAVIGATE_TO_VIEW', { view: 'learning-hub', openResource: '/tb_42' });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ instanceKey: 'tb_42' }));
  });

  it('routes knowledge-base locate to the document and memory locate to the Files memory view', () => {
    render(<WorkbenchEventBridge />);
    fire('DSTU_NAVIGATE_TO_KNOWLEDGE_BASE', { preferTab: 'manage', locator: { sourceId: 'file_9', resourceType: 'file', title: 'Doc' } });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ typeId: 'file', instanceKey: 'file_9' }));
    fire('DSTU_NAVIGATE_TO_KNOWLEDGE_BASE', { preferTab: 'memory', locator: { sourceId: 'note_m' } });
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      typeId: 'files', action: 'openQuickAccess', payload: { type: 'memory' },
      fallbackLaunch: expect.objectContaining({ typeId: 'files' }),
    }));
  });
});
