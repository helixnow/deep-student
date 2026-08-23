/**
 * TextbookContentView 页码选中的 isActive 门控
 *
 * 并排/多标签打开两本教材时，Chat 侧广播的 `pdf-page-refs:clear` /
 * `pdf-page-refs:remove` 是不带 sourceId 的全局事件（清空输入框 chips 时就是这样）。
 * 未门控的视图会把「后动的一本」的清空动作作用到「前一本」的页码高亮上。
 *
 * 契约与 FileContentView 对齐：只有 isActive 的视图响应全局清除事件。
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'pdfstream_check_access') return { available: true, size: 1024 };
    if (cmd === 'get_file_size') return 1024;
    return null;
  }),
  convertFileSrc: (p: string) => p,
}));

vi.mock('@/hooks/usePdfLoader', () => ({
  usePdfLoader: () => ({
    file: null,
    filePath: undefined,
    loading: false,
    error: null,
    isLargeFile: false,
    retry: vi.fn(),
  }),
}));

vi.mock('@/features/learning-hub/apps/views/usePdfFocusListener', () => ({
  usePdfFocusListener: () => [null, vi.fn()] as const,
}));

vi.mock('@/features/learning-hub/apps/views/previewPersistence', () => ({
  createPreviewPersistController: () => ({
    scheduleProgress: vi.fn(),
    scheduleBookmarks: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/features/pdf/components/TextbookPdfViewer', () => ({
  TextbookPdfViewer: ({
    fileName,
    selectedPages,
    onPageSelectionChange,
  }: {
    fileName: string;
    selectedPages: Set<number>;
    onPageSelectionChange: (pages: Set<number>) => void;
  }) => (
    <div>
      <span data-testid={`selected-${fileName}`}>
        {Array.from(selectedPages).sort((a, b) => a - b).join(',')}
      </span>
      <button type="button" onClick={() => onPageSelectionChange(new Set([3, 7]))}>
        {`select-${fileName}`}
      </button>
    </div>
  ),
}));

import TextbookContentView from '@/features/learning-hub/apps/views/TextbookContentView';
import type { DstuNode } from '@/dstu/types';

function makeNode(id: string): DstuNode {
  return {
    id,
    name: `${id}.pdf`,
    path: `/${id}.pdf`,
    type: 'textbook',
    previewType: 'pdf',
    sourceId: id,
    createdAt: 0,
    updatedAt: 0,
    metadata: { filePath: `/tmp/${id}.pdf` },
  } as unknown as DstuNode;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('TextbookContentView page selection isActive gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the inactive textbook selection when a global clear event fires', async () => {
    render(
      <>
        <TextbookContentView node={makeNode('book-a')} isActive={false} />
        <TextbookContentView node={makeNode('book-b')} isActive />
      </>,
    );
    await flush();

    await act(async () => {
      screen.getByText('select-book-a.pdf').click();
      screen.getByText('select-book-b.pdf').click();
    });

    expect(screen.getByTestId('selected-book-a.pdf').textContent).toBe('3,7');
    expect(screen.getByTestId('selected-book-b.pdf').textContent).toBe('3,7');

    // Chat 输入框「清空所有页码引用」：不带 sourceId 的全局广播
    await act(async () => {
      document.dispatchEvent(new CustomEvent('pdf-page-refs:clear', { detail: {} }));
    });

    expect(screen.getByTestId('selected-book-a.pdf').textContent).toBe('3,7');
    expect(screen.getByTestId('selected-book-b.pdf').textContent).toBe('');
  });

  it('keeps the inactive textbook selection when a global remove event fires', async () => {
    render(
      <>
        <TextbookContentView node={makeNode('book-a')} isActive={false} />
        <TextbookContentView node={makeNode('book-b')} isActive />
      </>,
    );
    await flush();

    await act(async () => {
      screen.getByText('select-book-a.pdf').click();
      screen.getByText('select-book-b.pdf').click();
    });

    await act(async () => {
      document.dispatchEvent(new CustomEvent('pdf-page-refs:remove', { detail: { page: 3 } }));
    });

    expect(screen.getByTestId('selected-book-a.pdf').textContent).toBe('3,7');
    expect(screen.getByTestId('selected-book-b.pdf').textContent).toBe('7');
  });

  it('defaults to active so single-view hosts keep responding to clear events', async () => {
    render(<TextbookContentView node={makeNode('solo')} />);
    await flush();

    await act(async () => {
      screen.getByText('select-solo.pdf').click();
    });
    expect(screen.getByTestId('selected-solo.pdf').textContent).toBe('3,7');

    await act(async () => {
      document.dispatchEvent(new CustomEvent('pdf-page-refs:clear', { detail: {} }));
    });
    expect(screen.getByTestId('selected-solo.pdf').textContent).toBe('');
  });
});
