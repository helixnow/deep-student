import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __studyTimeTestHooks,
  flushStudyTime,
  isStudySurfaceActive,
  setStudyFocusActive,
  setStudyMediaPlaying,
  startStudyTracking,
  stopStudyTracking,
  studyTimeTick,
} from '../studyTimeTracker';
import { STUDY_IDLE_MS } from '../studyLog';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { useViewStore } from '@/stores/viewStore';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

describe('study time tracker', () => {
  const base = new Date(2026, 9, 4, 10, 0, 0).getTime();
  let reported: Array<{ date: string; seconds: number }>;

  beforeEach(() => {
    reported = [];
    useViewStore.setState({ currentView: 'chat-v2', previousView: null });
    setVisibility('visible');
    startStudyTracking({
      reporter: async (day) => {
        reported.push(day);
      },
    });
    __studyTimeTestHooks.reset(base);
  });

  afterEach(async () => {
    usePomodoroStore.getState().stop(false);
    useViewStore.setState({ currentView: 'chat-v2', previousView: null });
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

  it.each([0, 1])('retains every unreported day when batch entry %i fails', async (failedIndex) => {
    stopStudyTracking();
    await flushStudyTime();
    const report = vi.fn().mockResolvedValue(undefined);
    if (failedIndex === 1) report.mockResolvedValueOnce(undefined);
    report.mockRejectedValueOnce(new Error('temporarily unavailable'));
    startStudyTracking({ reporter: report });
    const midnight = new Date(2026, 9, 5, 0, 0, 0).getTime();
    __studyTimeTestHooks.reset(midnight - 10_000);
    studyTimeTick(midnight + 5_000);

    await flushStudyTime();
    expect([...__studyTimeTestHooks.pending()]).toEqual(
      failedIndex === 0
        ? [['2026-10-04', 10], ['2026-10-05', 5]]
        : [['2026-10-05', 5]],
    );
    await flushStudyTime();
    expect(__studyTimeTestHooks.pending().size).toBe(0);
    expect(report.mock.calls.map(([day]) => day)).toEqual(
      failedIndex === 0
        ? [{ date: '2026-10-04', seconds: 10 }, { date: '2026-10-04', seconds: 10 }, { date: '2026-10-05', seconds: 5 }]
        : [{ date: '2026-10-04', seconds: 10 }, { date: '2026-10-05', seconds: 5 }, { date: '2026-10-05', seconds: 5 }],
    );
  });

  it('flushes the final visible slice without counting the subsequent hidden interval', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(base + 10_000);
    try {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await flushStudyTime();
      expect(reported).toEqual([{ date: '2026-10-04', seconds: 10 }]);

      now.mockReturnValue(base + 20_000);
      document.dispatchEvent(new Event('visibilitychange'));
      studyTimeTick(base + 30_000);
      await flushStudyTime();
      expect(reported).toHaveLength(1);

      now.mockReturnValue(base + 40_000);
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      studyTimeTick(base + 45_000);
      await flushStudyTime();
      expect(reported[1]).toEqual({ date: '2026-10-04', seconds: 5 });
    } finally {
      now.mockRestore();
    }
  });

  it('retries a backlog over the host limit without resending successful chunks', async () => {
    stopStudyTracking();
    await flushStudyTime();
    const report = vi.fn().mockRejectedValue(new Error('backend unavailable'));
    startStudyTracking({ reporter: report });
    __studyTimeTestHooks.reset(base);
    for (let i = 1; i <= 122; i++) {
      __studyTimeTestHooks.markActive(base + i * 30_000);
      studyTimeTick(base + i * 30_000);
      await flushStudyTime();
    }
    expect(__studyTimeTestHooks.pending().get('2026-10-04')).toBe(3660);

    report.mockReset();
    report.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('retry later'));
    await flushStudyTime();
    expect(report.mock.calls.map(([day]) => day.seconds)).toEqual([3600, 60]);
    expect(__studyTimeTestHooks.pending().get('2026-10-04')).toBe(60);

    report.mockResolvedValue(undefined);
    await flushStudyTime();
    expect(report.mock.calls.map(([day]) => day.seconds)).toEqual([3600, 60, 60]);
    expect(__studyTimeTestHooks.pending().size).toBe(0);
  });

  it('exempts active focus mode from idle cutoff only while visible and syncs with Pomodoro work state (BUG-18)', () => {
    const idleNow = base + STUDY_IDLE_MS + 60_000;
    studyTimeTick(idleNow - 15_000);
    expect(__studyTimeTestHooks.pending().size).toBe(0);

    // Focus active while visible -> exempt from 5-minute idle cutoff
    setStudyFocusActive(true);
    __studyTimeTestHooks.markActive(base);
    studyTimeTick(idleNow);
    expect(__studyTimeTestHooks.pending().get('2026-10-04')).toBe(15);

    // Hidden still pauses counting even when focus is active
    setVisibility('hidden');
    studyTimeTick(idleNow + 15_000);
    expect(__studyTimeTestHooks.pending().get('2026-10-04')).toBe(15);

    // Reset clears focus exemption
    setVisibility('visible');
    __studyTimeTestHooks.reset(base);
    studyTimeTick(idleNow);
    expect(__studyTimeTestHooks.pending().size).toBe(0);

    // Pomodoro store running work syncs study focus exemption, pause/stop clears it
    usePomodoroStore.getState().start();
    __studyTimeTestHooks.markActive(base);
    studyTimeTick(idleNow + 15_000);
    expect(__studyTimeTestHooks.pending().get('2026-10-04')).toBe(15);

    usePomodoroStore.getState().pause();
    __studyTimeTestHooks.markActive(base);
    studyTimeTick(idleNow + 30_000);
    expect(__studyTimeTestHooks.pending().get('2026-10-04')).toBe(15);

    usePomodoroStore.getState().resume();
    __studyTimeTestHooks.markActive(base);
    studyTimeTick(idleNow + 45_000);
    expect(__studyTimeTestHooks.pending().get('2026-10-04')).toBe(30);

    usePomodoroStore.getState().stop(false);
    __studyTimeTestHooks.markActive(base);
    studyTimeTick(idleNow + 60_000);
    expect(__studyTimeTestHooks.pending().get('2026-10-04')).toBe(30);
  });

  it('never inflates study time while browsing Settings, empty desktop, or non-study windows (S4-11)', async () => {
    // 1. Legacy shell in Settings / Dashboard / Todo must NOT accumulate study time
    useViewStore.setState({ currentView: 'settings', previousView: 'chat-v2' });
    expect(isStudySurfaceActive()).toBe(false);
    studyTimeTick(base + 15_000);
    studyTimeTick(base + 60_000);
    expect(__studyTimeTestHooks.pending().size).toBe(0);

    useViewStore.setState({ currentView: 'todo', previousView: 'settings' });
    studyTimeTick(base + 75_000);
    expect(__studyTimeTestHooks.pending().size).toBe(0);

    // 2. Workbench Desktop mode: empty desktop -> 0 study time
    useViewStore.setState({ currentView: 'chat-v2', previousView: null });
    document.body.innerHTML = '<div data-wb-workbench-root><div data-wb-desktop></div></div>';
    expect(isStudySurfaceActive()).toBe(false);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    studyTimeTick(base + 90_000);
    expect(__studyTimeTestHooks.pending().size).toBe(0);

    // 3. Workbench Settings window focused (switching presets / browsing settings for 2 minutes) -> 0 study time
    document.body.innerHTML = `
      <div data-wb-workbench-root>
        <section data-wb-window data-focused="true">
          <div data-wb-sys-app="settings"><button id="preset-btn">Preset</button></div>
        </section>
      </div>
    `;
    const presetBtn = document.getElementById('preset-btn')!;
    presetBtn.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    studyTimeTick(base + 105_000);
    studyTimeTick(base + 120_000);
    await flushStudyTime();
    expect(reported).toEqual([]);
    expect(__studyTimeTestHooks.pending().size).toBe(0);

    // 4. Switching to a focused Notes study window DOES accumulate only from that point forward
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base + 125_000);
    try {
      document.body.innerHTML = `
        <div data-wb-workbench-root>
          <section data-wb-window data-focused="true">
            <div data-wb-notes-workspace><div id="note-editor">Notes</div></div>
          </section>
        </div>
      `;
      document.getElementById('note-editor')!.dispatchEvent(new Event('keydown', { bubbles: true }));
      studyTimeTick(base + 135_000);
      expect(__studyTimeTestHooks.pending().get('2026-10-04')).toBe(15);

      // Active Pomodoro work still counts even if user peeks at Settings while timer runs
      document.body.innerHTML = `
        <div data-wb-workbench-root>
          <section data-wb-window data-focused="true">
            <div data-wb-sys-app="settings"></div>
          </section>
        </div>
      `;
      usePomodoroStore.getState().start();
      studyTimeTick(base + 150_000);
      expect(__studyTimeTestHooks.pending().get('2026-10-04')).toBe(30);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
