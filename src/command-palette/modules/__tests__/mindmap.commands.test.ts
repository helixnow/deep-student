import { describe, expect, it, vi } from 'vitest';
import { notesCommands } from '../notes.commands';
import type { DependencyResolver } from '../../registry/types';

function deps(appType: string | null): DependencyResolver {
  return {
    getCurrentView: () => 'workbench',
    getFocusedWorkbenchAppTypeId: () => appType,
  } as DependencyResolver;
}

describe('mind map view command', () => {
  const command = notesCommands.find((item) => item.id === 'mindmap.toggle-view')!;

  it('is scoped to an active mind map app', () => {
    expect(command.isEnabled?.(deps('mindmap'))).toBe(true);
    expect(command.isEnabled?.(deps('chat-v2'))).toBe(false);
  });

  it('dispatches the shared view-toggle event', () => {
    const listener = vi.fn();
    window.addEventListener('mindmap:toggle-view', listener);
    command.execute(deps('mindmap'));
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener('mindmap:toggle-view', listener);
  });
});
