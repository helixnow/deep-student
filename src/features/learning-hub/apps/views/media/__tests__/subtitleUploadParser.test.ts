import { describe, expect, it } from 'vitest';
import {
  isSupportedSubtitleFileName,
  normalizeSubtitleFileForImport,
  UNSUPPORTED_SUBTITLE_FORMAT_ERROR,
} from '../subtitleUploadParser';

function readText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

describe('subtitleUploadParser (S3-11)', () => {
  it('passes through standard .srt and .vtt files unchanged', async () => {
    const srtContent = '1\n00:00:00,000 --> 00:00:03,000\nHello world\n';
    const srtFile = new File([srtContent], 'lecture.srt', { type: 'application/x-subrip' });
    const normalized = await normalizeSubtitleFileForImport(srtFile);
    expect(normalized).toBe(srtFile);

    const vttContent = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nSlide one\n';
    const vttFile = new File([vttContent], 'lecture.vtt', { type: 'text/vtt' });
    expect(await normalizeSubtitleFileForImport(vttFile)).toBe(vttFile);
  });

  it('converts .ass Dialogue lines into valid .srt segments with tags stripped', async () => {
    const assContent = [
      '[Script Info]',
      'Title: Sample',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.50,0:00:04.25,Default,,0,0,0,,{\\an8}First line\\NSecond part',
      'Dialogue: 0,0:01:02.00,0:01:05.10,Default,,0,0,0,,Final line',
    ].join('\n');
    const file = new File([assContent], 'talk.ass', { type: 'text/plain' });

    const out = await normalizeSubtitleFileForImport(file);
    expect(out.name).toBe('talk.srt');
    const text = await readText(out);
    expect(text).toContain('00:00:01,500 --> 00:00:04,250');
    expect(text).toContain('First line\nSecond part');
    expect(text).not.toContain('{\\an8}');
    expect(text).toContain('00:01:02,000 --> 00:01:05,100');
    expect(text).toContain('Final line');
  });

  it('converts timestamped and plain .txt scripts into valid .srt cues', async () => {
    const txtTimed = new File(['[00:05] Intro\n[01:12] Main topic'], 'notes.txt', {
      type: 'text/plain',
    });
    const outTimed = await normalizeSubtitleFileForImport(txtTimed);
    expect(outTimed.name).toBe('notes.srt');
    const timedText = await readText(outTimed);
    expect(timedText).toContain('00:00:05,000 --> 00:01:12,000');
    expect(timedText).toContain('Intro');
    expect(timedText).toContain('00:01:12,000 --> 00:01:16,000');
    expect(timedText).toContain('Main topic');

    const txtPlain = new File(['Line A\nLine B'], 'plain.txt', { type: 'text/plain' });
    const outPlain = await normalizeSubtitleFileForImport(txtPlain);
    expect(outPlain.name).toBe('plain.srt');
    const plainText = await readText(outPlain);
    expect(plainText).toContain('00:00:00,000 --> 00:00:04,000\nLine A');
    expect(plainText).toContain('00:00:04,000 --> 00:00:08,000\nLine B');
  });

  it('throws on empty subtitle files', async () => {
    const empty = new File(['   \n'], 'empty.txt', { type: 'text/plain' });
    await expect(normalizeSubtitleFileForImport(empty)).rejects.toThrow();
  });

  it('rejects non-subtitle extensions (audio/video/binary) with a clear error', async () => {
    const unsupported = [
      'track.mp3',
      'lecture.MP4',
      'clip.wav',
      'voice.m4a',
      'audio.ogg',
      'video.webm',
      'movie.avi',
      'movie.mkv',
      'lossless.flac',
      'stream.aac',
      'slides.pdf',
      'noextension',
    ];
    for (const name of unsupported) {
      expect(isSupportedSubtitleFileName(name)).toBe(false);
      const file = new File([new Uint8Array([0, 1, 2, 3])], name, { type: 'application/octet-stream' });
      await expect(normalizeSubtitleFileForImport(file)).rejects.toThrow(
        UNSUPPORTED_SUBTITLE_FORMAT_ERROR,
      );
    }
    expect(isSupportedSubtitleFileName('captions.SRT')).toBe(true);
    expect(isSupportedSubtitleFileName('captions.vtt')).toBe(true);
    expect(isSupportedSubtitleFileName('captions.ass')).toBe(true);
    expect(isSupportedSubtitleFileName('captions.txt')).toBe(true);
    expect(isSupportedSubtitleFileName('captions.json')).toBe(true);
  });
});
