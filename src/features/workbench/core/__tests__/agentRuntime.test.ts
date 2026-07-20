import { beforeEach, describe, expect, it } from 'vitest';
import { appRegistry } from '../appRegistry';
import {
  actOnAgentWindow,
  AgentRuntimeError,
  getAgentCapabilities,
  observeAgentWindow,
  revertAgentUndo,
  waitForAgentCondition,
} from '../agentRuntime';
import { resetAgentUndoJournalForTests } from '../agentUndoJournal';
import type { AgentActionCall, AppDefinition } from '../types';
import { resetWindowStoreForTests, useWindowStore } from '../windowStore';

const TYPE_ID = 'acr2-core-runtime-test';
let value = 0;
let appRevision = 0;
let manyNodes = false;
let refAvailable = true;
let encodedTargetId: string | null = null;

function currentCounterRef(): string {
  return `counter:item:${encodeURIComponent(encodedTargetId ?? 'main')}`;
}

appRegistry.register({
  typeId: TYPE_ID,
  nameKey: 'workbench:test.acr2',
  icon: null,
  instanceMode: 'multi',
  memoryWeight: 1,
  defaultFrame: { w: 400, h: 300 },
  minSize: { w: 200, h: 150 },
  render: null as unknown as AppDefinition['render'],
  agentManifest: {
    version: 1,
    description: 'ACR 2.0 core fixture',
    capabilities: [
      {
        name: 'setValue',
        description: 'Set the fixture value',
        inputSchema: {
          type: 'object',
          properties: {
            value: { type: 'number' },
            entityRef: { type: 'string' },
          },
          required: ['value'],
          additionalProperties: false,
        },
        risk: 'low',
        mutates: true,
        reversible: true,
        idempotent: true,
        targetKinds: ['counter'],
      },
      {
        name: 'readValue',
        description: 'Read the fixture value',
        inputSchema: { type: 'object', additionalProperties: false },
        risk: 'read',
        mutates: false,
        reversible: false,
        idempotent: true,
      },
      {
        name: 'opaqueWrite',
        description: 'Mutation without a verifiable handler receipt',
        inputSchema: { type: 'object', additionalProperties: false },
        risk: 'low',
        mutates: true,
        reversible: false,
        idempotent: false,
      },
    ],
    observe: () => ({
      revision: `app:${appRevision}`,
      state: { value },
      selection: refAvailable ? [currentCounterRef()] : [],
      availableActions: ['setValue', 'readValue', 'opaqueWrite', 'undeclaredAction'],
      entities: refAvailable
        ? [{
            ref: currentCounterRef(),
            kind: 'counter',
            label: 'Counter',
            actions: ['setValue', 'undeclaredAction'],
          }]
        : [],
      affordances: manyNodes
        ? Array.from({ length: 205 }, (_, index) => ({
            ref: `counter:item:${index}`,
            kind: 'counter',
            actions: ['setValue'],
          }))
        : refAvailable
          ? [{
              ref: currentCounterRef(),
              kind: 'counter',
              actions: ['setValue', 'undeclaredAction'],
            }]
          : [],
    }),
    execute: (_ctx, action) => {
      if (action.name === 'readValue') {
        return { handled: true, changed: false, details: { value } };
      }
      if (action.name === 'opaqueWrite') {
        value += 1;
        appRevision += 1;
        return { handled: true };
      }
      if (action.name !== 'setValue') return { handled: false };
      const next = Number((action.args as { value: number }).value);
      const previous = value;
      value = next;
      appRevision += 1;
      const inverse: AgentActionCall = {
        name: 'setValue',
        args: { value: previous },
        targetRef: action.targetRef ?? currentCounterRef(),
      };
      return {
        handled: true,
        changed: true,
        acknowledged: true,
        entityRefs: ['counter:item:main'],
        undo: { inverse, label: 'Restore fixture value' },
      };
    },
  },
});

function openFixture(): string {
  return useWindowStore.getState().openWindow({
    typeId: TYPE_ID,
    instanceKey: 'fixture-1',
    title: 'Fixture',
  });
}

describe('ACR 2.0 core runtime', () => {
  beforeEach(() => {
    resetWindowStoreForTests({ w: 1200, h: 800 });
    resetAgentUndoJournalForTests({ clearStorage: true });
    value = 0;
    appRevision = 0;
    manyNodes = false;
    refAvailable = true;
    encodedTargetId = null;
  });

  it('discovers typed capabilities and emits a deterministic bounded observation', async () => {
    const windowId = openFixture();
    const discovery = getAgentCapabilities({ typeId: TYPE_ID });
    expect(discovery.apps[0]).toMatchObject({
      typeId: TYPE_ID,
      manifestVersion: 1,
      capabilities: [
        { name: 'setValue', mutates: true, reversible: true },
        { name: 'readValue', risk: 'read', mutates: false },
        { name: 'opaqueWrite', mutates: true, reversible: false },
      ],
    });

    const first = await observeAgentWindow({ windowId });
    const second = await observeAgentWindow({ windowId });
    expect(second.revision).toBe(first.revision);
    expect(first.availableActions).toEqual(['setValue', 'readValue', 'opaqueWrite']);
    expect(first.affordances.roots[0].actions).toEqual(['setValue']);
    expect(first.selection).toEqual(['counter:item:main']);

    manyNodes = true;
    appRevision += 1;
    const bounded = await observeAgentWindow({ windowId });
    expect(bounded.affordances).toMatchObject({
      nodeCount: 200,
      truncated: true,
    });
  });

  it('soft-rebases stale observations when the batch still validates against the fresh state', async () => {
    const windowId = openFixture();
    const stale = await observeAgentWindow({ windowId });
    value = 7;
    appRevision += 1;
    const rebased = await actOnAgentWindow({
      windowId,
      observationRevision: stale.revision,
      actions: [{ name: 'setValue', args: { value: 8 }, targetRef: 'counter:item:main' }],
    });
    expect(rebased.status).toBe('completed');
    expect(rebased.rebasedFromRevision).toBe(stale.revision);
    expect(value).toBe(8);
  });

  it('rejects stale observations with the fresh observation attached when rebase is impossible', async () => {
    const windowId = openFixture();
    const stale = await observeAgentWindow({ windowId });
    value = 7;
    refAvailable = false;
    appRevision += 1;
    await expect(actOnAgentWindow({
      windowId,
      observationRevision: stale.revision,
      actions: [{ name: 'setValue', args: { value: 8 }, targetRef: 'counter:item:main' }],
    })).rejects.toMatchObject({
      code: 'STALE_OBSERVATION',
      retryable: true,
      details: expect.objectContaining({
        observation: expect.objectContaining({ windowId }),
      }),
    });
    expect(value).toBe(7);
  });

  it('rejects stable refs that are no longer available', async () => {
    const windowId = openFixture();
    value = 7;
    appRevision += 1;
    const current = await observeAgentWindow({ windowId });
    const missingRef = await actOnAgentWindow({
      windowId,
      observationRevision: current.revision,
      actions: [{ name: 'setValue', args: { value: 8 } }],
    });
    expect(missingRef.results[0]).toMatchObject({ code: 'INVALID_AGENT_REF' });
    expect(value).toBe(7);

    const mismatchedRef = await actOnAgentWindow({
      windowId,
      observationRevision: current.revision,
      actions: [{
        name: 'setValue',
        args: { value: 8, entityRef: 'counter:item:other' },
        targetRef: 'counter:item:main',
      }],
    });
    expect(mismatchedRef.results[0]).toMatchObject({ code: 'TARGET_REF_MISMATCH' });
    expect(value).toBe(7);

    const invalidRef = await actOnAgentWindow({
      windowId,
      observationRevision: current.revision,
      actions: [{ name: 'setValue', args: { value: 8 }, targetRef: 'counter:item:missing' }],
    });
    expect(invalidRef).toMatchObject({
      status: 'failed',
      verified: false,
      results: [{ code: 'INVALID_AGENT_REF', verificationSource: 'unverified' }],
    });
  });

  it('verifies mutating actions by revision and replays persistent undo after reload', async () => {
    const windowId = openFixture();
    const before = await observeAgentWindow({ windowId });
    const receipt = await actOnAgentWindow({
      windowId,
      observationRevision: before.revision,
      actions: [{
        id: 'set-1',
        name: 'setValue',
        args: { value: 42 },
        targetRef: 'counter:item:main',
      }],
    });
    expect(value).toBe(42);
    expect(receipt).toMatchObject({
      status: 'completed',
      verified: true,
      undoDurability: 'persistent',
      results: [{
        handled: true,
        verified: true,
        verificationSource: 'handler-ack',
      }],
    });
    expect(receipt.undoToken).toMatch(/^acr-undo:/);

    // Simulate process memory loss and a restored window with a different windowId.
    resetAgentUndoJournalForTests();
    resetWindowStoreForTests({ w: 1200, h: 800 });
    openFixture();
    refAvailable = false;
    const deferred = await revertAgentUndo(receipt.undoToken!);
    expect(deferred).toMatchObject({
      reverted: false,
      undoToken: receipt.undoToken,
      durability: 'persistent',
    });
    expect(value).toBe(42);

    refAvailable = true;
    const reverted = await revertAgentUndo(receipt.undoToken!);
    expect(reverted).toMatchObject({
      reverted: true,
      undoToken: receipt.undoToken,
      durability: 'persistent',
    });
    expect(value).toBe(0);
    await expect(revertAgentUndo(receipt.undoToken!)).rejects.toBeInstanceOf(AgentRuntimeError);
  });

  it('binds persistent undo tokens to the originating chat session', async () => {
    const windowId = openFixture();
    const before = await observeAgentWindow({ windowId });
    const receipt = await actOnAgentWindow({
      windowId,
      observationRevision: before.revision,
      actions: [{
        name: 'setValue',
        args: { value: 17 },
        targetRef: 'counter:item:main',
      }],
    }, { sessionId: 'session-a' });
    expect(value).toBe(17);

    await expect(revertAgentUndo(receipt.undoToken!, {
      sessionId: 'session-b',
      approvalRiskCeiling: 'high',
    })).resolves.toMatchObject({
      reverted: false,
      message: expect.stringContaining('不属于当前会话'),
    });
    expect(value).toBe(17);

    await expect(revertAgentUndo(receipt.undoToken!, {
      sessionId: 'session-a',
      approvalRiskCeiling: 'high',
    })).resolves.toMatchObject({ reverted: true });
    expect(value).toBe(0);
  });

  it('marks read-only actions verified and bounds wait_for success/timeout', async () => {
    const windowId = openFixture();
    const before = await observeAgentWindow({ windowId });
    const read = await actOnAgentWindow({
      windowId,
      observationRevision: before.revision,
      actions: [{ name: 'readValue', args: {} }],
    });
    expect(read.results[0]).toMatchObject({
      verified: true,
      verificationSource: 'read-only-observation',
    });

    setTimeout(() => {
      value = 9;
      appRevision += 1;
    }, 30);
    const matched = await waitForAgentCondition({
      windowId,
      condition: { kind: 'state_equals', path: 'value', value: 9 },
      timeoutMs: 250,
      intervalMs: 25,
    });
    expect(matched.matched).toBe(true);

    const timedOut = await waitForAgentCondition({
      windowId,
      condition: { kind: 'state_equals', path: 'value', value: 999 },
      timeoutMs: 30,
      intervalMs: 25,
    });
    expect(timedOut).toMatchObject({ matched: false, timedOut: true });
    expect(timedOut.elapsedMs).toBeLessThan(100);
  });

  it('fails closed when a mutating handler provides no verifiable result', async () => {
    const windowId = openFixture();
    const before = await observeAgentWindow({ windowId });
    const result = await actOnAgentWindow({
      windowId,
      observationRevision: before.revision,
      actions: [{ name: 'opaqueWrite', args: {} }],
    });
    expect(value).toBe(1);
    expect(result).toMatchObject({
      status: 'partial',
      verified: false,
      results: [{
        handled: true,
        verified: false,
        verificationSource: 'unverified',
      }],
    });
  });

  it('validates malformed conditions and schema patterns before side effects', async () => {
    const windowId = openFixture();
    const before = await observeAgentWindow({ windowId });
    await expect(actOnAgentWindow({
      windowId,
      observationRevision: before.revision,
      actions: [{
        name: 'setValue',
        args: { value: 3 },
        targetRef: 'counter:item:main',
        expect: [{ kind: 'state_equals', value: 3 } as never],
      }],
    })).rejects.toMatchObject({ code: 'INVALID_CONDITION' });
    expect(value).toBe(0);

    await expect(waitForAgentCondition({
      windowId,
      condition: { kind: 'action_available' } as never,
      timeoutMs: 1,
    })).rejects.toMatchObject({ code: 'INVALID_CONDITION' });

    const capability = appRegistry.getAgentCapability(TYPE_ID, 'setValue')!;
    const valueSchema = capability.inputSchema.properties!.value!;
    const original = { ...valueSchema };
    try {
      valueSchema.type = 'string';
      valueSchema.pattern = '^\\d{4}-\\d{2}-\\d{2}$';
      await expect(actOnAgentWindow({
        windowId,
        observationRevision: before.revision,
        actions: [{
          name: 'setValue',
          args: { value: 'not-a-date' },
          targetRef: 'counter:item:main',
        }],
      })).rejects.toMatchObject({ code: 'INVALID_ACTION_ARGS' });

      valueSchema.pattern = '[';
      await expect(actOnAgentWindow({
        windowId,
        observationRevision: before.revision,
        actions: [{
          name: 'setValue',
          args: { value: '2026-07-12' },
          targetRef: 'counter:item:main',
        }],
      })).rejects.toMatchObject({ code: 'INVALID_ACTION_ARGS' });
    } finally {
      Object.keys(valueSchema).forEach((key) => delete valueSchema[key]);
      Object.assign(valueSchema, original);
    }
    expect(value).toBe(0);
  });

  it('compares targetIdPath against the decoded stable-ref id segment', async () => {
    const windowId = openFixture();
    const capability = appRegistry.getAgentCapability(TYPE_ID, 'setValue')!;
    const properties = capability.inputSchema.properties!;
    const previousPath = capability.targetIdPath;
    const previousEntityIdSchema = properties.entityId;
    const rawId = 'folder/a b:c';
    try {
      capability.targetIdPath = 'entityId';
      properties.entityId = { type: 'string' };
      encodedTargetId = rawId;
      appRevision += 1;
      const observed = await observeAgentWindow({ windowId });
      expect(currentCounterRef()).toBe('counter:item:folder%2Fa%20b%3Ac');

      const acted = await actOnAgentWindow({
        windowId,
        observationRevision: observed.revision,
        actions: [{
          name: 'setValue',
          args: { value: 12, entityId: rawId },
          targetRef: currentCounterRef(),
        }],
      });
      expect(acted).toMatchObject({ status: 'completed', verified: true });
      expect(value).toBe(12);
    } finally {
      capability.targetIdPath = previousPath;
      if (previousEntityIdSchema) properties.entityId = previousEntityIdSchema;
      else delete properties.entityId;
      encodedTargetId = null;
    }
  });

  it('persistent undo refuses user state drift and preserves the token', async () => {
    const windowId = openFixture();
    const before = await observeAgentWindow({ windowId });
    const acted = await actOnAgentWindow({
      windowId,
      observationRevision: before.revision,
      actions: [{ name: 'setValue', args: { value: 42 }, targetRef: currentCounterRef() }],
    });
    value = 99;
    appRevision += 1;
    const first = await revertAgentUndo(acted.undoToken!);
    const second = await revertAgentUndo(acted.undoToken!);
    expect(first).toMatchObject({
      reverted: false,
      undoToken: acted.undoToken,
      code: 'UNDO_CONFLICT',
    });
    expect(second).toMatchObject({
      reverted: false,
      undoToken: acted.undoToken,
      code: 'UNDO_CONFLICT',
    });
    expect(first.message).toContain('状态已变化');
    expect(value).toBe(99);
  });

  it('returns UNDO_IN_PROGRESS instead of joining a concurrent token replay', async () => {
    const windowId = openFixture();
    const before = await observeAgentWindow({ windowId });
    const acted = await actOnAgentWindow({
      windowId,
      observationRevision: before.revision,
      actions: [{ name: 'setValue', args: { value: 5 }, targetRef: currentCounterRef() }],
    });
    const manifest = appRegistry.getAgentManifest(TYPE_ID)!;
    const originalExecute = manifest.execute!;
    let releaseInverse!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseInverse = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    manifest.execute = async (ctx, action) => {
      if (
        action.name === 'setValue'
        && Number((action.args as { value: number }).value) === 0
      ) {
        markStarted();
        await gate;
      }
      return originalExecute(ctx, action);
    };
    try {
      const first = revertAgentUndo(acted.undoToken!);
      await started;
      const concurrent = await revertAgentUndo(acted.undoToken!);
      expect(concurrent).toMatchObject({
        reverted: false,
        code: 'UNDO_IN_PROGRESS',
        retryable: true,
      });
      releaseInverse();
      expect(await first).toMatchObject({ reverted: true });
    } finally {
      manifest.execute = originalExecute;
    }
  });

  it('ordinary undo cannot replay a High-risk forward action', async () => {
    const windowId = openFixture();
    const capability = appRegistry.getAgentCapability(TYPE_ID, 'setValue')!;
    const previousRisk = capability.risk;
    try {
      capability.risk = 'high';
      const before = await observeAgentWindow({ windowId });
      const acted = await actOnAgentWindow({
        windowId,
        observationRevision: before.revision,
        approvalRiskCeiling: 'high',
        actions: [{ name: 'setValue', args: { value: 7 }, targetRef: currentCounterRef() }],
      });
      const blocked = await revertAgentUndo(acted.undoToken!);
      expect(blocked).toMatchObject({ reverted: false, undoToken: acted.undoToken });
      expect(blocked.message).toContain('high 风险授权');
      expect(value).toBe(7);
      const elevated = await revertAgentUndo(acted.undoToken!, {
        approvalRiskCeiling: 'high',
      });
      expect(elevated.reverted).toBe(true);
      expect(value).toBe(0);
    } finally {
      capability.risk = previousRisk;
    }
  });

  it('wait_for aborts promptly and object schemas without properties reject extras', async () => {
    const windowId = openFixture();
    const before = await observeAgentWindow({ windowId });
    await expect(actOnAgentWindow({
      windowId,
      observationRevision: before.revision,
      actions: [{ name: 'readValue', args: { unexpected: true } }],
    })).rejects.toMatchObject({ code: 'INVALID_ACTION_ARGS' });

    const controller = new AbortController();
    const waiting = waitForAgentCondition({
      windowId,
      condition: { kind: 'state_equals', path: 'value', value: 999 },
      timeoutMs: 5_000,
      intervalMs: 25,
    }, { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
