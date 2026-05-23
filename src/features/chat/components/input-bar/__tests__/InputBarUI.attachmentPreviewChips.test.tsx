import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { InputBarUI } from '../InputBarUI';
import { createDefaultPanelStates } from '../../../core/types/common';
import type { AttachmentMeta } from '../../../core/types/common';

vi.mock('@/hooks/usePdfProcessingProgress', () => ({
  usePdfProcessingProgress: vi.fn(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({
    isDragging: false,
    dropZoneProps: {},
  }),
}));

vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({
    isMobile: false,
    isFullscreenContent: false,
  }),
}));

function renderInputBar({
  attachments,
  inputValue = '',
  canSend = false,
  canAbort = false,
  isStreaming = false,
  onRemoveAttachment = vi.fn(),
}: {
  attachments: AttachmentMeta[];
  inputValue?: string;
  canSend?: boolean;
  canAbort?: boolean;
  isStreaming?: boolean;
  onRemoveAttachment?: ReturnType<typeof vi.fn>;
}) {
  render(
    <InputBarUI
      inputValue={inputValue}
      canSend={canSend}
      canAbort={canAbort}
      isStreaming={isStreaming}
      attachments={attachments}
      panelStates={createDefaultPanelStates()}
      onInputChange={vi.fn()}
      onSend={vi.fn()}
      onAbort={vi.fn()}
      onAddAttachment={vi.fn()}
      onUpdateAttachment={vi.fn()}
      onRemoveAttachment={onRemoveAttachment}
      onClearAttachments={vi.fn()}
      onSetPanelState={vi.fn()}
      placeholder="输入消息"
    />
  );
}

describe('InputBarUI attachment preview chips', () => {
  it('opens a compact attachment launcher from the plus button', () => {
    renderInputBar({ attachments: [] });

    fireEvent.click(screen.getByTestId('btn-toggle-attachments'));

    expect(screen.getByRole('menuitem', { name: 'analysis:input_bar.attachments.add' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'chatV2:inputBar.resourceLibrary' })).toBeInTheDocument();
  });

  it('renders pending attachments as compact preview chips above the textarea', () => {
    const attachments: AttachmentMeta[] = [
      {
        id: 'att_psd',
        name: '1AI_图像 (1).psd',
        type: 'image',
        mimeType: 'image/vnd.adobe.photoshop',
        size: 1024,
        status: 'ready',
      },
      {
        id: 'att_txt',
        name: '安装教程.txt',
        type: 'document',
        mimeType: 'text/plain',
        size: 512,
        status: 'ready',
      },
    ];

    renderInputBar({ attachments });

    const previewList = screen.getByRole('list', { name: '待发送附件' });
    expect(within(previewList).getByRole('listitem', { name: '1AI_图像 (1).psd' })).toBeInTheDocument();
    expect(within(previewList).getByRole('listitem', { name: '安装教程.txt' })).toBeInTheDocument();
    expect(previewList).toHaveClass('attachment-preview-chips');
  });

  it('removes an attachment from its chip action', () => {
    const onRemoveAttachment = vi.fn();
    const attachments: AttachmentMeta[] = [
      {
        id: 'att_html',
        name: '族谱纵向图谱.html',
        type: 'document',
        mimeType: 'text/html',
        size: 4096,
        status: 'ready',
      },
    ];

    renderInputBar({ attachments, onRemoveAttachment });

    fireEvent.click(screen.getByRole('button', { name: '移除附件 族谱纵向图谱.html' }));

    expect(onRemoveAttachment).toHaveBeenCalledWith('att_html');
  });

  it('keeps the remove action inside the chip and reveals it on hover or focus', () => {
    const attachments: AttachmentMeta[] = [
      {
        id: 'att_psd',
        name: '1AI_图像 (1).psd',
        type: 'image',
        mimeType: 'image/vnd.adobe.photoshop',
        size: 1024,
        status: 'ready',
      },
    ];

    renderInputBar({ attachments });

    expect(screen.getByTestId('attachment-chip-icon-att_psd')).toHaveClass('h-5', 'w-5');
    expect(screen.getByTitle('1AI_图像 (1).psd')).not.toHaveClass('pr-8');
    expect(screen.getByTitle('1AI_图像 (1).psd')).toHaveClass('pr-7');
    expect(screen.getByRole('button', { name: '移除附件 1AI_图像 (1).psd' })).toHaveClass(
      'absolute',
      'right-1.5',
      'opacity-0',
      'group-hover/attachment-chip:opacity-100',
      'focus-visible:opacity-100'
    );
  });

  it('does not show a ready confirmation badge on attachment preview icons', () => {
    const attachments: AttachmentMeta[] = [
      {
        id: 'att_ready',
        name: '讲义.pdf',
        type: 'document',
        mimeType: 'application/pdf',
        size: 2048,
        status: 'ready',
      },
    ];

    renderInputBar({ attachments });

    const iconHost = screen.getByTestId('attachment-chip-icon-att_ready');
    expect(iconHost.querySelector('.text-emerald-500')).not.toBeInTheDocument();
  });

  it('shows short attachment filenames without truncating the text label', () => {
    const attachments: AttachmentMeta[] = [
      {
        id: 'att_icon',
        name: 'app-icon.png',
        type: 'image',
        mimeType: 'image/png',
        size: 1024,
        status: 'ready',
      },
    ];

    renderInputBar({ attachments });

    const filename = screen.getByText('app-icon.png');
    expect(filename).toHaveClass('whitespace-nowrap');
    expect(filename).not.toHaveClass('truncate');
    expect(screen.getByTitle('app-icon.png')).not.toHaveClass('max-w-[220px]');
  });

  it('keeps the enabled send and streaming stop controls pure black', () => {
    const { rerender } = render(
      <InputBarUI
        inputValue="开始学习"
        canSend
        canAbort={false}
        isStreaming={false}
        attachments={[]}
        panelStates={createDefaultPanelStates()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        onAddAttachment={vi.fn()}
        onUpdateAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onSetPanelState={vi.fn()}
        placeholder="输入消息"
      />
    );

    expect(screen.getByTestId('btn-send')).toHaveClass(
      '!border-black',
      '!bg-black',
      'hover:!bg-black',
      'active:!bg-black',
      '!text-white'
    );

    rerender(
      <InputBarUI
        inputValue=""
        canSend={false}
        canAbort
        isStreaming
        attachments={[]}
        panelStates={createDefaultPanelStates()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        onAddAttachment={vi.fn()}
        onUpdateAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onSetPanelState={vi.fn()}
        placeholder="输入消息"
      />
    );

    expect(screen.getByTestId('btn-stop')).toHaveClass(
      '!border-black',
      '!bg-black',
      'hover:!bg-black',
      'active:!bg-black',
      '!text-white'
    );
  });

  it('keeps the stop control visible while streaming even when queue mode is enabled', () => {
    render(
      <InputBarUI
        inputValue="继续讲"
        canSend={false}
        canAbort
        canSubmit
        isStreaming
        queueEnabled
        attachments={[]}
        panelStates={createDefaultPanelStates()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        onAddAttachment={vi.fn()}
        onUpdateAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onSetPanelState={vi.fn()}
        placeholder="输入消息"
      />
    );

    expect(screen.getByTestId('btn-stop')).toBeInTheDocument();
    expect(screen.queryByTestId('btn-send')).not.toBeInTheDocument();
  });

  it('sends on Enter while streaming when queue mode is enabled', () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();

    render(
      <InputBarUI
        inputValue="继续讲"
        canSend={false}
        canAbort
        canSubmit
        isStreaming
        queueEnabled
        attachments={[]}
        panelStates={createDefaultPanelStates()}
        onInputChange={vi.fn()}
        onSend={onSend}
        onAbort={onAbort}
        onAddAttachment={vi.fn()}
        onUpdateAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onSetPanelState={vi.fn()}
        placeholder="输入消息"
      />
    );

    fireEvent.keyDown(screen.getByTestId('input-bar-v2-textarea'), {
      key: 'Enter',
      code: 'Enter',
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('still stops when the Stop button is clicked during queue mode streaming', () => {
    const onAbort = vi.fn();

    render(
      <InputBarUI
        inputValue="继续讲"
        canSend={false}
        canAbort
        canSubmit
        isStreaming
        queueEnabled
        attachments={[]}
        panelStates={createDefaultPanelStates()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onAbort={onAbort}
        onAddAttachment={vi.fn()}
        onUpdateAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onSetPanelState={vi.fn()}
        placeholder="输入消息"
      />
    );

    fireEvent.click(screen.getByTestId('btn-stop'));

    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('keeps Enter as Stop while streaming when queue mode is disabled', () => {
    const onAbort = vi.fn();

    render(
      <InputBarUI
        inputValue="继续讲"
        canSend={false}
        canAbort
        isStreaming
        attachments={[]}
        panelStates={createDefaultPanelStates()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
        onAbort={onAbort}
        onAddAttachment={vi.fn()}
        onUpdateAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onSetPanelState={vi.fn()}
        placeholder="输入消息"
      />
    );

    fireEvent.keyDown(screen.getByTestId('input-bar-v2-textarea'), {
      key: 'Enter',
      code: 'Enter',
    });

    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});
