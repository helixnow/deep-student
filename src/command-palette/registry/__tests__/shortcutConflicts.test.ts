import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { UiKernel } from '@/ui-kernel/kernel';
import { createLegacyRegistryAdapters } from '@/ui-kernel/legacy-adapters';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';
import { matchWorkbenchShortcut, setWorkbenchShortcutPlatformOverride } from '@/features/workbench/core/shortcuts';
import { CommandRegistry, commandRegistry } from '../commandRegistry';
import { shortcutManager } from '../shortcutManager';
import type { Command, CommandView, DependencyResolver } from '../types';

const isConflictWarning = (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('[CommandRegistry] 快捷键');

function deps(view: CommandView, app: string | null = null): DependencyResolver {
  return {
    navigate: () => {},
    getCurrentView: () => view,
    getFocusedWorkbenchAppTypeId: () => app,
    t: ((key: string) => key) as unknown as TFunction,
    showNotification: () => {},
    toggleTheme: () => {},
    isDarkMode: () => false,
    switchLanguage: () => {},
    getCurrentLanguage: () => 'zh-CN',
    openCommandPalette: () => {},
    closeCommandPalette: () => {},
  };
}

const command = (partial: Partial<Command> & Pick<Command, 'id'>): Command => ({
  name: partial.id,
  category: 'global',
  execute: () => {},
  ...partial,
});

let kernel: UiKernel | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await kernel?.dispose();
  kernel = undefined;
});

async function bootOfficial(registry: CommandRegistry) {
  const legacy = createLegacyRegistryAdapters({
    commandRegistry: registry,
    blockRegistry: {} as never,
    appRegistry: {} as never,
  });
  kernel = new UiKernel({ ...memoryRegistryAdapters(), commands: legacy.commands });
  await installOfficialUiPlugins(kernel);
  return registry;
}

describe('shortcut conflict warnings at startup', () => {
  it('installs the official commands without a shortcut conflict warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await bootOfficial(new CommandRegistry());
    expect(registry.count()).toBeGreaterThan(80);
    expect(warn.mock.calls.filter(isConflictWarning)).toEqual([]);
  });

  it('keeps every shared shortcut bound to the command of the focused context', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await bootOfficial(new CommandRegistry());
    const resolve = (key: string, view: CommandView, app: string | null = null) =>
      registry.resolveShortcut(key, view, deps(view, app))?.id;

    expect(resolve('mod+n', 'workbench', 'chat')).toBe('chat.new-session');
    expect(resolve('mod+n', 'workbench', 'notes')).toBe('notes.new');
    expect(resolve('mod+shift+c', 'workbench', 'chat')).toBe('chat.copy-last-response');
    expect(resolve('mod+\\', 'workbench', 'chat')).toBe('chat.toggle-sidebar');
    expect(resolve('mod+\\', 'workbench', 'notes')).toBe('notes.toggle-sidebar');
    expect(resolve('mod+p', 'workbench', 'notes')).toBe('notes.quick-switch');
  });

  it('declares workbenchApps only where isEnabled enforces them', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await bootOfficial(new CommandRegistry());
    const declared = registry.getAll().filter((c) => c.workbenchApps?.length);
    expect(declared.length).toBeGreaterThan(0);
    const apps = [...new Set(declared.flatMap((c) => c.workbenchApps!)), 'files', 'chat', 'notes', 'mindmap', 'todo', 'other', null];
    for (const c of declared) {
      expect(c.isEnabled, c.id).toBeTypeOf('function');
      for (const app of apps) {
        if (app !== null && c.workbenchApps!.includes(app)) continue;
        expect(c.isEnabled!(deps('workbench', app)), `${c.id} with ${app} focused`).toBe(false);
      }
    }
  });
});

describe('shortcut conflict detection', () => {
  const warnings = (register: (registry: CommandRegistry) => void) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    register(new CommandRegistry());
    const found = warn.mock.calls.filter(isConflictWarning).length;
    warn.mockRestore();
    return found;
  };

  it('ignores commands that share the Workbench view but not a focused app', () => {
    expect(warnings((r) => {
      r.register(command({ id: 'a', shortcut: 'mod+n', visibleInViews: ['chat-v2', 'workbench'], workbenchApps: ['chat'] }));
      r.register(command({ id: 'b', shortcut: 'mod+n', visibleInViews: ['learning-hub', 'workbench'], workbenchApps: ['notes'] }));
    })).toBe(0);
  });

  it('warns when both commands can apply to the same focused app', () => {
    expect(warnings((r) => {
      r.register(command({ id: 'a', shortcut: 'mod+n', visibleInViews: ['workbench'], workbenchApps: ['chat', 'notes'] }));
      r.register(command({ id: 'b', shortcut: 'mod+n', visibleInViews: ['workbench'], workbenchApps: ['notes'] }));
    })).toBe(1);
    expect(warnings((r) => {
      r.register(command({ id: 'a', shortcut: 'mod+n', visibleInViews: ['workbench'], workbenchApps: ['chat'] }));
      r.register(command({ id: 'b', shortcut: 'mod+n', visibleInViews: ['workbench'] }));
    })).toBe(1);
  });

  it('accepts a narrower command that outranks a broader one, and nothing else', () => {
    expect(warnings((r) => {
      r.register(command({ id: 'global.search', shortcut: 'mod+p', priority: 99 }));
      r.register(command({ id: 'notes.switch', shortcut: 'mod+p', priority: 120, visibleInViews: ['workbench'], workbenchApps: ['notes'] }));
    })).toBe(0);
    // the narrower command never wins: dead shortcut
    expect(warnings((r) => {
      r.register(command({ id: 'global.search', shortcut: 'mod+p', priority: 130 }));
      r.register(command({ id: 'notes.switch', shortcut: 'mod+p', priority: 120, visibleInViews: ['workbench'], workbenchApps: ['notes'] }));
    })).toBe(1);
    // same scope: the loser is dead everywhere
    expect(warnings((r) => {
      r.register(command({ id: 'a', shortcut: 'mod+r', priority: 50, visibleInViews: ['chat-v2'] }));
      r.register(command({ id: 'b', shortcut: 'mod+r', priority: 90, visibleInViews: ['chat-v2'] }));
    })).toBe(1);
    // equal priority: settled by id
    expect(warnings((r) => {
      r.register(command({ id: 'a', shortcut: 'mod+r', priority: 90 }));
      r.register(command({ id: 'b', shortcut: 'mod+r', priority: 90, visibleInViews: ['chat-v2'] }));
    })).toBe(1);
  });
});

const NAMED_KEYS: Record<string, { key: string; code: string }> = {
  up: { key: 'ArrowUp', code: 'ArrowUp' },
  down: { key: 'ArrowDown', code: 'ArrowDown' },
  left: { key: 'ArrowLeft', code: 'ArrowLeft' },
  right: { key: 'ArrowRight', code: 'ArrowRight' },
  tab: { key: 'Tab', code: 'Tab' },
  '`': { key: '`', code: 'Backquote' },
  '\\': { key: '\\', code: 'Backslash' },
  '[': { key: '[', code: 'BracketLeft' },
  ']': { key: ']', code: 'BracketRight' },
  '=': { key: '=', code: 'Equal' },
  '-': { key: '-', code: 'Minus' },
  '.': { key: '.', code: 'Period' },
  ',': { key: ',', code: 'Comma' },
  '/': { key: '/', code: 'Slash' },
};

function keyOf(token: string): { key: string; code: string } {
  if (NAMED_KEYS[token]) return NAMED_KEYS[token];
  if (/^[a-z]$/.test(token)) return { key: token, code: `Key${token.toUpperCase()}` };
  if (/^[0-9]$/.test(token)) return { key: token, code: `Digit${token}` };
  if (/^f\d{1,2}$/.test(token)) return { key: token.toUpperCase(), code: token.toUpperCase() };
  throw new Error(`no key for "${token}"`);
}

/** The keydowns that run a command shortcut: `buildShortcutString` reads both ⌘ and Ctrl as `mod`, on every platform. */
function commandKeydowns(shortcut: string): KeyboardEvent[] {
  const tokens = shortcut.toLowerCase().split('+');
  const { key, code } = keyOf(tokens[tokens.length - 1]);
  const init = { key, code, shiftKey: tokens.includes('shift'), altKey: tokens.includes('alt') };
  return (tokens.includes('mod') ? [{ metaKey: true }, { ctrlKey: true }] : [{}])
    .map((modifier) => new KeyboardEvent('keydown', { ...init, ...modifier }));
}

describe('command shortcuts vs the Workbench window shortcuts', () => {
  afterEach(() => setWorkbenchShortcutPlatformOverride(null));

  const windowShortcutFor = (shortcut: string, isMac: boolean) => {
    setWorkbenchShortcutPlatformOverride(isMac);
    return commandKeydowns(shortcut).map((event) => matchWorkbenchShortcut(event)?.id).find(Boolean);
  };

  it('sees a collision when a command takes a window shortcut', () => {
    expect(windowShortcutFor('mod+alt+d', true)).toBe('show-desktop');
    expect(windowShortcutFor('mod+alt+d', false)).toBe('show-desktop');
    expect(windowShortcutFor('mod+w', true)).toBe('close-window');
    expect(windowShortcutFor('mod+w', false)).toBe('close-window');
    expect(windowShortcutFor('mod+shift+w', false)).toBeUndefined();
  });

  it('binds no official command to a key the Workbench window manager also handles, on macOS or elsewhere', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await bootOfficial(new CommandRegistry());
    const bound = registry.getAll().filter((c) => c.shortcut);
    expect(bound.length).toBeGreaterThan(30);
    const collisions = bound.flatMap((c) => [true, false].flatMap((isMac) => {
      const hit = windowShortcutFor(c.shortcut!, isMac);
      return hit ? [`${c.id} (${c.shortcut}) is also ${hit} on ${isMac ? 'macOS' : 'Windows/Linux'}`] : [];
    }));
    expect(collisions).toEqual([]);
  });
});

describe('shortcut settings conflict check', () => {
  it('prompts only for commands that can apply to the same focused workbench app, like the registry', () => {
    const revoke = commandRegistry.registerAll([
      command({ id: 'chat.x', shortcut: 'mod+shift+1', visibleInViews: ['chat-v2', 'workbench'], workbenchApps: ['chat'] }),
      command({ id: 'notes.y', shortcut: 'mod+shift+2', visibleInViews: ['learning-hub', 'workbench'], workbenchApps: ['notes'] }),
      command({ id: 'files.z', shortcut: 'mod+shift+3', visibleInViews: ['workbench'], workbenchApps: ['files', 'chat'] }),
    ]);
    try {
      expect(shortcutManager.checkConflict('mod+shift+2', 'chat.x')).toBeNull();
      expect(shortcutManager.checkConflict('mod+shift+3', 'chat.x')).toEqual({ shortcut: 'mod+shift+3', commands: ['files.z'] });
      expect(shortcutManager.checkConflict('mod+shift+2')).toEqual({ shortcut: 'mod+shift+2', commands: ['notes.y'] });
    } finally {
      revoke();
    }
  });
});
