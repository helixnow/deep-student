import { afterEach, describe, expect, it } from 'vitest';
import { getChatCommands } from '@/command-palette/modules/chat.commands';
import type { CommandView, DependencyResolver } from '@/command-palette/registry/types';
import {
  peekPendingChatNavigation,
  resetChatNavigationHandshakeForTest,
} from '../pendingChatNavigation';

const SUPPORTED_CHAT_COMMAND_IDS = [
  'chat.new-session',
  'chat.new-analysis-session',
  'chat.stop',
  'chat.copy-last-response',
  'chat.toggle-rag',
  'chat.toggle-graph',
  'chat.toggle-web-search',
  'chat.toggle-mcp',
  'chat.toggle-sidebar',
  'chat.toggle-panel',
  'chat.bookmark',
  'chat.ai-continue',
];

function deps(view: CommandView, appType: string | null = null): DependencyResolver {
  return {
    getCurrentView: () => view,
    getFocusedWorkbenchAppTypeId: () => appType,
  } as DependencyResolver;
}

describe('chat command visibility', () => {
  afterEach(() => {
    resetChatNavigationHandshakeForTest();
  });

  it('registers only commands backed by real consumers', () => {
    const commands = getChatCommands();
    expect(commands.map((command) => command.id)).toEqual(SUPPORTED_CHAT_COMMAND_IDS);
    expect(commands.every((command) =>
      command.visibleInViews?.includes('chat-v2')
      && command.visibleInViews.includes('workbench'),
    )).toBe(true);
  });

  it('enables chat commands only in legacy chat or a focused main Chat workbench window', () => {
    for (const command of getChatCommands()) {
      expect(command.isEnabled?.(deps('chat-v2'))).toBe(true);
      expect(command.isEnabled?.(deps('workbench', 'chat'))).toBe(true);
      expect(command.isEnabled?.(deps('workbench', 'notes'))).toBe(false);
      expect(command.isEnabled?.(deps('workbench', 'chat-session'))).toBe(false);
    }
  });

  it('routes new-session through the cold-navigation handshake', () => {
    const command = getChatCommands().find((item) => item.id === 'chat.new-session');
    expect(command).toBeDefined();

    command?.execute(deps('workbench', 'chat'));
    expect(peekPendingChatNavigation()).toEqual({ kind: 'new-session' });
  });
});
