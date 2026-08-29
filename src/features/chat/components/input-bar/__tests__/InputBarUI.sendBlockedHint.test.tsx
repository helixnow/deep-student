/**
 * 拆分回归 + 发送禁用原因内联提示测试
 *
 * 覆盖两块：
 * 1. InputBarUI 拆出 ComposerTextarea / ComposerToolbar / AttachmentPanelBody 后
 *    的行为回归：textarea 输入、Enter 发送、IME 合成期间 Enter 不发送。
 * 2. sendAvailability selector 驱动的「为什么发不了」内联提示：
 *    上传中/外部原因展示提示；empty 态不展示（按钮置灰表达）。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

function renderInputBar(props: Partial<React.ComponentProps<typeof InputBarUI>> = {}) {
  return render(
    <InputBarUI
      inputValue=""
      canSend={false}
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
      {...props}
    />
  );
}

describe('InputBarUI send-blocked inline hint (sendAvailability selector)', () => {
  it('shows the uploading reason inline and disables the send button', () => {
    const attachments: AttachmentMeta[] = [
      {
        id: 'att_up',
        name: '上传中.pdf',
        type: 'document',
        mimeType: 'application/pdf',
        size: 2048,
        status: 'uploading',
      },
    ];

    renderInputBar({ attachments, inputValue: '看看这个文件', canSend: true });

    const hint = screen.getByTestId('send-blocked-inline-hint');
    expect(hint).toHaveTextContent('附件上传中，请稍候');
    expect(screen.getByTestId('btn-send')).toBeDisabled();
  });

  it('shows the external disabled reason inline', () => {
    renderInputBar({
      inputValue: '继续',
      canSend: true,
      disabledReason: '当前模型不可用，请切换模型',
    });

    expect(screen.getByTestId('send-blocked-inline-hint')).toHaveTextContent(
      '当前模型不可用，请切换模型'
    );
    expect(screen.getByTestId('btn-send')).toBeDisabled();
  });

  it('does not show a hint for the empty state, only disables the button', () => {
    renderInputBar({ inputValue: '' });

    expect(screen.queryByTestId('send-blocked-inline-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('btn-send')).toBeDisabled();
  });

  it('shows no hint and enables send when content is ready', () => {
    renderInputBar({ inputValue: '你好', canSend: true });

    expect(screen.queryByTestId('send-blocked-inline-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('btn-send')).toBeEnabled();
  });

  it('surfaces the blocked reason as a toast when Enter is pressed while blocked', () => {
    const onSend = vi.fn();
    const attachments: AttachmentMeta[] = [
      {
        id: 'att_up2',
        name: '上传中.png',
        type: 'image',
        mimeType: 'image/png',
        size: 1024,
        status: 'uploading',
      },
    ];

    renderInputBar({ attachments, inputValue: '分析图片', canSend: true, onSend });

    fireEvent.keyDown(screen.getByTestId('input-bar-v2-textarea'), {
      key: 'Enter',
      code: 'Enter',
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(showGlobalNotificationMock).toHaveBeenCalledWith('info', '附件上传中，请稍候');
  });
});

describe('InputBarUI split regression (ComposerTextarea behavior)', () => {
  it('propagates textarea input through onInputChange', () => {
    const onInputChange = vi.fn();
    renderInputBar({ onInputChange });

    fireEvent.change(screen.getByTestId('input-bar-v2-textarea'), {
      target: { value: '拆分后仍可输入' },
    });

    expect(onInputChange).toHaveBeenCalledWith('拆分后仍可输入');
  });

  it('sends on Enter when content is ready', () => {
    const onSend = vi.fn();
    renderInputBar({ inputValue: '你好', canSend: true, onSend });

    fireEvent.keyDown(screen.getByTestId('input-bar-v2-textarea'), {
      key: 'Enter',
      code: 'Enter',
    });

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('does not send on Enter during IME composition, then sends after composition ends', async () => {
    const onSend = vi.fn();
    renderInputBar({ inputValue: '你好', canSend: true, onSend });

    const textarea = screen.getByTestId('input-bar-v2-textarea');

    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea);
    // Safari 时序守卫：compositionend 后同一轮事件循环内的 Enter 视为 IME 确认键
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();

    // 守卫窗口（setTimeout 0）过后 Enter 恢复发送语义
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('inserts a newline instead of sending on Shift+Enter', () => {
    const onSend = vi.fn();
    renderInputBar({ inputValue: '你好', canSend: true, onSend });

    fireEvent.keyDown(screen.getByTestId('input-bar-v2-textarea'), {
      key: 'Enter',
      code: 'Enter',
      shiftKey: true,
    });

    expect(onSend).not.toHaveBeenCalled();
  });
});
