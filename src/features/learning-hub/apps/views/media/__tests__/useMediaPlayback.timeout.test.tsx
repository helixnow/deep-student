import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_LOAD_TIMEOUT_MS, useMediaPlayback } from '../useMediaPlayback';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

function Player({ src = 'test.mp4', active = true, onError }: { src?: string; active?: boolean; onError: (reason?: string) => void }) {
  const playback = useMediaPlayback<HTMLVideoElement>({ src, isActive: active, onError });
  return <video ref={playback.mediaRef} data-ready={String(playback.isReady)} />;
}

describe('media playback deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

  it('terminates a load that never emits metadata or error, once per source', () => {
    const onError = vi.fn();
    const { rerender } = render(<Player onError={onError} />);
    act(() => vi.advanceTimersByTime(MEDIA_LOAD_TIMEOUT_MS + 1_000));
    expect(onError).toHaveBeenCalledWith('timeout');
    act(() => vi.advanceTimersByTime(MEDIA_LOAD_TIMEOUT_MS));
    expect(onError).toHaveBeenCalledTimes(1);
    rerender(<Player src="retry.mp4" onError={onError} />);
    act(() => vi.advanceTimersByTime(MEDIA_LOAD_TIMEOUT_MS + 1_000));
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('keeps metadata and progress when hidden, and pauses the deadline', () => {
    const onError = vi.fn();
    const { container, rerender } = render(<Player onError={onError} />);
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
    fireEvent.loadedMetadata(video);
    expect(video.dataset.ready).toBe('true');
    rerender(<Player active={false} onError={onError} />);
    act(() => vi.advanceTimersByTime(MEDIA_LOAD_TIMEOUT_MS * 2));
    expect(video.dataset.ready).toBe('true');
    expect(onError).not.toHaveBeenCalled();
  });

  it('repeated waiting events cannot postpone a stalled-playback failure forever', () => {
    const onError = vi.fn();
    const { container } = render(<Player onError={onError} />);
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    for (let i = 0; i < 4; i += 1) {
      fireEvent.waiting(video);
      act(() => vi.advanceTimersByTime(10_000));
    }
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('timeout');
  });

  it('logs Bilibili decoder state once without exposing source URLs or decoder messages', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onError = vi.fn();
    const { container } = render(<Player src="http://bilistream.localhost/att_test?token=private" onError={onError} />);
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 4, message: 'https://cdn.test/?secret=private' } });
    fireEvent.error(video);
    fireEvent.error(video);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(invoke).mock.calls[0][1];
    expect(payload).toMatchObject({ payload: { kind: 'BILIBILI_PLAYBACK', extra: { mediaErrorCode: 4, reason: 'media' } } });
    expect(JSON.stringify(payload)).not.toContain('private');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private');
  });

  it('does not count time spent in a hidden Android browser against the load deadline', () => {
    const onError = vi.fn();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    render(<Player onError={onError} />);
    act(() => vi.advanceTimersByTime(MEDIA_LOAD_TIMEOUT_MS * 3));
    expect(onError).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    act(() => vi.advanceTimersByTime(MEDIA_LOAD_TIMEOUT_MS - 1_000));
    expect(onError).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2_000));
    expect(onError).toHaveBeenCalledWith('timeout');
  });
});
