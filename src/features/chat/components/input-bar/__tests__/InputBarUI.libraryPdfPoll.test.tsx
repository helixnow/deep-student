/**
 * #449 回归：资源库引用进来、却没有任何处理状态的 PDF 附件
 * （status=ready + 空 readyModes，例如修复前加入的草稿附件）必须被兜底轮询覆盖：
 * 按 sourceId（VFS 文件 ID）补查后端状态，完成后解除发送拦截。
 */
import React, { useCallback, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { InputBarUI } from '../InputBarUI';
import { createDefaultPanelStates } from '../../../core/types/common';
import type { AttachmentMeta } from '../../../core/types/common';
import { usePdfProcessingStore } from '@/features/pdf/stores/pdfProcessingStore';

const { getBatchPdfProcessingStatusMock } = vi.hoisted(() => ({
  getBatchPdfProcessingStatusMock: vi.fn(),
}));

vi.mock('@/api/vfsPdfProcessingApi', () => ({
  getBatchPdfProcessingStatus: getBatchPdfProcessingStatusMock,
  retryPdfProcessing: vi.fn(),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/hooks/usePdfProcessingProgress', () => ({
  usePdfProcessingProgress: vi.fn(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({ isDragging: false, dropZoneProps: {} }),
}));

vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({ isMobile: false, isFullscreenContent: false }),
}));

const SOURCE_ID = 'file_5mMaqe5yDr';

function StatefulInputBar({ initial }: { initial: AttachmentMeta[] }) {
  const [attachments, setAttachments] = useState(initial);
  const onUpdateAttachment = useCallback((id: string, updates: Partial<AttachmentMeta>) => {
    setAttachments(prev => prev.map(a => (a.id === id ? { ...a, ...updates } : a)));
  }, []);
  return (
    <>
      <div data-testid="att-status">{attachments[0]?.status}</div>
      <InputBarUI
        inputValue="讲讲这一章"
        canSend
        canAbort={false}
        isStreaming={false}
        attachments={attachments}
        panelStates={createDefaultPanelStates()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        onAddAttachment={vi.fn()}
        onUpdateAttachment={onUpdateAttachment}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onSetPanelState={vi.fn()}
        placeholder="输入消息"
      />
    </>
  );
}

function libraryPdfWithoutStatus(): AttachmentMeta {
  return {
    id: `vfs-${SOURCE_ID}-1`,
    name: 'ch02（第二讲 运算放大器）.pdf',
    type: 'document',
    mimeType: 'application/pdf',
    size: 0,
    status: 'ready',
    resourceId: 'res_EVzR7CkaL4',
    sourceId: SOURCE_ID,
    injectModes: { pdf: ['text'] },
  };
}

beforeEach(() => {
  getBatchPdfProcessingStatusMock.mockReset();
  usePdfProcessingStore.getState().clear();
});

describe('InputBarUI poll covers library PDFs without processing status (#449)', () => {
  it('polls by sourceId and unblocks send once the backend reports completed', async () => {
    getBatchPdfProcessingStatusMock.mockResolvedValue({
      statuses: {
        [SOURCE_ID]: { stage: 'completed', percent: 100, readyModes: ['text', 'image'], mediaType: 'pdf' },
      },
    });

    render(<StatefulInputBar initial={[libraryPdfWithoutStatus()]} />);

    await waitFor(() => {
      expect(getBatchPdfProcessingStatusMock).toHaveBeenCalledWith([SOURCE_ID]);
    });
    await waitFor(() => {
      expect(screen.getByTestId('att-status')).toHaveTextContent('ready');
    });
    await waitFor(() => {
      expect(screen.getByTestId('btn-send')).toBeEnabled();
    });
  });

  it('keeps send blocked while the backend still reports processing', async () => {
    getBatchPdfProcessingStatusMock.mockResolvedValue({
      statuses: {
        [SOURCE_ID]: { stage: 'page_rendering', percent: 10, readyModes: [], mediaType: 'pdf' },
      },
    });

    render(<StatefulInputBar initial={[libraryPdfWithoutStatus()]} />);

    await waitFor(() => {
      expect(getBatchPdfProcessingStatusMock).toHaveBeenCalledWith([SOURCE_ID]);
    });
    expect(screen.getByTestId('att-status')).toHaveTextContent('processing');
    expect(screen.getByTestId('btn-send')).toBeDisabled();
  });
});
