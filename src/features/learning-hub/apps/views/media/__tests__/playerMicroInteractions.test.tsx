import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import {
  BOOST_DELAY_MS,
  CumulativeSeekController,
  DEFAULT_BOOST_RATE,
  HOVER_PREVIEW_DELAY_MS,
  HoldSpeedBoostController,
  HoverThumbnailPreviewController,
  MAX_PREVIEW_DIMENSION_PX,
  SEEK_ACCUMULATE_WINDOW_MS,
  clampPreviewCenterX,
  computePreviewBoxDimensions,
} from '../playerMicroInteractions';
import { MediaScrubber } from '../MediaScrubber';
import { VideoPlayer } from '../VideoPlayer';

describe('playerMicroInteractions controllers & component integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('HoldSpeedBoostController', () => {
    it('does not trigger 3.0x speed boost when released before 450ms', () => {
      let playbackRate = 1.25;
      const onBoostStateChange = vi.fn();
      const controller = new HoldSpeedBoostController({
        getPlaybackRate: () => playbackRate,
        applyPlaybackRate: (next) => {
          playbackRate = next;
        },
        onBoostStateChange,
      });

      controller.startHold(1.25);
      expect(controller.isHolding).toBe(true);
      expect(controller.isBoosting).toBe(false);

      vi.advanceTimersByTime(BOOST_DELAY_MS - 1);
      const releaseResult = controller.endHold();

      expect(releaseResult).toEqual({ wasBoosting: false, restoredRate: null });
      expect(playbackRate).toBe(1.25);
      expect(onBoostStateChange).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(controller.isBoosting).toBe(false);
      expect(playbackRate).toBe(1.25);
    });

    it('switches to 3.0x at >=450ms and restores exact originalPlaybackRate (1.25x) on release or blur', () => {
      let playbackRate = 1.25;
      const onBoostStateChange = vi.fn();
      const controller = new HoldSpeedBoostController({
        getPlaybackRate: () => playbackRate,
        applyPlaybackRate: (next) => {
          playbackRate = next;
        },
        onBoostStateChange,
      });

      controller.startHold();
      // Duplicate key repeat while holding must not overwrite saved original rate
      controller.startHold(2.0);

      vi.advanceTimersByTime(BOOST_DELAY_MS);
      expect(controller.isBoosting).toBe(true);
      expect(controller.originalPlaybackRate).toBe(1.25);
      expect(playbackRate).toBe(DEFAULT_BOOST_RATE);
      expect(onBoostStateChange).toHaveBeenCalledTimes(1);
      expect(onBoostStateChange).toHaveBeenLastCalledWith(true, 3.0);

      const releaseResult = controller.cancel();
      expect(releaseResult).toEqual({ wasBoosting: true, restoredRate: 1.25 });
      expect(controller.isBoosting).toBe(false);
      expect(playbackRate).toBe(1.25);
      expect(onBoostStateChange).toHaveBeenCalledTimes(2);
      expect(onBoostStateChange).toHaveBeenLastCalledWith(false, 1.25);
    });
  });

  describe('CumulativeSeekController', () => {
    it('accumulates three +5s steps into +15s within 700ms window and commits seek exactly once', () => {
      const commitSeek = vi.fn();
      const onStateChange = vi.fn();
      const controller = new CumulativeSeekController({
        commitSeek,
        onStateChange,
      });

      const s1 = controller.stepSeek(5, 20, 100);
      expect(s1).toEqual({
        isAccumulating: true,
        anchorTime: 20,
        accumulatedDelta: 5,
        targetTime: 25,
      });

      vi.advanceTimersByTime(300);
      // Even if media currentTime is still 20, subsequent steps build on anchorTime (20)
      const s2 = controller.stepSeek(5, 20, 100);
      expect(s2.accumulatedDelta).toBe(10);
      expect(s2.targetTime).toBe(30);

      vi.advanceTimersByTime(300);
      const s3 = controller.stepSeek(5, 20, 100);
      expect(s3.accumulatedDelta).toBe(15);
      expect(s3.targetTime).toBe(35);
      expect(commitSeek).not.toHaveBeenCalled();

      vi.advanceTimersByTime(SEEK_ACCUMULATE_WINDOW_MS - 1);
      expect(commitSeek).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(commitSeek).toHaveBeenCalledTimes(1);
      expect(commitSeek).toHaveBeenCalledWith(35, 15);
      expect(controller.isAccumulating).toBe(false);
    });

    it('clamps accumulated targetTime within [0, duration] and supports explicit flush()', () => {
      const commitSeek = vi.fn();
      const controller = new CumulativeSeekController({ commitSeek });

      // Upper bound clamp
      controller.stepSeek(10, 92, 100);
      const upper = controller.stepSeek(10, 92, 100);
      expect(upper.accumulatedDelta).toBe(20);
      expect(upper.targetTime).toBe(100);
      expect(controller.flush()).toBe(100);
      expect(commitSeek).toHaveBeenCalledTimes(1);
      expect(commitSeek).toHaveBeenLastCalledWith(100, 20);

      // Lower bound clamp
      controller.stepSeek(-10, 6, 100);
      const lower = controller.stepSeek(-10, 6, 100);
      expect(lower.accumulatedDelta).toBe(-20);
      expect(lower.targetTime).toBe(0);
      vi.advanceTimersByTime(SEEK_ACCUMULATE_WINDOW_MS);
      expect(commitSeek).toHaveBeenCalledTimes(2);
      expect(commitSeek).toHaveBeenLastCalledWith(0, -20);
    });
  });

  describe('HoverThumbnailPreviewController', () => {
    it('does not trigger frame decode when pointer leaves before 160ms, and triggers at >=160ms', () => {
      const onDecodeRequest = vi.fn();
      const controller = new HoverThumbnailPreviewController({ onDecodeRequest });

      controller.updateHover({
        pointerOffsetX: 100,
        trackWidth: 400,
        duration: 200,
      });
      expect(controller.isHovering).toBe(true);
      expect(controller.isDecodeActive).toBe(false);

      vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS - 10);
      controller.leaveHover();
      vi.advanceTimersByTime(50);
      expect(onDecodeRequest).not.toHaveBeenCalled();
      expect(controller.isDecodeActive).toBe(false);

      // Now hover and stay >= 160ms
      controller.updateHover({
        pointerOffsetX: 200,
        trackWidth: 400,
        duration: 200,
      });
      vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
      expect(controller.isDecodeActive).toBe(true);
      expect(onDecodeRequest).toHaveBeenCalledTimes(1);
      expect(onDecodeRequest).toHaveBeenCalledWith(100);
    });

    it('caps landscape width at 160px, portrait height at 160px, and clamps horizontal center within track bounds', () => {
      const landscape = computePreviewBoxDimensions(1920, 1080);
      expect(landscape.width).toBe(MAX_PREVIEW_DIMENSION_PX);
      expect(landscape.height).toBe(90);
      expect(landscape.isPortrait).toBe(false);

      const portrait = computePreviewBoxDimensions(1080, 1920);
      expect(portrait.width).toBe(90);
      expect(portrait.height).toBe(MAX_PREVIEW_DIMENSION_PX);
      expect(portrait.isPortrait).toBe(true);

      // Horizontal boundary clamping: 160px wide box on 500px track -> center clamped to [80, 420]
      expect(clampPreviewCenterX(12, 500, 160)).toBe(80);
      expect(clampPreviewCenterX(250, 500, 160)).toBe(250);
      expect(clampPreviewCenterX(495, 500, 160)).toBe(420);
    });
  });

  describe('VideoPlayer & MediaScrubber micro-interaction integration', () => {
    it('shows 3.0x speed boost capsule on 450ms hold and restores rate on release, plus accumulates seeks', () => {
      const { container } = render(
        <VideoPlayer src="blob:lesson.mp4" fileName="lesson.mp4" onError={vi.fn()} />,
      );

      const video = container.querySelector('video')!;
      // Before first frame is ready, video has opacity-0 anti-black-flash guard
      expect(video.dataset.firstFrameReady).toBe('false');
      expect(video.className).toContain('opacity-0');

      Object.defineProperty(video, 'duration', { configurable: true, value: 120 });
      Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 10 });
      video.playbackRate = 1.25;
      fireEvent.loadedMetadata(video);
      fireEvent.loadedData(video);

      expect(video.dataset.firstFrameReady).toBe('true');
      expect(video.className).toContain('opacity-100');

      const playerGroup = screen.getByRole('group', { name: 'lesson.mp4' });

      // Hold ArrowRight >= 450ms -> 3.0x speed boost indicator appears
      fireEvent.keyDown(playerGroup, { key: 'ArrowRight' });
      act(() => {
        vi.advanceTimersByTime(BOOST_DELAY_MS);
      });
      const indicator = screen.getByTestId('speed-boost-indicator');
      expect(indicator).toHaveTextContent('3.0x');
      expect(video.playbackRate).toBe(3.0);

      // Release ArrowRight -> restores 1.25x and removes indicator
      fireEvent.keyUp(playerGroup, { key: 'ArrowRight' });
      expect(screen.queryByTestId('speed-boost-indicator')).toBeNull();
      expect(video.playbackRate).toBe(1.25);

      // Short press ArrowRight 3 times within 700ms -> accumulates +30s and commits once
      for (let i = 0; i < 3; i += 1) {
        fireEvent.keyDown(playerGroup, { key: 'ArrowRight' });
        act(() => {
          vi.advanceTimersByTime(100);
        });
        fireEvent.keyUp(playerGroup, { key: 'ArrowRight' });
      }
      expect(container.querySelector('[data-seek-flash="right"]')).toHaveTextContent('+30s');
      expect(video.currentTime).toBe(10);

      act(() => {
        vi.advanceTimersByTime(SEEK_ACCUMULATE_WINDOW_MS);
      });
      expect(video.currentTime).toBe(40);
    });

    it('debounces scrubber thumbnail decode by 160ms and keeps preview video opacity-0 until first frame is ready', () => {
      const { container } = render(
        <MediaScrubber
          currentTime={10}
          duration={100}
          ariaLabel="播放进度"
          onSeek={vi.fn()}
          previewSrc="blob:preview.mp4"
        />,
      );

      const slider = screen.getByRole('slider', { name: '播放进度' });
      vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 400,
        bottom: 16,
        width: 400,
        height: 16,
        toJSON: () => ({}),
      });

      fireEvent.pointerMove(slider, { clientX: 20 });
      expect(screen.getByTestId('scrubber-hover-preview').dataset.decodeActive).toBe('false');
      expect(screen.queryByTestId('scrubber-preview-video')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
      });

      const previewVideo = screen.getByTestId('scrubber-preview-video') as HTMLVideoElement;
      const previewBox = screen.getByTestId('scrubber-preview-box');
      expect(previewVideo.dataset.ready).toBe('false');
      expect(previewVideo.className).toContain('opacity-0');

      // Portrait metadata -> 90x160 box
      Object.defineProperty(previewVideo, 'videoWidth', { configurable: true, value: 1080 });
      Object.defineProperty(previewVideo, 'videoHeight', { configurable: true, value: 1920 });
      fireEvent.loadedMetadata(previewVideo);
      expect(previewBox.style.width).toBe('90px');
      expect(previewBox.style.height).toBe('160px');

      // First frame decoded -> transitions to opacity-100
      fireEvent.loadedData(previewVideo);
      expect(previewVideo.dataset.ready).toBe('true');
      expect(previewVideo.className).toContain('opacity-100');
      expect(container.querySelectorAll('video').length).toBe(1);
    });

    it('clears touch scrubber preview on pointerUp/pointerCancel and ignores non-dragging touch pointerEnter', () => {
      render(
        <MediaScrubber
          currentTime={10}
          duration={100}
          ariaLabel="播放进度"
          onSeek={vi.fn()}
          previewSrc="blob:preview.mp4"
        />,
      );

      const slider = screen.getByRole('slider', { name: '播放进度' });
      vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 400,
        bottom: 16,
        width: 400,
        height: 16,
        toJSON: () => ({}),
      });

      // Touch pointerEnter without dragging is ignored
      const touchEnterEvent = new MouseEvent('pointerenter', {
        bubbles: true,
        clientX: 80,
      });
      Object.defineProperty(touchEnterEvent, 'pointerType', { value: 'touch' });
      act(() => {
        slider.dispatchEvent(touchEnterEvent);
      });
      expect(screen.queryByTestId('scrubber-hover-preview')).toBeNull();

      // Touch pointerDown + hold >= 160ms shows preview, pointerUp clears it immediately
      const touchDownEvent = new MouseEvent('pointerdown', {
        bubbles: true,
        clientX: 120,
      });
      Object.defineProperty(touchDownEvent, 'pointerType', { value: 'touch' });
      act(() => {
        slider.dispatchEvent(touchDownEvent);
        vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
      });
      expect(screen.getByTestId('scrubber-hover-preview')).toBeInTheDocument();

      const touchUpEvent = new MouseEvent('pointerup', {
        bubbles: true,
        clientX: 120,
      });
      Object.defineProperty(touchUpEvent, 'pointerType', { value: 'touch' });
      act(() => {
        slider.dispatchEvent(touchUpEvent);
      });
      expect(screen.queryByTestId('scrubber-hover-preview')).toBeNull();
    });

    it('ignores right-click or paused video hold, and ends speed boost on window pointerup', () => {
      const { container } = render(
        <VideoPlayer src="blob:lesson.mp4" fileName="lesson.mp4" onError={vi.fn()} />,
      );

      const video = container.querySelector('video')!;
      Object.defineProperty(video, 'duration', { configurable: true, value: 120 });
      video.playbackRate = 1.0;
      fireEvent.loadedMetadata(video);
      fireEvent.loadedData(video);

      // Paused video: left pointerDown does not trigger 3.0x boost
      act(() => {
        video.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
        vi.advanceTimersByTime(BOOST_DELAY_MS + 50);
      });
      expect(screen.queryByTestId('speed-boost-indicator')).toBeNull();
      expect(video.playbackRate).toBe(1.0);

      // Start playback
      fireEvent.play(video);

      // Right-click while playing does not trigger 3.0x boost
      act(() => {
        video.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 }));
        vi.advanceTimersByTime(BOOST_DELAY_MS + 50);
      });
      expect(screen.queryByTestId('speed-boost-indicator')).toBeNull();
      expect(video.playbackRate).toBe(1.0);

      // Left-click hold while playing triggers 3.0x boost, and window pointerup releases it
      act(() => {
        video.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
        vi.advanceTimersByTime(BOOST_DELAY_MS);
      });
      expect(screen.getByTestId('speed-boost-indicator')).toHaveTextContent('3.0x');
      expect(video.playbackRate).toBe(3.0);

      act(() => {
        window.dispatchEvent(new Event('pointerup'));
      });
      expect(screen.queryByTestId('speed-boost-indicator')).toBeNull();
      expect(video.playbackRate).toBe(1.0);
    });
  });
});
