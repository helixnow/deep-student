import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

import { CommandRegistry } from '@/command-palette/registry/commandRegistry';
import type { Command, DependencyResolver } from '@/command-palette/registry/types';

const createDeps = (): DependencyResolver => ({
  navigate: () => {},
  getCurrentView: () => 'chat-v2',
  t: ((key: string) => key) as unknown as TFunction,
  showNotification: () => {},
  toggleTheme: () => {},
  isDarkMode: () => false,
  switchLanguage: () => {},
  getCurrentLanguage: () => 'zh-CN',
  openCommandPalette: () => {},
  closeCommandPalette: () => {},
});

const createCommand = (partial: Partial<Command> & Pick<Command, 'id' | 'category' | 'execute'>): Command => ({
  name: partial.id,
  ...partial,
});

describe('CommandRegistry shortcut resolution', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
  });

  it('resolves same shortcut by current view without warning for disjoint views', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registry.register(createCommand({
      id: 'chat.new-session',
      category: 'chat',
      shortcut: 'mod+n',
      priority: 60,
      visibleInViews: ['chat-v2'],
      execute: () => {},
    }));

    registry.register(createCommand({
      id: 'notes.new',
      category: 'notes',
      shortcut: 'mod+n',
      priority: 100,
      visibleInViews: ['learning-hub'],
      execute: () => {},
    }));

    const deps = createDeps();
    expect(registry.resolveShortcut('mod+n', 'chat-v2', deps)?.id).toBe('chat.new-session');
    expect(registry.resolveShortcut('mod+n', 'learning-hub', deps)?.id).toBe('notes.new');
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('warns for overlapping shortcuts and resolves by priority and enabled state', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registry.register(createCommand({
      id: 'chat.retry-old',
      category: 'chat',
      shortcut: 'mod+r',
      priority: 50,
      visibleInViews: ['chat-v2'],
      execute: () => {},
    }));

    registry.register(createCommand({
      id: 'chat.retry-new',
      category: 'chat',
      shortcut: 'mod+r',
      priority: 90,
      visibleInViews: ['chat-v2'],
      isEnabled: () => false,
      execute: () => {},
    }));

    const deps = createDeps();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    // 高优先级命令不可用时，降级到可用命令
    expect(registry.resolveShortcut('mod+r', 'chat-v2', deps)?.id).toBe('chat.retry-old');
  });
});
