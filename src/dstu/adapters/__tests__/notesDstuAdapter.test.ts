import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const createMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('../../api', () => ({
  dstu: {
    create: createMock,
  },
}));

vi.mock('i18next', () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  },
}));

vi.mock('@/utils/fileManager', () => ({
  isGenericPlaceholderFileName: (name: string) => name === '文件' || name === 'File',
  isOpaqueDocumentId: (name: string) => {
    // 含冒号且冒号后全是数字
    const colonIdx = name.indexOf(':');
    if (colonIdx > 0) {
      const afterColon = name.slice(colonIdx + 1);
      if (afterColon.length > 0 && /^\d+$/.test(afterColon)) return true;
    }
    // 纯数字
    if (name.length > 0 && /^\d+$/.test(name)) return true;
    return false;
  },
}));

describe('notesDstuAdapter markdown import', async () => {
  const { notesDstuAdapter } = await import('../notesDstuAdapter');

  beforeEach(() => {
    invokeMock.mockReset();
    createMock.mockReset();
  });

  it('passes title hint and folder id to notes_import_markdown', async () => {
    invokeMock.mockResolvedValue({ id: 'note_1', name: 'Linear Algebra', type: 'note' });

    const result = await notesDstuAdapter.importMarkdownFile(
      'content://docs/tree/1',
      'Linear Algebra.md',
      'folder_123',
    );

    expect(result.ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('notes_import_markdown', {
      request: {
        filePath: 'content://docs/tree/1',
        titleHint: 'Linear Algebra.md',
        folderId: 'folder_123',
      },
    });
  });

  it('passes multiple files to notes_import_markdown_batch', async () => {
    invokeMock.mockResolvedValue({
      imported: [{ id: 'note_10', name: 'A', type: 'note' }],
      failed: [{ file_path: 'b.md', message: 'failed' }],
    });

    const result = await notesDstuAdapter.importMarkdownFiles([
      { filePath: 'a.md', titleHint: 'A.md' },
      { filePath: 'b.md', titleHint: 'B.md' },
    ], 'folder_batch');

    expect(result.ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('notes_import_markdown_batch', {
      request: {
        items: [
          { filePath: 'a.md', titleHint: 'A.md' },
          { filePath: 'b.md', titleHint: 'B.md' },
        ],
        folderId: 'folder_batch',
      },
    });
  });

  it('creates note from markdown content with normalized title and BOM-free content', async () => {
    createMock.mockResolvedValue({
      ok: true,
      value: { id: 'note_2', name: 'Motion', type: 'note' },
    });

    // 2026-10-02 (946e43abb)：开头 H1 作笔记标题、正文去掉这一行及其后空行，
    // 与路径导入 notes_import_markdown 同口径；BOM 在正文里被剔除。
    const result = await notesDstuAdapter.importMarkdownContent(
      'physics.markdown',
      '\uFEFF# Motion\n\ncontent',
      'folder_abc',
    );

    expect(result.ok).toBe(true);
    expect(createMock).toHaveBeenCalledWith('/', {
      type: 'note',
      name: 'Motion',
      content: 'content',
      metadata: { folderId: 'folder_abc' },
    });
  });

  it('uses the filename as title and strips BOM when markdown has no leading H1', async () => {
    createMock.mockResolvedValue({
      ok: true,
      value: { id: 'note_2b', name: 'physics', type: 'note' },
    });

    await notesDstuAdapter.importMarkdownContent(
      'physics.markdown',
      '\uFEFFcontent',
      'folder_abc',
    );

    expect(createMock).toHaveBeenCalledWith('/', {
      type: 'note',
      name: 'physics',
      content: 'content',
      metadata: { folderId: 'folder_abc' },
    });
  });

  it('falls back to untitled translation key when markdown filename is empty', async () => {
    createMock.mockResolvedValue({
      ok: true,
      value: { id: 'note_3', name: 'dstu:adapters.notes.untitled', type: 'note' },
    });

    await notesDstuAdapter.importMarkdownContent('', 'body');

    expect(createMock).toHaveBeenCalledWith('/', {
      type: 'note',
      name: 'dstu:adapters.notes.untitled',
      content: 'body',
      metadata: undefined,
    });
  });

  it('extracts H1 heading when filename is opaque document ID', async () => {
    createMock.mockResolvedValue({
      ok: true,
      value: { id: 'note_4', name: '线性代数笔记', type: 'note' },
    });

    await notesDstuAdapter.importMarkdownContent(
      '446',
      '# 线性代数笔记\n\n内容...',
    );

    expect(createMock).toHaveBeenCalledWith('/', expect.objectContaining({
      type: 'note',
      name: '线性代数笔记',
    }));
  });

  it('generates timestamp title when filename is generic placeholder and no H1', async () => {
    createMock.mockResolvedValue({
      ok: true,
      value: { id: 'note_5', name: '导入笔记_test', type: 'note' },
    });

    await notesDstuAdapter.importMarkdownContent(
      '文件',
      '没有标题的普通文本',
    );

    expect(createMock).toHaveBeenCalledWith('/', expect.objectContaining({
      type: 'note',
      name: expect.stringMatching(/^导入笔记_/),
    }));
  });

  it('generates timestamp title when filename is the English File placeholder', async () => {
    createMock.mockResolvedValue({
      ok: true,
      value: { id: 'note_6', name: '导入笔记_test', type: 'note' },
    });

    await notesDstuAdapter.importMarkdownContent(
      'File',
      '没有标题的普通文本',
    );

    expect(createMock).toHaveBeenCalledWith('/', expect.objectContaining({
      type: 'note',
      name: expect.stringMatching(/^导入笔记_/),
    }));
  });

  it('extracts H1 when filename is document:ID pattern', async () => {
    createMock.mockResolvedValue({
      ok: true,
      value: { id: 'note_6', name: 'My Notes', type: 'note' },
    });

    await notesDstuAdapter.importMarkdownContent(
      'document:1000019790',
      '# My Notes\n\ncontent',
    );

    expect(createMock).toHaveBeenCalledWith('/', expect.objectContaining({
      type: 'note',
      name: 'My Notes',
    }));
  });
});
