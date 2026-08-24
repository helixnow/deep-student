import { describe, it, expect, afterEach } from 'vitest';
import type { GenerativeActionTelemetryEvent } from '@/features/generative-ui/handlers/actionTelemetry';
import {
  GenerativeActionTelemetryRing,
  GENERATIVE_ACTION_TELEMETRY_RING_LIMIT,
  getDefaultGenerativeActionTelemetryRing,
  resetDefaultGenerativeActionTelemetryRing,
  pushDefaultGenerativeActionTelemetry,
} from '@/features/generative-ui/handlers/actionTelemetryRing';

function makeEvent(
  overrides: Partial<GenerativeActionTelemetryEvent> &
    Pick<GenerativeActionTelemetryEvent, 'actionId'> = { actionId: 'demo' },
): GenerativeActionTelemetryEvent {
  return {
    riskLevel: 'low',
    startedAt: 1,
    durationMs: 2,
    ok: true,
    phase: 'execute',
    ...overrides,
  };
}

describe('GenerativeActionTelemetryRing', () => {
  it('push 3, list length 3, latest is last', () => {
    const ring = new GenerativeActionTelemetryRing();
    const a = makeEvent({ actionId: 'a' });
    const b = makeEvent({ actionId: 'b' });
    const c = makeEvent({ actionId: 'c' });

    ring.push(a);
    ring.push(b);
    ring.push(c);

    expect(ring.size).toBe(3);
    expect(ring.list()).toHaveLength(3);
    expect(ring.list()).toEqual([a, b, c]);
    expect(ring.latest()).toBe(c);
  });

  it('overflow: push 51 with limit 50, size 50, first dropped', () => {
    const ring = new GenerativeActionTelemetryRing(GENERATIVE_ACTION_TELEMETRY_RING_LIMIT);
    expect(GENERATIVE_ACTION_TELEMETRY_RING_LIMIT).toBe(50);

    const events = Array.from({ length: 51 }, (_, i) =>
      makeEvent({ actionId: `event-${i}` }),
    );
    for (const event of events) {
      ring.push(event);
    }

    expect(ring.size).toBe(50);
    const listed = ring.list();
    expect(listed).toHaveLength(50);
    expect(listed[0]?.actionId).toBe('event-1');
    expect(listed).not.toContain(events[0]);
    expect(ring.latest()).toBe(events[50]);
    expect(ring.latest()?.actionId).toBe('event-50');
  });

  it('list() returns a shallow copy isolated from the store', () => {
    const ring = new GenerativeActionTelemetryRing();
    const first = makeEvent({ actionId: 'keep' });
    ring.push(first);

    const listed = ring.list();
    listed.push(makeEvent({ actionId: 'mutated' }));
    listed.pop();
    listed.pop();

    expect(ring.size).toBe(1);
    expect(ring.list()).toEqual([first]);
    expect(ring.latest()).toBe(first);
  });

  it('events keep actionId / ok / phase fields', () => {
    const ring = new GenerativeActionTelemetryRing();
    const event = makeEvent({
      actionId: 'copy-intent',
      ok: false,
      phase: 'undo',
      riskLevel: 'high',
    });
    ring.push(event);

    expect(ring.latest()).toMatchObject({
      actionId: 'copy-intent',
      ok: false,
      phase: 'undo',
    });
    expect(ring.list()[0]).toMatchObject({
      actionId: 'copy-intent',
      ok: false,
      phase: 'undo',
    });
  });

  it('clear() empties the ring', () => {
    const ring = new GenerativeActionTelemetryRing();
    ring.push(makeEvent({ actionId: 'a' }));
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.list()).toEqual([]);
    expect(ring.latest()).toBeUndefined();
  });
});

describe('default GenerativeActionTelemetryRing singleton', () => {
  afterEach(() => {
    resetDefaultGenerativeActionTelemetryRing();
  });

  it('resetDefault clears the singleton', () => {
    pushDefaultGenerativeActionTelemetry(makeEvent({ actionId: 'stale' }));
    expect(getDefaultGenerativeActionTelemetryRing().size).toBe(1);

    resetDefaultGenerativeActionTelemetryRing();

    const ring = getDefaultGenerativeActionTelemetryRing();
    expect(ring.size).toBe(0);
    expect(ring.list()).toEqual([]);
    expect(ring.latest()).toBeUndefined();
  });

  it('getDefault and pushDefault share the same instance', () => {
    const ring = getDefaultGenerativeActionTelemetryRing();
    pushDefaultGenerativeActionTelemetry(makeEvent({ actionId: 'shared' }));
    expect(ring.size).toBe(1);
    expect(ring.latest()?.actionId).toBe('shared');
    expect(getDefaultGenerativeActionTelemetryRing()).toBe(ring);
  });
});
