import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { memorySettings } from './support.ts';
import { inMemoryVfsDb } from './vfs-support.ts';
import { applyCompletionOutboxMigration } from '../repository/completion-outbox-repository.ts';
import type { AgentCompletionOutbox, NewCompletionDelivery } from '../api.ts';

it('publishes durable outbox operations from index and reborrows the active database', async () => {
  const first = inMemoryVfsDb();
  const second = inMemoryVfsDb();
  applyCompletionOutboxMigration(first.executor);
  applyCompletionOutboxMigration(second.executor);
  let active = first.executor;
  const host = await createTestHost({ provide: {
    settings: memorySettings(), storage: { locations: { activeDir: '.' }, database: () => active },
  } });
  try {
    await host.install(plugin);
    const outbox = host.ctx.get('agentCompletionOutbox') as AgentCompletionOutbox;
    const entry: NewCompletionDelivery = {
      deliveryId: 'delivery', taskId: null, runId: 'run', workspaceId: 'workspace',
      agentSessionId: 'worker', targetSessionId: 'parent', targetGeneration: null,
      payloadJson: '{"run_id":"run"}', createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(outbox.enqueue(entry)).toBe('inserted');
    expect(outbox.enqueue({ ...entry, deliveryId: 'other' })).toBe('duplicate_run');
    expect(outbox.claimPending('dispatcher', '2099-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 1)).toHaveLength(1);
    expect(outbox.markDelivered('delivery', 'wrong-owner')).toBe(false);
    expect(outbox.markDelivered('delivery', 'dispatcher')).toBe(true);
    expect(outbox.get('delivery')?.deliveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    active = second.executor;
    expect(outbox.getByRunId('run')).toBeNull();
    expect(outbox.enqueue(entry)).toBe('inserted');
    active = first.executor;
    expect(outbox.getByRunId('run')?.state).toBe('delivered');
  } finally {
    await host.dispose();
    first.close();
    second.close();
  }
});
