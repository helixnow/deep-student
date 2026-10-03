import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';

import { CommandRegistry } from '@/command-palette/registry/commandRegistry';
import type { Command, DependencyResolver } from '@/command-palette/registry/types';

const deps: DependencyResolver = {
  navigate: () => {},
  getCurrentView: () => 'chat-v2',
  getFocusedWorkbenchAppTypeId: () => null,
  t: ((key: string) => key) as unknown as TFunction,
  showNotification: () => {},
  toggleTheme: () => {},
  isDarkMode: () => false,
  switchLanguage: () => {},
  getCurrentLanguage: () => 'zh-CN',
  openCommandPalette: () => {},
  closeCommandPalette: () => {},
};

const command = (id: string, name: string, extra: Partial<Command> = {}): Command => ({
  id,
  name,
  category: 'navigation',
  priority: 90,
  execute: () => {},
  ...extra,
});

describe('CommandRegistry.search', () => {
  it('无匹配时返回空——不能因为优先级加成把全部命令列出来（回车会执行无关命令）', () => {
    const registry = new CommandRegistry();
    registry.register(command('nav.goto.chat-v2', '跳转到智能对话'));
    registry.register(command('nav.goto.todo', '跳转到待办事项'));
    expect(registry.search('总览', 'chat-v2', deps)).toEqual([]);
  });

  it('关键词命中仍然返回，并排在前面', () => {
    const registry = new CommandRegistry();
    registry.register(command('nav.goto.chat-v2', '跳转到智能对话', { priority: 100 }));
    registry.register(command('nav.goto.dashboard', '跳转到仪表盘', { keywords: ['总览', '周报'], priority: 85 }));
    expect(registry.search('周报', 'chat-v2', deps).map((c) => c.id)).toEqual(['nav.goto.dashboard']);
  });
});
