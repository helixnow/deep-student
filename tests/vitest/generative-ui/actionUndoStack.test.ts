import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GenerativeActionDefinition } from '@/features/generative-ui/types';
import type { GenerativeActionTelemetryEvent } from '@/features/generative-ui/handlers/actionTelemetry';
import {
  GenerativeActionUndoStack,
  wrapReversibleAction,
  resolveGenerativeActionUndo,
  GENERATIVE_ACTION_UNDO_STACK_LIMIT,
} from '@/features/generative-ui/handlers/actionUndoStack';

function makeDef(
  overrides: Partial<GenerativeActionDefinition> = {},
): GenerativeActionDefinition {
  return {
    id: 'rev-action',
    label: 'Reversible',
    riskLevel: 'low',
    handler: () => undefined,
    ...overrides,
  };
}

describe('GenerativeActionUndoStack', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('undoes in LIFO order', async () => {
    const order: string[] = [];
    const stack = new GenerativeActionUndoStack({ sink: () => undefined });

    stack.push({ actionId: 'a', undo: () => { order.push('a'); } });
    stack.push({ actionId: 'b', undo: () => { order.push('b'); } });
    stack.push({ actionId: 'c', undo: () => { order.push('c'); } });

    expect(stack.canUndo()).toBe(true);
    expect(stack.size).toBe(3);

    await expect(stack.undo()).resolves.toBe(true);
    await expect(stack.undo()).resolves.toBe(true);
    await expect(stack.undo()).resolves.toBe(true);
    await expect(stack.undo()).resolves.toBe(false);

    expect(order).toEqual(['c', 'b', 'a']);
    expect(stack.canUndo()).toBe(false);
  });

  it('caps the stack at 20 entries (drops oldest)', async () => {
    const undone: string[] = [];
    const stack = new GenerativeActionUndoStack({ sink: () => undefined });

    for (let i = 0; i < GENERATIVE_ACTION_UNDO_STACK_LIMIT + 3; i += 1) {
      const id = `item-${i}`;
      stack.push({ actionId: id, undo: () => { undone.push(id); } });
    }

    expect(stack.size).toBe(20);
    expect(GENERATIVE_ACTION_UNDO_STACK_LIMIT).toBe(20);

    await stack.undo();
    expect(undone).toEqual(['item-22']);

    while (stack.canUndo()) {
      await stack.undo();
    }

    expect(undone[undone.length - 1]).toBe('item-3');
    expect(undone).not.toContain('item-0');
    expect(undone).not.toContain('item-1');
    expect(undone).not.toContain('item-2');
    expect(undone).toHaveLength(20);
  });

  it('clear() empties the stack', () => {
    const stack = new GenerativeActionUndoStack({ sink: () => undefined });
    stack.push({ actionId: 'a', undo: () => undefined });
    stack.clear();
    expect(stack.canUndo()).toBe(false);
    expect(stack.size).toBe(0);
  });

  it('records telemetry and rethrows when undo fails', async () => {
    const events: GenerativeActionTelemetryEvent[] = [];
    const boom = new Error('undo exploded');
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(2_000).mockReturnValueOnce(2_025);

    const stack = new GenerativeActionUndoStack({
      sink: (event) => events.push(event),
    });
    stack.push({
      actionId: 'risky',
      riskLevel: 'high',
      undo: () => {
        throw boom;
      },
    });

    await expect(stack.undo()).rejects.toBe(boom);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actionId: 'risky',
      riskLevel: 'high',
      startedAt: 2_000,
      durationMs: 25,
      ok: false,
      error: boom,
      phase: 'undo',
    });
    expect(stack.canUndo()).toBe(false);
  });
});

describe('wrapReversibleAction / resolveGenerativeActionUndo', () => {
  it('handler return value { undo } is preferred over definition.undo', async () => {
    const fromResult = vi.fn();
    const fromDef = vi.fn();
    const wrapped = wrapReversibleAction(makeDef(), {
      execute: () => ({ undo: fromResult }),
      undo: fromDef,
    });

    const result = await wrapped.handler();
    const resolved = resolveGenerativeActionUndo(wrapped, result);
    expect(resolved).toBe(fromResult);
    expect(wrapped.undo).toBe(fromDef);
  });

  it('falls back to definition.undo when handler returns void', async () => {
    const undo = vi.fn();
    const wrapped = wrapReversibleAction(makeDef(), {
      execute: () => undefined,
      undo,
    });

    const result = await wrapped.handler();
    expect(resolveGenerativeActionUndo(wrapped, result)).toBe(undo);
    expect(resolveGenerativeActionUndo(wrapped, undefined)).toBe(undo);
  });

  it('pushed wrapReversibleAction undo runs via the stack', async () => {
    const calls: string[] = [];
    const wrapped = wrapReversibleAction(makeDef({ id: 'toggle' }), {
      execute: () => {
        calls.push('execute');
      },
      undo: () => {
        calls.push('undo');
      },
    });

    const stack = new GenerativeActionUndoStack({ sink: () => undefined });
    const result = await wrapped.handler();
    const undo = resolveGenerativeActionUndo(wrapped, result);
    expect(undo).toBeDefined();
    stack.push({ actionId: wrapped.id, undo: undo! });
    await stack.undo();
    expect(calls).toEqual(['execute', 'undo']);
  });
});
