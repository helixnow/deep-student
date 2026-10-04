import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __studyTimeTestHooks,
  flushStudyTime,
  setStudyMediaPlaying,
  startStudyTracking,
  stopStudyTracking,
  studyTimeTick,
} from '../studyTimeTracker';
import { STUDY_IDLE_MS } from '../studyLog';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

describe('study time tracker', () => {
  const base = new Date(2026, 9, 4, 10, 0, 0).getTime();
  let reported: Array<{ date: string; seconds: number }>;

  beforeEach(() => {
    reported = [];
    setVisibility('visible');
    startStudyTracking({
      reporter: async (day) => {
        reported.push(day);
      },
    });
    __studyTimeTestHooks.reset(base);
  });

  afterEach(async () => {
    stopStudyTracking();
    await flushStudyTime();
    __studyTimeTestHooks.reset(base);
    reported = [];
    document.body.innerHTML = '';
  });

  it('counts visible present heartbeats and reports whole seconds', async () => {
    studyTimeTick(base + 15_000);
    studyTimeTick(base + 30_000);
    expect(__studyTimeTestHooks.pending().get('2026-10-04')).toBe(30);
    await flushStudyTime();
    expect(reported).toEqual([{ date: '2026-10-04', seconds: 30 }]);
    expect(__studyTimeTestHooks.pending().size).toBe(0);
  });

  it('auto-flushes every four counted heartbeats', async () => {
    for (let i = 1; i <= 4; i++) studyTimeTick(base + i * 15_000);
    await flushStudyTime();
    expect(reported).toEqual([{ date: '2026-10-04', seconds: 60 }]);
  });

  it('does not count hidden time or idle time without playback', () => {
    setVisibility('hidden');
    studyTimeTick(base + 15_000);
    expect(__studyTimeTestHooks.pending().size).toBe(0);

    setVisibility('visible');
    const idleNow = base + STUDY_IDLE_MS + 60_000;
    studyTimeTick(idleNow);
    expect(__studyTimeTestHooks.pending().size).toBe(0);
  });

  it('keeps counting while media plays even without input', () => {
    const idleNow = base + STUDY_IDLE_MS + 60_000;
    studyTimeTick(idleNow - 15_000);
    expect(__studyTimeTestHooks.pending().size).toBe(0);

    const video = document.createElement('video');
    Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
    Object.defineProperty(video, 'ended', { configurable: true, get: () => false });
    document.body.appendChild(video);
    studyTimeTick(idleNow);
    expect(__studyTimeTestHooks.pending().get('2026-10-04')).toBe(15);

    video.remove();
    setStudyMediaPlaying(true);
    __studyTimeTestHooks.markActive(base); // 显式播放态同样豁免空闲判定
    studyTimeTick(idleNow + 15_000);
    expect(__studyTimeTestHooks.pending().get('2026-10-04')).toBe(30);
    setStudyMediaPlaying(false);
  });

  it('keeps unreported seconds in memory when the backend call fails', async () => {
    stopStudyTracking();
    const failing = vi.fn().mockRejectedValue(new Error('vfs not ready'));
    startStudyTracking({ reporter: failing });
    __studyTimeTestHooks.reset(base);
    studyTimeTick(base + 15_000);
    await flushStudyTime();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(__studyTimeTestHooks.pending().get('2026-10-04')).toBe(15);
  });
});
