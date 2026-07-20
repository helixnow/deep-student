import { describe, expect, it } from 'vitest';

import { learningCommands } from '@/command-palette/modules/learning.commands';
import type { DependencyResolver } from '@/command-palette/registry/types';

const deps: DependencyResolver = {
  navigate: () => undefined,
  getCurrentView: () => 'learning-hub',
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

describe('learning command capability gating', () => {
  it('only registers commands that have real event consumers', () => {
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

  it('does not keep stub commands that would click with no reaction', () => {
    const removedStubs = [
      'learning.show-progress',
      'learning.start-review',
      'learning.history',
      'learning.translate-selection',
      'learning.switch-language-pair',
      'learning.achievements',
    ];

    for (const commandId of removedStubs) {
      expect(learningCommands.find((item) => item.id === commandId)).toBeUndefined();
    }
  });
});
