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
    t: (key: string) => key,
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
      value: { id: 'note_2', name: 'physics', type: 'note' },
    });

    const result = await notesDstuAdapter.importMarkdownContent(
      'physics.markdown',
      '\uFEFF# Motion\n\ncontent',
      'folder_abc',
    );

    expect(result.ok).toBe(true);
    expect(createMock).toHaveBeenCalledWith('/', {
      type: 'note',
      name: 'physics',
      content: '# Motion\n\ncontent',
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
});
