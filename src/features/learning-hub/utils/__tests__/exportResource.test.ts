/**
 * exportResourceById 平台分支契约：
 * - Android 走与桌面相同的保存管线（dialogSave → content:// 目标），
 *   文件夹 ZIP（payloadType=file）经 saveFromSource/copy_file 写出；
 * - 成功提示展示建议文件名而非不透明 content:// URI；
 * - iOS 仍降级为复制 Markdown。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const exportFormatsMock = vi.hoisted(() => vi.fn());
const exportResourceMock = vi.hoisted(() => vi.fn());
const saveFromSourceMock = vi.hoisted(() => vi.fn());
const saveTextFileMock = vi.hoisted(() => vi.fn());
const saveBinaryFileMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const clipboardMock = vi.hoisted(() => vi.fn());

vi.mock('@/dstu', () => ({
  dstu: { exportFormats: exportFormatsMock, exportResource: exportResourceMock },
}));
vi.mock('@/utils/fileManager', () => ({
  fileManager: {
    saveFromSource: saveFromSourceMock,
    saveTextFile: saveTextFileMock,
    saveBinaryFile: saveBinaryFileMock,
  },
}));
vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: clipboardMock }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: notifyMock }));

import { exportResourceById, isExportUnsupportedPlatform } from '../exportResource';

const t = ((key: string, opts?: Record<string, unknown>) =>
  opts?.path ? `${key}:${String(opts.path)}` : key) as unknown as import('i18next').TFunction;

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

function setUserAgent(ua: string) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua);
}

describe('exportResourceById platform handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats Android as supported and iOS as unsupported', () => {
    setUserAgent(ANDROID_UA);
    expect(isExportUnsupportedPlatform()).toBe(false);
    setUserAgent(IOS_UA);
    expect(isExportUnsupportedPlatform()).toBe(true);
  });

  it('exports a folder ZIP on Android through saveFromSource to a content:// target', async () => {
    setUserAgent(ANDROID_UA);
    exportFormatsMock.mockResolvedValue({ ok: true, value: ['zip'] });
    exportResourceMock.mockResolvedValue({
      ok: true,
      value: {
        payloadType: 'file',
        tempPath: '/data/user/0/app/cache/tmp/dstu_folder_export_fld_1.zip',
        suggestedFilename: 'My Folder.zip',
      },
    });
    saveFromSourceMock.mockResolvedValue({
      canceled: false,
      path: 'content://com.android.providers.downloads.documents/document/446',
    });

    const ok = await exportResourceById('fld_1', t);

    expect(ok).toBe(true);
    expect(exportResourceMock).toHaveBeenCalledWith('/fld_1', 'zip');
    expect(saveFromSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: '/data/user/0/app/cache/tmp/dstu_folder_export_fld_1.zip',
        defaultFileName: 'My Folder.zip',
      }),
    );
    expect(clipboardMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith('success', 'contextMenu.exportSuccess:My Folder.zip');
  });

  it('exports binary resources (images) on Android via saveBinaryFile', async () => {
    setUserAgent(ANDROID_UA);
    exportFormatsMock.mockResolvedValue({ ok: true, value: ['original'] });
    exportResourceMock.mockResolvedValue({
      ok: true,
      value: { payloadType: 'binary', dataBase64: btoa('PNG'), suggestedFilename: 'photo.png' },
    });
    saveBinaryFileMock.mockResolvedValue({ canceled: false, path: 'content://x/document/9' });

    const ok = await exportResourceById('img_1', t);

    expect(ok).toBe(true);
    expect(saveBinaryFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultFileName: 'photo.png' }),
    );
  });

  it('keeps the iOS clipboard fallback for text resources', async () => {
    setUserAgent(IOS_UA);
    exportResourceMock.mockResolvedValue({
      ok: true,
      value: { payloadType: 'text', content: '# hi', suggestedFilename: 'n.md' },
    });
    clipboardMock.mockResolvedValue(true);

    const ok = await exportResourceById('tr_1', t);

    expect(ok).toBe(true);
    expect(clipboardMock).toHaveBeenCalledWith('# hi');
    expect(saveTextFileMock).not.toHaveBeenCalled();
  });
});
