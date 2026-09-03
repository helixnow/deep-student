/**
 * useAppUpdater i18n regression tests
 *
 * 验证下载/安装失败路径的用户可见 error.message 来自 i18n key
 * （settings:about.update.error.*），不再包含硬编码中文文案。
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkMock, relaunchMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  relaunchMock: vi.fn(),
}));

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string) => key,
  },
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: checkMock,
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: relaunchMock,
}));

vi.mock('@/utils/platform', () => ({
  isMobilePlatform: () => false,
}));

vi.mock('@/utils/urlOpener', () => ({
  openLink: vi.fn(),
}));

import { useAppUpdater } from '@/hooks/useAppUpdater';

const CJK_PATTERN = /[\u4e00-\u9fff]/;

describe('useAppUpdater error message i18n', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // 关闭启动自动检查，避免测试期间的定时器副作用
    localStorage.setItem('ds-update-frequency', 'never');
  });

  it('uses the i18n unavailable key when check() finds no update before install', async () => {
    checkMock.mockResolvedValue(null);

    const { result } = renderHook(() => useAppUpdater());

    await act(async () => {
      await result.current.downloadAndInstall();
    });

    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(result.current.downloading).toBe(false);
    expect(result.current.error).toEqual({
      phase: 'unavailable',
      message: 'settings:about.update.error.unavailable',
    });
    expect(result.current.error!.message).not.toMatch(CJK_PATTERN);
  });

  it('uses the i18n relaunch key when relaunch() fails after install', async () => {
    checkMock.mockResolvedValue({
      version: '99.0.0',
      date: undefined,
      body: undefined,
      downloadAndInstall: vi.fn(async (onEvent: (event: any) => void) => {
        onEvent({ event: 'Started', data: { contentLength: 10 } });
        onEvent({ event: 'Progress', data: { chunkLength: 10 } });
        onEvent({ event: 'Finished' });
      }),
    });
    relaunchMock.mockRejectedValue(new Error('relaunch blocked'));

    const { result } = renderHook(() => useAppUpdater());

    await act(async () => {
      await result.current.downloadAndInstall();
    });

    expect(relaunchMock).toHaveBeenCalledTimes(1);
    expect(result.current.downloading).toBe(false);
    expect(result.current.progress).toBe(100);
    expect(result.current.error).toEqual({
      phase: 'relaunch',
      message: 'settings:about.update.error.relaunch',
    });
    expect(result.current.error!.message).not.toMatch(CJK_PATTERN);
  });

  it('uses the i18n relaunch key when a post-install error is thrown after Finished', async () => {
    checkMock.mockResolvedValue({
      version: '99.0.0',
      date: undefined,
      body: undefined,
      downloadAndInstall: vi.fn(async (onEvent: (event: any) => void) => {
        onEvent({ event: 'Started', data: { contentLength: 10 } });
        onEvent({ event: 'Progress', data: { chunkLength: 10 } });
        onEvent({ event: 'Finished' });
        throw new Error('app bundle replaced');
      }),
    });

    const { result } = renderHook(() => useAppUpdater());

    await act(async () => {
      await result.current.downloadAndInstall();
    });

    expect(relaunchMock).not.toHaveBeenCalled();
    expect(result.current.downloading).toBe(false);
    expect(result.current.error).toEqual({
      phase: 'relaunch',
      message: 'settings:about.update.error.relaunch',
    });
    expect(result.current.error!.message).not.toMatch(CJK_PATTERN);
  });
});
