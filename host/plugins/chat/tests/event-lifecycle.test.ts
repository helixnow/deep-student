import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { BackendEventsSink, ChatV2EventEmitter, CHUNK_BATCH_WINDOW_MS } from '../src/events.ts';

it('plugin unload flushes its pending chunks without flushing another Host', async () => {
  const f = databaseFixture();
  const first = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
  const second = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
  vi.useFakeTimers();
  const a = new ChatV2EventEmitter(new BackendEventsSink(first.ctx.backendEvents), 'sess_a');
  const b = new ChatV2EventEmitter(new BackendEventsSink(second.ctx.backendEvents), 'sess_b');
  try {
    a.emitContentChunk('blk_a', 'first-a', null);
    a.emitContentChunk('blk_a', 'tail-a', null);
    b.emitContentChunk('blk_b', 'first-b', null);
    b.emitContentChunk('blk_b', 'tail-b', null);
    expect(a.pendingChunkCount()).toBe(1);
    expect(b.pendingChunkCount()).toBe(1);
    expect(first.eventsNamed('chat_v2_event_sess_a')).toHaveLength(0);
    expect(second.eventsNamed('chat_v2_event_sess_b')).toHaveLength(0);
    // Unload just the plugin: the event transport remains alive for tail delivery.
    await first.plugins[0]!.fiber.dispose();
    expect(a.pendingChunkCount()).toBe(0);
    expect(b.pendingChunkCount()).toBe(1);
    expect(first.eventsNamed('chat_v2_event_sess_a').at(-1)).toMatchObject({ chunk: 'first-atail-a' });
    await vi.advanceTimersByTimeAsync(CHUNK_BATCH_WINDOW_MS);
    expect(b.pendingChunkCount()).toBe(0);
    expect(second.eventsNamed('chat_v2_event_sess_b').at(-1)).toMatchObject({ chunk: 'first-btail-b' });
    expect(first.eventsNamed('chat_v2_event_sess_a')).toHaveLength(1);
    expect(second.eventsNamed('chat_v2_event_sess_b')).toHaveLength(1);
  } finally {
    a.dispose(); b.dispose(); vi.useRealTimers();
    await first.dispose(); await second.dispose(); f.dispose();
  }
});
