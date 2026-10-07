/**
 * MediaStudyView 伴随面板（音视频子应用学习页）：
 * - 宽容器（桌面）→ 播放器右侧分段面板；窄容器（手机 ≤767 / 窄窗）→ 播放器下方，
 *   视频 16:9 固定在上，字幕为默认分区，面板不可收起；
 * - 分区常驻挂载只切可见（讲义生成不因切换中止）；
 * - 无字幕时字幕分区给出「转写 / 导入字幕」；讲义入口移出工具栏；
 * - 无 context（资源库 / 聊天面板）保持原布局，并多一个「在音视频中学习」。
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transcriptState = vi.hoisted(() => ({
  transcript: null as null | { status: string; segments: unknown[]; progress: null },
}));
const openMediaStudio = vi.hoisted(() => vi.fn());
const lastVideo = vi.hoisted(() => ({ current: null as null | { src: string; onError: () => void } }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));
vi.mock('../VideoPlayer', () => ({
  VideoPlayer: (props: { src: string; onError: () => void }) => {
    lastVideo.current = props;
    return <div data-testid="video-player" data-src={props.src} />;
  },
}));
vi.mock('../BilibiliEmbedPlayer', () => ({ BilibiliEmbedPlayer: () => <div data-testid="bilibili-embed" /> }));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${path}`,
}));
vi.mock('../AudioPlayer', () => ({ AudioPlayer: () => <div data-testid="audio-player" /> }));
vi.mock('../useMediaTranscript', () => ({
  useMediaTranscript: () => ({
    transcript: transcriptState.transcript,
    loading: false,
    error: null,
    estimate: null,
    estimating: false,
    starting: false,
    cancelling: false,
    requestEstimate: vi.fn(),
    clearEstimate: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    refresh: vi.fn(),
    importFromPath: vi.fn(),
    exportToPath: vi.fn(),
  }),
}));
vi.mock('../useMediaProgressSync', () => ({
  useMediaProgressSync: () => ({ onStatus: vi.fn(), resumedFromRef: { current: null } }),
}));
vi.mock('../useTranscriptTrack', () => ({
  useTranscriptTrack: () => ({ trackSrc: null, trackRef: { current: null }, captionsOn: false, toggleCaptions: vi.fn() }),
}));
vi.mock('@/features/media-handout', () => ({
  HandoutGenerateButton: () => <div data-testid="toolbar-handout" />,
}));
vi.mock('@/features/learning-hub/useReferenceToChat', () => ({
  useReferenceToChat: () => ({ referenceToChat: vi.fn() }),
}));
vi.mock('@/features/chat/context/vfsRefApi', () => ({ uploadAttachmentBlob: vi.fn() }));
vi.mock('@/features/media-studio/mediaStudioNavigation', () => ({ openMediaStudio }));

import { MediaStudyView } from '../MediaStudyView';
import {
  MEDIA_STUDY_TRANSCRIPT_TAB,
  MediaStudyCompanionContext,
  type MediaStudyCompanionValue,
} from '../mediaStudyCompanion';

let observedWidth = 0;
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    this.cb([{ contentRect: { width: observedWidth } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect() {}
  unobserve() {}
}

function renderView(options: { width: number; companion?: Partial<MediaStudyCompanionValue> | null; kind?: 'audio' | 'video' }) {
  observedWidth = options.width;
  const onTab = vi.fn();
  const handoutRender = vi.fn(() => <div data-testid="handout-content" />);
  const companion: MediaStudyCompanionValue | null = options.companion === null ? null : {
    ariaLabel: 'study-tabs',
    activeTab: MEDIA_STUDY_TRANSCRIPT_TAB,
    onActiveTabChange: onTab,
    tabs: [
      { id: 'handout', label: '讲义', render: handoutRender },
      { id: 'ask', label: '问答', render: () => <div data-testid="ask-content" /> },
    ],
    ...options.companion,
  };
  const view = (
    <MediaStudyView kind={options.kind ?? 'video'} src="filestream://x" resourceId="file_lecture" fileName="L1.mp4" onError={vi.fn()} />
  );
  render(companion ? <MediaStudyCompanionContext.Provider value={companion}>{view}</MediaStudyCompanionContext.Provider> : view);
  return { onTab, handoutRender };
}

describe('MediaStudyView companion panel', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    transcriptState.transcript = null;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('desktop width: segmented rail beside the player, transcript tab first', () => {
    renderView({ width: 1100 });
    const rail = document.querySelector('[data-media-study-companion]');
    expect(rail?.getAttribute('data-media-study-companion')).toBe('side');
    const tabs = screen.getAllByRole('radio').map((el) => el.textContent);
    expect(tabs).toEqual(['learningHub:mediaTranscript.panelTitle', '讲义', '问答']);
    // 桌面可收起面板
    expect(screen.getByRole('button', { name: 'learningHub:mediaTranscript.hidePanel' })).toBeTruthy();
  });

  it('phone width: tabs under a pinned 16:9 video, transcript default, panel cannot be hidden', () => {
    renderView({ width: 400 });
    const rail = document.querySelector('[data-media-study-companion]');
    expect(rail?.getAttribute('data-media-study-companion')).toBe('bottom');
    expect(screen.getByTestId('video-player').parentElement?.className).toContain('aspect-video');
    expect(screen.queryByRole('button', { name: 'learningHub:mediaTranscript.hidePanel' })).toBeNull();
    const transcriptPane = document.querySelector(`[data-media-study-tab="${MEDIA_STUDY_TRANSCRIPT_TAB}"]`);
    expect(transcriptPane?.className).toContain('flex');
    expect(document.querySelector('[data-media-study-tab="handout"]')?.className).toContain('hidden');
  });

  it('keeps every tab mounted and only toggles visibility', () => {
    const { onTab, handoutRender } = renderView({ width: 400, companion: { activeTab: 'ask' } });
    expect(screen.getByTestId('handout-content')).toBeTruthy();
    expect(handoutRender).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'file_lecture', kind: 'video', hasTranscript: false }));
    expect(document.querySelector('[data-media-study-tab="ask"]')?.className).toContain('flex');
    fireEvent.click(screen.getByRole('radio', { name: '讲义' }));
    expect(onTab).toHaveBeenCalledWith('handout');
  });

  it('without a transcript the transcript tab offers transcribe and subtitle import; handout moves out of the toolbar', () => {
    renderView({ width: 400 });
    expect(screen.getByText('learningHub:mediaTranscript.emptyTitle')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /learningHub:mediaTranscript.import/ }).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('toolbar-handout')).toBeNull();
    expect(screen.queryByRole('button', { name: 'learningHub:mediaTranscript.openInStudio' })).toBeNull();
  });

  it('without the companion context (resource library / chat panel) keeps the original layout plus 在音视频中学习', () => {
    renderView({ width: 1100, companion: null });
    expect(document.querySelector('[data-media-study-companion]')).toBeNull();
    expect(screen.getByTestId('toolbar-handout')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'learningHub:mediaTranscript.openInStudio' }));
    expect(openMediaStudio).toHaveBeenCalledWith('file_lecture');
  });

describe('MediaStudyView · Bilibili link items', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    transcriptState.transcript = null;
    lastVideo.current = null;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const LINK = {
    kind: 'bilibili', version: 1, bvid: 'BV1xx411c7mD', aid: 1, cid: 2, page: 1, pageCount: 1,
    title: '线代', part: '', owner: null, cover: null, durationMs: 60_000, url: 'https://www.bilibili.com/video/BV1xx411c7mD',
  };

  it('plays the link in the app player and falls back to the Bilibili player on error', () => {
    observedWidth = 1200;
    render(
      <MediaStudyView kind="video" src="" bilibili={LINK as never} resourceId="file_link" fileName="线代.bilibili" onError={vi.fn()} />,
    );
    expect(screen.getByTestId('video-player').dataset.src).toBe('bilistream://localhost/file_link?qn=80');
    expect(screen.queryByTestId('bilibili-embed')).toBeNull();
    // 画面可用：截帧按钮在
    expect(screen.getByRole('button', { name: 'learningHub:mediaTranscript.captureFrame' })).toBeTruthy();

    act(() => lastVideo.current?.onError());
    expect(screen.getByTestId('bilibili-embed')).toBeTruthy();
    expect(document.querySelector('[data-bilibili-fallback]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'learningHub:mediaTranscript.captureFrame' })).toBeNull();

    fireEvent.click(screen.getByText('learningHub:mediaBilibili.playback.retry'));
    expect(screen.getByTestId('video-player')).toBeTruthy();
  });
});
});
