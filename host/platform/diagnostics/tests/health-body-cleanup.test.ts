import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../storage/service.ts';
import diagnostics from '../index.ts';

// test_utils/health_check.rs:27-38 returns status/latency without reading the body;
// dropping Response must not turn a header result into a request failure.
it.each([200, 503])('F4-V2-16 health status %s survives response-body cleanup failure', async status => {
  // Explicit transport cleanup fault, not a live Prometheus test. The Response
  // and ReadableStream are native; only fetch transport is replaced here.
  const body = new ReadableStream({ cancel: () => Promise.reject(new Error('body cleanup failed')) });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));
  const host = await createTestHost();
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  try {
    host.ctx.provide('storage', storage);
    await host.install(diagnostics);
    const result = await host.invoke<{
      available: boolean; details: Record<string, boolean>; errors: string[];
      results: { service: string; available: boolean; latency_ms: number | null; error: string | null }[];
    }>('check_test_dependencies');
    const error = status === 200 ? null : 'HTTP 503 Service Unavailable';
    expect(result.available).toBe(status === 200);
    expect(result.details).toEqual({ prometheus: status === 200, database: true, web_search: true });
    expect(result.errors).toEqual(error === null ? [] : [error]);
    expect(result.results[0]).toEqual({ service: 'prometheus', available: status === 200,
      latency_ms: expect.any(Number), error });
    expect(result.results.map(value => value.service)).toEqual(['prometheus', 'database', 'web_search']);
  } finally { fetcher.mockRestore(); await host.dispose(); storage.dispose(); }
});
