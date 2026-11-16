/**
 * L1：对话里点页码 / 媒体时间戳 → 资源窗带上来源窗，开在它旁边（placement:'beside'）。
 * 落位几何本身见 core/__tests__/besidePlacement.test.ts。
 */
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
import { resolveSourceWindowId } from '@/utils/sourceWindowId';

afterEach(() => { cleanup(); launch.mockReset(); });

describe('WorkbenchEventBridge opens cited resources beside their source window', () => {
  it('passes the citing window as the beside anchor for pdf-ref:open', () => {
    vi.useFakeTimers();
    try {
      render(<WorkbenchEventBridge />);
      act(() => {
        document.dispatchEvent(new CustomEvent('pdf-ref:open', {
          detail: { sourceId: 'file_paper', pageNumber: 2, sourceWindowId: 'win_chat' },
        }));
      });
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({
        instanceKey: 'file_paper',
        placement: { mode: 'beside', anchorWindowId: 'win_chat' },
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('still asks for beside placement (anchor = focused window) when the dispatcher knows no window', () => {
    vi.useFakeTimers();
    try {
      render(<WorkbenchEventBridge />);
      act(() => {
        document.dispatchEvent(new CustomEvent('pdf-ref:open', { detail: { sourceId: 'tb_1', pageNumber: 5 } }));
      });
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({
        placement: { mode: 'beside', anchorWindowId: null },
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the citing window for media-ref:open too', () => {
    vi.useFakeTimers();
    try {
      render(<WorkbenchEventBridge />);
      act(() => {
        document.dispatchEvent(new CustomEvent('media-ref:open', {
          detail: { resourceId: 'file_talk', seconds: 30, sourceWindowId: 'win_chat' },
        }));
      });
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({
        typeId: 'file',
        instanceKey: 'file_talk',
        placement: { mode: 'beside', anchorWindowId: 'win_chat' },
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveSourceWindowId', () => {
  it('reads the enclosing workbench window id, or undefined outside any window', () => {
    const shell = document.createElement('section');
    shell.setAttribute('data-window-id', 'win_42');
    const badge = document.createElement('span');
    shell.appendChild(badge);
    document.body.appendChild(shell);
    try {
      expect(resolveSourceWindowId(badge)).toBe('win_42');
      expect(resolveSourceWindowId(document.body)).toBeUndefined();
      expect(resolveSourceWindowId(null)).toBeUndefined();
    } finally {
      shell.remove();
    }
  });
});
