import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const openPathMock = vi.fn();
const revealItemInDirMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: (...args: unknown[]) => openPathMock(...args),
  revealItemInDir: (...args: unknown[]) => revealItemInDirMock(...args),
}));

import {
  EXTERNAL_OPEN_UNSUPPORTED,
  canOpenFilesExternally,
  canRevealInFolder,
  openFileExternally,
  revealFileOrOpen,
  shareFileExternally,
} from '../systemFileOpener';

function stubNavigator(platform: string, userAgent: string, maxTouchPoints = 0): void {
  vi.stubGlobal('navigator', { platform, userAgent, maxTouchPoints });
}

const DESKTOP = ['MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 0] as const;
const ANDROID = ['Linux armv8l', 'Mozilla/5.0 (Linux; Android 15; wv)', 5] as const;
const IPHONE = ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', 5] as const;

describe('systemFileOpener', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openPathMock.mockReset();
    revealItemInDirMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('desktop keeps using the opener plugin', async () => {
    stubNavigator(...DESKTOP);
    expect(canRevealInFolder()).toBe(true);
    expect(canOpenFilesExternally()).toBe(true);

    await expect(openFileExternally('/tmp/a.pptx')).resolves.toBe('open');
    expect(openPathMock).toHaveBeenCalledWith('/tmp/a.pptx');

    await expect(revealFileOrOpen('/tmp/a.pptx')).resolves.toBe('reveal');
    expect(revealItemInDirMock).toHaveBeenCalledWith('/tmp/a.pptx');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('Android routes open/reveal/share through the native command, never the opener', async () => {
    stubNavigator(...ANDROID);
    expect(canRevealInFolder()).toBe(false);
    expect(canOpenFilesExternally()).toBe(true);

    invokeMock.mockResolvedValueOnce('view');
    await expect(openFileExternally('/data/app/files/a.pptx')).resolves.toBe('view');
    expect(invokeMock).toHaveBeenLastCalledWith('open_file_externally', {
      path: '/data/app/files/a.pptx',
      mode: 'view',
    });

    // 无应用可打开时原生侧回退分享面板
    invokeMock.mockResolvedValueOnce('share');
    await expect(revealFileOrOpen('content://x/document/1')).resolves.toBe('share');
    expect(invokeMock).toHaveBeenLastCalledWith('open_file_externally', {
      path: 'content://x/document/1',
      mode: 'view',
    });

    invokeMock.mockResolvedValueOnce('share');
    await expect(shareFileExternally('/data/app/cache/shared/d/x.zip')).resolves.toBe('share');
    expect(invokeMock).toHaveBeenLastCalledWith('open_file_externally', {
      path: '/data/app/cache/shared/d/x.zip',
      mode: 'share',
    });

    expect(openPathMock).not.toHaveBeenCalled();
    expect(revealItemInDirMock).not.toHaveBeenCalled();
  });

  it('iOS reports unsupported instead of calling the broken opener', async () => {
    stubNavigator(...IPHONE);
    expect(canOpenFilesExternally()).toBe(false);
    await expect(openFileExternally('/x')).rejects.toThrow(EXTERNAL_OPEN_UNSUPPORTED);
    await expect(revealFileOrOpen('/x')).rejects.toThrow(EXTERNAL_OPEN_UNSUPPORTED);
    expect(openPathMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
