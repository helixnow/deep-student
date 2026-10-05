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
import { BilibiliLinkDialog, summarizeBilibiliBatch, type BilibiliBatchSummary } from '../BilibiliLinkDialog';
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
    // 新建模式的多 P 视频：勾选清单，默认只勾链接里的那一 P → 仍是单个导入
    expect(document.querySelector('[data-bilibili-page-check="2"]')?.getAttribute('data-state')).toBe('checked');
    expect(document.querySelector('[data-bilibili-page-check="1"]')?.getAttribute('data-state')).toBe('unchecked');
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

const THREE_PARTS = {
  ...PROBE,
  pages: [
    { page: 1, cid: 1001, part: '01 向量', durationMs: 300_000 },
    { page: 2, cid: 1002, part: '02 矩阵', durationMs: 300_000 },
    { page: 3, cid: 1003, part: '03 行列式', durationMs: 300_000 },
  ],
};
const CANONICAL = 'https://www.bilibili.com/video/BV1xx411c7mD';
const errorPayload = (code: string, message: string) => Promise.reject(JSON.stringify({ code, message }));

async function lookUp(link = 'https://b23.tv/AbC123') {
  fireEvent.change(document.querySelector('[data-bilibili-link-input]') as HTMLInputElement, { target: { value: link } });
  fireEvent.click(screen.getByRole('button', { name: /learningHub:mediaBilibili.parse/ }));
  await waitFor(() => expect(document.querySelector('[data-bilibili-pages]')).toBeTruthy());
}

describe('BilibiliLinkDialog · multi-part batch', () => {
  it('lists parts with the linked one checked, imports every selected part in order and summarizes', async () => {
    respond({
      media_bilibili_probe: () => THREE_PARTS,
      media_bilibili_create: (args) =>
        args.page === 2
          ? errorPayload('bilibili-no-subtitle', '第 2 P没有可用字幕')
          : { fileId: `file_p${String(args.page)}`, name: 'x.bilibili', created: args.page === 1, segments: 10 },
    });
    const onDone = vi.fn();
    render(
      <BilibiliLinkDialog open mode={{ kind: 'create' }} onOpenChange={vi.fn()} onDone={onDone} batchIntervalMs={0} retryDelayMs={0} />,
    );
    await lookUp();
    const checked = () =>
      Array.from(document.querySelectorAll('[data-bilibili-page-check]'))
        .filter((el) => el.getAttribute('data-state') === 'checked')
        .map((el) => el.getAttribute('data-bilibili-page-check'));
    expect(checked()).toEqual(['2']);
    // 多 P：勾选清单代替单选下拉
    expect(document.querySelector('[data-bilibili-page-select]')).toBeNull();
    const confirm = document.querySelector('[data-bilibili-confirm]') as HTMLButtonElement;
    expect(confirm.textContent).toBe('learningHub:mediaBilibili.confirmCreate');

    fireEvent.click(document.querySelector('[data-bilibili-select-none]') as HTMLElement);
    expect(confirm.disabled).toBe(true);
    fireEvent.click(document.querySelector('[data-bilibili-select-all]') as HTMLElement);
    expect(checked()).toEqual(['1', '2', '3']);
    expect(confirm.textContent).toBe('learningHub:mediaBilibili.confirmBatch');

    fireEvent.click(confirm);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const creates = invokeMock.mock.calls.filter(([command]) => command === 'media_bilibili_create').map(([, args]) => args);
    expect(creates).toEqual([1, 2, 3].map((page) => ({ input: CANONICAL, page, lan: 'zh-CN' })));
    expect(onDone).toHaveBeenCalledWith({
      fileId: 'file_p1',
      created: true,
      segments: 20,
      name: '线性代数',
      batch: { total: 3, created: 1, updated: 1, skipped: [2], failed: [], remaining: 0 },
    });
  });

  it('retries a failed request once, then stops the batch and reports what is left', async () => {
    respond({
      media_bilibili_probe: () => THREE_PARTS,
      media_bilibili_create: () => errorPayload('bilibili-request-failed', 'B 站暂时拦截了请求（风控）'),
    });
    const onDone = vi.fn();
    render(
      <BilibiliLinkDialog open mode={{ kind: 'create' }} onOpenChange={vi.fn()} onDone={onDone} batchIntervalMs={0} retryDelayMs={0} />,
    );
    await lookUp();
    fireEvent.click(document.querySelector('[data-bilibili-select-all]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-bilibili-confirm]') as HTMLElement);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(invokeMock.mock.calls.filter(([command]) => command === 'media_bilibili_create')).toHaveLength(2);
    expect(onDone.mock.calls[0][0].batch).toEqual({
      total: 3,
      created: 0,
      updated: 0,
      skipped: [],
      failed: [{ page: 1, message: 'B 站暂时拦截了请求（风控）' }],
      remaining: 2,
    });
  });

  it('stop finishes the current part and leaves the rest', async () => {
    let release: () => void = () => {};
    respond({
      media_bilibili_probe: () => THREE_PARTS,
      media_bilibili_create: (args) =>
        new Promise((resolve) => {
          release = () => resolve({ fileId: `file_p${String(args.page)}`, name: 'x', created: true, segments: 5 });
        }),
    });
    const onDone = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <BilibiliLinkDialog open mode={{ kind: 'create' }} onOpenChange={onOpenChange} onDone={onDone} batchIntervalMs={0} retryDelayMs={0} />,
    );
    await lookUp();
    fireEvent.click(document.querySelector('[data-bilibili-select-all]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-bilibili-confirm]') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-bilibili-batch-progress]')?.textContent).toContain('learningHub:mediaBilibili.batchProgress'));

    fireEvent.click(document.querySelector('[data-bilibili-stop]') as HTMLElement);
    expect((document.querySelector('[data-bilibili-stop]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0].batch).toMatchObject({ created: 1, remaining: 2 });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('summarizes batch results with locale-appropriate separators and a capped page list', () => {
    const t = (key: string, options?: Record<string, unknown>) => `${key.split('.').pop()}(${JSON.stringify(options ?? {})})`;
    const summary: BilibiliBatchSummary = {
      total: 20,
      created: 8,
      updated: 1,
      skipped: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      failed: [{ page: 12, message: '超时' }],
      remaining: 8,
    };
    const zh = summarizeBilibiliBatch(summary, t, 'zh-CN');
    expect(zh.split('；')).toHaveLength(4);
    expect(zh).toContain('batchDone({"count":9})');
    expect(zh).toContain('"pages":"P2、P3、P4、P5、P6、P7、P8、P9 (+2)"');
    expect(zh).toContain('"message":"超时"');
    expect(zh).toContain('batchStopped({"count":8})');
    const en = summarizeBilibiliBatch({ ...summary, skipped: [2, 3], failed: [], remaining: 0 }, t, 'en-US');
    expect(en).toBe('batchDone({"count":9}); batchSkipped({"pages":"P2, P3"})');
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
