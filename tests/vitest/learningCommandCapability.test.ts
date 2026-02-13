import { describe, expect, it } from 'vitest';

import { learningCommands } from '@/command-palette/modules/learning.commands';
import type { DependencyResolver } from '@/command-palette/registry/types';

const deps: DependencyResolver = {
  navigate: () => undefined,
  getCurrentView: () => 'learning-hub',
  t: ((key: string) => key) as any,
  showNotification: () => undefined,
  toggleTheme: () => undefined,
  isDarkMode: () => false,
  switchLanguage: () => undefined,
  getCurrentLanguage: () => 'zh-CN',
  openCommandPalette: () => undefined,
  closeCommandPalette: () => undefined,
};

describe('learning command capability gating', () => {
  it('only exposes commands that are marked executable in this build', () => {
    const enabledIds = learningCommands
      .filter((command) => (command.isEnabled ? command.isEnabled(deps) : true))
      .map((command) => command.id)
      .sort();

    expect(enabledIds).toEqual(
      [
        'learning.essay-grading',
        'learning.essay-suggestions',
        'learning.grade-essay',
        'learning.translate',
      ].sort()
    );
  });

  it('hides review/progress style commands until handlers are implemented', () => {
    const hiddenTargets = [
      'learning.show-progress',
      'learning.start-review',
      'learning.history',
      'learning.translate-selection',
    ];

    for (const commandId of hiddenTargets) {
      const command = learningCommands.find((item) => item.id === commandId);
      expect(command).toBeDefined();
      expect(command?.isEnabled?.(deps)).toBe(false);
    }
  });
});
