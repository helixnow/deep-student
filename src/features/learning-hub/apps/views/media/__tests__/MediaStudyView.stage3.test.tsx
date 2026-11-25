import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { APP_EVENTS } from '@/events/app';

const mocks = vi.hoisted(() => ({
  transcript: null as null | { status: string; segments: Array<Record<string, unknown>>; progress: { stage: string; completedSegments: number; totalSegments: number; percent: number } | null },
  estimate: null as null | { durationSeconds: number; estimatedSegments: number; asrModelName: string | null; asrConfigured: boolean },
  importFromPath: vi.fn(async () => 1),
  requestEstimate: vi.fn(async () => ({ ok: true })),
  stageBlobUpload: vi.fn(async () => 'upload-1'),
  abortStagedUpload: vi.fn(async () => {}),
  isWebUiShell: vi.fn(() => true),
  usesAndroidSaf: vi.fn(() => false),
  isTauriEnvironment: vi.fn(() => false),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      typeof opts?.defaultValue === 'string' ? opts.defaultValue : key,
    i18n: { language: 'zh-CN' },
  }),
}));
vi.mock('../VideoPlayer', () => ({
  VideoPlayer: () => <div data-testid="video-player" />,
}));
vi.mock('../BilibiliEmbedPlayer', () => ({
  BilibiliEmbedPlayer: () => <div data-testid="bilibili-embed" />,
}));
vi.mock('../AudioPlayer', () => ({
  AudioPlayer: () => <div data-testid="audio-player" />,
}));
vi.mock('../useMediaTranscript', () => ({
  useMediaTranscript: () => ({
    transcript: mocks.transcript,
    loading: false,
    error: null,
    estimate: mocks.estimate,
    estimating: false,
    starting: false,
    cancelling: false,
    requestEstimate: mocks.requestEstimate,
    clearEstimate: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    refresh: vi.fn(),
    importFromPath: mocks.importFromPath,
    exportToPath: vi.fn(),
  }),
}));
vi.mock('../useMediaProgressSync', () => ({
  useMediaProgressSync: () => ({ onStatus: vi.fn(), resumedFromRef: { current: null } }),
}));
vi.mock('../useTranscriptTrack', () => ({
  useTranscriptTrack: () => ({ trackSrc: null, trackRef: { current: null }, captionsOn: false, toggleCaptions: vi.fn() }),
}));
vi.mock('@/utils/stagedUpload', () => ({
  stageBlobUpload: mocks.stageBlobUpload,
  abortStagedUpload: mocks.abortStagedUpload,
}));
vi.mock('@/utils/fileManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/fileManager')>()),
  isWebUiShell: mocks.isWebUiShell,
  usesAndroidSaf: mocks.usesAndroidSaf,
}));
vi.mock('@/utils/urlOpener', () => ({
  isTauriEnvironment: mocks.isTauriEnvironment,
  openUrl: vi.fn(),
}));
vi.mock('@/features/media-handout', () => ({
  HandoutGenerateButton: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" data-testid="handout-btn" disabled={disabled}>
      生成讲义
    </button>
  ),
}));
vi.mock('@/features/learning-hub/useReferenceToChat', () => ({
  useReferenceToChat: () => ({ referenceToChat: vi.fn() }),
}));
vi.mock('@/features/chat/context/vfsRefApi', () => ({ uploadAttachmentBlob: vi.fn() }));
vi.mock('@/features/media-studio/mediaStudioNavigation', () => ({ openMediaStudio: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${path}`,
}));

import { MediaStudyView } from '../MediaStudyView';
import { MediaStudyCompanionContext } from '../mediaStudyCompanion';

class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    this.cb(
      [{ contentRect: { width: 1024 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  disconnect() {}
  unobserve() {}
}

describe('MediaStudyView S3-11 subtitle import & ASR settings link', () => {
  const OriginalRO = globalThis.ResizeObserver;

  beforeEach(() => {
    cleanup();
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    mocks.transcript = null;
    mocks.estimate = null;
    mocks.importFromPath.mockClear();
    mocks.requestEstimate.mockClear();
    mocks.stageBlobUpload.mockClear();
    mocks.abortStagedUpload.mockClear();
    mocks.isWebUiShell.mockReturnValue(true);
    mocks.isTauriEnvironment.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    globalThis.ResizeObserver = OriginalRO;
  });

  it('mounts hidden subtitle file input, clicks it on import, and imports normalized .srt files', async () => {
    render(
      <MediaStudyView
        filePath="/media/lecture.mp4"
        fileName="lecture.mp4"
        fileType="mp4"
        mediaResourceId="res-media-1"
      />,
    );

    const fileInput = screen.getByTestId('media-subtitle-file-input') as HTMLInputElement;
    expect(fileInput).toHaveAttribute('type', 'file');
    expect(fileInput.getAttribute('accept')).toContain('.srt');
    expect(fileInput.getAttribute('accept')).toContain('.txt');
    const clickSpy = vi.spyOn(fileInput, 'click');

    // Open desktop overflow menu and click "导入字幕文件…"
    fireEvent.click(screen.getByRole('button', { name: 'learningHub:mediaTranscript.more' }));
    const importMenuItem = screen.getByRole('menuitem', { name: 'learningHub:mediaTranscript.import' });
    fireEvent.click(importMenuItem);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    const srtFile = new File(
      ['1\n00:00:00,000 --> 00:00:03,000\nImported line\n'],
      'subtitles.srt',
      { type: 'application/x-subrip' },
    );
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [srtFile] } });
    });

    await waitFor(() => {
      expect(mocks.stageBlobUpload).toHaveBeenCalledTimes(1);
      expect(mocks.importFromPath).toHaveBeenCalledWith('dstu-staged:upload-1');
    });
  });

  it('unlocks HandoutGenerateButton when transcript has done segments during indexing stage', () => {
    mocks.transcript = {
      status: 'running',
      progress: { stage: 'indexing', completedSegments: 2, totalSegments: 2, percent: 95 },
      segments: [
        {
          id: 1,
          segmentIndex: 0,
          startMs: 0,
          endMs: 2500,
          text: 'Hello',
          status: 'done',
          source: 'imported',
        },
      ],
    };

    render(
      <MediaStudyCompanionContext.Provider
        value={{
          tabs: [
            {
              id: 'handout',
              label: '讲义',
              render: (ctx) => (
                <div
                  data-testid="companion-has-transcript"
                  data-has-transcript={String(ctx.hasTranscript)}
                />
              ),
            },
          ],
          activeTab: 'handout',
          onActiveTabChange: vi.fn(),
          ariaLabel: '伴随面板',
        }}
      >
        <MediaStudyView
          filePath="/media/lecture.mp4"
          fileName="lecture.mp4"
          fileType="mp4"
          mediaResourceId="res-media-2"
        />
      </MediaStudyCompanionContext.Provider>,
    );

    expect(screen.getByTestId('companion-has-transcript')).toHaveAttribute(
      'data-has-transcript',
      'true',
    );
  });

  it('shows configure ASR model CTA when ASR is unconfigured and navigates to Settings -> models', async () => {
    mocks.estimate = {
      durationSeconds: 120,
      estimatedSegments: 3,
      asrModelName: null,
      asrConfigured: false,
    };

    const events: Array<{ type: string; detail: unknown }> = [];
    const onNav = (e: Event) => events.push({ type: e.type, detail: (e as CustomEvent).detail });
    const onTab = (e: Event) => events.push({ type: e.type, detail: (e as CustomEvent).detail });
    window.addEventListener(APP_EVENTS.NAVIGATE_TO_VIEW, onNav);
    window.addEventListener(APP_EVENTS.SETTINGS_NAVIGATE_TAB, onTab);

    try {
      render(
        <MediaStudyView
          filePath="/media/lecture.mp4"
          fileName="lecture.mp4"
          fileType="mp4"
          mediaResourceId="res-media-3"
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'learningHub:mediaTranscript.transcribe' }));
      const configBtn = await screen.findByTestId('media-configure-asr-button');
      expect(configBtn).toHaveTextContent('learningHub:mediaTranscript.goConfigureAsr');
      fireEvent.click(configBtn);

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: APP_EVENTS.NAVIGATE_TO_VIEW,
            detail: expect.objectContaining({ view: 'settings' }),
          }),
          expect.objectContaining({
            type: APP_EVENTS.SETTINGS_NAVIGATE_TAB,
            detail: expect.objectContaining({ tab: 'models' }),
          }),
        ]),
      );
    } finally {
      window.removeEventListener(APP_EVENTS.NAVIGATE_TO_VIEW, onNav);
      window.removeEventListener(APP_EVENTS.SETTINGS_NAVIGATE_TAB, onTab);
    }
  });

  it('rejects non-subtitle files (e.g. .mp3) immediately without opening overwrite confirmation or importing', async () => {
    mocks.transcript = {
      status: 'done',
      progress: null,
      segments: [
        { id: 1, segmentIndex: 0, startMs: 0, endMs: 2500, text: '第一句字幕', status: 'done', source: 'imported' },
        { id: 2, segmentIndex: 1, startMs: 2500, endMs: 5000, text: '第二句字幕', status: 'done', source: 'imported' },
      ],
    };

    render(
      <MediaStudyView
        filePath="/media/lecture.mp4"
        fileName="lecture.mp4"
        fileType="mp4"
        mediaResourceId="res-media-4"
      />,
    );

    const fileInput = screen.getByTestId('media-subtitle-file-input') as HTMLInputElement;
    const mp3File = new File([new Uint8Array([0xff, 0xfb, 0x90, 0x00])], 'audio.mp3', { type: 'audio/mpeg' });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [mp3File] } });
    });

    expect(screen.queryByText('Replace existing subtitles?')).toBeNull();
    expect(mocks.stageBlobUpload).not.toHaveBeenCalled();
    expect(mocks.importFromPath).not.toHaveBeenCalled();
  });

  it('requires confirmation before overwriting existing subtitle cues on valid .vtt upload', async () => {
    mocks.transcript = {
      status: 'done',
      progress: null,
      segments: [
        { id: 1, segmentIndex: 0, startMs: 0, endMs: 2500, text: '第一句字幕', status: 'done', source: 'imported' },
        { id: 2, segmentIndex: 1, startMs: 2500, endMs: 5000, text: '第二句字幕', status: 'done', source: 'imported' },
      ],
    };

    render(
      <MediaStudyView
        filePath="/media/lecture.mp4"
        fileName="lecture.mp4"
        fileType="mp4"
        mediaResourceId="res-media-5"
      />,
    );

    const fileInput = screen.getByTestId('media-subtitle-file-input') as HTMLInputElement;
    const vttFile = new File(
      ['WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nEnglish cue\n'],
      'captions.vtt',
      { type: 'text/vtt' },
    );
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [vttFile] } });
    });

    // Confirmation dialog opens; nothing staged or imported yet
    expect(await screen.findByText('Replace existing subtitles?')).toBeInTheDocument();
    expect(mocks.stageBlobUpload).not.toHaveBeenCalled();
    expect(mocks.importFromPath).not.toHaveBeenCalled();

    // Confirm replacement
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => {
      expect(mocks.stageBlobUpload).toHaveBeenCalledTimes(1);
      expect(mocks.importFromPath).toHaveBeenCalledWith('dstu-staged:upload-1');
    });
  });
});
