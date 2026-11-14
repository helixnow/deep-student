/** `lib.rs::start_vfs_index_worker` loop semantics (3321-3453). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IndexingConfig } from '../api.ts';
import { VfsIndexWorker, type VfsIndexWorkerDeps } from '../src/index-worker.ts';

const baseConfig: IndexingConfig = {
  enabled: true, batchSize: 7, intervalSecs: 5, maxConcurrent: 2, retryDelaySecs: 60, maxRetries: 3,
};

function harness(overrides: Partial<VfsIndexWorkerDeps> = {}) {
  const calls: string[] = [];
  let config = { ...baseConfig };
  let textConfigured = true;
  let maintenance = false;
  let release: (() => void) | null = null;
  let blockBatch = false;
  const deps: VfsIndexWorkerDeps = {
    getConfig: () => config,
    lanceEnabled: () => true,
    startupMaintenance: () => maintenance,
    textEmbeddingConfigured: async () => textConfigured,
    reviveConfigBlocked: () => { calls.push('revive'); return 0; },
    processTextBatch: async (size) => {
      calls.push(`text:${size}`);
      if (blockBatch) await new Promise<void>((resolve) => { release = resolve; });
      return [1, 0];
    },
    prepareUnitsWithoutEmbedding: (limit) => { calls.push(`prepare:${limit}`); return 0; },
    drainLanceOrphanQueue: async (limit) => { calls.push(`drain:${limit}`); return 0; },
    multimodalConfigured: async () => false,
    processMultimodalBatch: async (size) => { calls.push(`mm:${size}`); return [0, 0]; },
    maybeOptimizeAll: async () => { calls.push('optimize'); return 0; },
    now: () => Date.now(),
    ...overrides,
  };
  return {
    worker: new VfsIndexWorker(deps),
    calls,
    setConfig: (patch: Partial<IndexingConfig>) => { config = { ...config, ...patch }; },
    setTextConfigured: (value: boolean) => { textConfigured = value; },
    setMaintenance: (value: boolean) => { maintenance = value; },
    blockBatches: () => { blockBatch = true; },
    releaseBatch: () => { blockBatch = false; release?.(); release = null; },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('VfsIndexWorker', () => {
  it('runs immediately, then once per interval_secs with batch_size; stop leaves no timer', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual(['revive', 'text:7', 'optimize']);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(h.calls.filter(call => call.startsWith('text'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.calls.filter(call => call.startsWith('text'))).toHaveLength(2);
    // Revive only on the transition to configured.
    expect(h.calls.filter(call => call === 'revive')).toHaveLength(1);
    await h.worker.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.worker.running).toBe(false);
  });

  it('unconfigured embedding prepares units and drains orphans; mm batch only when configured', async () => {
    vi.useFakeTimers();
    const h = harness({ multimodalConfigured: async () => true });
    h.setTextConfigured(false);
    h.worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual(['prepare:7', 'drain:200', 'mm:7', 'optimize']);
    h.setTextConfigured(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.calls.slice(4)).toEqual(['revive', 'text:7', 'mm:7', 'optimize']);
    await h.worker.stop();
  });

  it('disabled config and startup maintenance never process; resuming picks work up', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.setConfig({ enabled: false });
    h.worker.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.calls).toEqual([]);
    h.setConfig({ enabled: true });
    h.setMaintenance(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.calls).toEqual([]);
    h.setMaintenance(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.calls).toContain('text:7');
    await h.worker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pause waits for the in-flight batch and blocks new ones until resume', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.setConfig({ intervalSecs: 1 });
    h.blockBatches();
    h.worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual(['revive', 'text:7']);
    let paused = false;
    const pause = h.worker.pause().then(() => { paused = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(paused).toBe(false);
    h.releaseBatch();
    await pause;
    expect(h.calls).toEqual(['revive', 'text:7', 'optimize']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls.filter(call => call.startsWith('text'))).toHaveLength(1);
    h.worker.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.filter(call => call.startsWith('text'))).toHaveLength(2);
    await h.worker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop waits for the in-flight batch and starts nothing afterwards', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.blockBatches();
    h.worker.start();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stop = h.worker.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    h.releaseBatch();
    await stop;
    expect(h.calls).toEqual(['revive', 'text:7', 'optimize']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('failures in one stage are logged and never stop the loop', async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    const h = harness({
      processTextBatch: async () => { throw new Error('boom'); },
      maybeOptimizeAll: async () => { throw new Error('lance'); },
      logger: { debug() {}, info() {}, warn: (message: string) => { warnings.push(message); }, error() {} },
    });
    h.worker.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(warnings).toEqual([
      '[VfsIndexWorker] text batch failed: boom', '[VfsIndexWorker] Lance auto-optimize failed: lance',
      '[VfsIndexWorker] text batch failed: boom', '[VfsIndexWorker] Lance auto-optimize failed: lance',
    ]);
    await h.worker.stop();
  });
});
