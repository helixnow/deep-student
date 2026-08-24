/**
 * FinderQuickLook 打开与可视预览渲染测试
 *
 * 覆盖：打开浮层（元数据卡 + 图标回退）、图片/PDF 可视预览
 * （shimmer → img）、加载失败回退、Esc/空格关闭、「打开」按钮。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DstuNode } from '@/dstu/types';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: 'zh-CN' },
    }),
  };
});

vi.mock('@/components/ui/DsButton', () => ({
  DsButton: ({ children, iconOnly: _iconOnly, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

const previewMocks = vi.hoisted(() => ({
  resolveQuickLookVisual: vi.fn(),
  loadQuickLookVisual: vi.fn(),
}));
vi.mock('@/features/learning-hub/components/finder/quickLookPreview', () => previewMocks);

import { FinderQuickLook } from '@/features/learning-hub/components/finder/FinderQuickLook';

function makeItem(overrides: Partial<DstuNode> = {}): DstuNode {
  return {
    id: 'file_img1',
    path: '/资料/photo.png',
    name: 'photo.png',
    type: 'file',
    size: 2048,
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    ...overrides,
  };
}

describe('FinderQuickLook', () => {
  beforeEach(() => {
    previewMocks.resolveQuickLookVisual.mockReset();
    previewMocks.loadQuickLookVisual.mockReset();
    previewMocks.resolveQuickLookVisual.mockReturnValue(null);
    previewMocks.loadQuickLookVisual.mockResolvedValue(null);
    // jsdom 未实现 ObjectURL API：卸载清理会调用 revokeObjectURL
    URL.revokeObjectURL = vi.fn();
  });

  it('打开时渲染 dialog：名称 + 元数据卡；无可视预览时不出现 shimmer', () => {
    render(
      <FinderQuickLook
        item={makeItem({ type: 'folder', name: '资料', childCount: 3 })}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('资料')).toBeInTheDocument();
    expect(screen.queryByTestId('quick-look-visual-loading')).toBeNull();
    expect(screen.queryByTestId('quick-look-visual')).toBeNull();
    // 元数据行：大小 / 修改时间 / 位置
    expect(screen.getByText('learningHub:finder.quickLook.sizeLabel')).toBeInTheDocument();
    expect(screen.getByText('learningHub:finder.quickLook.pathLabel')).toBeInTheDocument();
  });

  it('图片项：先 shimmer，加载完成后渲染 img（data-visual-kind=image）', async () => {
    previewMocks.resolveQuickLookVisual.mockReturnValue('image');
    let resolveLoad!: (v: unknown) => void;
    previewMocks.loadQuickLookVisual.mockReturnValue(
      new Promise((resolve) => { resolveLoad = resolve; }),
    );

    render(<FinderQuickLook item={makeItem()} onClose={vi.fn()} />);

    expect(screen.getByTestId('quick-look-visual-loading')).toBeInTheDocument();

    resolveLoad({ kind: 'image', url: 'blob:preview-1', isObjectUrl: true });
    const img = await screen.findByTestId('quick-look-visual');
    expect(img).toHaveAttribute('src', 'blob:preview-1');
    expect(img).toHaveAttribute('data-visual-kind', 'image');
    expect(screen.queryByTestId('quick-look-visual-loading')).toBeNull();
  });

  it('PDF 项：渲染首页预览 + 「第 1 页」徽标', async () => {
    previewMocks.resolveQuickLookVisual.mockReturnValue('pdf');
    previewMocks.loadQuickLookVisual.mockResolvedValue({
      kind: 'pdf',
      url: 'data:image/png;base64,x',
      isObjectUrl: false,
    });

    render(
      <FinderQuickLook
        item={makeItem({ id: 'tb_1', type: 'textbook', name: '高等数学.pdf' })}
        onClose={vi.fn()}
      />,
    );

    const img = await screen.findByTestId('quick-look-visual');
    expect(img).toHaveAttribute('data-visual-kind', 'pdf');
    expect(screen.getByText('learningHub:finder.quickLook.pdfFirstPage')).toBeInTheDocument();
  });

  it('可视加载失败（null）回退图标卡片，不再显示 shimmer', async () => {
    previewMocks.resolveQuickLookVisual.mockReturnValue('image');
    previewMocks.loadQuickLookVisual.mockResolvedValue(null);

    render(<FinderQuickLook item={makeItem()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByTestId('quick-look-visual-loading')).toBeNull();
    });
    expect(screen.queryByTestId('quick-look-visual')).toBeNull();
  });

  it('Esc 与空格都关闭（capture 拦截）；输入框内按键不关闭', () => {
    const onClose = vi.fn();
    render(<FinderQuickLook item={makeItem()} onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: ' ' });
    expect(onClose).toHaveBeenCalledTimes(2);

    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    input.remove();
  });

  it('「打开」按钮把 item 交给 onOpen', () => {
    const onOpen = vi.fn();
    const item = makeItem();
    render(<FinderQuickLook item={item} onClose={vi.fn()} onOpen={onOpen} />);

    fireEvent.click(screen.getByText('learningHub:finder.quickLook.open'));
    expect(onOpen).toHaveBeenCalledWith(item);
  });

  it('ObjectURL 预览在卸载时被释放（防 Blob 泄漏）', async () => {
    const revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
    previewMocks.resolveQuickLookVisual.mockReturnValue('image');
    previewMocks.loadQuickLookVisual.mockResolvedValue({
      kind: 'image',
      url: 'blob:preview-2',
      isObjectUrl: true,
    });

    const { unmount } = render(<FinderQuickLook item={makeItem()} onClose={vi.fn()} />);
    await screen.findByTestId('quick-look-visual');

    unmount();
    expect(revokeSpy).toHaveBeenCalledWith('blob:preview-2');
  });
});
