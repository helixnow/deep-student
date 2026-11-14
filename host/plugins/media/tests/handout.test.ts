import { expect, it } from 'vitest';
import { HandoutRegistry, CancellationToken, runCancellable } from '../src/handout.ts';

it('cancel_marks_shared_token', async () => {
  const registry = new HandoutRegistry();
  const t = registry.tokenFor('run-a');
  expect(t.isCancelled()).toBe(false);
  expect(registry.cancel('run-a')).toBeNull();
  expect(t.isCancelled()).toBe(true);
  expect(registry.tokenFor('run-a').isCancelled()).toBe(true);
  expect(registry.release('run-a')).toBeNull();
  expect(registry.tokenFor('run-a').isCancelled()).toBe(false);
  expect(registry.release('run-a')).toBeNull();
});

it('cancelled_token_short_circuits', async () => {
  const t = new CancellationToken();
  t.cancel();
  await expect(runCancellable(t, Promise.resolve({ assistant_message: 'x', cancelled: false })))
    .rejects.toMatchObject({ value: { error_type: 'Validation', message: 'cancelled', details: null } });
});
