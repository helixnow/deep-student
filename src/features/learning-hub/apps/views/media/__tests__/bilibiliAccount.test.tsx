/**
 * B 站账号（内联扫码登录）与链接条目的应用内播放：
 * - 未登录 → 扫码登录 → 轮询（已扫码 / 成功）→ 显示昵称；退出后回到未登录；二维码过期可刷新；
 * - 头像 <img> 的 referrerpolicy 先于 src（图床防盗链）；
 * - 链接条目默认用应用自己的播放器播 bilistream 地址，出错退回 B 站外链播放器并提示，可切回。
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${encodeURIComponent(path)}`,
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options?.name ? `${key}:${String(options.name)}` : key),
    i18n: { language: 'zh-CN' },
  }),
}));

import { BilibiliAccountPanel } from '../BilibiliAccountPanel';
import { buildBilibiliStreamUrl, resetBilibiliAccountForTests } from '../bilibiliAccount';

const LOGGED_OUT = { loggedIn: false, mid: null, uname: null, face: null, vip: false, verified: true, expired: false };
const LOGGED_IN = { loggedIn: true, mid: 42, uname: '学习者', face: 'https://i0.hdslb.com/bfs/face/a.jpg', vip: true, verified: true, expired: false };
const QR = { qrcodeKey: '0123456789abcdef0123456789abcdef', qrPng: 'data:image/png;base64,AAAA', expiresInSecs: 180 };

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('BilibiliAccountPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBilibiliAccountForTests();
    invokeMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('logs in by QR inline and then shows the account', async () => {
    const polls = [
      { state: 'scanned', status: null },
      { state: 'success', status: LOGGED_IN },
    ];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'media_bilibili_auth_status') return LOGGED_OUT;
      if (cmd === 'media_bilibili_login_qr_start') return QR;
      if (cmd === 'media_bilibili_login_qr_poll') return polls.shift();
      throw new Error(cmd);
    });
    render(<BilibiliAccountPanel />);
    await flush();
    expect(screen.getByText('learningHub:mediaBilibili.account.hint')).toBeTruthy();

    fireEvent.click(screen.getByText('learningHub:mediaBilibili.account.login'));
    await flush();
    expect(document.querySelector('[data-bilibili-qr] img')?.getAttribute('src')).toBe(QR.qrPng);
    expect(screen.getByText('learningHub:mediaBilibili.account.scanPrompt')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await flush();
    expect(invokeMock).toHaveBeenCalledWith('media_bilibili_login_qr_poll', { qrcodeKey: QR.qrcodeKey });
    expect(screen.getByText('learningHub:mediaBilibili.account.scanned')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await flush();
    expect(screen.getByText(/account.loggedIn:学习者/)).toBeTruthy();
    const face = document.querySelector('[data-bilibili-account="logged-in"] img') as HTMLImageElement;
    const attrs = [...face.attributes].map((a) => a.name);
    expect(attrs.indexOf('referrerpolicy')).toBeLessThan(attrs.indexOf('src'));

    invokeMock.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByText('learningHub:mediaBilibili.account.logout'));
    await flush();
    expect(invokeMock).toHaveBeenCalledWith('media_bilibili_logout');
    expect(screen.getByText('learningHub:mediaBilibili.account.hint')).toBeTruthy();
  });

  it('stops polling when the QR code expires and offers a refresh', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'media_bilibili_auth_status') return LOGGED_OUT;
      if (cmd === 'media_bilibili_login_qr_start') return QR;
      if (cmd === 'media_bilibili_login_qr_poll') return { state: 'expired', status: null };
      throw new Error(cmd);
    });
    render(<BilibiliAccountPanel />);
    await flush();
    fireEvent.click(screen.getByText('learningHub:mediaBilibili.account.login'));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await flush();
    expect(screen.getByText('learningHub:mediaBilibili.account.qrExpired')).toBeTruthy();
    const polled = invokeMock.mock.calls.filter(([cmd]) => cmd === 'media_bilibili_login_qr_poll').length;
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'media_bilibili_login_qr_poll').length).toBe(polled);
    fireEvent.click(screen.getByText('learningHub:mediaBilibili.account.refresh'));
    await flush();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'media_bilibili_login_qr_start').length).toBe(2);
  });

  it('says so when the stored session expired', async () => {
    invokeMock.mockResolvedValue({ ...LOGGED_OUT, expired: true });
    render(<BilibiliAccountPanel />);
    await flush();
    expect(screen.getByText('learningHub:mediaBilibili.account.expired')).toBeTruthy();
  });
});

describe('buildBilibiliStreamUrl', () => {
  it('points the in-app player at the bilistream protocol for the link item', () => {
    expect(buildBilibiliStreamUrl('file_abc')).toBe('bilistream://localhost/file_abc');
    expect(buildBilibiliStreamUrl('file_abc', 64)).toBe('bilistream://localhost/file_abc?qn=64');
    expect(buildBilibiliStreamUrl('file_abc', 80, 2)).toBe('bilistream://localhost/file_abc?qn=80&e=2');
  });
});
