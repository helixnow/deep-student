/**
 * 框选提问覆盖层：拖出的框按屏幕坐标交给截图，截好的 PNG 交给当前会话输入框后退出；
 * 误触 / 页面没渲染完时留在框选模式；Esc 与「取消」退出。
 */
import React, { useRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { captureMock, sendImageToChatMock, notifyMock } = vi.hoisted(() => ({
  captureMock: vi.fn(),
  sendImageToChatMock: vi.fn(),
  notifyMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}|${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('../../regionCapture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../regionCapture')>()),
  capturePdfRegion: captureMock,
}));
vi.mock('@/features/chat/context/imageToChat', () => ({ sendImageToChat: sendImageToChatMock }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: notifyMock }));

import { PdfRegionCapture } from '../PdfRegionCapture';

class TestPointerEvent extends MouseEvent {
  pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent });

function Harness({ onExit }: { onExit: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef}>
      <div ref={viewportRef} data-testid="viewport" />
      <PdfRegionCapture
        containerRef={containerRef}
        viewportRef={viewportRef}
        documentTitle="线性代数.pdf"
        isTouch={false}
        onExit={onExit}
      />
    </div>
  );
}

function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  const layer = screen.getByTestId('pdf-region-capture');
  fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(layer, { pointerId: 1, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(layer, { pointerId: 1, clientX: to.x, clientY: to.y });
}

describe('PdfRegionCapture', () => {
  beforeEach(() => {
    captureMock.mockReset();
    sendImageToChatMock.mockReset();
    notifyMock.mockReset();
  });

  it('captures the dragged box and hands the PNG to the chat input, then leaves capture mode', async () => {
    captureMock.mockResolvedValue({ kind: 'ok', blob: new Blob(['png'], { type: 'image/png' }), page: 3 });
    sendImageToChatMock.mockResolvedValue(true);
    const onExit = vi.fn();
    render(<Harness onExit={onExit} />);

    drag({ x: 60, y: 80 }, { x: 10, y: 20 });

    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(captureMock).toHaveBeenCalledWith(screen.getByTestId('viewport'), { left: 10, top: 20, width: 50, height: 60 });
    const [file, description] = sendImageToChatMock.mock.calls[0] as [File, string];
    expect(file.type).toBe('image/png');
    expect(file.name).toBe('pdf:capture.file_name|{"name":"线性代数","page":3}.png');
    expect(description).toBe('pdf:capture.source|{"name":"线性代数","page":3}');
  });

  it('stays in capture mode after a misclick without bothering the reader', async () => {
    captureMock.mockResolvedValue({ kind: 'too-small' });
    const onExit = vi.fn();
    render(<Harness onExit={onExit} />);

    drag({ x: 10, y: 10 }, { x: 12, y: 12 });

    await waitFor(() => expect(captureMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('pdf-region-capture')).not.toHaveAttribute('data-busy'));
    expect(onExit).not.toHaveBeenCalled();
    expect(sendImageToChatMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('asks the reader to wait when the page has not rendered yet', async () => {
    captureMock.mockResolvedValue({ kind: 'not-rendered', page: 5 });
    const onExit = vi.fn();
    render(<Harness onExit={onExit} />);

    drag({ x: 10, y: 10 }, { x: 80, y: 90 });

    await waitFor(() => expect(notifyMock).toHaveBeenCalledWith('info', 'pdf:capture.not_rendered'));
    expect(onExit).not.toHaveBeenCalled();
    expect(sendImageToChatMock).not.toHaveBeenCalled();
  });

  it('keeps capture mode when there is no chat session to send to', async () => {
    captureMock.mockResolvedValue({ kind: 'ok', blob: new Blob(['png'], { type: 'image/png' }), page: 1 });
    sendImageToChatMock.mockResolvedValue(false);
    const onExit = vi.fn();
    render(<Harness onExit={onExit} />);

    drag({ x: 10, y: 10 }, { x: 80, y: 90 });

    await waitFor(() => expect(sendImageToChatMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('pdf-region-capture')).not.toHaveAttribute('data-busy'));
    expect(onExit).not.toHaveBeenCalled();
  });

  it('leaves capture mode on Escape and on Cancel', () => {
    const onExit = vi.fn();
    render(<Harness onExit={onExit} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'common:cancel' }));
    expect(onExit).toHaveBeenCalledTimes(2);
  });
});
