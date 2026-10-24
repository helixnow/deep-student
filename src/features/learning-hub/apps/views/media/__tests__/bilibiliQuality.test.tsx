/**
 * B 站链接条目的应用内清晰度：
 * - 后端回报的可选档位进控制条菜单（短名、当前档打勾），非 B 站条目不显示；
 * - 选一档 → 记为全局偏好、播放地址带新 qn，新播放器就绪后回到原位置并保持播放 / 暂停；
 * - 下次打开（任意条目）按偏好请求；登录 / 退出后账号代次 +1 换新地址；
 * - B 站降档时提示实际清晰度；外链播放器提示以游客身份播放。
 */
import React, { useImperativeHandle } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
type FakeVideoProps = {
  src: string;
  onError: () => void;
  onStatusChange?: (s: { currentTime: number; duration: number; isPlaying: boolean; isReady: boolean }) => void;
  handleRef?: React.Ref<unknown>;
  quality?: { options: Array<{ value: number; label: string }>; value: number; onChange: (v: number) => void } | null;
};
const video = vi.hoisted(() => ({
  props: null as null | FakeVideoProps,
  seekTo: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  mounts: 0,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${encodeURIComponent(path)}`,
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options?.quality ? `${key}:${String(options.quality)}` : key),
    i18n: { language: 'zh-CN' },
  }),
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: notify }));
vi.mock('../VideoPlayer', () => ({
  VideoPlayer: function FakeVideo(props: FakeVideoProps) {
    video.props = props;
    useImperativeHandle(props.handleRef, () => ({
      getElement: () => null,
      seekTo: video.seekTo,
      play: video.play,
      pause: video.pause,
    }));
    React.useEffect(() => {
      video.mounts += 1;
      props.onStatusChange?.({ currentTime: 0, duration: 0, isPlaying: false, isReady: false });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="video-player" data-src={props.src} />;
  },
}));
vi.mock('../BilibiliEmbedPlayer', () => ({ BilibiliEmbedPlayer: () => <div data-testid="bilibili-embed" /> }));
vi.mock('../AudioPlayer', () => ({ AudioPlayer: () => <div data-testid="audio-player" /> }));
vi.mock('../useMediaTranscript', () => ({
  useMediaTranscript: () => ({
    transcript: null,
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
vi.mock('@/features/media-handout', () => ({ HandoutGenerateButton: () => null }));
vi.mock('@/features/learning-hub/useReferenceToChat', () => ({ useReferenceToChat: () => ({ referenceToChat: vi.fn() }) }));
vi.mock('@/features/chat/context/vfsRefApi', () => ({ uploadAttachmentBlob: vi.fn() }));
vi.mock('@/features/media-studio/mediaStudioNavigation', () => ({ openMediaStudio: vi.fn() }));

import { MediaStudyView } from '../MediaStudyView';
import { QualityMenu } from '../QualityMenu';
import { useBilibiliQuality } from '../useBilibiliQuality';
import {
  getBilibiliQualityPreference,
  refreshBilibiliAccount,
  resetBilibiliAccountForTests,
  setBilibiliAccount,
  shortQualityLabel,
} from '../bilibiliAccount';

const LINK = {
  kind: 'bilibili', version: 1, bvid: 'BV1xx411c7mD', aid: 1, cid: 2, page: 1, pageCount: 1,
  title: '线代', part: '', owner: null, cover: null, durationMs: 60_000, url: 'https://www.bilibili.com/video/BV1xx411c7mD',
};
const OPTIONS = [
  { qn: 80, label: '高清 1080P' },
  { qn: 64, label: '高清 720P' },
  { qn: 16, label: '流畅 360P' },
];
const ACCOUNT = { loggedIn: false, mid: null, uname: null, face: null, vip: false, verified: true, expired: false };

/** 后端：B 站给不高于请求的最高可用档 */
function qualityBackend(available = OPTIONS) {
  invokeMock.mockImplementation(async (cmd: string, args: { qn: number }) => {
    if (cmd === 'media_bilibili_auth_status') return ACCOUNT;
    if (cmd !== 'media_bilibili_stream_quality') throw new Error(`unexpected ${cmd}`);
    const current = available.find((o) => o.qn <= args.qn)?.qn ?? available[available.length - 1].qn;
    return { requested: args.qn, current, options: available };
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    this.cb([{ contentRect: { width: 1200 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect() {}
  unobserve() {}
}

function renderLink(resourceId = 'file_link') {
  return render(
    <MediaStudyView kind="video" src="" bilibili={LINK as never} resourceId={resourceId} fileName="线代.bilibili" onError={vi.fn()} />,
  );
}

function status(currentTime: number, isPlaying: boolean, isReady = true) {
  act(() => video.props?.onStatusChange?.({ currentTime, duration: 600, isPlaying, isReady }));
}

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  window.localStorage.clear();
  resetBilibiliAccountForTests();
  invokeMock.mockReset();
  notify.mockReset();
  video.props = null;
  video.mounts = 0;
  video.seekTo.mockReset();
  video.play.mockReset();
  video.pause.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Linux Bilibili source', () => {
  it('waits for the loopback URL and replaces it when quality changes', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15');
    invokeMock.mockImplementation(async (cmd: string, args: { qn: number }) => {
      if (cmd !== 'media_bilibili_stream_quality') return undefined;
      return { requested: args.qn, current: args.qn, options: OPTIONS, streamUrl: `http://127.0.0.1:12345/deepstudent-bili-stream/v1/file_link?qn=${args.qn}&s=fixture` };
    });
    const { result } = renderHook(() => useBilibiliQuality('file_link'));
    expect(result.current.streamUrl).toBeNull();
    await flush();
    expect(result.current.streamUrl).toContain('http://127.0.0.1:12345/deepstudent-bili-stream/v1/');
    act(() => result.current.select(64));
    expect(result.current.streamUrl).toBeNull();
    await flush();
    expect(result.current.streamUrl).toContain('qn=64');
  });

  it('keeps Android on the existing custom protocol', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 16; wv)');
    qualityBackend();
    const { result } = renderHook(() => useBilibiliQuality('file_link'));
    expect(result.current.streamUrl).toBe('bilistream://localhost/file_link?qn=80&a=1');
    await flush();
    expect(result.current.streamUrl).toBe('bilistream://localhost/file_link?qn=80&a=1');
  });
});

describe('shortQualityLabel', () => {
  it('keeps the resolution part of Bilibili labels', () => {
    expect(shortQualityLabel({ qn: 80, label: '高清 1080P' })).toBe('1080P');
    expect(shortQualityLabel({ qn: 16, label: '流畅 360P' })).toBe('360P');
    expect(shortQualityLabel({ qn: 74, label: '高清 720P60' })).toBe('720P60');
    expect(shortQualityLabel({ qn: 1, label: '自定义' })).toBe('自定义');
  });
});

describe('QualityMenu', () => {
  it('shows the current quality and reports a different choice', () => {
    const onChange = vi.fn();
    render(
      <QualityMenu
        options={[{ value: 80, label: '1080P' }, { value: 64, label: '720P' }]}
        value={64}
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'learningHub:mediaBilibili.playback.quality: 720P' });
    expect(trigger.textContent).toBe('720P');
    fireEvent.click(trigger);
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((el) => el.textContent)).toEqual(['1080P', '720P']);
    expect(items[1].getAttribute('aria-checked')).toBe('true');
    // 选当前档不触发
    fireEvent.click(items[1]);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    fireEvent.click(screen.getAllByRole('menuitemradio')[0]);
    expect(onChange).toHaveBeenCalledWith(80);
  });
});

describe('MediaStudyView · Bilibili quality', () => {
  it('retries failed in-app playback with a new source and cache attempt', async () => {
    qualityBackend();
    render(<MediaStudyView kind="video" src="" bilibili={LINK as never} resourceId="file_link" fileName="lecture.bilibili" onError={vi.fn()} />);
    await flush();
    const first = video.props!.src;
    act(() => video.props!.onError());
    expect(screen.queryByTestId('bilibili-embed')).toBeNull();
    expect(document.querySelector('[data-bilibili-stream-error]')).toBeTruthy();
    fireEvent.click(screen.getByText('learningHub:mediaBilibili.playback.retry'));
    await flush();
    expect(video.props!.src).not.toBe(first);
    expect(video.props!.src).toContain('a=2');
    expect(invokeMock).toHaveBeenLastCalledWith('media_bilibili_stream_quality', { fileId: 'file_link', qn: 80, epoch: 0, attempt: 2 });
  });
  it('defaults to the highest quality and lists what the backend can play', async () => {
    qualityBackend();
    renderLink();
    expect(video.props?.src).toBe('bilistream://localhost/file_link?qn=80&a=1');
    await flush();
    expect(invokeMock).toHaveBeenCalledWith('media_bilibili_stream_quality', { fileId: 'file_link', qn: 80, epoch: 0, attempt: 1 });
    expect(video.props?.quality?.value).toBe(80);
    expect(video.props?.quality?.options).toEqual([
      { value: 80, label: '1080P' },
      { value: 64, label: '720P' },
      { value: 16, label: '360P' },
    ]);
  });

  it('switching keeps the position and play state, and is remembered for the next item', async () => {
    qualityBackend();
    renderLink();
    await flush();
    status(0, false, false);
    status(42.5, true);
    const mountsBefore = video.mounts;

    act(() => video.props?.quality?.onChange(64));
    expect(video.props?.src).toBe('bilistream://localhost/file_link?qn=64&a=1');
    expect(video.mounts).toBe(mountsBefore + 1);
    expect(getBilibiliQualityPreference()).toBe(64);
    await flush();
    expect(video.props?.quality?.value).toBe(64);
    expect(notify).not.toHaveBeenCalled();

    // 新播放器就绪 → 回到 42.5s 并继续播放
    expect(video.seekTo).not.toHaveBeenCalled();
    status(0, false, true);
    expect(video.seekTo).toHaveBeenCalledWith(42.5);
    expect(video.play).toHaveBeenCalledTimes(1);

    // 暂停状态下切换：恢复位置但不自动播放
    status(50, false);
    act(() => video.props?.quality?.onChange(16));
    status(0, false, true);
    expect(video.seekTo).toHaveBeenLastCalledWith(50);
    expect(video.play).toHaveBeenCalledTimes(1);

    // 偏好是全局的：另一个条目按 360P 请求
    cleanup();
    renderLink('file_other');
    expect(video.props?.src).toBe('bilistream://localhost/file_other?qn=16&a=2');
  });

  it('tells the user when Bilibili downgrades the chosen quality', async () => {
    // 列表里有 1080P，但这次请求被降到 720P（例如会话刚失效）
    invokeMock.mockImplementation(async (_cmd: string, args: { qn: number }) => ({
      requested: args.qn,
      current: args.qn === 80 ? 64 : args.qn,
      options: OPTIONS,
    }));
    window.localStorage.setItem('media.bilibili.preferredQn', '16');
    renderLink();
    await flush();
    act(() => video.props?.quality?.onChange(80));
    await flush();
    expect(notify).toHaveBeenCalledWith('info', 'learningHub:mediaBilibili.playback.qualityDowngraded:720P');
  });

  it('requests a fresh source when reselecting 1080P after the default request was downgraded', async () => {
    let current = 64;
    invokeMock.mockImplementation(async (cmd: string, args: { qn: number }) => {
      if (cmd === 'media_bilibili_auth_status') return ACCOUNT;
      if (cmd === 'media_bilibili_stream_quality') return { requested: args.qn, current, options: OPTIONS };
      throw new Error(`unexpected ${cmd}`);
    });
    renderLink();
    await flush();
    expect(video.props?.quality?.value).toBe(64);
    status(42.5, true);
    const first = video.props!.src;

    act(() => video.props?.quality?.onChange(80));
    await flush();
    expect(video.props?.src).not.toBe(first);
    expect(video.props?.src).toBe('bilistream://localhost/file_link?qn=80&a=2');
    expect(invokeMock).toHaveBeenLastCalledWith('media_bilibili_stream_quality', { fileId: 'file_link', qn: 80, epoch: 0, attempt: 2 });
    expect(getBilibiliQualityPreference()).toBe(80);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith('info', 'learningHub:mediaBilibili.playback.qualityDowngraded:720P');
    status(0, false, true);
    expect(video.seekTo).toHaveBeenLastCalledWith(42.5);
    expect(video.play).toHaveBeenCalledTimes(1);

    status(50, false);
    current = 80;
    act(() => video.props?.quality?.onChange(80));
    await flush();
    expect(video.props?.src).toBe('bilistream://localhost/file_link?qn=80&a=3');
    expect(video.props?.quality?.value).toBe(80);
    status(0, false, true);
    expect(video.seekTo).toHaveBeenLastCalledWith(50);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('logging in bumps the account epoch so a fresh address (and quality list) is used', async () => {
    qualityBackend([{ qn: 64, label: '高清 720P' }, { qn: 16, label: '流畅 360P' }]);
    renderLink();
    await flush();
    expect(video.props?.quality?.value).toBe(64);
    status(0, false, false);
    status(30, true);
    // 账号面板先查到游客状态（不换代），再扫码登录成功（换代）
    await act(async () => {
      await refreshBilibiliAccount();
    });
    expect(video.props?.src).toBe('bilistream://localhost/file_link?qn=80&a=1');
    qualityBackend();
    act(() => setBilibiliAccount({ ...ACCOUNT, loggedIn: true, mid: 7 }));
    expect(video.props?.src).toBe('bilistream://localhost/file_link?qn=80&e=1&a=1');
    await flush();
    expect(invokeMock).toHaveBeenLastCalledWith('media_bilibili_stream_quality', { fileId: 'file_link', qn: 80, epoch: 1, attempt: 1 });
    // 换地址后同样续上位置
    status(0, false, true);
    expect(video.seekTo).toHaveBeenLastCalledWith(30);
    expect(video.props?.quality?.value).toBe(80);
  });

  it('no quality menu for local videos; the Bilibili player notes it plays as a guest', async () => {
    qualityBackend();
    render(<MediaStudyView kind="video" src="filestream://x" resourceId="file_local" fileName="a.mp4" onError={vi.fn()} />);
    await flush();
    expect(video.props?.quality ?? null).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
    cleanup();

    renderLink();
    await flush();
    fireEvent.click(screen.getByText('learningHub:mediaBilibili.playback.useEmbed'));
    expect(screen.getByTestId('bilibili-embed')).toBeTruthy();
    expect(document.querySelector('[data-bilibili-fallback]')?.textContent).toBe(
      'learningHub:mediaBilibili.playback.embedGuest',
    );
  });
});
