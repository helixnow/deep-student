import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { OptionalEmitter, NoopProgressCallback, SyncProgressEmitter, setStatusSink, clearStatusSink, reportSyncStatus } from '../src/emitter.ts';
import { progress, withOutcome } from '../src/progress.ts';

it('test_optional_emitter_none', async () => {
  const emitter = new OptionalEmitter(null);
  expect(emitter.hasEmitter()).toBe(false);
  await emitter.emitPreparing(); await emitter.emitUploading(1, 10, 'test.txt'); await emitter.emitCompleted();
});
it('test_optional_emitter_from_none', () => { expect(new OptionalEmitter(null).hasEmitter()).toBe(false); });
it('test_noop_callback', async () => {
  const callback = new NoopProgressCallback();
  await callback.onProgress(progress.preparing()); await callback.onComplete(); await callback.onError('test error');
});
it('emits through Host with throttle, monotonic percent, stable operation id and status terminal guard', async () => {
  const host = await createTestHost();
  const clock = vi.spyOn(performance, 'now');
  try {
    const emitter = new SyncProgressEmitter(host.ctx.backendEvents, message => host.ctx.logger.error(message));
    clock.mockReturnValue(0);
    await emitter.emitPreparing();
    await emitter.emitUploading(1, 10, 'a');
    await emitter.emitUploading(2, 10, 'b');
    expect(host.events).toHaveLength(2);
    clock.mockReturnValue(100);
    await emitter.emitUploading(3, 10, 'c');
    await emitter.emitDownloading(1, 10, null);
    setStatusSink(emitter);
    reportSyncStatus('retrying');
    await emitter.emit(withOutcome(progress.failed('incomplete'), 'partial'));
    reportSyncStatus('late');
    const events = host.eventsNamed('data-governance-sync-progress') as Array<ReturnType<typeof progress.preparing>>;
    expect(events.map(x => x.percent)).toEqual([0, 62.5, 67.5, 67.5, 67.5, 67.5]);
    expect(events[4]?.current_item).toBe('retrying');
    expect(events[5]?.outcome).toBe('partial');
    expect(new Set(events.map(x => x.operation_id)).size).toBe(1);
    expect(events[0]?.operation_id).toMatch(/^[0-9a-f-]{36}$/);
  } finally { clearStatusSink(); clock.mockRestore(); await host.dispose(); }
});
