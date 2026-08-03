import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { InputBarUI } from '../InputBarUI';
import { createDefaultPanelStates } from '../../../core/types/common';
import type { AttachmentMeta } from '../../../core/types/common';

const { showGlobalNotificationMock } = vi.hoisted(() => ({
  showGlobalNotificationMock: vi.fn(),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
}));

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
  it('shows a global warning toast when Enter is pressed with no sendable content', () => {
    renderInputBar({ attachments: [] });

    fireEvent.keyDown(screen.getByTestId('input-bar-v2-textarea'), {
      key: 'Enter',
      code: 'Enter',
    });

    // 测试环境的 i18n 已同步加载 common 命名空间，断言用户可见的翻译文案而非原始 key
    expect(showGlobalNotificationMock).toHaveBeenCalledWith('warning', '请输入内容');
  });

  it('opens a compact attachment launcher from the plus button', async () => {
    renderInputBar({ attachments: [] });

    fireEvent.click(screen.getByTestId('btn-toggle-attachments'));

    // 桌面端加号菜单：文件动作收在「添加文件」二级飞出层内（P1-1 改造后结构）
    fireEvent.click(await screen.findByTestId('plus-menu-add-file'));
    expect(await screen.findByTestId('plus-menu-add-attachment')).toBeInTheDocument();
    expect(screen.getByTestId('plus-menu-resource-library')).toBeInTheDocument();
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

    const previewList = screen.getByRole('list', { name: 'analysis:input_bar.attachments.title' });
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

    fireEvent.click(screen.getByRole('button', { name: /(?:移除|remove).*族谱纵向图谱\.html/i }));

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
    // chip title 现为「文件名 · 状态」，改用 listitem 定位 chip 按钮
    const chipItem = screen.getByRole('listitem', { name: '1AI_图像 (1).psd' });
    const chipButton = chipItem.querySelector('.attachment-preview-chip');
    expect(chipButton).not.toHaveClass('pr-8');
    expect(chipButton).toHaveClass('pr-3');
    expect(screen.getByRole('button', { name: /(?:移除|remove).*1AI_图像 \(1\)\.psd/i })).toHaveClass(
      'absolute',
      'inset-0',
      'opacity-0',
      'group-hover/attachment-chip:opacity-100',
      'focus-visible:opacity-100'
    );
  });

  it('keeps the remove action always visible with an expanded hit area on coarse pointers', () => {
    const attachments: AttachmentMeta[] = [
      {
        id: 'att_touch',
        name: 'touch.png',
        type: 'image',
        mimeType: 'image/png',
        size: 1024,
        status: 'ready',
      },
    ];

    renderInputBar({ attachments });

    // P0-3: 触屏没有 hover，删除按钮常显 + 伪元素扩大命中区（≥44px）
    // ★ L5 修复后：命中区只向左/上/下外扩，不向右压住文件名（点 chip 开预览）区域
    expect(screen.getByRole('button', { name: /(?:移除|remove).*touch\.png/i })).toHaveClass(
      '[@media(pointer:coarse)]:opacity-100',
      '[@media(pointer:coarse)]:after:absolute',
      '[@media(pointer:coarse)]:after:-left-3',
      '[@media(pointer:coarse)]:after:-top-3',
      '[@media(pointer:coarse)]:after:-bottom-3',
      '[@media(pointer:coarse)]:after:right-0'
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

  it('truncates long attachment filenames while keeping the full name in the chip title', () => {
    // ★ M6 修复后：文件名标签统一 max-w + truncate（超长文件名不再把 chip 撑爆），
    // 完整文件名保留在 chip 的 title 中
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
    expect(filename).toHaveClass('max-w-[10rem]', 'truncate');
    const chipItem = screen.getByRole('listitem', { name: 'app-icon.png' });
    const chipButton = chipItem.querySelector('.attachment-preview-chip');
    expect(chipButton?.getAttribute('title')).toContain('app-icon.png');
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
