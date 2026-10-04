import { describe, expect, it } from 'vitest';
import { frameDiff, rgbaToGray, sampleTimestamps, selectDistinctFrames } from '../frames';

const flat = (v: number) => new Uint8Array(256).fill(v);

describe('frame dedup', () => {
  it('frameDiff is the mean absolute difference', () => {
    expect(frameDiff(flat(10), flat(30))).toBe(20);
    expect(frameDiff(flat(10), flat(10))).toBe(0);
  });

  it('keeps slide changes, drops near-duplicates, compares with the last KEPT frame', () => {
    // 0:新画面 1:轻微晃动(5) 2:累计漂移到 20（相对上一张保留帧 ≥16 → 保留） 3:翻页
    const grays = [flat(100), flat(105), flat(120), flat(200)];
    expect(selectDistinctFrames(grays, 16)).toEqual([0, 2, 3]);
  });

  it('caps the number of frames', () => {
    const grays = Array.from({ length: 10 }, (_, i) => flat(i * 25));
    expect(selectDistinctFrames(grays, 16, 4)).toEqual([0, 1, 2, 3]);
  });

  it('rgbaToGray uses BT.601 weights', () => {
    expect(Array.from(rgbaToGray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]))).toEqual([76, 149, 29]);
  });
});

describe('sampleTimestamps', () => {
  it('samples every interval in whole seconds, avoiding the very end', () => {
    expect(sampleTimestamps(100, 25)).toEqual([2, 27, 52, 77]);
  });
  it('handles very short or invalid durations', () => {
    expect(sampleTimestamps(1.5, 25)).toEqual([0]);
    expect(sampleTimestamps(NaN)).toEqual([]);
    expect(sampleTimestamps(0)).toEqual([]);
  });
});
