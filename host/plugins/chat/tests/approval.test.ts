import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { ChatV2Error } from '../api.ts';
import type { ApprovalManager, ApprovalResponse } from '../../agent-workspace/api.ts';
import type { SettingsService } from '../../../platform/settings/api.ts';

interface FakeState {
  values: Map<string, string>;
  remembered: number;
  responses: ApprovalResponse[];
  cancelled: string[];
  nextResult: { delivered: boolean; settingKey: string | null };
}

function fakeSettings(state: FakeState): SettingsService {
  return {
    save(key: string, value: string) { state.values.set(key, value); },
    get(key: string) { return state.values.get(key) ?? null; },
    delete(key: string) { return state.values.delete(key); },
    listByPrefix(prefix: string) {
      return [...state.values.entries()].filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value, updatedAt: '2026-01-01T00:00:00Z' }));
    },
    deleteByPrefix(prefix: string) {
      let count = 0;
      for (const key of [...state.values.keys()]) {
        if (key.startsWith(prefix)) { state.values.delete(key); count += 1; }
      }
      return count;
    },
    saveSecret: async (key, value) => { state.values.set(key, value); },
    getSecret: async key => state.values.get(key) ?? null,
    deleteSecret: async key => state.values.delete(key),
    bind: () => fakeSettings(state),
  };
}

function fakeApprovals(state: FakeState): ApprovalManager {
  return {
    register: async () => { throw new Error('not used'); },
    registerWithScope: async () => { throw new Error('not used'); },
    respond: () => false,
    respondWithResult(response: ApprovalResponse) {
      state.responses.push(response);
      return state.nextResult;
    },
    cancelWithSession: () => false,
    rejectAllPending: () => 0,
    cancel(toolCallId: string) { state.cancelled.push(toolCallId); return true; },
    checkRemembered: () => null,
    checkSessionRemembered: () => null,
    clearSessionRemembered: () => undefined,
    clearRemembered: () => undefined,
    clearAllRemembered() { state.remembered += 1; },
    defaultTimeout: () => 0,
    pendingCount: () => 0,
  };
}

function commandError(kind: string, data?: unknown): string {
  const ErrorClass = ChatV2Error as unknown as new (kind: string, data?: unknown) => ChatV2Error;
  return new ErrorClass(kind, data).toCommandError();
}

describe('chat_v2 tool approval commands', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let state: FakeState;

  async function makeHost(approvals = true): Promise<void> {
    state = {
      values: new Map(), remembered: 0, responses: [], cancelled: [],
      nextResult: { delivered: true, settingKey: 'tool_approval.scope.local:execute_command.{"command":"ls"}' },
    };
    host = await createTestHost({
      plugins: [plugin],
      provide: {
        storage: f.storage,
        vfs: vfsStub,
        settings: fakeSettings(state),
        ...(approvals ? { 'agentApproval': fakeApprovals(state) } : {}),
      },
    });
  }

  beforeEach(() => { f = databaseFixture(); });
  afterEach(async () => { await host?.dispose(); f.dispose(); });

  it('rejects an empty tool_call_id before touching the manager', async () => {
    await makeHost();
    await expect(host.invoke('chat_v2_tool_approval_respond', {
      sessionId: 'sess_1', toolCallId: '  ', toolName: 'execute_command', approved: true, remember: false,
    })).rejects.toBe(commandError('InvalidInput', 'tool_call_id must not be empty'));
    expect(state.responses).toHaveLength(0);
  });

  it('persists remembered approvals through the server-provided setting key', async () => {
    await makeHost();
    await expect(host.invoke('chat_v2_tool_approval_respond', {
      sessionId: 'sess_1', toolCallId: 'call_1', toolName: 'execute_command', approved: true,
      reason: 'looks fine', remember: true, rememberSession: null, arguments: { command: 'ls' },
    })).resolves.toBeNull();
    expect(state.responses).toEqual([{
      sessionId: 'sess_1', toolCallId: 'call_1', toolName: 'execute_command', approved: true,
      reason: 'looks fine', remember: true, rememberSession: false,
    }]);
    expect(state.values.get('tool_approval.scope.local:execute_command.{"command":"ls"}')).toBe('allow');

    state.nextResult = { delivered: true, settingKey: null };
    await host.invoke('chat_v2_tool_approval_respond', {
      sessionId: 'sess_1', toolCallId: 'call_2', toolName: 'skill_install', approved: false, remember: true,
    });
    // A null key means the manager already fail-closed the remember request.
    expect(state.values.size).toBe(1);
    expect(state.responses[1]!.approved).toBe(false);
  });

  it('does not persist when remember is false', async () => {
    await makeHost();
    await host.invoke('chat_v2_tool_approval_respond', {
      sessionId: 'sess_1', toolCallId: 'call_3', toolName: 'execute_command', approved: true, remember: false,
    });
    expect(state.values.size).toBe(0);
  });

  it('surfaces approval_expired and emits the error event when no waiter exists', async () => {
    await makeHost();
    state.nextResult = { delivered: false, settingKey: null };
    await expect(host.invoke('chat_v2_tool_approval_respond', {
      sessionId: 'sess_expired', toolCallId: 'call_gone', toolName: 'execute_command',
      approved: true, remember: true,
    })).rejects.toBe(commandError('Timeout',
      'approval_expired: no waiting approval for tool_call_id=call_gone'));
    const events = host.eventsNamed('chat_v2_event_sess_expired') as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_approval_request', phase: 'error', blockId: 'approval_call_gone',
      error: 'approval_expired', sessionId: 'sess_expired',
    });
    expect(state.values.size).toBe(0);
  });

  it('cancel forwards the tool_call_id and fails closed without a manager', async () => {
    await makeHost();
    await expect(host.invoke('chat_v2_tool_approval_cancel', { toolCallId: 'call_cancel' }))
      .resolves.toBeNull();
    expect(state.cancelled).toEqual(['call_cancel']);

    await host.dispose();
    await makeHost(false);
    await expect(host.invoke('chat_v2_tool_approval_cancel', { toolCallId: 'call_cancel' }))
      .rejects.toBe(commandError('Other', 'ApprovalManager is not available'));
  });

  it('clear_approval_history clears memory and deletes every scoped setting', async () => {
    await makeHost();
    state.values.set('tool_approval.scope.local:execute_command.{"command":"ls"}', 'allow');
    state.values.set('tool_approval.scope.local:skill_install.', 'deny');
    state.values.set('tool_approval.scope.', 'deny');
    state.values.set('chat_v2.unrelated', 'keep');
    await expect(host.invoke('chat_v2_clear_approval_history')).resolves.toBe(3);
    expect(state.remembered).toBe(1);
    expect([...state.values.keys()]).toEqual(['chat_v2.unrelated']);
    await expect(host.invoke('chat_v2_clear_approval_history')).resolves.toBe(0);
  });

  it('clear_approval_history maps settings failures to DATABASE_ERROR', async () => {
    await makeHost();
    const broken = fakeSettings(state);
    broken.deleteByPrefix = () => { throw new Error('disk I/O error'); };
    await host.dispose();
    host = await createTestHost({
      plugins: [plugin],
      provide: { storage: f.storage, vfs: vfsStub, settings: broken, 'agentApproval': fakeApprovals(state) },
    });
    await expect(host.invoke('chat_v2_clear_approval_history'))
      .rejects.toBe(commandError('Database', 'disk I/O error'));
  });
});
