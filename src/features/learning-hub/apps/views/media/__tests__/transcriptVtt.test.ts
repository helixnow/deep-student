import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '../mediaTranscriptApi';
import {
  buildWebVtt,
  createCueSynchronizer,
  findActiveSegmentIndex,
  formatVttTimestamp,
  planCueSync,
  segmentCueSignature,
  type CueTrackLike,
} from '../transcriptVtt';

const seg = (idx: number, startMs: number, endMs: number, text: string, status: TranscriptSegment['status'] = 'done'): TranscriptSegment => ({
  idx,
  startMs,
  endMs,
  text,
  status,
});

class FakeTrack implements CueTrackLike {
  list: Array<{ id: string; startTime: number; endTime: number; text: string }> = [];
  get cues() {
    return { getCueById: (id: string) => this.list.find((c) => c.id === id) ?? null };
  }
  addCue(cue: never) {
    this.list.push(cue);
  }
  removeCue(cue: never) {
    this.list = this.list.filter((c) => c !== cue);
  }
}

const fakeCue = (startTime: number, endTime: number, text: string) => ({ id: '', startTime, endTime, text });

describe('WebVTT generation', () => {
  it('formats timestamps as hh:mm:ss.mmm', () => {
    expect(formatVttTimestamp(0)).toBe('00:00:00.000');
    expect(formatVttTimestamp(3_723_045)).toBe('01:02:03.045');
  });

  it('only emits done segments with text, with seg-<idx> cue ids', () => {
    const vtt = buildWebVtt([
      seg(0, 0, 1500, 'hello'),
      seg(1, 1500, 3000, '', 'done'),
      seg(2, 3000, 4000, 'pending', 'pending'),
      seg(3, 4000, 5000, 'line one\n\nline --> two'),
    ]);
    expect(vtt.startsWith('WEBVTT\n')).toBe(true);
    expect(vtt).toContain('seg-0\n00:00:00.000 --> 00:00:01.500 line:80%,end\nhello');
    expect(vtt).not.toContain('seg-1');
    expect(vtt).not.toContain('seg-2');
    // blank lines collapse and "-->" inside text is neutralised
    expect(vtt).toContain('seg-3\n00:00:04.000 --> 00:00:05.000 line:80%,end\nline one\nline → two');
  });
});

describe('incremental cue sync', () => {
  it('plans adds for new segments and replacements for changed ones', () => {
    const applied = new Map([
      [0, segmentCueSignature(seg(0, 0, 1000, 'a'))],
      [1, segmentCueSignature(seg(1, 1000, 2000, 'b'))],
    ]);
    const plan = planCueSync(applied, [seg(0, 0, 1000, 'a'), seg(1, 1000, 2000, 'b2'), seg(2, 2000, 3000, 'c')]);
    expect(plan.remove).toEqual([1]);
    expect(plan.add.map((s) => s.idx)).toEqual([1, 2]);
  });

  it('adds only the delta on top of the blob-loaded seed without rebuilding', () => {
    const seed = [seg(0, 0, 1000, 'a')];
    const track = new FakeTrack();
    // simulate the <track src=blob> having loaded the seed cue
    track.list.push({ id: 'seg-0', startTime: 0, endTime: 1, text: 'a' });
    const sync = createCueSynchronizer(seed, fakeCue);

    expect(sync.sync(track, seed)).toBe(0);
    expect(sync.sync(track, [...seed, seg(1, 1000, 2000, 'b')])).toBe(1);
    expect(track.list.map((c) => c.id)).toEqual(['seg-0', 'seg-1']);
    const seedCue = track.list[0];

    // text correction for segment 1 replaces only that cue
    expect(sync.sync(track, [...seed, seg(1, 1000, 2000, 'b!')])).toBe(2);
    expect(track.list[0]).toBe(seedCue);
    expect(track.list.find((c) => c.id === 'seg-1')?.text).toBe('b!');

    // import that drops segment 0 removes its cue
    sync.sync(track, [seg(1, 1000, 2000, 'b!')]);
    expect(track.list.map((c) => c.id)).toEqual(['seg-1']);
    expect(sync.appliedCount()).toBe(1);
  });
});

describe('findActiveSegmentIndex', () => {
  const list = [seg(0, 0, 1000, 'a'), seg(1, 2000, 3000, 'b'), seg(2, 5000, 6000, 'c')];
  it('returns the last segment that has started', () => {
    expect(findActiveSegmentIndex(list, -1)).toBe(-1);
    expect(findActiveSegmentIndex(list, 0)).toBe(0);
    expect(findActiveSegmentIndex(list, 2500)).toBe(1);
    expect(findActiveSegmentIndex(list, 4000)).toBe(1);
    expect(findActiveSegmentIndex(list, 9000)).toBe(2);
    expect(findActiveSegmentIndex([], 10)).toBe(-1);
  });
});
