import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

import { openFileFromPalette } from '@/command-palette/hooks/useResourceSearch';
import type { DependencyResolver } from '@/command-palette/registry/types';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import type { DstuNode } from '@/dstu/types';

const note: DstuNode = {
  id: 'note_1',
  sourceId: 'note_1',
  path: '/course/note_1',
  name: 'Course note',
  type: 'note',
  createdAt: 1,
  updatedAt: 1,
};

function workbenchDeps(navigate: ReturnType<typeof vi.fn>): DependencyResolver {
  return {
    navigate,
    getCurrentView: () => 'workbench',
    getFocusedWorkbenchAppTypeId: () => 'notes',
    t: ((key: string) => key) as unknown as TFunction,
    showNotification: vi.fn(),
    toggleTheme: () => undefined,
    isDarkMode: () => false,
    switchLanguage: () => undefined,
    getCurrentLanguage: () => 'zh-CN',
    openCommandPalette: () => undefined,
    closeCommandPalette: () => undefined,
  };
}

describe('command palette resource routing in the Workbench', () => {
  it('opens a note through the Workbench instead of navigating to the unmounted Learning Hub', async () => {
    const navigate = vi.fn();
    const launch = vi.spyOn(workbenchBus, 'launch').mockReturnValue('notes-window');

    try {
      await openFileFromPalette(workbenchDeps(navigate), note);

      expect(launch).toHaveBeenCalledWith({
        typeId: 'note',
        instanceKey: 'note_1',
        reason: 'command',
      });
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      launch.mockRestore();
    }
  });
});
