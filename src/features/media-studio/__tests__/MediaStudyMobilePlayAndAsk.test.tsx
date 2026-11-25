import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DstuNode } from '@/dstu/types';
import { useMediaStudyCompanion } from '@/features/learning-hub/apps/views/media/mediaStudyCompanion';

const {
  invokeMock,
  dstuGetMock,
  useReferenceToChatMock,
  startMediaChatMock,
  showGlobalNotificationMock,
  isWebUiShellMock,
  stableT,
  stableI18n,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  dstuGetMock: vi.fn(),
  useReferenceToChatMock: vi.fn(),
  startMediaChatMock: vi.fn(),
  showGlobalNotificationMock: vi.fn(),
  isWebUiShellMock: vi.fn(() => false),
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
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: stableT,
      i18n: stableI18n,
    }),
  };
});

vi.mock('@/dstu', () => ({
  dstu: {
    get: dstuGetMock,
  },
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
  };
});

vi.mock('@/features/learning-hub/useReferenceToChat', () => ({
  useReferenceToChat: useReferenceToChatMock,
}));

vi.mock('../mediaChat', () => ({
  startMediaChat: startMediaChatMock,
}));

vi.mock('@/features/learning-hub/apps/views/FileContentView', () => ({
  default: function MockFileContentView({ node }: { node: DstuNode }) {
    const companion = useMediaStudyCompanion();
    const askTab = companion?.tabs.find((tab) => tab.id === 'ask');
    const mime = (node.metadata as { mimeType?: string } | undefined)?.mimeType ?? '';
    const isAudio = mime.startsWith('audio/') || /\.mp3$/i.test(node.name);
    const mediaSrc =
      node.id === 'file_missing_src'
        ? ''
        : `filestream://localhost/${encodeURIComponent(`/blobs/${node.id}.bin`)}?mime=${encodeURIComponent(mime || 'video/mp4')}`;

    return (
      <div data-testid="mock-mobile-media-view" style={{ width: '360px', height: '720px' }}>
        <div className="relative aspect-video w-full" data-testid="player-wrapper">
          {isAudio ? (
            <audio data-testid="mobile-study-audio" src={mediaSrc} />
          ) : (
            <video data-testid="mobile-study-video" src={mediaSrc} />
          )}
          <button
            type="button"
            aria-label="播放"
            data-testid="central-play-btn"
            className="absolute inset-0 z-10"
            onClick={(e) => {
              const el = (e.currentTarget.parentElement?.querySelector('video, audio') ??
                null) as HTMLMediaElement | null;
              void el?.play().catch(() => undefined);
            }}
          >
            <span>Play</span>
          </button>
          <div data-testid="disabled-play-parent">
            <button
              type="button"
              aria-label="播放"
              disabled
              data-testid="disabled-premetadata-play-btn"
            >
              Disabled Play
            </button>
          </div>
        </div>
        <div role="tablist">
          <button
            type="button"
            data-testid="switch-to-ask-tab"
            onClick={() => companion?.onActiveTabChange('ask')}
          >
            问答
          </button>
        </div>
        <div
          data-media-study-tab="ask"
          className={companion?.activeTab === 'ask' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
        >
          {askTab
            ? askTab.render({
                resourceId: node.id,
                kind: isAudio ? 'audio' : 'video',
                src: mediaSrc,
                fileName: node.name,
                transcriptStatus: 'done',
                hasTranscript: true,
                doneSegments: 1,
                totalSegments: 1,
                segments: [
                  {
                    idx: 0,
                    startMs: 1000,
                    endMs: 9000,
                    text: '本节讲解波的干涉与衍射条件',
                    status: 'done',
                  },
                ],
                chapters: [{ seconds: 0, title: '干涉条件导引' }],
                currentChapterIndex: 0,
                seekTo: vi.fn(),
                getCurrentTime: () => 4,
              })
            : null}
        </div>
      </div>
    );
  },
}));

import { MediaStudyPage } from '../components/MediaStudyPage';
import {
  describeMediaPlaybackError,
  findHitDisabledPlayButton,
  resolvePlayableMediaUrl,
} from '../mediaPlaybackGuard';

const SAMPLE_VIDEO_NODE: DstuNode = {
  id: 'file_mobile_vid_1',
  name: '大学物理波动学.mp4',
  path: '/file_mobile_vid_1',
  type: 'file',
  size: 1024 * 1024,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  metadata: { mimeType: 'video/mp4' },
};

const SAMPLE_AUDIO_NODE: DstuNode = {
  id: 'file_mobile_aud_1',
  name: '英语听力精讲.mp3',
  path: '/file_mobile_aud_1',
  type: 'file',
  size: 512 * 1024,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  metadata: { mimeType: 'audio/mpeg' },
};

describe('MediaStudyPage 360px mobile play fallback & Ask tab visible input (S3-17)', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'handout_llm_complete') {
        return '波的相干条件包括：频率相同、振动方向相同、相位差恒定 [00:01]。';
      }
      return null;
    });
    isWebUiShellMock.mockReturnValue(false);
    dstuGetMock.mockResolvedValue({ ok: true, value: SAMPLE_VIDEO_NODE });
    useReferenceToChatMock.mockReturnValue({
      referenceToChat: vi.fn().mockResolvedValue({ success: true }),
    });
    startMediaChatMock.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it('normalizes raw custom protocol media URLs to WebUI HTTP Range endpoints while preserving blob/http and native shell URLs', () => {
    expect(
      resolvePlayableMediaUrl('filestream://localhost/%2Fdata%2Flecture.mp4?mime=video%2Fmp4', {
        isWebUi: true,
        origin: 'http://127.0.0.1:4173',
      }),
    ).toBe('http://127.0.0.1:4173/api/protocol/filestream/%2Fdata%2Flecture.mp4?mime=video%2Fmp4');

    expect(
      resolvePlayableMediaUrl('filestream://localhost/%2Fdata%2Flecture.mp4?mime=video%2Fmp4', {
        isWebUi: false,
      }),
    ).toBe('filestream://localhost/%2Fdata%2Flecture.mp4?mime=video%2Fmp4');

    expect(
      resolvePlayableMediaUrl('blob:http://127.0.0.1:4173/abc-123', {
        isWebUi: true,
        origin: 'http://127.0.0.1:4173',
      }),
    ).toBe('blob:http://127.0.0.1:4173/abc-123');
  });

  it('rewrites leaked filestream:// src to /api/protocol/filestream/ in WebUI shell so playback works cleanly', async () => {
    isWebUiShellMock.mockReturnValue(true);
    render(
      <MediaStudyPage
        resourceId="file_mobile_vid_1"
        isActive
        isSmallScreen
        titlebarTarget={null}
        onBack={vi.fn()}
      />,
    );

    const mountedVideo = (await screen.findByTestId('mobile-study-video')) as HTMLVideoElement;
    expect(mountedVideo.getAttribute('src')).toContain('/api/protocol/filestream/');
    expect(mountedVideo.getAttribute('src')).toContain('mime=video%2Fmp4');
  });

  it('falls back to muted playback with unmute banner when unmuted play() rejects with NotAllowedError on 360px mobile', async () => {
    let protoCalls = 0;
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function mockPlay(this: HTMLMediaElement) {
      protoCalls += 1;
      if (protoCalls === 1 && !this.muted) {
        const err = new Error('play() failed because the user didn’t interact first');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      }
      return Promise.resolve();
    };

    try {
      render(
        <MediaStudyPage
          resourceId="file_mobile_vid_1"
          isActive
          isSmallScreen
          titlebarTarget={null}
          onBack={vi.fn()}
        />,
      );

      const mountedVideo = (await screen.findByTestId('mobile-study-video')) as HTMLVideoElement;
      expect(mountedVideo.muted).toBe(false);

      await act(async () => {
        fireEvent.click(screen.getByTestId('central-play-btn'));
      });

      expect(protoCalls).toBe(2);
      expect(mountedVideo.muted).toBe(true);
      const banner = await screen.findByTestId('media-muted-autoplay-banner');
      expect(banner).toHaveTextContent('已切换为静音播放');

      // Clicking "取消静音" unmutes the video and dismisses the banner
      fireEvent.click(screen.getByRole('button', { name: '取消静音' }));
      expect(mountedVideo.muted).toBe(false);
      expect(screen.queryByTestId('media-muted-autoplay-banner')).toBeNull();
    } finally {
      HTMLMediaElement.prototype.play = origPlay;
    }
  });

  it('surfaces visible inline error banner and toast notification with retry reload when media fails or pre-metadata play is tapped', async () => {
    const origPlay = HTMLMediaElement.prototype.play;
    const origLoad = HTMLMediaElement.prototype.load;
    let shouldFail = true;
    let playCalls = 0;
    const loadSpy = vi.fn();
    HTMLMediaElement.prototype.load = loadSpy;
    HTMLMediaElement.prototype.play = function mockFailThenPass() {
      playCalls += 1;
      if (shouldFail) {
        const err = new Error('Format not supported');
        err.name = 'NotSupportedError';
        return Promise.reject(err);
      }
      return Promise.resolve();
    };

    try {
      render(
        <MediaStudyPage
          resourceId="file_mobile_vid_1"
          isActive
          isSmallScreen
          titlebarTarget={null}
          onBack={vi.fn()}
        />,
      );

      await screen.findByTestId('mobile-study-video');

      // Direct synthetic click on pre-metadata disabled Play button triggers playback guard
      await act(async () => {
        fireEvent.click(screen.getByTestId('disabled-premetadata-play-btn'));
      });

      expect(playCalls).toBe(1);
      const errBanner = await screen.findByTestId('media-playback-error-banner');
      expect(errBanner).toHaveTextContent('Format not supported');
      expect(showGlobalNotificationMock).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('Format not supported'),
        '音视频播放失败',
      );

      // Clicking retry reloads and invokes play() again
      shouldFail = false;
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '重试' }));
      });
      expect(loadSpy).toHaveBeenCalled();
      expect(playCalls).toBe(2);
      expect(screen.queryByTestId('media-playback-error-banner')).toBeNull();
    } finally {
      HTMLMediaElement.prototype.play = origPlay;
      HTMLMediaElement.prototype.load = origLoad;
    }
  });

  it('handles real-browser clicks falling through pointer-events: none disabled Play buttons and surfaces audio MediaError codes even with empty message', async () => {
    dstuGetMock.mockResolvedValue({ ok: true, value: SAMPLE_AUDIO_NODE });

    const origPlay = HTMLMediaElement.prototype.play;
    const playSpy = vi.fn(() => Promise.resolve());
    HTMLMediaElement.prototype.play = playSpy;

    try {
      render(
        <MediaStudyPage
          resourceId="file_mobile_aud_1"
          isActive
          isSmallScreen
          titlebarTarget={null}
          onBack={vi.fn()}
        />,
      );

      const audioEl = (await screen.findByTestId('mobile-study-audio')) as HTMLAudioElement;
      const disabledBtn = screen.getByTestId('disabled-premetadata-play-btn') as HTMLButtonElement;
      const parentDiv = screen.getByTestId('disabled-play-parent');

      // Simulate real Chromium behavior where pointer-events: none lets a tap over the disabled
      // button land on its enabled parent with coordinates inside the button's bounding box.
      vi.spyOn(disabledBtn, 'getBoundingClientRect').mockReturnValue({
        left: 140,
        top: 200,
        right: 188,
        bottom: 248,
        width: 48,
        height: 48,
        x: 140,
        y: 200,
        toJSON: () => ({}),
      });
      expect(
        findHitDisabledPlayButton(document.querySelector('[data-media-study]') as HTMLElement, {
          target: parentDiv,
          clientX: 164,
          clientY: 224,
        }),
      ).toBe(disabledBtn);

      await act(async () => {
        fireEvent.click(parentDiv, { clientX: 164, clientY: 224 });
      });
      expect(playSpy).toHaveBeenCalledTimes(1);

      // Simulate browser MediaError with empty message (code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED)
      Object.defineProperty(audioEl, 'error', {
        configurable: true,
        value: { code: 4, message: '' },
      });
      await act(async () => {
        audioEl.dispatchEvent(new Event('error'));
      });

      const banner = await screen.findByTestId('media-playback-error-banner');
      expect(banner).toHaveTextContent('当前浏览器不支持此音视频格式或媒体源不可用');
      expect(showGlobalNotificationMock).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('当前浏览器不支持此音视频格式或媒体源不可用'),
        '音视频播放失败',
      );

      // Also verify code 3 decode error message helper
      expect(
        describeMediaPlaybackError({ mediaError: { code: 3, message: '' } }),
      ).toContain('音视频解码失败');
    } finally {
      HTMLMediaElement.prototype.play = origPlay;
    }
  });

  it('surfaces a visible error instead of silent no-op when media src is missing on play click', async () => {
    dstuGetMock.mockResolvedValue({
      ok: true,
      value: { ...SAMPLE_VIDEO_NODE, id: 'file_missing_src' },
    });

    render(
      <MediaStudyPage
        resourceId="file_missing_src"
        isActive
        isSmallScreen
        titlebarTarget={null}
        onBack={vi.fn()}
      />,
    );

    await screen.findByTestId('mobile-study-video');
    await act(async () => {
      fireEvent.click(screen.getByTestId('central-play-btn'));
    });

    const banner = await screen.findByTestId('media-playback-error-banner');
    expect(banner).toHaveTextContent('未找到可播放的音视频地址');
    expect(showGlobalNotificationMock).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('未找到可播放的音视频地址'),
      '音视频播放失败',
    );
  });

  it('renders ContextualMiniChat expanded at the top of Ask tab on 360px with immediately visible input + Send button, native scroll, and compact mobile CSS rules', async () => {
    render(
      <MediaStudyPage
        resourceId="file_mobile_vid_1"
        isActive
        isSmallScreen
        titlebarTarget={null}
        onBack={vi.fn()}
      />,
    );

    await screen.findByTestId('mobile-study-video');
    fireEvent.click(screen.getByTestId('switch-to-ask-tab'));

    const miniChat = await screen.findByTestId('contextual-mini-chat');
    expect(miniChat).toBeVisible();

    const askHost = document.querySelector('[data-media-ask-composer-host]');
    expect(askHost).not.toBeNull();
    // Native scroll avoids hidden-tab OverlayScrollbars zero-height clipping when switching to "问答"
    const askScroll = document.querySelector('[data-media-study-tab="ask"] [data-native-scrollbars="true"]');
    expect(askScroll).not.toBeNull();

    const askInput = screen.getByRole('textbox', { name: '伴读提问输入框' });
    const sendBtn = screen.getByRole('button', { name: '发送伴读提问' });
    expect(askInput).toBeVisible();
    expect(sendBtn).toBeVisible();

    // Typing a question and clicking Send invokes LLM completion and renders direct grounded answer with ▶ 00:01 jump pill
    fireEvent.change(askInput, { target: { value: '波的相干条件是什么？' } });
    expect(sendBtn).not.toBeDisabled();
    fireEvent.click(sendBtn);
    await waitFor(() => {
      expect(screen.getByTestId('mini-chat-message-list')).toHaveTextContent(
        '频率相同、振动方向相同、相位差恒定',
      );
    });
    expect(screen.getByTestId('mini-chat-message-list')).toHaveTextContent('波的相干条件是什么？');
    expect(screen.getByRole('button', { name: '跳转到 00:01' })).toBeInTheDocument();

    // Verify MediaStudyPage.css keeps central Play circle at z-index: 30, lets disabled Play pass through,
    // compacts 360px audio + Ask tab layout, and adds @container rules for ~460px split windows
    const cssPath = path.resolve(__dirname, '../components/MediaStudyPage.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('[data-media-study] button.absolute.inset-0.z-10');
    expect(css).toContain('z-index: 30;');
    expect(css).toContain('pointer-events: none;');
    expect(css).toContain('[data-media-study] [data-media-study-tab="ask"] [data-testid="contextual-mini-chat"]');
    expect(css).toContain('max-height: 7.5rem;');
    expect(css).toContain('@container media-study (width <= 540px)');
  });
});
