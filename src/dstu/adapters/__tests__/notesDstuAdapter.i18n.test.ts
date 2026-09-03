/**
 * 笔记 Markdown 导入错误文案 i18n 契约测试
 *
 * 验证 importMarkdownFile / importMarkdownFiles 失败时，
 * toVfsError / reportError 的用户可见文案走 sidebar:notes_import.* 翻译键，
 * 且 defaultValue 与 zh-CN 主干原文一致。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import zhSidebar from '@/locales/zh-CN/sidebar.json';
import enSidebar from '@/locales/en-US/sidebar.json';

const invokeMock = vi.fn();
const reportErrorMock = vi.fn();
const tMock = vi.fn(
  (key: string, options?: { defaultValue?: string }): string => {
    const bare = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    const value = bare.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object' && part in (acc as object)) {
        return (acc as Record<string, unknown>)[part];
      }
      return undefined;
    }, zhSidebar as Record<string, unknown>);
    if (typeof value === 'string') return value;
    return options?.defaultValue ?? key;
  },
);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('../../api', () => ({
  dstu: {},
}));

vi.mock('i18next', () => ({
  default: {
    t: tMock,
  },
}));

vi.mock('@/utils/fileManager', () => ({
  isOpaqueDocumentId: () => false,
}));

vi.mock('@/shared/result', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/result')>();
  return {
    ...actual,
    reportError: reportErrorMock,
  };
});

describe('notesDstuAdapter markdown import i18n', async () => {
  const { notesDstuAdapter } = await import('../notesDstuAdapter');

  beforeEach(() => {
    invokeMock.mockReset();
    reportErrorMock.mockReset();
    tMock.mockClear();
  });

  it('locale files provide sidebar notes_import keys in both languages', () => {
    expect(zhSidebar.notes_import.markdown).toBe('导入 Markdown 笔记');
    expect(zhSidebar.notes_import.markdown_batch).toBe('批量导入 Markdown 笔记');

    expect(enSidebar.notes_import.markdown).toBeTypeOf('string');
    expect(enSidebar.notes_import.markdown).not.toHaveLength(0);
    expect(enSidebar.notes_import.markdown_batch).toBeTypeOf('string');
    expect(enSidebar.notes_import.markdown_batch).not.toHaveLength(0);
  });

  it('importMarkdownFile failure uses sidebar:notes_import.markdown for error and report context', async () => {
    invokeMock.mockRejectedValue(undefined);

    const result = await notesDstuAdapter.importMarkdownFile('/tmp/a.md', 'A.md', null);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure result');

    expect(tMock).toHaveBeenCalledWith('sidebar:notes_import.markdown', {
      defaultValue: '导入 Markdown 笔记',
    });
    expect(result.error.message).toBe('导入 Markdown 笔记');
    expect(reportErrorMock).toHaveBeenCalledWith(result.error, '导入 Markdown 笔记');
  });

  it('importMarkdownFiles failure uses sidebar:notes_import.markdown_batch for error and report context', async () => {
    invokeMock.mockRejectedValue(undefined);

    const result = await notesDstuAdapter.importMarkdownFiles(
      [{ filePath: '/tmp/a.md' }, { filePath: '/tmp/b.md' }],
      null,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure result');

    expect(tMock).toHaveBeenCalledWith('sidebar:notes_import.markdown_batch', {
      defaultValue: '批量导入 Markdown 笔记',
    });
    expect(result.error.message).toBe('批量导入 Markdown 笔记');
    expect(reportErrorMock).toHaveBeenCalledWith(result.error, '批量导入 Markdown 笔记');
  });

  it('keeps backend-provided error messages instead of the default context text', async () => {
    invokeMock.mockRejectedValue(new Error('disk full'));

    const result = await notesDstuAdapter.importMarkdownFile('/tmp/a.md');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure result');

    expect(result.error.message).toBe('disk full');
    expect(reportErrorMock).toHaveBeenCalledWith(result.error, '导入 Markdown 笔记');
  });
});
