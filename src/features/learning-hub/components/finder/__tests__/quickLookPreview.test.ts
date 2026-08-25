/**
 * Quick Look 可视预览解析 / 加载测试
 *
 * resolver 为纯函数直接断言；loader 通过 mock Tauri invoke 与 vfsRagApi
 * 验证图片双路径回退（blob 直读 → base64 附件）与 PDF 首页 data URL。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const getPdfPageImageDataUrlMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/vfsRagApi', () => ({
  getPdfPageImageDataUrl: getPdfPageImageDataUrlMock,
}));

import {
  loadQuickLookVisual,
  resolveImageMime,
  resolveQuickLookVisual,
} from '../quickLookPreview';

function node(overrides: Partial<Parameters<typeof resolveQuickLookVisual>[0]> = {}) {
  return {
    id: 'file_1',
    name: 'photo.png',
    type: 'file' as const,
    previewType: undefined,
    resourceId: undefined,
    metadata: undefined,
    ...overrides,
  };
}

describe('resolveQuickLookVisual', () => {
  it('图片：type=image / previewType=image / 图片扩展名任一命中', () => {
    expect(resolveQuickLookVisual(node({ type: 'image', name: 'x' }))).toBe('image');
    expect(resolveQuickLookVisual(node({ name: 'x.bin', previewType: 'image' }))).toBe('image');
    expect(resolveQuickLookVisual(node({ name: 'IMG_001.JPG' }))).toBe('image');
    expect(resolveQuickLookVisual(node({ name: 'scan.webp' }))).toBe('image');
  });

  it('PDF：previewType=pdf / 教材 / .pdf 附件', () => {
    expect(resolveQuickLookVisual(node({ name: 'x.bin', previewType: 'pdf' }))).toBe('pdf');
    expect(resolveQuickLookVisual(node({ type: 'textbook', name: '高数' }))).toBe('pdf');
    expect(resolveQuickLookVisual(node({ name: 'paper.pdf' }))).toBe('pdf');
  });

  it('文件夹与无扩展名普通文件无可视预览', () => {
    expect(resolveQuickLookVisual(node({ type: 'folder', name: '资料' }))).toBeNull();
    expect(resolveQuickLookVisual(node({ name: 'notes.docx' }))).toBeNull();
    expect(resolveQuickLookVisual(node({ name: 'README' }))).toBeNull();
    // 末尾点号不算扩展名
    expect(resolveQuickLookVisual(node({ name: 'weird.' }))).toBeNull();
  });

  it('resolveImageMime：metadata.mimeType 优先，回退扩展名，最后 image/png', () => {
    expect(resolveImageMime(node({ metadata: { mimeType: 'image/webp' } }))).toBe('image/webp');
    expect(resolveImageMime(node({ name: 'a.jpg' }))).toBe('image/jpeg');
    expect(resolveImageMime(node({ name: 'noext' }))).toBe('image/png');
    // 非 image/ 前缀的 mimeType 不采信
    expect(resolveImageMime(node({ name: 'a.gif', metadata: { mimeType: 'application/pdf' } }))).toBe('image/gif');
  });
});

describe('loadQuickLookVisual', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    getPdfPageImageDataUrlMock.mockReset();
    // jsdom 未实现 createObjectURL：直接挂 mock（只增静态方法，不替换构造器）
    URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    URL.revokeObjectURL = vi.fn();
  });

  it('图片：blob 直读成功 → ObjectURL（isObjectUrl=true）', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'vfs_get_file_blob_path') return '/data/blobs/abc';
      if (cmd === 'read_file_bytes') return new ArrayBuffer(16);
      throw new Error(`unexpected: ${cmd}`);
    });

    const result = await loadQuickLookVisual(node());
    expect(result).toEqual({ kind: 'image', url: 'blob:mock-url', isObjectUrl: true });
    expect(invokeMock).toHaveBeenCalledWith('vfs_get_file_blob_path', { id: 'file_1' });
    expect(invokeMock).toHaveBeenCalledWith('read_file_bytes', { path: '/data/blobs/abc' });
  });

  it('图片：blob 路径缺失时回退 base64 附件内容', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'vfs_get_file_blob_path') return null;
      if (cmd === 'vfs_get_attachment_content') {
        return { content: 'aGVsbG8=', found: true };
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    const result = await loadQuickLookVisual(node());
    expect(result?.kind).toBe('image');
    expect(result?.isObjectUrl).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('vfs_get_attachment_content', { attachmentId: 'file_1' });
  });

  it('图片：双路径全部失败返回 null（回退图标，不抛错）', async () => {
    invokeMock.mockRejectedValue(new Error('backend down'));
    await expect(loadQuickLookVisual(node())).resolves.toBeNull();
  });

  it('PDF：按 resourceId 优先取首页 data URL（isObjectUrl=false）', async () => {
    getPdfPageImageDataUrlMock.mockResolvedValue('data:image/png;base64,xxx');
    const result = await loadQuickLookVisual(
      node({ type: 'textbook', name: '高数', resourceId: 'res_tb1' }),
    );
    expect(result).toEqual({
      kind: 'pdf',
      url: 'data:image/png;base64,xxx',
      isObjectUrl: false,
    });
    expect(getPdfPageImageDataUrlMock).toHaveBeenCalledWith('res_tb1', 0);
  });

  it('PDF：无 resourceId 回退节点 id；后端抛错返回 null', async () => {
    getPdfPageImageDataUrlMock.mockResolvedValue('data:image/png;base64,yyy');
    await loadQuickLookVisual(node({ name: 'paper.pdf', id: 'file_pdf' }));
    expect(getPdfPageImageDataUrlMock).toHaveBeenCalledWith('file_pdf', 0);

    getPdfPageImageDataUrlMock.mockRejectedValue(new Error('no page image'));
    await expect(
      loadQuickLookVisual(node({ name: 'paper.pdf' })),
    ).resolves.toBeNull();
  });

  it('无可视预览类型直接返回 null 且不触达后端', async () => {
    await expect(loadQuickLookVisual(node({ type: 'folder', name: 'x' }))).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(getPdfPageImageDataUrlMock).not.toHaveBeenCalled();
  });
});
