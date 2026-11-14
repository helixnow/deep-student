/**
 * 框选提问覆盖层：拖出的框按屏幕坐标交给截图，截好的 PNG 交给当前会话输入框后退出；
 * 误触 / 页面没渲染完时留在框选模式；Esc 与「取消」退出。
 */
import React, { useRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { captureMock, sendImageToChatMock, notifyMock, extractStructuredMock, copyClipboardMock, decodeMock } = vi.hoisted(() => ({
  captureMock: vi.fn(),
  sendImageToChatMock: vi.fn(),
  notifyMock: vi.fn(),
  extractStructuredMock: vi.fn(),
  copyClipboardMock: vi.fn(),
  decodeMock: vi.fn(),
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
vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: copyClipboardMock }));
vi.mock('../../pdfRegionExtract', () => ({
  extractStructuredFromRegion: extractStructuredMock,
}));
vi.mock('../../interop/pdfInteropBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../interop/pdfInteropBridge')>()),
  decodeCapturedRegion: decodeMock,
}));

import { PdfRegionCapture } from '../PdfRegionCapture';

class TestPointerEvent extends MouseEvent {
  pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent });

function Harness({
  onExit,
  onPinRegion,
  interopResourceId,
  viewStateKey,
}: {
  onExit: () => void;
  onPinRegion?: (payload: { blob: Blob; page: number; title: string }) => void;
  interopResourceId?: string;
  viewStateKey?: string;
}) {
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
        onPinRegion={onPinRegion}
        onExit={onExit}
        interopResourceId={interopResourceId}
        viewStateKey={viewStateKey}
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
    decodeMock.mockReset();
  });

  it('finishes pointer-up outside the overlay even when pointer capture is unavailable', async () => {
    captureMock.mockResolvedValue({ kind: 'too-small' });
    render(<Harness onExit={vi.fn()} />);
    const layer = screen.getByTestId('pdf-region-capture');
    expect(layer.style.userSelect).toBe('none');
    fireEvent.pointerDown(layer, { pointerId: 7, button: 0, clientX: 10, clientY: 20 });
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 100, clientY: 120 });
    await waitFor(() => expect(captureMock).toHaveBeenCalledTimes(1));
    expect(captureMock.mock.calls[0][1]).toEqual({ left: 10, top: 20, width: 90, height: 100 });
  });

  it.each(['Escape', 'pointercancel', 'blur', 'lostpointercapture'])('releases a pending rectangle on %s without capturing', (exit) => {
    render(<Harness onExit={vi.fn()} />);
    const layer = screen.getByTestId('pdf-region-capture');
    const release = vi.fn();
    layer.releasePointerCapture = release;
    fireEvent.pointerDown(layer, { pointerId: 4, button: 0, clientX: 10, clientY: 10 });
    if (exit === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
    else if (exit === 'blur') fireEvent.blur(window);
    else if (exit === 'pointercancel') fireEvent.pointerCancel(window, { pointerId: 4 });
    else fireEvent.lostPointerCapture(layer, { pointerId: 4 });
    fireEvent.pointerUp(window, { pointerId: 4, clientX: 100, clientY: 100 });
    expect(release).toHaveBeenCalledWith(4);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('cancels old page/zoom geometry and ignores captures resolved after Escape', async () => {
    let resolve!: (value: unknown) => void;
    captureMock.mockReturnValue(new Promise((done) => { resolve = done; }));
    const view = render(<Harness onExit={vi.fn()} viewStateKey="1:100:0" />);
    const layer = screen.getByTestId('pdf-region-capture');
    fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    view.rerender(<Harness onExit={vi.fn()} viewStateKey="1:200:90" />);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(captureMock).not.toHaveBeenCalled();
    drag({ x: 10, y: 10 }, { x: 100, y: 100 });
    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => { resolve({ kind: 'ok', blob: new Blob(['png']), page: 1 }); });
    expect(sendImageToChatMock).not.toHaveBeenCalled();
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

  it('pins cropped region as floating reference when Pin mode is selected', async () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    captureMock.mockResolvedValue({ kind: 'ok', blob, page: 3 });
    const onPinRegion = vi.fn();
    const onExit = vi.fn();
    render(<Harness onExit={onExit} onPinRegion={onPinRegion} />);

    fireEvent.click(screen.getByRole('radio', { name: 'pdf:capture.mode_pin' }));
    drag({ x: 20, y: 20 }, { x: 160, y: 120 });

    await waitFor(() => expect(onPinRegion).toHaveBeenCalledTimes(1));
    expect(onPinRegion).toHaveBeenCalledWith({
      blob,
      page: 3,
      title: 'pdf:pinned.card_title|{"name":"线性代数","page":3}',
    });
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(sendImageToChatMock).not.toHaveBeenCalled();
  });

  it('extracts LaTeX formula into an editable inline card and copies to clipboard', async () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    captureMock.mockResolvedValue({ kind: 'ok', blob, page: 4 });
    extractStructuredMock.mockResolvedValue({
      source: 'llm',
      content: '$$A = U \\Sigma V^T$$',
    });
    copyClipboardMock.mockResolvedValue(true);
    const onExit = vi.fn();
    render(<Harness onExit={onExit} />);

    fireEvent.click(screen.getByRole('radio', { name: 'pdf:capture.mode_latex' }));
    drag({ x: 30, y: 30 }, { x: 200, y: 110 });

    const dialog = await screen.findByRole('dialog', { name: 'pdf:capture.result_latex_title' });
    expect(dialog).toBeInTheDocument();
    const textarea = dialog.querySelector('textarea')!;
    expect(textarea.value).toBe('$$A = U \\Sigma V^T$$');

    fireEvent.click(screen.getByRole('button', { name: 'pdf:capture.copy_result' }));
    await waitFor(() => expect(copyClipboardMock).toHaveBeenCalledWith('$$A = U \\Sigma V^T$$'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('does not send a capture completed after the reader unmounts', async () => {
    let resolve!: (value: unknown) => void;
    captureMock.mockReturnValue(new Promise((done) => { resolve = done; }));
    const onExit = vi.fn();
    const view = render(<Harness onExit={onExit} />);
    drag({ x: 10, y: 10 }, { x: 100, y: 100 });
    view.unmount();
    await act(async () => { resolve({ kind: 'ok', blob: new Blob(['png']), page: 1 }); });
    expect(sendImageToChatMock).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('opens occlusion with original image pixels and dimensions, not the downsized drag preview', async () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    captureMock.mockResolvedValue({ kind: 'ok', blob, page: 3 });
    decodeMock.mockImplementation(async (_blob, maxEdge) => maxEdge === 1200
      ? { dataUrl: 'data:image/png;base64,PREVIEW', width: 1200, height: 600 }
      : { dataUrl: 'data:image/png;base64,ORIGINAL', width: 2400, height: 1200 });
    const onExit = vi.fn();
    const onOpen = vi.fn();
    window.addEventListener('ds:open-image-occlusion-builder', onOpen);
    try {
      render(<Harness onExit={onExit} interopResourceId="pdf_a" />);
      fireEvent.click(screen.getByRole('radio', { name: 'pdf:interop.drag_region' }));
      drag({ x: 10, y: 10 }, { x: 100, y: 100 });
      await screen.findByTestId('pdf-region-excerpt-card');
      fireEvent.click(screen.getByTestId('pdf-region-occlusion-btn'));
      await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
      expect((onOpen.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
        imageBlob: blob, imageDataUrl: 'data:image/png;base64,ORIGINAL', naturalWidth: 2400, naturalHeight: 1200,
      });
    } finally {
      window.removeEventListener('ds:open-image-occlusion-builder', onOpen);
    }
  });
});
