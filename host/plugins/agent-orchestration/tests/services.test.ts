import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import {
  agentAutomationService, agentSubagentService, agentTodoService, BUILTIN_DESCRIPTORS, isPtcAllowed,
  type AgentAutomationService, type AgentSubagentService, type AgentTodoService,
} from '../api.ts';

function settingsStore(): { get(key: string): string | null; save(key: string, value: string): void } {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    save: (key, value) => { values.set(key, value); },
  };
}

function unavailableStorage(): { database(name: string): never } {
  return {
    database(name: string): never {
      throw new Error(`database ${name} is not available in this wiring test`);
    },
  };
}

describe('agent-orchestration service registration', () => {
  it('provides agentAutomation, agentSubagent and agentTodo under their lowerCamelCase names', async () => {
    const host = await createTestHost({
      plugins: [plugin],
      provide: { settings: settingsStore(), storage: unavailableStorage() },
    });
    const automation = host.ctx.get('agentAutomation') as AgentAutomationService | undefined;
    const subagent = host.ctx.get('agentSubagent') as AgentSubagentService | undefined;
    const todo = host.ctx.get('agentTodo') as AgentTodoService | undefined;
    expect(automation).toBeDefined();
    expect(subagent).toBeDefined();
    expect(todo).toBeDefined();
    expect(typeof todo?.loadPersistedTodoList).toBe('function');
    expect(typeof todo?.restoreTodoListFromDb).toBe('function');
    expect(plugin.meta.provides).toEqual(['agentAutomation', 'agentSubagent', 'agentTodo']);
    expect(agentAutomationService).toEqual({ name: 'agentAutomation', version: '1.0.0' });
    expect(agentSubagentService).toEqual({ name: 'agentSubagent', version: '1.0.0' });
    expect(agentTodoService).toEqual({ name: 'agentTodo', version: '1.0.0' });
  });

  it('agentSubagent reads and writes settings without the L04/L05 services', async () => {
    const host = await createTestHost({
      plugins: [plugin],
      provide: { settings: settingsStore(), storage: unavailableStorage() },
    });
    const subagent = host.ctx.get('agentSubagent') as AgentSubagentService;
    expect(subagent.isEnabled()).toBe(false);
    expect(subagent.getSettings()).toEqual({ instructions: '' });
    subagent.setSettings({ instructions: '  keep the workspace tidy  ' });
    expect(subagent.getSettings()).toEqual({ instructions: 'keep the workspace tidy' });
  });

  it('does not publish dependent capabilities before L03/L04 provide them', async () => {
    const host = await createTestHost({
      plugins: [plugin],
      provide: { settings: settingsStore(), storage: unavailableStorage() },
    });
    const subagent = host.ctx.get('agentSubagent') as AgentSubagentService;
    expect(subagent.runHeadlessTurn).toBeUndefined();
    expect(subagent.runHeadlessAgentTurn).toBeUndefined();
    expect(subagent.deliverInbox).toBeUndefined();
    expect(host.ctx.commands.has('chat_v2_super_deliver_inbox')).toBe(false);
    expect(host.ctx.commands.has('chat_v2_background_subagent')).toBe(false);
  });

  it('publishes headless and inbox capabilities once their providers exist', async () => {
    const runner = {
      runHeadlessTurn: async () => ({
        sessionId: 'sess_turn', assistantMessageId: 'msg_turn', status: 'completed',
        summary: 'ok', durationMs: 1,
      }),
      runHeadlessAgentTurn: async () => ({
        sessionId: 'sess_wake', assistantMessageId: 'msg_wake', content: 'ok', durationMs: 1,
      }),
    };
    const pipeline = { runSendMessage: async () => 'a', spawnGoalContinuation: () => {}, settleActiveGoal: () => {} };
    const host = await createTestHost({
      plugins: [plugin],
      provide: {
        settings: settingsStore(), storage: unavailableStorage(),
        chatSession: runner, 'chat.send@1': pipeline,
      },
    });
    const subagent = host.ctx.get('agentSubagent') as AgentSubagentService;
    expect(typeof subagent.deliverInbox).toBe('function');
    expect(typeof subagent.runHeadlessTurn).toBe('function');
    expect(typeof subagent.runHeadlessAgentTurn).toBe('function');
    expect(host.ctx.commands.has('chat_v2_super_deliver_inbox')).toBe(true);
    await expect(subagent.runHeadlessTurn!({
      prompt: 'hello', sessionMode: 'isolated', source: 'test',
    })).resolves.toMatchObject({ sessionId: 'sess_turn', status: 'completed' });
  });

  it('api.ts publishes the PTC descriptor surface consumed by L07 agent-skills', () => {
    expect(BUILTIN_DESCRIPTORS.length).toBeGreaterThan(0);
    expect(BUILTIN_DESCRIPTORS.every((descriptor) => typeof descriptor.name === 'string')).toBe(true);
    expect(isPtcAllowed('unified_search')).toBe(true);
    expect(isPtcAllowed('builtin-web_search')).toBe(true);
    expect(isPtcAllowed('note_read')).toBe(false);
    expect(isPtcAllowed('not_a_tool')).toBe(false);
  });
});
