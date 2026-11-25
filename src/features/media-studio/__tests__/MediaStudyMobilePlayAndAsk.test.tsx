import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DstuNode } from '@/dstu/types';
import { useMediaStudyCompanion } from '@/features/learning-hub/apps/views/media/mediaStudyCompanion';

const { dstuGetMock, useReferenceToChatMock, startMediaChatMock, stableT, stableI18n } =
  vi.hoisted(() => ({
    dstuGetMock: vi.fn(),
    useReferenceToChatMock: vi.fn(),
    startMediaChatMock: vi.fn(),
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
    return (
      <div data-testid="mock-mobile-media-view" style={{ width: '360px' }}>
        <div className="relative aspect-video w-full">
          <video data-testid="mobile-study-video" src={`filestream://${node.id}`} />
          <button
            type="button"
            aria-label="播放"
            data-testid="central-play-btn"
            className="absolute inset-0 z-10"
            onClick={(e) => {
              const vid = (e.currentTarget.parentElement?.querySelector('video') ??
                null) as HTMLVideoElement | null;
              void vid?.play().catch(() => undefined);
            }}
          >
            <span>Play</span>
          </button>
          <button
            type="button"
            aria-label="播放"
            disabled
            data-testid="disabled-premetadata-play-btn"
          >
            Disabled Play
          </button>
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
        {companion?.activeTab === 'ask' && askTab
          ? askTab.render({
              resourceId: node.id,
              kind: 'video',
              src: `filestream://${node.id}`,
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
    );
  },
}));

import { MediaStudyPage } from '../components/MediaStudyPage';

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

describe('MediaStudyPage 360px mobile play fallback & Ask tab visible input (S3-17)', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    dstuGetMock.mockResolvedValue({ ok: true, value: SAMPLE_VIDEO_NODE });
    useReferenceToChatMock.mockReturnValue({
      referenceToChat: vi.fn().mockResolvedValue({ success: true }),
    });
    startMediaChatMock.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
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

  it('surfaces a visible playback error banner with retry button (never silent no-op) when media fails or pre-metadata play is tapped', async () => {
    const origPlay = HTMLMediaElement.prototype.play;
    let shouldFail = true;
    let calls = 0;
    HTMLMediaElement.prototype.play = function mockFailThenPass() {
      calls += 1;
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

      // Even clicking a pre-metadata disabled Play button triggers MediaStudyPage's capture fallback!
      await act(async () => {
        fireEvent.click(screen.getByTestId('disabled-premetadata-play-btn'));
      });

      expect(calls).toBe(1);
      const errBanner = await screen.findByTestId('media-playback-error-banner');
      expect(errBanner).toHaveTextContent('Format not supported');

      // Clicking retry invokes play() again
      shouldFail = false;
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '重试' }));
      });
      expect(calls).toBe(2);
      expect(screen.queryByTestId('media-playback-error-banner')).toBeNull();
    } finally {
      HTMLMediaElement.prototype.play = origPlay;
    }
  });

  it('renders ContextualMiniChat expanded at the top of Ask tab on 360px with immediately visible input + Send button and z-30 central play CSS rule', async () => {
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

    const askInput = screen.getByRole('textbox', { name: '伴读提问输入框' });
    const sendBtn = screen.getByRole('button', { name: '发送伴读提问' });
    expect(askInput).toBeVisible();
    expect(sendBtn).toBeVisible();

    // Typing a question and clicking Send works immediately in-place on 360px
    fireEvent.change(askInput, { target: { value: '波的相干条件是什么？' } });
    expect(sendBtn).not.toBeDisabled();
    fireEvent.click(sendBtn);
    expect(screen.getByTestId('mini-chat-message-list')).toHaveTextContent('波的相干条件是什么？');
    expect(screen.getByTestId('mini-chat-message-list')).toHaveTextContent('本节讲解波的干涉与衍射条件');

    // Verify MediaStudyPage.css keeps central Play circle at z-index: 30 above bottom scrubber
    const cssPath = path.resolve(__dirname, '../components/MediaStudyPage.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('[data-media-study] button.absolute.inset-0.z-10');
    expect(css).toContain('z-index: 30;');
  });
});
