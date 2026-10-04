import { describe, expect, it } from 'vitest';

import {
  STUDY_IDLE_MS,
  dateKey,
  isPresent,
  mergeSeconds,
  shiftDays,
  splitByDay,
  splitDuration,
  studyHeatLevel,
  takeWholeSeconds,
  tickSlices,
} from '../studyLog';

const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0) =>
  new Date(y, m - 1, d, h, min, s).getTime();

describe('studyLog pure functions', () => {
  it('uses local calendar dates, not UTC', () => {
    expect(dateKey(at(2026, 10, 4, 0, 30))).toBe('2026-10-04');
    expect(dateKey(at(2026, 10, 4, 23, 59, 59))).toBe('2026-10-04');
    expect(shiftDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('splits a heartbeat across local midnight', () => {
    const slices = splitByDay(at(2026, 10, 4, 23, 59, 50), at(2026, 10, 5, 0, 0, 5));
    expect(slices).toEqual([
      { date: '2026-10-04', seconds: 10 },
      { date: '2026-10-05', seconds: 5 },
    ]);
    expect(splitByDay(10, 10)).toEqual([]);
    expect(splitByDay(20, 10)).toEqual([]);
    expect(splitByDay(Number.NaN, 10)).toEqual([]);
  });

  it('caps a single tick at 30 s and skips absent time', () => {
    const now = at(2026, 10, 4, 10);
    // 睡眠唤醒：距上次心跳 2 小时，只计 30 秒
    expect(tickSlices(now - 2 * 3600_000, now, true)).toEqual([{ date: '2026-10-04', seconds: 30 }]);
    expect(tickSlices(now - 15_000, now, true)).toEqual([{ date: '2026-10-04', seconds: 15 }]);
    expect(tickSlices(now - 15_000, now, false)).toEqual([]);
  });

  it('presence = visible && (media playing || recent input)', () => {
    const now = 1_000_000;
    expect(isPresent({ visible: false, mediaPlaying: true, now, lastActiveAt: now })).toBe(false);
    expect(isPresent({ visible: true, mediaPlaying: false, now, lastActiveAt: now - 1000 })).toBe(true);
    expect(
      isPresent({ visible: true, mediaPlaying: false, now, lastActiveAt: now - STUDY_IDLE_MS }),
    ).toBe(false);
    // 播放中不做空闲判定
    expect(
      isPresent({ visible: true, mediaPlaying: true, now, lastActiveAt: now - 10 * STUDY_IDLE_MS }),
    ).toBe(true);
  });

  it('merges per day and reports whole seconds, keeping remainders', () => {
    const pending = new Map<string, number>();
    mergeSeconds(pending, [{ date: '2026-10-04', seconds: 10.4 }]);
    mergeSeconds(pending, [
      { date: '2026-10-04', seconds: 15 },
      { date: '2026-10-05', seconds: 0.6 },
    ]);
    expect(pending.get('2026-10-04')).toBe(25.4);
    const [batch, rest] = takeWholeSeconds(pending);
    expect(batch).toEqual([{ date: '2026-10-04', seconds: 25 }]);
    expect(rest.get('2026-10-04')).toBe(0.4);
    expect(rest.get('2026-10-05')).toBe(0.6);
  });

  it('maps seconds to fixed 15/45/90-minute heat levels', () => {
    expect(studyHeatLevel(0)).toBe(0);
    expect(studyHeatLevel(60)).toBe(1);
    expect(studyHeatLevel(15 * 60)).toBe(2);
    expect(studyHeatLevel(45 * 60)).toBe(3);
    expect(studyHeatLevel(90 * 60)).toBe(4);
    expect(studyHeatLevel(Number.NaN)).toBe(0);
  });

  it('splits durations into hours and minutes', () => {
    expect(splitDuration(0)).toEqual({ hours: 0, minutes: 0 });
    expect(splitDuration(59)).toEqual({ hours: 0, minutes: 0 });
    expect(splitDuration(38 * 60 + 20)).toEqual({ hours: 0, minutes: 38 });
    expect(splitDuration(2 * 3600 + 5 * 60)).toEqual({ hours: 2, minutes: 5 });
  });
});
