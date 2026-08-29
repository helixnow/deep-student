/**
 * AttachmentPreviewChips 重试入口回归（issue #64：OCR 经常显示未就绪）
 *
 * 图片附件流水线 OCR 阶段一次性调用失败后，后端以 completed_with_issues 收尾，
 * chip 进入 partial（「未就绪：OCR 文本」）。后端 retry() 本就接受该状态，
 * 但此前只有 error 态露出重试按钮 → partial 是死状态（重新上传同一图片
 * 会被内容去重命中同一条失败记录）。本组测试锁定：
 * - partial 态必须露出重试入口并回调 onRetry；
 * - ready 态不出现重试入口；
 * - error 态重试入口保持既有行为。
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { AttachmentPreviewChips } from '@/features/chat/components/input-bar/AttachmentPreviewChips';
import { usePdfProcessingStore } from '@/features/pdf/stores/pdfProcessingStore';
import type { AttachmentMeta } from '@/features/chat/core/types/common';

vi.mock('@/components/ui/DsButton', () => ({
  DsButton: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/features/chat/components/InlineImageViewer', () => ({
  InlineImageViewer: () => null,
}));

function buildImageAttachment(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    id: 'att-ui-1',
    name: 'photo.jpg',
    type: 'image',
    mimeType: 'image/jpeg',
    size: 12345,
    status: 'ready',
    sourceId: 'att_source_1',
    injectModes: { image: ['image', 'ocr'] },
    ...overrides,
  };
}

describe('AttachmentPreviewChips 重试入口', () => {
  beforeEach(() => {
    usePdfProcessingStore.getState().clear();
  });

  it('partial（OCR 未就绪）时露出重试入口并回调 onRetry', () => {
    const onRetry = vi.fn();
    const attachment = buildImageAttachment({
      processingStatus: {
        stage: 'completed_with_issues',
        percent: 100,
        readyModes: ['image'],
        mediaType: 'image',
      },
    });

    render(
      <AttachmentPreviewChips
        attachments={[attachment]}
        onRemove={vi.fn()}
        onRetry={onRetry}
      />
    );

    const retryButton = screen.getByRole('button', { name: '重试 photo.jpg' });
    expect(retryButton).toBeInTheDocument();

    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(attachment);
  });

  it('全部模式就绪时不出现重试入口', () => {
    const attachment = buildImageAttachment({
      processingStatus: {
        stage: 'completed',
        percent: 100,
        readyModes: ['image', 'ocr'],
        mediaType: 'image',
      },
    });

    render(
      <AttachmentPreviewChips
        attachments={[attachment]}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: '重试 photo.jpg' })).toBeNull();
  });

  it('error 态重试入口保持既有行为', () => {
    const onRetry = vi.fn();
    const attachment = buildImageAttachment({
      status: 'error',
      error: '处理超时',
    });

    render(
      <AttachmentPreviewChips
        attachments={[attachment]}
        onRemove={vi.fn()}
        onRetry={onRetry}
      />
    );

    const retryButton = screen.getByRole('button', { name: '重试 photo.jpg' });
    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledWith(attachment);
  });

  it('缺少 sourceId 或未传 onRetry 时不出现重试入口', () => {
    const partialStatus = {
      stage: 'completed_with_issues' as const,
      percent: 100,
      readyModes: ['image'] as Array<'text' | 'ocr' | 'image'>,
      mediaType: 'image' as const,
    };

    const { unmount } = render(
      <AttachmentPreviewChips
        attachments={[buildImageAttachment({ sourceId: undefined, processingStatus: partialStatus })]}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: '重试 photo.jpg' })).toBeNull();
    unmount();

    render(
      <AttachmentPreviewChips
        attachments={[buildImageAttachment({ processingStatus: partialStatus })]}
        onRemove={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: '重试 photo.jpg' })).toBeNull();
  });
});
