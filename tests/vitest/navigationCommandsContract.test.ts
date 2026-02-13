import { describe, expect, it } from 'vitest';

import { getNavigationCommands } from '@/command-palette/modules/navigation.commands';
import type { CurrentView } from '@/types/navigation';
import type { DependencyResolver } from '@/command-palette/registry/types';

const deprecatedTargets = new Set<string>([
  'analysis',
  'chat',
  'notes',
  'review',
  'exam-sheet',
  'textbook-library',
  'markdown-editor',
  'batch',
]);

describe('navigation commands contract', () => {
  it('does not navigate to deprecated views', async () => {
    const navigatedViews: CurrentView[] = [];
    const navigationCommands = getNavigationCommands();

    const deps: DependencyResolver = {
      navigate: (view) => {
        navigatedViews.push(view);
      },
      getCurrentView: () => 'chat-v2',
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

  it('removes note/review direct navigation commands', () => {
    const navigationCommands = getNavigationCommands();
    const ids = new Set(navigationCommands.map((cmd) => cmd.id));
    expect(ids.has('nav.goto.notes')).toBe(false);
    expect(ids.has('nav.goto.review')).toBe(false);
  });
});
