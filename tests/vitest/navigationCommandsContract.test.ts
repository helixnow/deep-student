import { beforeEach, describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => ({ enabled: false, launch: vi.fn() }));
vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: { isEnabled: () => bus.enabled, launch: bus.launch },
}));

import { getNavigationCommands } from '@/command-palette/modules/navigation.commands';
import type { CurrentView } from '@/types/navigation';
import type { DependencyResolver } from '@/command-palette/registry/types';

const deprecatedTargets = new Set<string>([
  'analysis',
  'chat',
  'review',
  'exam-sheet',
  'textbook-library',
  'markdown-editor',
  'batch',
]);

describe('navigation commands contract', () => {
  beforeEach(() => {
    bus.enabled = false;
    bus.launch.mockClear();
  });

  it('does not navigate to deprecated views', async () => {
    const navigatedViews: CurrentView[] = [];
    const navigationCommands = getNavigationCommands();

    const deps: DependencyResolver = {
      navigate: (view) => {
        navigatedViews.push(view);
      },
      getCurrentView: () => 'chat-v2',
      getFocusedWorkbenchAppTypeId: () => null,
      t: ((key: string) => key) as any,
      showNotification: () => undefined,
      toggleTheme: () => undefined,
      isDarkMode: () => false,
      switchLanguage: () => undefined,
      getCurrentLanguage: () => 'zh-CN',
      openCommandPalette: () => undefined,
      closeCommandPalette: () => undefined,
    };

    for (const cmd of navigationCommands) {
      await cmd.execute(deps as any);
    }

    expect(navigatedViews.length).toBeGreaterThan(0);
    for (const view of navigatedViews) {
      expect(deprecatedTargets.has(view)).toBe(false);
    }
  });

  it('navigates directly to the notes library while keeping the deprecated review command removed', async () => {
    const navigationCommands = getNavigationCommands();
    const command = navigationCommands.find((cmd) => cmd.id === 'nav.goto.notes');
    const navigate = vi.fn();

    expect(command).toBeDefined();
    await command!.execute({ navigate } as DependencyResolver);
    expect(navigate).toHaveBeenCalledWith('notes');
    expect(navigationCommands.some((cmd) => cmd.id === 'nav.goto.review')).toBe(false);
  });

  it('opens the notebook app instead of a hidden classic view when the desktop OS is active', async () => {
    bus.enabled = true;
    const command = getNavigationCommands().find((cmd) => cmd.id === 'nav.goto.notes');
    const navigate = vi.fn();

    await command!.execute({ navigate } as DependencyResolver);
    expect(bus.launch).toHaveBeenCalledWith({ typeId: 'notebook', reason: 'command' });
    expect(navigate).not.toHaveBeenCalled();
  });
});
