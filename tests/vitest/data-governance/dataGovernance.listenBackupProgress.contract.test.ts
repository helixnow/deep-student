import { describe, expect, it, vi } from 'vitest';

const mockListen = vi.fn();

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

import { listenBackupProgress } from '@/api/dataGovernance';

describe('DataGovernanceApi.listenBackupProgress contract', () => {
  it('normalizes camelCase payload and filters by jobId', async () => {
    let handler: ((event: { payload: unknown }) => void) | null = null;

    mockListen.mockImplementation(async (_eventName: string, cb: (event: { payload: unknown }) => void) => {
      handler = cb;
      return () => undefined;
    });

    const onProgress = vi.fn();
    await listenBackupProgress('job-1', onProgress);

    // wrong jobId -> ignored
    handler?.({
      payload: {
        jobId: 'job-OTHER',
        kind: 'export',
        status: 'running',
        phase: 'scan',
        progress: 5,
        processedItems: 0,
        totalItems: 4,
        cancellable: true,
        createdAt: '2026-02-07T00:00:00Z',
      },
    });
    expect(onProgress).toHaveBeenCalledTimes(0);

    // correct jobId -> normalized + delivered
    handler?.({
      payload: {
        jobId: 'job-1',
        kind: 'export',
        status: 'running',
        phase: 'scan',
        progress: 5,
        processedItems: 0,
        totalItems: 4,
        cancellable: true,
        createdAt: '2026-02-07T00:00:00Z',
        result: {
          success: true,
          requiresRestart: true,
        },
      },
    });

    expect(onProgress).toHaveBeenCalledTimes(1);
    const event = onProgress.mock.calls[0]?.[0] as any;
    expect(event.job_id).toBe('job-1');
    expect(event.processed_items).toBe(0);
    expect(event.total_items).toBe(4);
    expect(event.created_at).toBe('2026-02-07T00:00:00Z');
    expect(event.result?.requires_restart).toBe(true);
  });

  it('accepts snake_case payloads', async () => {
    let handler: ((event: { payload: unknown }) => void) | null = null;

    mockListen.mockImplementation(async (_eventName: string, cb: (event: { payload: unknown }) => void) => {
      handler = cb;
      return () => undefined;
    });

    const onProgress = vi.fn();
    await listenBackupProgress('job-2', onProgress);

    handler?.({
      payload: {
        job_id: 'job-2',
        kind: 'import',
        status: 'running',
        phase: 'extract',
        progress: 42,
        processed_items: 10,
        total_items: 20,
        cancellable: true,
        created_at: '2026-02-07T00:00:00Z',
        result: {
          success: true,
          requires_restart: false,
        },
      },
    });

    expect(onProgress).toHaveBeenCalledTimes(1);
    const event = onProgress.mock.calls[0]?.[0] as any;
    expect(event.job_id).toBe('job-2');
    expect(event.processed_items).toBe(10);
    expect(event.total_items).toBe(20);
    expect(event.result?.requires_restart).toBe(false);
  });
});

