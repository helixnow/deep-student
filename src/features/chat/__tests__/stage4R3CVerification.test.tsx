import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionListStore } from '../stores/sessionListStore';
import { archiveSession } from '../adapters/tauri/sessionCommands';
import { SkillSelector } from '../skills/components/SkillSelector';
import type { TauriAdapterHost } from '../adapters/tauri/adapterHost';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

describe('Stage 4 R3-C archive sync & skill selector close', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useSessionListStore.getState().setSessions([]);
  });

  it('S4-02 archiveSession removes archived session from sessionListStore and dispatches update event', async () => {
    invokeMock.mockResolvedValueOnce(null);
    useSessionListStore.getState().setSessions([
      {
        id: 'sess_keep',
        mode: 'chat',
        title: 'Keep',
        titleLocked: false,
        persistStatus: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'sess_arch',
        mode: 'chat',
        title: 'Archive Me',
        titleLocked: false,
        persistStatus: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const events: string[] = [];
    const listener = () => events.push('updated');
    window.addEventListener('chat-v2:sessions-updated', listener);

    try {
      await archiveSession({ sessionId: 'sess_arch' } as unknown as TauriAdapterHost);
    } finally {
      window.removeEventListener('chat-v2:sessions-updated', listener);
    }

    expect(invokeMock).toHaveBeenCalledWith('chat_v2_archive_session', { sessionId: 'sess_arch' });
    expect(useSessionListStore.getState().sessions.map((s) => s.id)).toEqual(['sess_keep']);
    expect(events).toEqual(['updated']);
  });

  it('S4-06 SkillSelector close button invokes onClose inside plus-menu variant', () => {
    const onClose = vi.fn();
    render(
      <SkillSelector
        activeSkillIds={[]}
        onToggleSkill={vi.fn()}
        onClose={onClose}
        variant="menu"
      />,
    );

    const closeBtn = screen.getByTestId('skill-selector-close');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
