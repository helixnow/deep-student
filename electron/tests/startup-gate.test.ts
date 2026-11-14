import { expect, it, vi } from 'vitest';
import { createStartupGate } from '../startup-gate.ts';

it('wait_times_out_when_never_marked_then_succeeds_after_mark', async () => {
  const gate = createStartupGate();
  expect(await gate.waitStartupReady(50)).toBe(false);
  gate.markStartupReady();
  expect(gate.isStartupReady()).toBe(true);
  expect(await gate.waitStartupReady(1_000)).toBe(true);
});

it('guard_marks_ready_on_drop', async () => {
  const gate = createStartupGate();
  { using guard = gate.guard(); }
  expect(gate.isStartupReady()).toBe(true);
  expect(await gate.waitStartupReady(10)).toBe(true);
});

it('late_subscriber_sees_ready_immediately', async () => {
  const gate = createStartupGate();
  gate.markStartupReady();
  expect(await gate.waitStartupReady(10)).toBe(true);
});

it('the readiness callback fires exactly once even if the gate is marked again', () => {
  const ready = vi.fn();
  const gate = createStartupGate(ready);
  gate.markStartupReady();
  gate.markStartupReady();
  gate.guard()[Symbol.dispose]();
  expect(ready).toHaveBeenCalledTimes(1);
});
