import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { VideoPlayer } from '../VideoPlayer';
import { useMediaPlayback } from '../useMediaPlayback';
import { TranscriptPanel } from '../TranscriptPanel';
import type { TranscriptSegment } from '../mediaTranscriptApi';

vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: vi.fn(async () => true) }));

describe('Media mobile closure (playsInline, narrow controls, MediaSession, background play, transcript selection)', () => {
  const originalMediaSession = navigator.mediaSession;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      writable: true,
      value: originalMediaSession,
    });
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('sets playsInline on <video> and hides ±10s skip buttons on 390px narrow screen so fullscreen never overflows', () => {
    globalThis.ResizeObserver = class {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(target: Element) {
        this.cb(
          [{ target, contentRect: { width: 390, height: 220 } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    };

    const { container } = render(
      <VideoPlayer src="blob:demo" fileName="lecture-01.mp4" onError={vi.fn()} />,
    );

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.playsInline).toBe(true);

    // At 390px, ±10s buttons are hidden to keep play / time / rate / fullscreen inside viewport
    expect(screen.queryByRole('button', { name: '快退 10 秒' })).toBeNull();
    expect(screen.queryByRole('button', { name: '快进 10 秒' })).toBeNull();
    expect(screen.getByRole('button', { name: '全屏' })).toBeInTheDocument();
  });

  it('wires navigator.mediaSession handlers and honors allowBackgroundPlayback when tab becomes inactive', () => {
    const handlers = new Map<string, MediaSessionActionHandler | null>();
    const mediaSessionMock = {
      metadata: null as unknown,
      playbackState: 'none' as MediaSessionPlaybackState,
      setActionHandler: vi.fn((action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
        handlers.set(action, handler);
      }),
      setPositionState: vi.fn(),
    };
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      writable: true,
      value: mediaSessionMock,
    });

    const pauseSpy = vi.fn();
    const playSpy = vi.fn(async () => undefined);

    const { result, rerender } = renderHook(
      ({ isActive, allowBackgroundPlayback }) =>
        useMediaPlayback<HTMLAudioElement>({
          src: 'blob:audio',
          title: '高等数学音频.mp3',
          isActive,
          allowBackgroundPlayback,
        }),
      { initialProps: { isActive: true, allowBackgroundPlayback: true } },
    );

    const fakeAudio = document.createElement('audio');
    fakeAudio.pause = pauseSpy;
    fakeAudio.play = playSpy;
    result.current.mediaRef.current = fakeAudio;

    expect(mediaSessionMock.setActionHandler).toHaveBeenCalledWith('play', expect.any(Function));
    expect(mediaSessionMock.setActionHandler).toHaveBeenCalledWith('pause', expect.any(Function));
    expect(mediaSessionMock.setActionHandler).toHaveBeenCalledWith('seekbackward', expect.any(Function));
    expect(mediaSessionMock.setActionHandler).toHaveBeenCalledWith('seekforward', expect.any(Function));

    // Switching view with allowBackgroundPlayback=true should NOT pause
    rerender({ isActive: false, allowBackgroundPlayback: true });
    expect(pauseSpy).not.toHaveBeenCalled();

    // Switching view with allowBackgroundPlayback=false SHOULD pause
    rerender({ isActive: false, allowBackgroundPlayback: false });
    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it('allows selectable transcript text and exposes translate & timestamp-note actions in selection toolbar', () => {
    const segs: TranscriptSegment[] = [
      { idx: 0, startMs: 12000, endMs: 18000, text: 'Backpropagation computes gradients efficiently.', status: 'done' },
    ];
    const onTranslateSelection = vi.fn();
    const onSaveNoteFromSelection = vi.fn();

    render(
      <TranscriptPanel
        segments={segs}
        activeSegmentIdx={0}
        onSeek={vi.fn()}
        status="completed"
        progress={null}
        layout="bottom"
        onTranslateSelection={onTranslateSelection}
        onSaveNoteFromSelection={onSaveNoteFromSelection}
      />,
    );

    // Cue text must be selectable (not trapped inside native <button>)
    const cueText = screen.getByText('Backpropagation computes gradients efficiently.');
    expect(cueText.className).toContain('select-text');
    expect(cueText.closest('button')).toBeNull();

    // Enter select mode, pick segment, and verify both quick actions fire
    fireEvent.click(screen.getByRole('button', { name: '选择字幕段' }));
    fireEvent.click(cueText);
    fireEvent.click(screen.getByRole('button', { name: '查词翻译' }));
    expect(onTranslateSelection).toHaveBeenCalledWith([segs[0]]);

    fireEvent.click(screen.getByRole('button', { name: '选择字幕段' }));
    fireEvent.click(cueText);
    fireEvent.click(screen.getByRole('button', { name: '时间戳笔记' }));
    expect(onSaveNoteFromSelection).toHaveBeenCalledWith([segs[0]]);
  });
});
