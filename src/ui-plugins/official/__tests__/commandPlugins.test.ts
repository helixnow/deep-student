import { act } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import { getNavigationCommands } from '@/command-palette/modules/navigation.commands';
import { getChatCommands } from '@/command-palette/modules/chat.commands';
import { getGlobalCommands } from '@/command-palette/modules/global.commands';
import { settingsCommands } from '@/command-palette/modules/settings.commands';
import { notesCommands } from '@/command-palette/modules/notes.commands';
import { learningCommands } from '@/command-palette/modules/learning.commands';
import { automationCommands } from '@/command-palette/modules/automation.commands';
import { ankiCommands } from '@/command-palette/modules/anki.commands';
import { devCommands } from '@/command-palette/modules/dev.commands';
import type { Command } from '@/command-palette/registry/types';
import { installOfficialUiPlugins } from '../install';
import { memoryRegistryAdapters } from '../../testing/registries';

const ids = (commands: readonly { id: string }[]) => commands.map((command) => command.id);

const OWNERS: Record<string, () => readonly Command[]> = {
  'dstu.ui.navigation': getNavigationCommands,
  'dstu.ui.chat': getChatCommands,
  'dstu.ui.app': () => [...getGlobalCommands(), ...settingsCommands],
  'dstu.ui.notes': () => notesCommands,
  'dstu.ui.learning-hub': () => learningCommands,
  'dstu.ui.todo': () => automationCommands,
  'dstu.ui.anki': () => ankiCommands,
  'dstu.ui.dev': () => devCommands,
};

let kernel: UiKernel | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await kernel?.dispose();
  kernel = undefined;
  await act(async () => { await i18n.changeLanguage('zh-CN'); });
});

async function boot() {
  kernel = new UiKernel(memoryRegistryAdapters());
  await installOfficialUiPlugins(kernel);
  return kernel;
}

beforeAll(async () => {
  for (let i = 0; i < 200 && !(i18n.hasResourceBundle('zh-CN', 'command_palette') && i18n.hasResourceBundle('en-US', 'command_palette')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await act(async () => { await i18n.changeLanguage('zh-CN'); });
});

describe('official command plugins (FE-B1)', () => {
  it('installs one plugin per feature, in the original module order, each owning exactly its commands', async () => {
    const k = await boot();
    expect(ids(k.registries.commands.list())).toEqual(Object.values(OWNERS).flatMap((create) => ids(create())));
    for (const [owner, create] of Object.entries(OWNERS)) {
      const before = ids(k.registries.commands.list());
      await k.unload(owner);
      const own = ids(create());
      expect(ids(k.registries.commands.list())).toEqual(before.filter((id) => !own.includes(id)));
    }
    expect(k.registries.commands.list()).toEqual([]);
  });

  it('installs the developer commands in development builds only', async () => {
    vi.stubEnv('DEV', false);
    const k = await boot();
    expect(k.list()).not.toContain('dstu.ui.dev');
    expect(ids(k.registries.commands.list()).filter((id) => id.startsWith('dev.'))).toEqual([]);
    expect(k.registries.commands.list()).toHaveLength(87);
  });

  it('lets a community plugin add a command and rejects one that claims an official id', async () => {
    const k = await boot();
    const run = vi.fn();
    await k.install(defineUiPlugin({ meta: { id: 'community.study-stats' }, apply(ctx) {
      ctx.ui.commands.register({ id: 'studyStats.open', name: 'Open study stats', category: 'global', execute: run });
    } }));
    expect(k.registries.commands.get('studyStats.open')).toMatchObject({ name: 'Open study stats' });
    await expect(k.install(defineUiPlugin({ meta: { id: 'community.hijack' }, apply(ctx) {
      ctx.ui.commands.register({ id: 'nav.goto.chat-v2', name: 'Hijacked', category: 'navigation', execute: run });
    } }))).rejects.toThrow('command "nav.goto.chat-v2" is already registered');
    expect((k.registries.commands.get('nav.goto.chat-v2') as Command).name).toBe('跳转到智能对话');
    await k.unload('community.study-stats');
    expect(k.registries.commands.get('studyStats.open')).toBeUndefined();
  });

  it('follows the language without re-registering, so order and identity stay put', async () => {
    const k = await boot();
    const before = k.registries.commands.list();
    const navigate = before.find((command) => command.id === 'nav.goto.chat-v2') as unknown as Command;
    expect(navigate.name).toBe('跳转到智能对话');
    await act(async () => { await i18n.changeLanguage('en-US'); });
    expect(k.registries.commands.list()).toBe(before);
    expect(navigate.name).toBe('Go to Smart Chat');
    expect(navigate.keywords).toEqual(['chat', 'conversation', 'ai', 'smart', 'v2']);
  });

  it('picks up the command_palette namespace when it arrives after installation', async () => {
    const saved = i18n.getResourceBundle('zh-CN', 'command_palette');
    i18n.removeResourceBundle('zh-CN', 'command_palette');
    try {
      const k = await boot();
      const navigate = k.registries.commands.get('nav.goto.chat-v2') as Command;
      expect(navigate.name).toBe('Go to Smart Chat');
      act(() => { i18n.addResourceBundle('zh-CN', 'command_palette', saved, true, true); });
      expect(navigate.name).toBe('跳转到智能对话');
    } finally {
      if (!i18n.hasResourceBundle('zh-CN', 'command_palette')) i18n.addResourceBundle('zh-CN', 'command_palette', saved, true, true);
    }
  });

  it('stops following the language once its plugin is unloaded', async () => {
    const k = await boot();
    const navigate = k.registries.commands.get('nav.goto.chat-v2') as Command;
    await k.unload('dstu.ui.navigation');
    await act(async () => { await i18n.changeLanguage('en-US'); });
    expect(navigate.name).toBe('跳转到智能对话');
  });
});
