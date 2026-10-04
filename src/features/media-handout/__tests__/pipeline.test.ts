import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getMediaTranscript: vi.fn(),
  llmComplete: vi.fn(),
  vlmCaption: vi.fn(),
  cancelRun: vi.fn(async () => undefined),
  releaseRun: vi.fn(async () => undefined),
  saveNoteImage: vi.fn(),
}));
const notes = vi.hoisted(() => ({
  saveTextAsNote: vi.fn(),
  updateNoteContent: vi.fn(),
}));

vi.mock('../api', () => api);
vi.mock('@/shared/notes/saveTextAsNote', () => ({ saveTextAsNote: notes.saveTextAsNote }));
vi.mock('@/dstu/adapters/notesDstuAdapter', () => ({
  notesDstuAdapter: { updateNoteContent: notes.updateNoteContent },
}));

import { HandoutError, runHandout, snapFigures } from '../pipeline';

const text = { titleSuffix: ' 讲义', sectionFallback: 'FALLBACK', frameFallbackCaption: '画面' };

function transcript(n: number, lineLen = 10) {
  return {
    status: 'completed',
    segments: Array.from({ length: n }, (_, i) => ({
      idx: i,
      startMs: i * 10_000,
      endMs: i * 10_000 + 9_000,
      text: `第${i}句${'内容'.repeat(lineLen)}`,
      status: 1,
    })),
  };
}

const outlineJson = JSON.stringify({
  title: '机器学习讲义',
  summary: '概述',
  sections: [
    { heading: '甲', start: '00:00', end: '00:30', points: ['p'] },
    { heading: '乙', start: '00:30', end: '01:00', points: ['q'] },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  notes.saveTextAsNote.mockResolvedValue({ ok: true, noteId: 'note_1', title: 't', landed: 'root' });
  notes.updateNoteContent.mockResolvedValue({ ok: true });
});

describe('runHandout (audio → text-only)', () => {
  it('writes sections with one retry and salvage, then saves an anchored note', async () => {
    api.getMediaTranscript.mockResolvedValue(transcript(7));
    let jiaCalls = 0;
    api.llmComplete.mockImplementation(async (prompt: string) => {
      if (prompt.includes('"sections"')) return outlineJson;
      if (prompt.includes('「甲」')) {
        jiaCalls++;
        // 第一次 IR 不合法，第二次合法
        return jiaCalls === 1 ? '{"blocks":[{"type":"bogus"}]}' : '{"blocks":[{"type":"lead","text":"甲主旨"}]}';
      }
      return '纯文本输出\n第二行'; // 两次都不合规 → salvage
    });

    const phases: string[] = [];
    const res = await runHandout({
      resourceId: 'file_a',
      mediaName: '课',
      videoSrc: null,
      lang: 'zh',
      text,
      onProgress: (p) => phases.push(p.phase),
    });

    expect(jiaCalls).toBe(2);
    expect(res).toMatchObject({ noteId: 'note_1', title: '机器学习讲义', sectionCount: 2, figureCount: 0 });
    expect(api.vlmCaption).not.toHaveBeenCalled();
    const content: string = notes.saveTextAsNote.mock.calls[0][0].content;
    expect(content).toContain('[媒体@file_a:00:00]');
    expect(content).toContain('[媒体@file_a:00:30]');
    expect(content).toContain('甲主旨');
    expect(content).toContain('纯文本输出');
    expect(notes.saveTextAsNote.mock.calls[0][0].origin).toEqual({ kind: 'resource', resourceId: 'file_a', title: '课' });
    expect(notes.updateNoteContent).not.toHaveBeenCalled();
    expect(phases).toContain('writing');
    expect(phases[phases.length - 1]).toBe('done');
    expect(api.releaseRun).toHaveBeenCalledTimes(1);
  });

  it('summarises long transcripts in chunks before the outline', async () => {
    api.getMediaTranscript.mockResolvedValue(transcript(300, 30));
    api.llmComplete.mockImplementation(async (prompt: string, opts: { json?: boolean }) => {
      if (prompt.includes('"sections"')) return outlineJson;
      if (!opts.json) return '[00:00] 要点';
      return '{"blocks":[{"type":"para","text":"正文"}]}';
    });
    await runHandout({ resourceId: 'file_a', mediaName: '课', videoSrc: null, lang: 'zh', text });
    const summaryCalls = api.llmComplete.mock.calls.filter(([, o]) => !o.json);
    expect(summaryCalls.length).toBeGreaterThan(1);
    expect(summaryCalls.every(([p]) => p.length < 6000 + 500)).toBe(true);
  });

  it('requires a transcript', async () => {
    api.getMediaTranscript.mockResolvedValue(transcript(2));
    await expect(
      runHandout({ resourceId: 'file_a', mediaName: '课', videoSrc: null, lang: 'zh', text }),
    ).rejects.toMatchObject({ code: 'no_transcript' });
  });

  it('cancels in-flight backend calls on abort', async () => {
    api.getMediaTranscript.mockResolvedValue(transcript(7));
    const controller = new AbortController();
    api.llmComplete.mockImplementation(async () => {
      controller.abort();
      throw { error_type: 'Validation', message: 'cancelled' };
    });
    const err = await runHandout({
      resourceId: 'file_a',
      mediaName: '课',
      videoSrc: null,
      lang: 'zh',
      text,
      signal: controller.signal,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(HandoutError);
    expect(err.code).toBe('cancelled');
    expect(api.cancelRun).toHaveBeenCalled();
    expect(notes.saveTextAsNote).not.toHaveBeenCalled();
  });
});

it('snapFigures aligns figures to extracted frames and drops orphans', () => {
  const frames = [{ ts: 27, caption: 'VLM 说明', isTeaching: true, width: 1, height: 1, blob: new Blob() }];
  expect(
    snapFigures(
      [
        { type: 'figure', ts: 28 },
        { type: 'figure', ts: 90, caption: 'x' },
        { type: 'para', text: 'p' },
      ],
      frames,
    ),
  ).toEqual([
    { type: 'figure', ts: 27, caption: 'VLM 说明' },
    { type: 'para', text: 'p' },
  ]);
});
