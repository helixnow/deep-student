import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { DstuNode } from '@/dstu/types';

const {
  invokeMock,
  convertFileSrcMock,
  dstuGetMock,
  showGlobalNotificationMock,
  isWebUiShellMock,
  supportsStreamProtocolMock,
  stableT,
  stableI18n,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  convertFileSrcMock: vi.fn((p: string, scheme = 'asset') => `${scheme}://localhost/${encodeURIComponent(p)}`),
  dstuGetMock: vi.fn(),
  showGlobalNotificationMock: vi.fn(),
  isWebUiShellMock: vi.fn(() => true),
  supportsStreamProtocolMock: vi.fn(() => true),
  stableT: (key: string, options?: Record<string, unknown>) => {
    if (options && typeof options.defaultValue === 'string') {
      return options.defaultValue.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) =>
        options[k] !== undefined && options[k] !== null ? String(options[k]) : '',
      );
    }
    return key;
  },
  stableI18n: { resolvedLanguage: 'zh-CN', language: 'zh-CN' },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  convertFileSrc: convertFileSrcMock,
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: stableT, i18n: stableI18n }),
  };
});

vi.mock('@/dstu', () => ({
  dstu: { get: dstuGetMock },
}));

vi.mock('@/components/UnifiedNotification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/UnifiedNotification')>();
  return {
    ...actual,
    showGlobalNotification: showGlobalNotificationMock,
  };
});

vi.mock('@/utils/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/platform')>();
  return {
    ...actual,
    isWebUiShell: isWebUiShellMock,
    supportsStreamProtocol: supportsStreamProtocolMock,
  };
});

vi.mock('@/features/pdf/components/TextbookPdfViewer', () => ({
  TextbookPdfViewer: () => null,
}));

vi.mock('@/features/learning-hub/apps/views/media/MediaStudyView', () => ({
  MediaStudyView: function MockMediaStudyView(props: {
    kind: 'audio' | 'video';
    src: string;
    sourceKind?: 'stream' | 'blob';
    onError: () => void;
  }) {
    const mediaRef = React.useRef<HTMLMediaElement | null>(null);
    React.useLayoutEffect(() => {
      const el = mediaRef.current;
      if (!el) return;
      // Simulate real Chromium HTML5 resource-selection step 2: networkState === 3 (NETWORK_NO_SOURCE)
      // with error === null synchronously on mount while awaiting stable state before HTTP 206 starts.
      Object.defineProperty(el, 'networkState', { configurable: true, value: 3 });
      Object.defineProperty(el, 'readyState', { configurable: true, value: 0 });
      Object.defineProperty(el, 'error', { configurable: true, value: null });
    }, [props.src]);

    return (
      <div data-testid="mock-media-study-root" data-media-source-kind={props.sourceKind}>
        {props.kind === 'audio' ? (
          <audio
            ref={mediaRef as React.RefObject<HTMLAudioElement>}
            data-testid="g27-audio"
            src={props.src}
            onError={() => props.onError()}
          />
        ) : (
          <video
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            data-testid="g27-video"
            src={props.src}
            onError={() => props.onError()}
          />
        )}
      </div>
    );
  },
}));

import { MediaStudyPage } from '../components/MediaStudyPage';
import {
  isCustomProtocolMediaUrl,
  shouldReportMediaElementError,
} from '../mediaPlaybackGuard';

function makeMockElement(overrides: Partial<{
  isConnected: boolean;
  srcAttr: string | null;
  currentSrc: string;
  hasSourceChild: boolean;
  error: Pick<MediaError, 'code' | 'message'> | null;
  networkState: number;
  readyState: number;
  paused: boolean;
  ended: boolean;
}> = {}) {
  const srcAttr = 'srcAttr' in overrides ? overrides.srcAttr : '/api/protocol/filestream/%2Ftmp%2Fa.mp4?mime=video%2Fmp4';
  return {
    isConnected: overrides.isConnected ?? true,
    currentSrc: overrides.currentSrc ?? '',
    error: (overrides.error === undefined ? { code: 4, message: '' } : overrides.error) as MediaError | null,
    networkState: overrides.networkState ?? 3,
    readyState: overrides.readyState ?? 0,
    paused: overrides.paused ?? true,
    ended: overrides.ended ?? false,
    getAttribute: (name: string) => (name === 'src' ? srcAttr : null),
    querySelector: () => (overrides.hasSourceChild ? ({} as Element) : null),
  };
}

describe('mediaPlaybackGuard G27 transient/stale error suppression', () => {
  it('suppresses initial NETWORK_NO_SOURCE (3) without MediaError, empty/detached/stale/aborted/fallback-pending, and already-decoded errors', () => {
    expect(isCustomProtocolMediaUrl('filestream://localhost/%2Ftmp%2Fa.mp4')).toBe(true);
    expect(isCustomProtocolMediaUrl('/api/protocol/filestream/%2Ftmp%2Fa.mp4')).toBe(false);

    // 1. HTML5 initial mount state: networkState === 3 with error === null
    expect(shouldReportMediaElementError(makeMockElement({ error: null, networkState: 3 }))).toBe(false);

    // 2. Detached / unmounting media element
    expect(shouldReportMediaElementError(makeMockElement({ isConnected: false }))).toBe(false);

    // 3. Cleared / empty src during teardown (`removeAttribute('src'); load()`)
    expect(shouldReportMediaElementError(makeMockElement({ srcAttr: null, currentSrc: '' }))).toBe(false);
    expect(shouldReportMediaElementError(makeMockElement({ srcAttr: '   ', currentSrc: '' }))).toBe(false);

    // 4. Stream -> blob fallback still pending in FileContentView
    expect(shouldReportMediaElementError(makeMockElement(), { fallbackPending: true })).toBe(false);

    // 5. Raw custom protocol URL in WebUI (before rewrite) or stale currentSrc after rewrite
    expect(
      shouldReportMediaElementError(
        makeMockElement({ srcAttr: 'filestream://localhost/%2Ftmp%2Fa.mp4' }),
        { isWebUi: true },
      ),
    ).toBe(false);
    expect(
      shouldReportMediaElementError(
        makeMockElement({
          srcAttr: '/api/protocol/filestream/%2Ftmp%2Fa.mp4',
          currentSrc: 'filestream://localhost/%2Ftmp%2Fa.mp4',
        }),
        { isWebUi: true },
      ),
    ).toBe(false);

    // 6. Stale error whose currentSrc belongs to a previous URL
    expect(
      shouldReportMediaElementError(
        makeMockElement({
          srcAttr: 'blob:http://127.0.0.1:4173/new-blob',
          currentSrc: 'http://127.0.0.1:4173/api/protocol/filestream/%2Ftmp%2Fold.mp4',
        }),
      ),
    ).toBe(false);

    // 7. MEDIA_ERR_ABORTED (code 1)
    expect(shouldReportMediaElementError(makeMockElement({ error: { code: 1, message: 'aborted' } }))).toBe(false);

    // 8. Already decoded frames (readyState >= 2) receiving stale SRC_NOT_SUPPORTED (code 4)
    expect(shouldReportMediaElementError(makeMockElement({ readyState: 3, error: { code: 4, message: '' } }))).toBe(false);

    // 9. Genuine terminal codec/source failure IS reported
    expect(
      shouldReportMediaElementError(
        makeMockElement({
          srcAttr: 'blob:http://127.0.0.1:4173/broken-blob',
          currentSrc: 'blob:http://127.0.0.1:4173/broken-blob',
          error: { code: 4, message: '' },
          readyState: 0,
        }),
        { isWebUi: true, fallbackPending: false },
      ),
    ).toBe(true);
    expect(
      shouldReportMediaElementError(
        makeMockElement({
          srcAttr: 'blob:http://127.0.0.1:4173/corrupt-blob',
          error: { code: 3, message: 'PIPELINE_ERROR_DECODE' },
          readyState: 0,
        }),
        { isWebUi: true, fallbackPending: false },
      ),
    ).toBe(true);
  });
});

describe('MediaStudyPage + FileContentView G27 false fatal playback banner regression', () => {
  const origCreateObjectUrl = URL.createObjectURL;
  const origRevokeObjectUrl = URL.revokeObjectURL;

  const mp4Node: DstuNode = {
    id: 'file_g27_mp4',
    name: 'lecture.mp4',
    path: '/file_g27_mp4',
    type: 'file',
    size: 2048,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: { mimeType: 'video/mp4' },
  };

  const mp3Node: DstuNode = {
    id: 'file_g27_mp3',
    name: 'podcast_256k.mp3',
    path: '/file_g27_mp3',
    type: 'file',
    size: 1024,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: { mimeType: 'audio/mpeg' },
  };

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    isWebUiShellMock.mockReturnValue(true);
    supportsStreamProtocolMock.mockReturnValue(true);
    URL.createObjectURL = vi.fn(() => 'blob:http://127.0.0.1:4173/fallback-blob');
    URL.revokeObjectURL = vi.fn();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'vfs_get_file_blob_path') return '/data/blobs/media.bin';
      if (cmd === 'filestream_check_access') return true;
      if (cmd === 'get_file_size') return 2048;
      if (cmd === 'read_file_bytes') return new Uint8Array([0, 1, 2, 3]).buffer;
      return null;
    });
  });

  afterEach(() => {
    cleanup();
    URL.createObjectURL = origCreateObjectUrl;
    URL.revokeObjectURL = origRevokeObjectUrl;
  });

  it('does not fire false fatal banner/toast on valid MP4 & 256kbps MP3 when initial networkState === 3, normalizes filestream:// before mount, and suppresses transient stream->blob fallback errors', async () => {
    dstuGetMock.mockResolvedValue({ ok: true, value: mp4Node });

    const { rerender } = render(
      <MediaStudyPage
        resourceId={mp4Node.id}
        isActive
        isSmallScreen={false}
        titlebarTarget={null}
        onBack={vi.fn()}
      />,
    );

    const videoEl = (await screen.findByTestId('g27-video')) as HTMLVideoElement;
    // FileContentView normalizes raw filestream:// -> /api/protocol/filestream/ BEFORE mounting MediaStudyView
    expect(videoEl.getAttribute('src')).toContain('/api/protocol/filestream/');
    expect(videoEl.getAttribute('src')).toContain('mime=video%2Fmp4');
    expect(screen.getByTestId('mock-media-study-root')).toHaveAttribute('data-media-source-kind', 'stream');

    // Initial networkState === 3 without MediaError must NEVER show error banner or toast
    expect(screen.queryByTestId('media-playback-error-banner')).toBeNull();
    expect(showGlobalNotificationMock).not.toHaveBeenCalled();

    // Transient stream error triggers FileContentView blob fallback without flashing fatal banner/toast
    Object.defineProperty(videoEl, 'error', { configurable: true, value: { code: 4, message: '' } });
    await act(async () => {
      videoEl.dispatchEvent(new Event('error'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('mock-media-study-root')).toHaveAttribute('data-media-source-kind', 'blob');
    });
    expect(screen.getByTestId('g27-video').getAttribute('src')).toBe('blob:http://127.0.0.1:4173/fallback-blob');
    expect(screen.queryByTestId('media-playback-error-banner')).toBeNull();
    expect(showGlobalNotificationMock).not.toHaveBeenCalled();

    // Same clean behavior for valid 256kbps MP3
    dstuGetMock.mockResolvedValue({ ok: true, value: mp3Node });
    rerender(
      <MediaStudyPage
        resourceId={mp3Node.id}
        isActive
        isSmallScreen={false}
        titlebarTarget={null}
        onBack={vi.fn()}
      />,
    );

    const audioEl = (await screen.findByTestId('g27-audio')) as HTMLAudioElement;
    expect(audioEl.getAttribute('src')).toContain('/api/protocol/filestream/');
    expect(audioEl.getAttribute('src')).toContain('mime=audio%2Fmpeg');
    expect(screen.queryByTestId('media-playback-error-banner')).toBeNull();
    expect(showGlobalNotificationMock).not.toHaveBeenCalled();
  });

  it('surfaces terminal blob error and clears error banner cleanly on loadedmetadata, loadeddata, canplay, and playing', async () => {
    supportsStreamProtocolMock.mockReturnValue(false);
    dstuGetMock.mockResolvedValue({ ok: true, value: mp3Node });

    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function mockRejectPlay() {
      const err = new Error('Transient decode hiccup');
      err.name = 'NotSupportedError';
      return Promise.reject(err);
    };

    try {
      render(
        <MediaStudyPage
          resourceId={mp3Node.id}
          isActive
          isSmallScreen={false}
          titlebarTarget={null}
          onBack={vi.fn()}
        />,
      );

      const audioEl = (await screen.findByTestId('g27-audio')) as HTMLAudioElement;
      expect(screen.getByTestId('mock-media-study-root')).toHaveAttribute('data-media-source-kind', 'blob');

      for (const recoveryEvent of ['loadedmetadata', 'loadeddata', 'canplay', 'playing'] as const) {
        // Trigger error banner via .play() rejection while element remains mounted
        await act(async () => {
          await audioEl.play().catch(() => undefined);
        });
        expect(screen.getByTestId('media-playback-error-banner')).toBeInTheDocument();

        // Recovery event clears the banner cleanly when MediaError is absent
        Object.defineProperty(audioEl, 'error', { configurable: true, value: null });
        Object.defineProperty(audioEl, 'readyState', { configurable: true, value: 2 });
        await act(async () => {
          audioEl.dispatchEvent(new Event(recoveryEvent));
        });
        expect(screen.queryByTestId('media-playback-error-banner')).toBeNull();
      }

      // Terminal blob MediaError surfaces both the error banner and FileContentView retry UI
      Object.defineProperty(audioEl, 'error', { configurable: true, value: { code: 4, message: '' } });
      Object.defineProperty(audioEl, 'readyState', { configurable: true, value: 0 });
      await act(async () => {
        audioEl.dispatchEvent(new Event('error'));
      });
      expect(screen.getByTestId('media-playback-error-banner')).toBeInTheDocument();
      expect(screen.getByText('learningHub:file.mediaRenderFailed')).toBeInTheDocument();
    } finally {
      HTMLMediaElement.prototype.play = origPlay;
    }
  });
});
