import { describe, expect, it } from 'vitest';
import {
  chunkTranscript,
  parseOutline,
  sectionFigureRange,
  sectionFrameWindow,
  sectionTranscriptWindow,
  segmentsToTranscript,
  snapToFrame,
  usableSegments,
  type TranscriptSegment,
} from '../windowing';

const seg = (idx: number, startSec: number, text: string, status = 1): TranscriptSegment => ({
  idx,
  startMs: startSec * 1000,
  endMs: startSec * 1000 + 4000,
  text,
  status,
});

describe('transcript formatting and chunking', () => {
  it('keeps only completed non-empty segments in time order', () => {
    const out = usableSegments([seg(1, 20, 'b'), seg(0, 5, 'a'), seg(2, 30, '', 1), seg(3, 40, 'x', 2)]);
    expect(out.map((s) => s.text)).toEqual(['a', 'b']);
    expect(segmentsToTranscript(out)).toBe('[00:05] a\n[00:20] b');
  });

  it('chunks on line boundaries within the limit', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `[00:0${i}] ${'x'.repeat(20)}`);
    const chunks = chunkTranscript(lines.join('\n'), 70);
    expect(chunks.every((c) => c.length <= 70)).toBe(true);
    expect(chunks.join('\n')).toBe(lines.join('\n'));
    expect(chunks[0].startsWith('[00:00]')).toBe(true);
  });

  it('hard-splits a single oversize line', () => {
    expect(chunkTranscript('a'.repeat(25), 10)).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  });
});

describe('parseOutline', () => {
  it('normalises order, fills missing ends and caps at 12 sections', () => {
    const sections = Array.from({ length: 14 }, (_, i) => ({
      heading: `S${i}`,
      start: `${String(i).padStart(2, '0')}:00`,
      end: i === 3 ? 'bad' : `${String(i).padStart(2, '0')}:59`,
      points: ['p', 3],
    }));
    sections.reverse();
    const raw = `前言\n${JSON.stringify({ title: 'T', summary: 'S', sections })}\n后记`;
    const outline = parseOutline(raw, 14 * 60, 'fallback');
    expect(outline.title).toBe('T');
    expect(outline.sections).toHaveLength(12);
    expect(outline.sections[0]).toMatchObject({ heading: 'S0', startSec: 0, endSec: 59, points: ['p'] });
    expect(outline.sections[3]).toMatchObject({ startSec: 180, endSec: 240 }); // 缺 end → 下一节起点
    expect(outline.sections[11].endSec).toBe(14 * 60); // 截断后最后一节吞下剩余时间
  });

  it('falls back to the given title and rejects empty outlines', () => {
    expect(parseOutline('{"sections":[{"heading":"A","start":"00:00","end":"01:00"}]}', 60, 'F').title).toBe('F');
    expect(() => parseOutline('{"sections":[{"heading":"","start":"x"}]}', 60, 'F')).toThrow();
    expect(() => parseOutline('nothing', 60, 'F')).toThrow();
  });
});

describe('section windows', () => {
  const segments = [seg(0, 50, 'a'), seg(1, 56, 'b'), seg(2, 120, 'c'), seg(3, 184, 'd'), seg(4, 186, 'e')];
  const section = { startSec: 60, endSec: 180 };

  it('transcript window is ±5 s around the section', () => {
    expect(sectionTranscriptWindow(segments, section).map((s) => s.text)).toEqual(['b', 'c', 'd']);
  });

  it('frame window is ±10 s and only teaching frames', () => {
    const frames = [
      { ts: 49, isTeaching: true },
      { ts: 52, isTeaching: true },
      { ts: 100, isTeaching: false },
      { ts: 190, isTeaching: true },
      { ts: 191, isTeaching: true },
    ];
    expect(sectionFrameWindow(frames, section).map((f) => f.ts)).toEqual([52, 190]);
    expect(sectionFigureRange(section)).toEqual({ startSec: 50, endSec: 190 });
  });

  it('snapToFrame picks the nearest frame within tolerance', () => {
    const frames = [{ ts: 27 }, { ts: 52 }];
    expect(snapToFrame(29, frames)?.ts).toBe(27);
    expect(snapToFrame(40, frames)).toBeNull();
  });
});
