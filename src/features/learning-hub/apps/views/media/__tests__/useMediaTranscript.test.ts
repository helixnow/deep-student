import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  },
}));

import { TRANSCRIPT_REFETCH_THROTTLE_MS, useMediaTranscript } from '../useMediaTranscript';

const segment = (idx: number, status: number) => ({ idx, startMs: idx * 1000, endMs: idx * 1000 + 900, text: `s${idx}`, status });

beforeEach(() => {
  invokeMock.mockReset();
  listeners.clear();
});
afterEach(() => vi.useRealTimers());

describe('useMediaTranscript', () => {
  it('loads the current transcript and degrades to "none" when the command is missing', async () => {
    invokeMock.mockRejectedValueOnce(new Error('command media_transcript_get not found'));
    const { result } = renderHook(() => useMediaTranscript({ resourceId: 'file_1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.transcript).toEqual({ status: 'none', segments: [], progress: null });
    expect(result.current.error).toContain('not found');
  });

  it('applies progress events for this resource and refetches segments (throttled)', async () => {
    invokeMock.mockResolvedValueOnce({ status: 'queued', segments: [] });
    const { result } = renderHook(() => useMediaTranscript({ resourceId: 'file_1', aliasIds: ['att_1'] }));
    await waitFor(() => expect(result.current.transcript?.status).toBe('queued'));
    await waitFor(() => expect(listeners.has('media-processing-progress')).toBe(true));

    vi.useFakeTimers();
    invokeMock.mockResolvedValue({ status: 'running', segments: [segment(0, 1)], progress: { stage: 'asr', completedSegments: 1, totalSegments: 4 } });
    act(() => {
      listeners.get('media-processing-progress')!({
        payload: { fileId: 'other', mediaType: 'audio', status: { stage: 'asr', completedSegments: 9, totalSegments: 9 } },
      });
      listeners.get('media-processing-progress')!({
        payload: { fileId: 'att_1', mediaType: 'audio', status: { stage: 'asr', completedSegments: 1, totalSegments: 4, percent: 25 } },
      });
    });
    expect(result.current.transcript?.status).toBe('running');
    expect(result.current.transcript?.progress).toMatchObject({ completedSegments: 1, totalSegments: 4 });

    await act(async () => {
      vi.advanceTimersByTime(TRANSCRIPT_REFETCH_THROTTLE_MS + 10);
    });
    vi.useRealTimers();
    await waitFor(() => expect(result.current.transcript?.segments).toHaveLength(1));
    expect(invokeMock).toHaveBeenCalledWith('media_transcript_get', { resourceId: 'file_1' });
  });

  it('estimate → start flows through the contract commands', async () => {
    invokeMock.mockResolvedValueOnce({ status: 'none', segments: [] });
    const { result } = renderHook(() => useMediaTranscript({ resourceId: 'file_2' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    invokeMock.mockResolvedValueOnce({ durationMs: 60_000, plannedSegments: 8, asrModel: null });
    let estimate: Awaited<ReturnType<typeof result.current.requestEstimate>> | undefined;
    await act(async () => {
      estimate = await result.current.requestEstimate();
    });
    expect(estimate).toEqual({ ok: true, value: { durationMs: 60_000, plannedSegments: 8, asrModel: null } });
    expect(result.current.estimate?.plannedSegments).toBe(8);

    invokeMock.mockResolvedValueOnce({});
    await act(async () => {
      await result.current.start();
    });
    expect(invokeMock).toHaveBeenCalledWith('media_transcribe_start', { resourceId: 'file_2' });
    expect(result.current.transcript?.status).toBe('queued');
    expect(result.current.estimate).toBeNull();
  });
});
