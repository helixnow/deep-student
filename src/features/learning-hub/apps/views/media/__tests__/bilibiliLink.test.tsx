/**
 * B 站链接：IPC 封装（命令名 / 参数 / 归一化）、内嵌播放器地址、导入弹窗、内嵌播放器句柄。
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
  }),
}));

import {
  bilibiliLinkApi,
  buildBilibiliEmbedUrl,
  buildBilibiliPageUrl,
  isBilibiliLinkItem,
  normalizeLinkDescriptor,
  normalizeProbe,
  stripBilibiliExtension,
  type BilibiliLinkDescriptor,
} from '../bilibiliLinkApi';
import { BilibiliLinkDialog } from '../BilibiliLinkDialog';
import { BILIBILI_EMBED_SANDBOX, BilibiliEmbedPlayer } from '../BilibiliEmbedPlayer';
import type { MediaPlayerHandle, MediaPlayerStatus } from '../mediaPlayerHandle';

const PROBE = {
  bvid: 'BV1xx411c7mD',
  title: '线性代数',
  owner: '老师',
  cover: 'https://i1.hdslb.com/bfs/archive/cover.jpg',
  durationMs: 600_000,
  pages: [
    { page: 1, cid: 1001, part: '01 向量', durationMs: 300_000 },
    { page: 2, cid: 1002, part: '02 矩阵', durationMs: 300_000 },
  ],
  page: 2,
  tracks: [
    { lan: 'ai-zh', lanDoc: '中文（自动生成）', ai: true },
    { lan: 'zh-CN', lanDoc: '中文（中国）', ai: false },
  ],
  defaultLan: 'zh-CN',
  url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
  existingId: null,
};

const LINK: BilibiliLinkDescriptor = {
  bvid: 'BV1xx411c7mD',
  aid: 42,
  cid: 1002,
  page: 2,
  pageCount: 2,
  title: '线性代数',
  part: '02 矩阵',
  owner: '老师',
  cover: null,
  durationMs: 300_000,
  url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
};

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => cleanup());

describe('bilibiliLinkApi', () => {
  it('recognises link items and strips the display extension', () => {
    expect(isBilibiliLinkItem('video/x-bilibili', 'a')).toBe(true);
    expect(isBilibiliLinkItem('application/octet-stream', '课.BILIBILI')).toBe(true);
    expect(isBilibiliLinkItem('video/mp4', '课.mp4')).toBe(false);
    expect(stripBilibiliExtension('线代 P2.bilibili')).toBe('线代 P2');
    expect(stripBilibiliExtension('lecture.mp4')).toBe('lecture.mp4');
  });

  it('builds embed / page URLs and refuses anything that is not a BV id', () => {
    const embed = new URL(buildBilibiliEmbedUrl(LINK));
    expect(embed.origin).toBe('https://player.bilibili.com');
    expect(Object.fromEntries(embed.searchParams)).toEqual({
      isOutside: 'true',
      bvid: 'BV1xx411c7mD',
      p: '2',
      autoplay: '0',
      danmaku: '0',
    });
    const seek = new URL(buildBilibiliEmbedUrl(LINK, { startSeconds: 65.9, autoplay: true }));
    expect(seek.searchParams.get('t')).toBe('65');
    expect(seek.searchParams.get('autoplay')).toBe('1');
    expect(() => buildBilibiliEmbedUrl({ bvid: 'javascript:alert(1)', page: 1 })).toThrow();
    expect(buildBilibiliPageUrl(LINK, 90.4)).toBe('https://www.bilibili.com/video/BV1xx411c7mD?p=2&t=90');
    expect(buildBilibiliPageUrl(LINK)).toBe('https://www.bilibili.com/video/BV1xx411c7mD?p=2');
    expect(() => normalizeLinkDescriptor({ ...LINK, bvid: 'BV1"><img>' })).toThrow();
  });

  it('normalizes snake_case probe payloads', () => {
    const probe = normalizeProbe({
      ...PROBE,
      duration_ms: 1,
      durationMs: undefined,
      default_lan: 'ai-zh',
      defaultLan: undefined,
      existing_id: 'file_1',
      tracks: [{ lan: 'ai-zh', lan_doc: '中文（自动生成）', ai: true }, { lan: '' }],
    });
    expect(probe.durationMs).toBe(1);
    expect(probe.defaultLan).toBe('ai-zh');
    expect(probe.existingId).toBe('file_1');
    expect(probe.tracks).toEqual([{ lan: 'ai-zh', lanDoc: '中文（自动生成）', ai: true }]);
  });

  it('calls the contract command names and turns {code,message} errors into readable errors', async () => {
    invokeMock.mockResolvedValueOnce(PROBE);
    await bilibiliLinkApi.probe('BV1xx411c7mD');
    expect(invokeMock).toHaveBeenLastCalledWith('media_bilibili_probe', { input: 'BV1xx411c7mD', page: null });

    invokeMock.mockResolvedValueOnce({ fileId: 'file_9', name: 'x.bilibili', created: true, segments: 3 });
    await expect(bilibiliLinkApi.create('BV1xx411c7mD', 2, 'zh-CN')).resolves.toMatchObject({ fileId: 'file_9', created: true });
    expect(invokeMock).toHaveBeenLastCalledWith('media_bilibili_create', { input: 'BV1xx411c7mD', page: 2, lan: 'zh-CN' });

    invokeMock.mockResolvedValueOnce({ segments: [] });
    await bilibiliLinkApi.importSubtitle('file_1', 'BV1xx411c7mD');
    expect(invokeMock).toHaveBeenLastCalledWith('media_bilibili_import_subtitle', {
      resourceId: 'file_1',
      input: 'BV1xx411c7mD',
      page: null,
      lan: null,
    });

    invokeMock.mockRejectedValueOnce(JSON.stringify({ code: 'bilibili-no-subtitle', message: '这个视频没有可用字幕' }));
    await expect(bilibiliLinkApi.getLink('file_1')).rejects.toMatchObject({
      code: 'bilibili-no-subtitle',
      message: '这个视频没有可用字幕',
    });
  });
});

function respond(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected command ${command}`);
    return handler(args);
  });
}

describe('BilibiliLinkDialog', () => {
  it('create: looks up the link, preselects the default track and imports it', async () => {
    respond({
      media_bilibili_probe: () => PROBE,
      media_bilibili_create: () => ({ fileId: 'file_new', name: '线性代数 P2 02 矩阵.bilibili', created: true, segments: 12 }),
    });
    const onDone = vi.fn();
    const onOpenChange = vi.fn();
    render(<BilibiliLinkDialog open mode={{ kind: 'create' }} onOpenChange={onOpenChange} onDone={onDone} />);

    const confirm = document.querySelector('[data-bilibili-confirm]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const input = document.querySelector('[data-bilibili-link-input]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: ' https://www.bilibili.com/video/BV1xx411c7mD?p=2 ' } });
    fireEvent.click(screen.getByRole('button', { name: /learningHub:mediaBilibili.parse/ }));

    await waitFor(() => expect(document.querySelector('[data-bilibili-probe="BV1xx411c7mD"]')).toBeTruthy());
    expect(screen.getByText('线性代数')).toBeTruthy();
    expect(document.querySelector('[data-bilibili-page-select]')).toBeTruthy();
    expect(document.querySelector('[data-bilibili-track-select]')?.textContent).toContain('中文（中国）');

    fireEvent.click(confirm);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith('media_bilibili_create', {
      input: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
      page: 2,
      lan: 'zh-CN',
    });
    expect(onDone).toHaveBeenCalledWith({ fileId: 'file_new', created: true, segments: 12, name: '线性代数 P2 02 矩阵.bilibili' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('attach: imports into the given resource; no tracks keeps import disabled; errors are shown', async () => {
    respond({
      media_bilibili_probe: (args) =>
        String(args.input).includes('none')
          ? { ...PROBE, tracks: [], defaultLan: null }
          : String(args.input).includes('bad')
            ? Promise.reject(JSON.stringify({ code: 'bilibili-invalid-link', message: '没有认出 B 站视频链接' }))
            : PROBE,
      media_bilibili_import_subtitle: () => ({
        status: 'completed',
        segments: [
          { idx: 0, startMs: 0, endMs: 1000, text: '一', status: 1 },
          { idx: 1, startMs: 1000, endMs: 2000, text: '二', status: 1 },
        ],
      }),
    });
    const onDone = vi.fn();
    render(
      <BilibiliLinkDialog
        open
        mode={{ kind: 'attach', resourceId: 'file_local', name: 'lecture.mp4' }}
        onOpenChange={vi.fn()}
        onDone={onDone}
      />,
    );
    const input = document.querySelector('[data-bilibili-link-input]') as HTMLInputElement;
    const parse = screen.getByRole('button', { name: /learningHub:mediaBilibili.parse/ });
    const confirm = document.querySelector('[data-bilibili-confirm]') as HTMLButtonElement;

    fireEvent.change(input, { target: { value: 'bad link' } });
    fireEvent.click(parse);
    await waitFor(() => expect(document.querySelector('[data-bilibili-error]')?.textContent).toBe('没有认出 B 站视频链接'));

    fireEvent.change(input, { target: { value: 'BV1xx411c7mD none' } });
    fireEvent.click(parse);
    await waitFor(() => expect(document.querySelector('[data-bilibili-no-tracks]')).toBeTruthy());
    expect(document.querySelector('[data-bilibili-error]')).toBeNull();
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'BV1xx411c7mD' } });
    fireEvent.click(parse);
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith('media_bilibili_import_subtitle', {
      resourceId: 'file_local',
      input: 'BV1xx411c7mD',
      page: 2,
      lan: 'zh-CN',
    });
    expect(onDone).toHaveBeenCalledWith({ fileId: 'file_local', created: false, segments: 2, name: 'lecture.mp4' });
  });

  it('refetch: the link is fixed and looked up as soon as the dialog opens', async () => {
    respond({ media_bilibili_probe: () => PROBE });
    render(
      <BilibiliLinkDialog
        open
        mode={{ kind: 'refetch', resourceId: 'file_link', name: '线性代数', url: LINK.url, page: 2 }}
        onOpenChange={vi.fn()}
      />,
    );
    expect((document.querySelector('[data-bilibili-link-input]') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: /learningHub:mediaBilibili.parse/ })).toBeNull();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('media_bilibili_probe', { input: LINK.url, page: 2 }));
  });
});

describe('BilibiliEmbedPlayer', () => {
  it('embeds the sandboxed player, seeks by reloading with t=, and unmounts when hidden', () => {
    const handleRef: React.MutableRefObject<MediaPlayerHandle | null> = { current: null };
    const statuses: MediaPlayerStatus[] = [];
    const { rerender } = render(
      <BilibiliEmbedPlayer link={LINK} handleRef={handleRef} onStatusChange={(s) => statuses.push(s)} />,
    );
    const frame = () => document.querySelector('[data-bilibili-frame]') as HTMLIFrameElement | null;
    expect(frame()!.getAttribute('sandbox')).toBe(BILIBILI_EMBED_SANDBOX);
    expect(BILIBILI_EMBED_SANDBOX).not.toContain('allow-top-navigation');
    expect(BILIBILI_EMBED_SANDBOX).not.toContain('allow-popups');
    expect(new URL(frame()!.src).searchParams.get('t')).toBeNull();
    expect(statuses.at(-1)).toMatchObject({ isReady: false, duration: 300 });

    fireEvent.load(frame()!);
    expect(statuses.at(-1)).toMatchObject({ isReady: true, currentTime: 0 });
    expect(handleRef.current?.getElement()).toBeNull();

    act(() => {
      handleRef.current!.seekTo(65.7);
      handleRef.current!.play();
    });
    const url = new URL(frame()!.src);
    expect(url.searchParams.get('t')).toBe('65');
    expect(url.searchParams.get('autoplay')).toBe('1');
    expect(statuses.at(-1)).toMatchObject({ currentTime: 65.7, isReady: true });

    // 超出时长：钳到结尾
    act(() => handleRef.current!.seekTo(10_000));
    expect(new URL(frame()!.src).searchParams.get('t')).toBe('300');

    rerender(<BilibiliEmbedPlayer link={LINK} handleRef={handleRef} isActive={false} />);
    expect(frame()).toBeNull();
    expect(document.querySelector('[data-bilibili-player]')?.textContent).toContain('线性代数');
  });
});
