import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

import { CommandRegistry } from '@/command-palette/registry/commandRegistry';
import type { Command, DependencyResolver } from '@/command-palette/registry/types';

/**
 * 测试 ShortcutManager 的视图范围冲突检测。
 *
 * 由于 shortcutManager 是单例且依赖 commandRegistry 单例，
 * 此处直接使用 commandRegistry 实例构造场景后，调用 shortcutManager 方法。
 *
 * 注：这组测试聚焦 commandRegistry.resolveShortcut 的视图 + 优先级 + isEnabled 行为，
 * 作为 resolveEffectiveShortcut（缓存版）的下层验证。
 */

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

const createCommand = (
  partial: Partial<Command> & Pick<Command, 'id' | 'category' | 'execute'>,
): Command => ({
  name: partial.id,
  ...partial,
});

describe('CommandRegistry view-scoped shortcut resolution', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
  });

  it('same shortcut in disjoint views resolves independently', () => {
    registry.register(
      createCommand({
        id: 'chat.save',
        category: 'chat',
        shortcut: 'mod+s',
        priority: 80,
        visibleInViews: ['chat-v2'],
        execute: () => {},
      }),
    );
    registry.register(
      createCommand({
        id: 'notes.save',
        category: 'notes',
        shortcut: 'mod+s',
        priority: 80,
        visibleInViews: ['learning-hub'],
        execute: () => {},
      }),
    );

    const deps = createDeps();
    expect(registry.resolveShortcut('mod+s', 'chat-v2', deps)?.id).toBe('chat.save');
    expect(registry.resolveShortcut('mod+s', 'learning-hub', deps)?.id).toBe('notes.save');
    // 未注册 mod+s 的视图返回 undefined
    expect(registry.resolveShortcut('mod+s', 'settings', deps)).toBeUndefined();
  });

  it('global command (no visibleInViews) matches all views', () => {
    registry.register(
      createCommand({
        id: 'global.zoom-in',
        category: 'global',
        shortcut: 'mod+=',
        priority: 50,
        execute: () => {},
      }),
    );

    const deps = createDeps();
    expect(registry.resolveShortcut('mod+=', 'chat-v2', deps)?.id).toBe('global.zoom-in');
    expect(registry.resolveShortcut('mod+=', 'settings', deps)?.id).toBe('global.zoom-in');
  });

  it('view-scoped command takes priority over global when both match', () => {
    registry.register(
      createCommand({
        id: 'global.toggle-theme',
        category: 'global',
        shortcut: 'mod+shift+t',
        priority: 80,
        execute: () => {},
      }),
    );
    registry.register(
      createCommand({
        id: 'chat.toggle-thinking',
        category: 'chat',
        shortcut: 'mod+shift+t',
        priority: 90,
        visibleInViews: ['chat-v2'],
        execute: () => {},
      }),
    );

    const deps = createDeps();
    // chat-v2: higher-priority scoped command wins
    expect(registry.resolveShortcut('mod+shift+t', 'chat-v2', deps)?.id).toBe(
      'chat.toggle-thinking',
    );
    // settings: only global matches
    expect(registry.resolveShortcut('mod+shift+t', 'settings', deps)?.id).toBe(
      'global.toggle-theme',
    );
  });

  it('disabled command falls back to next available', () => {
    registry.register(
      createCommand({
        id: 'cmd.primary',
        category: 'chat',
        shortcut: 'mod+r',
        priority: 100,
        visibleInViews: ['chat-v2'],
        isEnabled: () => false,
        execute: () => {},
      }),
    );
    registry.register(
      createCommand({
        id: 'cmd.fallback',
        category: 'chat',
        shortcut: 'mod+r',
        priority: 50,
        visibleInViews: ['chat-v2'],
        execute: () => {},
      }),
    );

    const deps = createDeps();
    expect(registry.resolveShortcut('mod+r', 'chat-v2', deps)?.id).toBe('cmd.fallback');
  });

  it('returns undefined when no command matches', () => {
    const deps = createDeps();
    expect(registry.resolveShortcut('mod+shift+z', 'chat-v2', deps)).toBeUndefined();
  });
});
