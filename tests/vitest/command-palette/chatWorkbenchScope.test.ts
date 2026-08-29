import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

import { getChatCommands } from '@/command-palette/modules/chat.commands';
import { getChatCapability } from '@/command-palette/registry/capabilityRegistry';
import type { DependencyResolver } from '@/command-palette/registry/types';
import {
  markChatPageReady,
  peekPendingChatNavigation,
  resetChatNavigationHandshakeForTest,
} from '@/features/chat/navigation/pendingChatNavigation';

function createDeps(
  view: ReturnType<DependencyResolver['getCurrentView']>,
  focusedWorkbenchAppTypeId: string | null = null,
): DependencyResolver {
  return {
    navigate: () => undefined,
    getCurrentView: () => view,
    getFocusedWorkbenchAppTypeId: () => focusedWorkbenchAppTypeId,
    t: ((key: string) => key) as unknown as TFunction,
    showNotification: () => undefined,
    toggleTheme: () => undefined,
    isDarkMode: () => false,
    switchLanguage: () => undefined,
    getCurrentLanguage: () => 'zh-CN',
    openCommandPalette: () => undefined,
    closeCommandPalette: () => undefined,
  };
}

describe('chat command workbench scope', () => {
  const commands = getChatCommands();
  const readyCommands = commands.filter((command) => getChatCapability(command.id) === 'ready');
  const registeredCommandIds = new Set(commands.map((command) => command.id));
  const hiddenCapabilityIds = [
    'chat.share',
    'chat.export',
    'chat.import',
    'chat.toggle-learn-mode',
    'chat.voice-input',
  ];

  afterEach(() => {
    resetChatNavigationHandshakeForTest();
  });

  it('registers only commands backed by ready capabilities', () => {
    expect(readyCommands.length).toBeGreaterThan(0);
    expect(readyCommands).toHaveLength(commands.length);
  });

  it('exposes every ready command in both chat-v2 and workbench views', () => {
    for (const command of readyCommands) {
      expect(command.visibleInViews, command.id).toContain('chat-v2');
      expect(command.visibleInViews, command.id).toContain('workbench');
    }
  });

  it('enables ready commands in the workbench only when the focused app is chat', () => {
    for (const command of readyCommands) {
      expect(command.isEnabled?.(createDeps('workbench', 'chat')), command.id).toBe(true);
      expect(command.isEnabled?.(createDeps('workbench', 'notes')), command.id).toBe(false);
      expect(command.isEnabled?.(createDeps('workbench', null)), command.id).toBe(false);
    }
  });

  it('keeps ready commands enabled in the legacy chat-v2 view', () => {
    for (const command of readyCommands) {
      expect(command.isEnabled?.(createDeps('chat-v2')), command.id).toBe(true);
    }
  });

  it('does not register hidden ghost commands', () => {
    for (const commandId of hiddenCapabilityIds) {
      expect(getChatCapability(commandId), commandId).toBe('hidden');
      expect(registeredCommandIds.has(commandId), commandId).toBe(false);
    }
  });

  it('executes the ready command via its window event when focused on the workbench chat app', () => {
    const newSession = commands.find((command) => command.id === 'chat.new-session');
    if (!newSession) throw new Error('chat.new-session command must be registered');

    const listener = vi.fn();
    window.addEventListener('CHAT_NEW_SESSION', listener);
    try {
      newSession.execute(createDeps('workbench', 'chat'));
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('CHAT_NEW_SESSION', listener);
    }
  });

  it('queues chat.new-session while ChatV2Page is not ready and replays it on ready', () => {
    const newSession = commands.find((command) => command.id === 'chat.new-session');
    if (!newSession) throw new Error('chat.new-session command must be registered');

    // 页面未就绪：事件照发（壳层开窗依赖），意图入 pending
    newSession.execute(createDeps('workbench', 'chat'));
    expect(peekPendingChatNavigation()).toEqual({ kind: 'new-session' });

    // 页面就绪：pending 重放为 CHAT_NEW_SESSION
    const listener = vi.fn();
    window.addEventListener('CHAT_NEW_SESSION', listener);
    try {
      markChatPageReady();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(peekPendingChatNavigation()).toBeNull();
    } finally {
      window.removeEventListener('CHAT_NEW_SESSION', listener);
    }
  });
});
