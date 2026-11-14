import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import diagnostics from '../index.ts';

it('check_test_dependencies keeps Rust service order, HTTP status display and web_search default', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
  const host = await createTestHost({ plugins: [diagnostics], provide: { storage: { database: () => ({}) } } });
  try {
    const result = await host.invoke<{ available: boolean; details: unknown; errors: string[]; results: { service: string }[] }>('check_test_dependencies');
    expect(result.available).toBe(false);
    expect(result.details).toEqual({ prometheus: false, database: true, web_search: true });
    expect(result.errors).toEqual(['HTTP 503 Service Unavailable']);
    expect(result.results.map(r => r.service)).toEqual(['prometheus', 'database', 'web_search']);
  } finally { fetcher.mockRestore(); await host.dispose(); }
});
