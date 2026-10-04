import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import {
  MAX_WATCHED_DELTA_MS,
  mediaTranscriptApi,
  normalizeTranscript,
  parseMediaProcessingEvent,
} from '../mediaTranscriptApi';
import { resolveResumePosition } from '../useMediaProgressSync';

beforeEach(() => invokeMock.mockReset());

describe('mediaTranscriptApi commands', () => {
  it('calls the contract command names with camelCase resourceId', async () => {
    invokeMock.mockResolvedValue({
      durationMs: 600_000,
      plannedSegments: 80,
      asrModel: 'FunAudioLLM/SenseVoiceSmall',
      asrConfigured: true,
      exact: true,
    });
    await expect(mediaTranscriptApi.estimate('file_1')).resolves.toEqual({
      durationMs: 600_000,
      plannedSegments: 80,
      asrModel: 'FunAudioLLM/SenseVoiceSmall',
      asrConfigured: true,
      exact: true,
    });
    expect(invokeMock).toHaveBeenLastCalledWith('media_transcribe_estimate', { resourceId: 'file_1' });

    invokeMock.mockResolvedValue(undefined);
    await mediaTranscriptApi.cancel('file_1');
    expect(invokeMock).toHaveBeenLastCalledWith('media_transcribe_cancel', { resourceId: 'file_1' });

    await mediaTranscriptApi.exportFile('file_1', 'srt', 'content://x/y.srt');
    expect(invokeMock).toHaveBeenLastCalledWith('media_transcript_export', {
      resourceId: 'file_1',
      format: 'srt',
      dest: 'content://x/y.srt',
    });

    invokeMock.mockResolvedValue({ segments: [] });
    await mediaTranscriptApi.importFile('file_1', '/tmp/a.vtt');
    expect(invokeMock).toHaveBeenLastCalledWith('media_transcript_import', { resourceId: 'file_1', path: '/tmp/a.vtt' });
  });

  it('sends progress updates rounded and with the watched delta capped', async () => {
    invokeMock.mockResolvedValue(undefined);
    await mediaTranscriptApi.setProgress('file_1', {
      positionMs: 1234.6,
      durationMs: 600_000.2,
      watchedDeltaMs: 999_999,
      finished: false,
    });
    expect(invokeMock).toHaveBeenLastCalledWith('media_progress_set', {
      resourceId: 'file_1',
      positionMs: 1235,
      durationMs: 600_000,
      watchedDeltaMs: MAX_WATCHED_DELTA_MS,
      finished: false,
    });
  });

  it('normalizes playback progress (snake or camel case, null when absent)', async () => {
    invokeMock.mockResolvedValueOnce({ last_position_ms: 5000, duration_ms: null, watched_ms: 12, finished: 1 });
    await expect(mediaTranscriptApi.getProgress('file_1')).resolves.toEqual({
      lastPositionMs: 5000,
      durationMs: null,
      watchedMs: 12,
      finished: true,
    });
    invokeMock.mockResolvedValueOnce(null);
    await expect(mediaTranscriptApi.getProgress('file_1')).resolves.toBeNull();
  });
});

describe('command errors', () => {
  it('unwraps the backend {code,message} JSON payload into a readable error', async () => {
    invokeMock.mockRejectedValueOnce('{"code":"settings-required","message":"未配置语音识别"}');
    await expect(mediaTranscriptApi.start('file_1')).rejects.toMatchObject({
      code: 'settings-required',
      message: '未配置语音识别',
    });
    invokeMock.mockRejectedValueOnce('plain failure');
    await expect(mediaTranscriptApi.get('file_1')).rejects.toMatchObject({ message: 'plain failure' });
  });

  it('keeps null duration / segments from a failed probe', async () => {
    invokeMock.mockResolvedValueOnce({ durationMs: null, plannedSegments: null, asrModel: 'm', asrConfigured: false, exact: false });
    await expect(mediaTranscriptApi.estimate('file_1')).resolves.toEqual({
      durationMs: null,
      plannedSegments: null,
      asrModel: 'm',
      asrConfigured: false,
      exact: false,
    });
  });
});

describe('normalizeTranscript', () => {
  it('maps numeric statuses, sorts segments and keeps progress', () => {
    const t = normalizeTranscript({
      status: 'running',
      segments: [
        { idx: 1, startMs: 2000, endMs: 3000, text: 'b', status: 0 },
        { idx: 0, startMs: 0, endMs: 1000, text: 'a', status: 1 },
        { idx: 2, start_ms: 3000, end_ms: 4000, text: 'c', status: 2 },
        { idx: 'x' },
      ],
      progress: { stage: 'asr', completedSegments: 1, totalSegments: 3 },
    });
    expect(t.status).toBe('running');
    expect(t.segments.map((s) => [s.idx, s.status])).toEqual([[0, 'done'], [1, 'pending'], [2, 'failed']]);
    expect(t.progress).toMatchObject({ stage: 'asr', completedSegments: 1, totalSegments: 3 });
    expect(Math.round(t.progress!.percent)).toBe(33);
  });

  it('infers completed / partial when status is missing', () => {
    expect(normalizeTranscript({ segments: [{ idx: 0, startMs: 0, endMs: 1, text: 'a', status: 1 }] }).status).toBe('completed');
    expect(
      normalizeTranscript({
        segments: [
          { idx: 0, startMs: 0, endMs: 1, text: 'a', status: 1 },
          { idx: 1, startMs: 1, endMs: 2, text: '', status: 2 },
        ],
      }).status,
    ).toBe('partial');
    expect(normalizeTranscript(null)).toEqual({ status: 'none', segments: [], progress: null });
  });

  it('maps backend error / cancelled statuses', () => {
    const seg = { idx: 0, startMs: 0, endMs: 1, text: 'a', status: 1 };
    const pending = { idx: 1, startMs: 1, endMs: 2, text: '', status: 0 };
    expect(normalizeTranscript({ status: 'error', segments: [] }).status).toBe('failed');
    expect(normalizeTranscript({ status: 'cancelled', segments: [] }).status).toBe('none');
    expect(normalizeTranscript({ status: 'cancelled', segments: [seg, pending] }).status).toBe('partial');
  });
});

describe('parseMediaProcessingEvent', () => {
  it('reads progress from the nested status object (existing event shape)', () => {
    const ev = parseMediaProcessingEvent('media-processing-progress', {
      fileId: 'file_1',
      mediaType: 'video',
      status: { stage: 'asr', percent: 40, completedSegments: 4, totalSegments: 10, readyModes: [] },
    });
    expect(ev).toEqual({
      kind: 'progress',
      resourceId: 'file_1',
      mediaType: 'video',
      progress: { stage: 'asr', completedSegments: 4, totalSegments: 10, percent: 40 },
    });
  });

  it('ignores pdf/image events and parses completed / error', () => {
    expect(parseMediaProcessingEvent('media-processing-progress', { fileId: 'a', mediaType: 'pdf', status: {} })).toBeNull();
    expect(parseMediaProcessingEvent('media-processing-completed', { fileId: 'f', mediaType: 'audio', stage: 'completed' }))
      .toEqual({ kind: 'completed', resourceId: 'f', mediaType: 'audio', stage: 'completed' });
    expect(parseMediaProcessingEvent('media-processing-error', { fileId: 'f', mediaType: 'audio', stage: 'asr', error: 'boom' }))
      .toEqual({ kind: 'error', resourceId: 'f', mediaType: 'audio', stage: 'asr', error: 'boom' });
  });
});

describe('resolveResumePosition', () => {
  it('resumes mid-way, but not near the edges or when finished', () => {
    expect(resolveResumePosition(120_000, 600, false)).toBe(120);
    expect(resolveResumePosition(3_000, 600, false)).toBeNull();
    expect(resolveResumePosition(598_000, 600, false)).toBeNull();
    expect(resolveResumePosition(120_000, 600, true)).toBeNull();
    expect(resolveResumePosition(120_000, 0, false)).toBe(120);
  });
});
