import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { loadQuestionImageUrls, QUESTION_IMAGE_LOAD_ERROR } from '../questionImageLoader';

describe('loadQuestionImageUrls', () => {
  it('每张图都有结果：成功给 data URL，未找到或调用被拒绝记为失败哨兵（#465）', async () => {
    const fetchContent = vi.fn(async (id: string) => {
      if (id === 'file_ok') return { content: 'QUJD', found: true };
      if (id === 'file_missing') return { content: null, found: false };
      throw new Error(`Invalid attachment ID format: ${id}`);
    });

    const urls = await loadQuestionImageUrls(
      [
        { id: 'file_ok', mime: 'image/jpeg' },
        { id: 'file_missing', mime: 'image/png' },
        { id: 'bad_id', mime: 'image/png' },
      ],
      fetchContent,
    );

    expect(urls).toEqual({
      file_ok: 'data:image/jpeg;base64,QUJD',
      file_missing: QUESTION_IMAGE_LOAD_ERROR,
      bad_id: QUESTION_IMAGE_LOAD_ERROR,
    });
  });

  it('默认经 vfs_get_attachment_content 取图', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockResolvedValueOnce({ content: 'eA==', found: true });

    const urls = await loadQuestionImageUrls([{ id: 'res_fig', mime: 'image/png' }]);

    expect(invoke).toHaveBeenCalledWith('vfs_get_attachment_content', { attachmentId: 'res_fig' });
    expect(urls.res_fig).toBe('data:image/png;base64,eA==');
  });
});
