import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { ChatV2Error } from '../api.ts';
import type { PlanGateManager, PlanGateResponse } from '../../chat-pipeline/api.ts';
import { planGateRespondAction } from '../src/plan-gate.ts';

function commandError(kind: string, data?: unknown): string {
  const ErrorClass = ChatV2Error as unknown as new (kind: string, data?: unknown) => ChatV2Error;
  return new ErrorClass(kind, data).toCommandError();
}

function fakePlanGateManager(): { manager: PlanGateManager; pending: Map<string, unknown> } {
  const pending = new Map<string, { planId: string; resolve(value: PlanGateResponse): void }>();
  const manager: PlanGateManager = {
    withTimeout() { return manager; },
    defaultTimeout() { return 300; },
    register(sessionId, toolCallId, planId) {
      const key = `${sessionId}\n${toolCallId}`;
      return new Promise<PlanGateResponse>(resolve => { pending.set(key, { planId, resolve }); });
    },
    respond(response) {
      const key = `${response.sessionId}\n${response.toolCallId}`;
      const waiting = pending.get(key);
      if (waiting === undefined || waiting.planId !== response.planId) return false;
      pending.delete(key);
      waiting.resolve(response);
      return true;
    },
    cancel(sessionId, toolCallId) {
      pending.delete(`${sessionId}\n${toolCallId}`);
    },
  };
  return { manager, pending };
}

describe('chat_v2_plan_gate_respond', () => {
  let f: ReturnType<typeof databaseFixture>;

  afterEach(() => { f?.dispose(); });

  async function setup(gates: PlanGateManager): Promise<Awaited<ReturnType<typeof createTestHost>>> {
    f = databaseFixture();
    return createTestHost({
      plugins: [plugin],
      provide: { storage: f.storage, vfs: vfsStub, 'chatPipeline': { planGateManager: gates } },
    });
  }

  it('delivers an approval to the waiting plan gate', async () => {
    const { manager, pending } = fakePlanGateManager();
    const host = await setup(manager);
    try {
      const wait = manager.register('sess_plan', 'call_1', 'plan_1');
      expect(pending.size).toBe(1);
      const result = await host.invoke('chat_v2_plan_gate_respond', {
        sessionId: 'sess_plan', planId: 'plan_1', toolCallId: 'call_1',
        approved: true, reason: 'looks good',
      });
      expect(result).toBeNull();
      await expect(wait).resolves.toEqual({
        sessionId: 'sess_plan', planId: 'plan_1', toolCallId: 'call_1',
        approved: true, reason: 'looks good',
      });
      expect(pending.size).toBe(0);
    } finally {
      await host.dispose();
    }
  });

  it('omits an absent reason and rejects a second response', async () => {
    const { manager } = fakePlanGateManager();
    const host = await setup(manager);
    try {
      const wait = manager.register('sess_plan', 'call_2', 'plan_2');
      await host.invoke('chat_v2_plan_gate_respond', {
        sessionId: 'sess_plan', planId: 'plan_2', toolCallId: 'call_2',
        approved: false, reason: null,
      });
      const response = await wait;
      expect(response).toEqual({ sessionId: 'sess_plan', planId: 'plan_2', toolCallId: 'call_2', approved: false });
      expect('reason' in response).toBe(false);

      await expect(host.invoke('chat_v2_plan_gate_respond', {
        sessionId: 'sess_plan', planId: 'plan_2', toolCallId: 'call_2', approved: true,
      })).rejects.toBe(commandError('Timeout',
        'plan_gate_expired: no waiting plan gate for tool_call_id=call_2'));
    } finally {
      await host.dispose();
    }
  });

  it('does not consume the waiting gate when the plan id differs', async () => {
    const { manager, pending } = fakePlanGateManager();
    const host = await setup(manager);
    try {
      const wait = manager.register('sess_plan', 'call_3', 'plan_3');
      await expect(host.invoke('chat_v2_plan_gate_respond', {
        sessionId: 'sess_plan', planId: 'plan_stale', toolCallId: 'call_3', approved: true,
      })).rejects.toBe(commandError('Timeout',
        'plan_gate_expired: no waiting plan gate for tool_call_id=call_3'));
      expect(pending.size).toBe(1);

      await host.invoke('chat_v2_plan_gate_respond', {
        sessionId: 'sess_plan', planId: 'plan_3', toolCallId: 'call_3', approved: true,
      });
      await expect(wait).resolves.toMatchObject({ planId: 'plan_3', approved: true });
    } finally {
      await host.dispose();
    }
  });

  it('reports an unavailable plan gate manager', async () => {
    f = databaseFixture();
    const host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    try {
      await expect(host.invoke('chat_v2_plan_gate_respond', {
        sessionId: 'sess_plan', planId: 'plan_1', toolCallId: 'call_1', approved: true,
      })).rejects.toBe(commandError('Other', 'PlanGateManager is not available'));
    } finally {
      await host.dispose();
    }
    expect(() => planGateRespondAction(undefined, {
      sessionId: 'sess_plan', planId: 'plan_1', toolCallId: 'call_1', approved: true,
    })).toThrow('PlanGateManager is not available');
  });
});
